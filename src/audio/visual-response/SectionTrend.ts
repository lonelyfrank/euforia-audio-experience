import { Envelope } from './Envelope';

/** Signed section change, not a beat derivative. Constant memory; no startup impulse. */
export class SectionTrend {
  private readonly fast = new Envelope(1.5, 1.5);
  private readonly slow = new Envelope(6, 6);
  private ready = false;

  update(value: number, dt: number): number {
    if (!this.ready) {
      this.fast.reset(value);
      this.slow.reset(value);
      this.ready = true;
    }
    return Math.max(-1, Math.min(1, (this.fast.update(value, dt) - this.slow.update(value, dt)) * 4));
  }

  reset(): void {
    this.ready = false;
  }
}
