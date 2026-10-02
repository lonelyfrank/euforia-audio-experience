/** Confidence that engages the grid / lets it go (hysteresis). */
const ENGAGE = 0.6;
const RELEASE = 0.35;
/** Seconds a reading must hold before the mode changes. */
const ENGAGE_HOLD = 1;
const RELEASE_HOLD = 1.5;
/** Ramps (s) of the grid weight: in slowly, out a little faster, never a jump. */
const WEIGHT_IN = 1.5;
const WEIGHT_OUT = 0.8;

export type RhythmMode = 'grid' | 'free';

/**
 * Decides how much the direction may lean on the beat grid. With a trusted
 * grid, effects lock to beats and bars; when confidence drops (beatless
 * music, a break, a tempo the tracker lost) the weight ramps down and the
 * direction falls back to atmosphere and transients. Hysteresis and holds
 * keep it from flickering; the weight always ramps.
 */
export class RhythmGate {
  mode: RhythmMode = 'free';
  /** 0..1: how much grid-locked effects may show. */
  weight = 0;
  private heldFor = 0;

  update(confidence: number, dt: number): number {
    const wants: RhythmMode = this.mode === 'grid' ? (confidence < RELEASE ? 'free' : 'grid') : confidence > ENGAGE ? 'grid' : 'free';
    if (wants === this.mode) this.heldFor = 0;
    else {
      this.heldFor += dt;
      if (this.heldFor >= (wants === 'grid' ? ENGAGE_HOLD : RELEASE_HOLD)) {
        this.mode = wants;
        this.heldFor = 0;
      }
    }
    const target = this.mode === 'grid' ? 1 : 0;
    const tau = target > this.weight ? WEIGHT_IN : WEIGHT_OUT;
    this.weight += (target - this.weight) * (1 - Math.exp(-dt / tau));
    return this.weight;
  }

  reset(): void {
    this.mode = 'free';
    this.weight = 0;
    this.heldFor = 0;
  }
}
