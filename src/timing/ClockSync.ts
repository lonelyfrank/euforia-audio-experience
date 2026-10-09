/** Observations are kept as one minimum per bucket of this many seconds… */
const BUCKET = 0.25;
/** …for this many buckets: the offset is the fastest delivery of the last 12 s. */
const BUCKETS = 48;
/** Buckets that count as "now" when looking for a jump of the clocks (1 s). */
const RECENT = 4;
/** Seconds after a (re)start during which the estimate takes every better observation at once: the first arrivals are rarely the fastest. */
const ACQUIRE = 2;
/**
 * Fastest correction afterwards, seconds per second. Far above any drift between an audio clock and
 * the host's (≈ 1e-4), far below what reads as a change of speed: the mapped time never steps.
 */
const SLEW = 0.002;
/** A difference this large (s) is not jitter: the clocks jumped apart (a suspended machine, a stalled host). The estimate starts over. */
const STEP = 0.25;

/**
 * Maps the analysis capture clock (seconds since the capture started) to the
 * host clock (seconds of `performance.now()`).
 *
 * Each observation says "at host time `now`, the newest analysed sample, at
 * capture time `capture`, was `age` seconds old". `now - age - capture` is
 * the offset between the clocks plus whatever delay was not accounted for
 * (IPC, scheduling): the minimum over the last seconds is the best estimate.
 *
 * What is shown is timed through this mapping, so it must not move with the
 * arrival of each message: after the first seconds the offset only glides
 * towards the estimate (`SLEW`), which is enough to follow the slow drift
 * between the audio and host clocks and keeps the mapped time monotonic.
 * Only a real discontinuity (`STEP`) restarts it. The result is when a sample
 * was captured; when it is *heard* depends on the output's latency (see Timing).
 */
export class ClockSync {
  /** Host time minus capture time (s), once `ready`. */
  offset = 0;
  ready = false;
  /** Times the estimate started over because the clocks jumped (diagnostics). */
  resyncs = 0;
  /** The estimate the offset glides towards: the fastest delivery of the window (diagnostics). */
  floor = 0;
  private readonly buckets = new Float64Array(BUCKETS).fill(-1);
  private readonly minima = new Float64Array(BUCKETS);
  private since = 0;
  private lastNow = 0;

  observe(now: number, capture: number, age = 0): void {
    const value = now - age - capture;
    const bucket = Math.floor(now / BUCKET);
    const slot = ((bucket % BUCKETS) + BUCKETS) % BUCKETS;
    const { buckets, minima } = this;
    if (buckets[slot] !== bucket) {
      buckets[slot] = bucket;
      minima[slot] = value;
    } else if (value < minima[slot]) minima[slot] = value;
    if (!this.ready) {
      this.offset = this.floor = value;
      this.ready = true;
      this.since = this.lastNow = now;
      return;
    }
    let floor = Infinity;
    let recent = Infinity;
    for (let i = 0; i < BUCKETS; i++) {
      const b = buckets[i];
      if (b < 0 || b > bucket || b <= bucket - BUCKETS) continue;
      if (minima[i] < floor) floor = minima[i];
      if (b > bucket - RECENT && minima[i] < recent) recent = minima[i];
    }
    const dt = Math.max(now - this.lastNow, 0);
    this.lastNow = now;
    if (now - this.since < ACQUIRE) {
      this.offset = this.floor = floor;
    } else if (recent - this.offset > STEP || this.offset - floor > STEP) {
      // Every recent delivery is far later than the mapping says, or one came far earlier than it allows.
      buckets.fill(-1);
      buckets[slot] = bucket;
      minima[slot] = value;
      this.offset = this.floor = value;
      this.since = now;
      this.resyncs++;
    } else {
      this.floor = floor;
      const error = floor - this.offset;
      const step = SLEW * dt;
      this.offset += error > step ? step : error < -step ? -step : error;
    }
  }

  toHost(capture: number): number {
    return capture + this.offset;
  }

  toCapture(host: number): number {
    return host - this.offset;
  }

  reset(): void {
    this.ready = false;
    this.buckets.fill(-1);
    this.offset = this.floor = 0;
  }
}
