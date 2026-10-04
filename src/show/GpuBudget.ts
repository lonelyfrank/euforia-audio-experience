/** Fixture cost units allowed at most per quality level (measured on an Intel iGPU at 1080p). */
export const MAX_UNITS: Readonly<Record<'low' | 'medium' | 'high', number>> = { low: 3, medium: 2.2, high: 1.6 };
/** Frame rate that earns another unit after GOOD seconds, and that loses one after BAD seconds. */
const GOOD_FPS = 57;
const BAD_FPS = 50;
const GOOD = 10;
const BAD = 2;
/** After losing a unit, no new one for this long (s): no back-and-forth. */
const HOLD = 60;

/**
 * How many fixtures the GPU can afford, from the measured frame rate: start
 * with one scene, earn more while the frame rate stays high, give one back
 * quickly when it drops, and don't try again for a while.
 */
export class GpuBudget {
  units = 1;
  private good = 0;
  private bad = 0;
  private hold = 0;

  update(fps: number, dt: number, level: 'low' | 'medium' | 'high'): number {
    const max = MAX_UNITS[level];
    this.hold = Math.max(0, this.hold - dt);
    this.good = fps >= GOOD_FPS ? this.good + dt : 0;
    this.bad = fps < BAD_FPS ? this.bad + dt : 0;
    if (this.bad >= BAD && this.units > 1) {
      this.units = Math.max(1, this.units - 1);
      this.bad = this.good = 0;
      this.hold = HOLD;
    } else if (this.good >= GOOD && this.hold <= 0 && this.units < max) {
      this.units = Math.min(max, this.units + 1);
      this.good = 0;
    }
    this.units = Math.min(this.units, max);
    return this.units;
  }

  reset(): void {
    this.units = 1;
    this.good = this.bad = this.hold = 0;
  }
}
