import type { QualityProfile, QualitySetting } from '../types/visualizer';

/**
 * Halo quality ladder: Low 0.5×, Medium 0.75×, High 1× of the device pixel
 * ratio (capped at 2); Auto starts at 1× capped at 1.5 and steps down.
 */
export const QUALITY_PROFILES: Record<QualitySetting, QualityProfile> = {
  low: { level: 'low', pixelScale: 0.5, maxPixelRatio: 1.5, density: 0.35, bloom: false },
  medium: { level: 'medium', pixelScale: 0.75, maxPixelRatio: 1.5, density: 0.65, bloom: true },
  high: { level: 'high', pixelScale: 1, maxPixelRatio: 2, density: 1, bloom: true },
  auto: { level: 'auto', pixelScale: 1, maxPixelRatio: 1.5, density: 1, bloom: true },
};

/** Where AUTO goes when the frame rate is too low. */
const AUTO_STEPS: QualitySetting[] = ['auto', 'medium', 'low'];
/** Seconds of frame timing gathered before AUTO takes a decision. */
const SAMPLE_WINDOW = 3;
/** Step down when running below this fraction of the target frame rate. */
const TOLERANCE = 0.85;
const TARGET_FPS = 60;
/** Frames longer than this (s) are ignored. */
const STALL = 0.25;

/**
 * Resolves the quality setting to a profile. AUTO steps down when the
 * measured frame rate stays below target; it never steps back up during a
 * session (this avoids oscillating). A manual change resets it.
 */
export class QualityController {
  private setting: QualitySetting = 'auto';
  private autoStep = 0;
  private elapsed = 0;
  private frames = 0;

  get profile(): QualityProfile {
    return QUALITY_PROFILES[this.setting === 'auto' ? AUTO_STEPS[this.autoStep] : this.setting];
  }

  set(setting: QualitySetting): void {
    this.setting = setting;
    this.autoStep = 0;
    this.resetWindow();
  }

  /** Returns true when the profile changed. */
  sample(dt: number): boolean {
    // Stalls (loading, shader compiles, a hidden window) are not frame-rate evidence.
    if (this.setting !== 'auto' || dt > STALL) return false;
    this.elapsed += dt;
    this.frames++;
    if (this.elapsed < SAMPLE_WINDOW) return false;
    const fps = this.frames / this.elapsed;
    this.resetWindow();
    if (fps < TARGET_FPS * TOLERANCE && this.autoStep < AUTO_STEPS.length - 1) {
      this.autoStep++;
      return true;
    }
    return false;
  }

  resetWindow(): void {
    this.elapsed = 0;
    this.frames = 0;
  }
}
