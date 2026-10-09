/** DSP work / audio time above which the analysis is overloaded (for HOT_SECONDS), and below which it has room again (for COOL_SECONDS). */
export const DSP_HOT = 0.4;
export const DSP_COOL = 0.2;
const HOT_SECONDS = 2;
const COOL_SECONDS = 30;
/** Seconds of audio after the start that are not evidence of overload (a cold module, cold caches). */
export const DSP_WARM_UP = 3;

/**
 * CPU work / audio duration of the analysis thread (the music and the scenes' graphics), independent
 * of RAF/GPU. An overloaded thread lowers the DSP quality: slow feature rates and the cadence of the
 * scenes' analysis only, never hops, onsets or beats. The same thresholds run in the native backend.
 */
export class DspBudget {
  quality = 0;
  load = 0;
  private hot = 0;
  private cool = 0;
  private elapsed = 0;
  private initialized = false;
  update(workSeconds: number, audioSeconds: number): number {
    if (!(audioSeconds > 0) || !Number.isFinite(workSeconds)) return this.quality;
    const cost = Math.min(4, workSeconds / audioSeconds);
    this.load = this.initialized ? this.load + (cost - this.load) * (1 - Math.exp(-audioSeconds)) : cost;
    this.initialized = true;
    this.elapsed += audioSeconds;
    this.hot = this.load > DSP_HOT && this.elapsed > DSP_WARM_UP ? this.hot + audioSeconds : 0;
    this.cool = this.load < DSP_COOL ? this.cool + audioSeconds : 0;
    if (this.hot > HOT_SECONDS && this.quality < 2) { this.quality++; this.hot = this.cool = 0; }
    if (this.cool > COOL_SECONDS && this.quality > 0) { this.quality--; this.hot = this.cool = 0; }
    return this.quality;
  }
}
