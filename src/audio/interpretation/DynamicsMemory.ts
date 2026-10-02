import type { MusicState } from '../../types/audio';

/** Three bounded memories of absolute loudness; independent of adaptive display gain. */
export class DynamicsMemory {
  private instant = 0;
  private short = 0;
  private high = 0;
  private low = 0;
  private ready = false;

  update(level: number, dt: number, out: MusicState): void {
    if (!this.ready) {
      this.instant = this.short = this.high = this.low = level;
      this.ready = true;
    }
    this.instant += (level - this.instant) * (1 - Math.exp(-dt / 0.04));
    this.short += (level - this.short) * (1 - Math.exp(-dt / 0.6));
    const memory = 1 - Math.exp(-dt / 12);
    this.high = Math.max(level, this.high + (level - this.high) * memory);
    this.low = Math.min(level, this.low + (level - this.low) * memory);
    out.shortEnergy = this.short;
    out.energyDelta = Math.max(-1, Math.min(1, (this.instant - this.short) * 3));
    out.attack = Math.max(0, out.energyDelta);
    out.decay = Math.max(0, -out.energyDelta);
    out.dynamicRange = Math.min(1, (this.high - this.low) * 2);
  }

  reset(): void { this.ready = false; }
}
