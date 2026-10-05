/** CPU work / audio duration, independent of RAF/GPU. Slow feature rates only. */
export class DspBudget {
  quality = 0;
  load = 0;
  private hot = 0;
  private cool = 0;
  private initialized = false;
  update(workSeconds: number, audioSeconds: number): number {
    if (!(audioSeconds > 0) || !Number.isFinite(workSeconds)) return this.quality;
    const cost = Math.min(4, workSeconds / audioSeconds);
    this.load = this.initialized ? this.load + (cost - this.load) * (1 - Math.exp(-audioSeconds)) : cost;
    this.initialized = true;
    this.hot = this.load > 0.3 ? this.hot + audioSeconds : 0;
    this.cool = this.load < 0.12 ? this.cool + audioSeconds : 0;
    if (this.hot > 2 && this.quality < 2) { this.quality++; this.hot = this.cool = 0; }
    if (this.cool > 30 && this.quality > 0) { this.quality--; this.hot = this.cool = 0; }
    return this.quality;
  }
}
