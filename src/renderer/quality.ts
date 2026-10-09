import type { QualityProfile, QualitySetting } from '../types/visualizer';

/**
 * Euforia-Audio-Experience quality ladder: Low 0.5×, Medium 0.75×, High 1× of the device pixel
 * ratio (capped at 2); Auto starts at 1× capped at 1.5 and steps down.
 */
export const QUALITY_PROFILES: Record<QualitySetting, QualityProfile> = {
  low: { level: 'low', pixelScale: 0.5, maxPixelRatio: 1.5, density: 0.35, bloom: false },
  medium: { level: 'medium', pixelScale: 0.75, maxPixelRatio: 1.5, density: 0.65, bloom: true },
  high: { level: 'high', pixelScale: 1, maxPixelRatio: 2, density: 1, bloom: true },
  auto: { level: 'auto', pixelScale: 1, maxPixelRatio: 1.5, density: 1, bloom: true },
};

/** Where AUTO goes when the frame rate is too low. */
const AUTO_STEPS: QualityProfile[] = [
  QUALITY_PROFILES.auto,
  { ...QUALITY_PROFILES.auto, pixelScale: 0.85 },
  QUALITY_PROFILES.medium,
  { ...QUALITY_PROFILES.medium, pixelScale: 0.65, bloom: false },
  QUALITY_PROFILES.low,
];
/** Seconds of frame timing gathered before a decision. */
const SAMPLE_WINDOW = 3;
/** Step down when running below this fraction of the target frame rate. */
const TOLERANCE = 0.85;
export const TARGET_FPS = 60;
/** Frames longer than this (s) are ignored. */
const STALL = 0.25;
/**
 * Share of the frame the main thread spends on its own logic (analysis records, experience, rig)
 * above which a slow frame rate is the CPU's doing: fewer pixels or passes would not bring it back.
 */
const CPU_BOUND = 0.5;
/** Seconds a profile is left alone after a change before its frame rate counts (the new scene settles). */
const SETTLE = 2;
/** Stable seconds a recovery needs at first, and at most after recoveries that did not hold. */
const RECOVER = 30;
const RECOVER_MAX = 480;
/** A recovery followed by a new step down within this many seconds did not hold. */
const RECOVERY_HELD = 120;

/** What limits the frame rate, when something does: the GPU (pixels, passes), or the main thread's own logic. */
export type FrameLimit = 'none' | 'gpu' | 'cpu';

/**
 * The one observer of the rendering load. It measures the frame rate, tells what limits it, and
 * resolves the quality setting to a profile; the fixture budget (GpuBudget) reads the same numbers,
 * so the two never pull against each other.
 *
 * AUTO steps down when the measured frame rate stays below target *and the GPU is the limit*: a
 * CPU-bound frame rate is left alone (fewer pixels would not help), and so are transitions (a
 * crossfade draws two scenes) and stalls (loading, a hidden window), which are not evidence.
 * Recovery requires 30 stable seconds and a 60 s cooldown; a recovery that does not hold doubles
 * the wait before the next one, so a machine between two steps settles on the lower instead of
 * rebuilding its scene every minute. Resolution steps do not rebuild geometry.
 */
export class QualityController {
  private setting: QualitySetting = 'auto';
  private autoStep = 0;
  private elapsed = 0;
  private frames = 0;
  private logic = 0;
  private stable = 0;
  private cooldown = 0;
  private settle = 0;
  private recover = RECOVER;
  private sinceRecovery = Infinity;
  /** Smoothed frame rate, measured at every quality setting (stalls excluded): the GPU budget reads it. */
  fps = 60;
  /** What limited the last full window. */
  limit: FrameLimit = 'none';
  /** Main-thread logic time over frame time in the last full window (0..1). */
  logicShare = 0;

  get profile(): QualityProfile {
    return this.setting === 'auto' ? AUTO_STEPS[this.autoStep] : QUALITY_PROFILES[this.setting];
  }

  /** AUTO is below its first step: quality was taken from the scene to keep the frame rate. */
  get reduced(): boolean {
    return this.setting === 'auto' && this.autoStep > 0;
  }

  /** Steps AUTO has taken down (0 = full quality; fixed settings read 0). */
  get step(): number {
    return this.setting === 'auto' ? this.autoStep : 0;
  }

  set(setting: QualitySetting): void {
    this.setting = setting;
    this.autoStep = 0;
    this.stable = this.cooldown = this.settle = 0;
    this.recover = RECOVER;
    this.sinceRecovery = Infinity;
    this.limit = 'none';
    this.resetWindow();
  }

  /**
   * One rendered frame: `dt` its interval (s), `logic` the seconds its main-thread logic took before
   * any drawing, `steady` false while a scene is fading in or out or still preparing. Returns true
   * when the profile changed.
   */
  sample(dt: number, logic = 0, steady = true): boolean {
    // Stalls (loading, shader compiles, a hidden window) are not frame-rate evidence.
    if (dt <= 0 || dt > STALL) {
      this.resetWindow();
      this.stable = 0;
      return false;
    }
    this.fps += (1 / dt - this.fps) * 0.02;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.sinceRecovery += dt;
    if (!steady) this.settle = SETTLE;
    if (this.settle > 0) {
      // A transition, or the seconds after a change: what is measured is not the profile's own cost.
      if (steady) this.settle -= dt;
      this.resetWindow();
      return false;
    }
    this.elapsed += dt;
    this.frames++;
    this.logic += logic;
    if (this.elapsed < SAMPLE_WINDOW) return false;
    const fps = this.frames / this.elapsed;
    const window = this.elapsed;
    this.logicShare = Math.min(1, this.logic / this.elapsed);
    this.limit = fps >= TARGET_FPS * TOLERANCE ? 'none' : this.logicShare > CPU_BOUND ? 'cpu' : 'gpu';
    this.resetWindow();
    if (this.setting !== 'auto') return false;
    if (this.limit === 'gpu' && this.autoStep < AUTO_STEPS.length - 1) {
      // A step down soon after a recovery: that recovery did not hold, the next one waits longer.
      if (this.sinceRecovery < RECOVERY_HELD) this.recover = Math.min(this.recover * 2, RECOVER_MAX);
      this.sinceRecovery = Infinity;
      this.autoStep++;
      this.stable = 0;
      this.cooldown = 60;
      this.settle = SETTLE;
      return true;
    }
    this.stable = fps >= 58 ? this.stable + window : 0;
    if (this.stable >= this.recover && this.cooldown <= 0 && this.autoStep > 0) {
      this.autoStep--;
      this.stable = 0;
      this.cooldown = 60;
      this.settle = SETTLE;
      this.sinceRecovery = 0;
      return true;
    }
    return false;
  }

  resetWindow(): void {
    this.elapsed = 0;
    this.frames = 0;
    this.logic = 0;
  }
}
