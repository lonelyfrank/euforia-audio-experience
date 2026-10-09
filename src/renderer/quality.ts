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
/** Seconds of frame timing gathered before AUTO takes a decision. */
const SAMPLE_WINDOW = 3;
/** Step down when running below this fraction of the target frame rate. */
const TOLERANCE = 0.85;
export const TARGET_FPS = 60;
/** Frames longer than this (s) are ignored. */
const STALL = 0.25;

/**
 * Resolves the quality setting to a profile. AUTO steps down when the
 * measured frame rate stays below target. Recovery requires 30 stable seconds
 * and a 60 s cooldown. Resolution steps do not rebuild geometry.
 */
export class QualityController {
  private setting: QualitySetting = 'auto';
  private autoStep = 0;
  private elapsed = 0;
  private frames = 0;
  private stable = 0;
  private cooldown = 0;
  /** Smoothed frame rate, measured at every quality setting (stalls excluded): the GPU budget reads it. */
  fps = 60;

  get profile(): QualityProfile {
    return this.setting === 'auto' ? AUTO_STEPS[this.autoStep] : QUALITY_PROFILES[this.setting];
  }

  set(setting: QualitySetting): void {
    this.setting = setting;
    this.autoStep = 0;
    this.stable = this.cooldown = 0;
    this.resetWindow();
  }

  /** Returns true when the profile changed. */
  sample(dt: number): boolean {
    // Stalls (loading, shader compiles, a hidden window) are not frame-rate evidence.
    if (dt > 0 && dt <= STALL) this.fps += (1 / dt - this.fps) * 0.02;
    if (this.setting !== 'auto') return false;
    if (dt <= 0 || dt > STALL) { this.resetWindow(); this.stable = 0; return false; }
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.elapsed += dt;
    this.frames++;
    if (this.elapsed < SAMPLE_WINDOW) return false;
    const fps = this.frames / this.elapsed;
    const window = this.elapsed;
    this.resetWindow();
    if (fps < TARGET_FPS * TOLERANCE && this.autoStep < AUTO_STEPS.length - 1) {
      this.autoStep++;
      this.stable = 0;
      this.cooldown = 60;
      return true;
    }
    this.stable = fps >= 58 ? this.stable + window : 0;
    if (this.stable >= 30 && this.cooldown <= 0 && this.autoStep > 0) {
      this.autoStep--;
      this.stable = 0;
      this.cooldown = 60;
      return true;
    }
    return false;
  }

  resetWindow(): void {
    this.elapsed = 0;
    this.frames = 0;
  }
}
