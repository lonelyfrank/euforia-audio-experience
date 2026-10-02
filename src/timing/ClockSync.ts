/** Seconds of observations the offset is the minimum of. */
const WINDOW = 3;
/** Time constant (s) of the glide when the estimate moves (no sudden jumps of the grid). */
const GLIDE = 0.5;
const SLOTS = 64;

/**
 * Maps the analysis capture clock (seconds since the capture started) to the
 * host clock (seconds of `performance.now()`).
 *
 * Each observation says "at host time `now`, the newest analysed sample, at
 * capture time `capture`, was `age` seconds old". `now - age - capture` is
 * the offset between the clocks plus whatever delay was not accounted for
 * (IPC, scheduling): the minimum over the last seconds is the best estimate,
 * and following it tracks the slow drift between the audio and host clocks.
 * The result is when a sample was captured; when it is *heard* depends on
 * the output's latency (see Timing).
 */
export class ClockSync {
  /** Host time minus capture time (s), once `ready`. */
  offset = 0;
  ready = false;
  private readonly times = new Float64Array(SLOTS);
  private readonly values = new Float64Array(SLOTS);
  private count = 0;
  private head = 0;
  private lastNow = 0;

  observe(now: number, capture: number, age = 0): void {
    const value = now - age - capture;
    this.times[this.head] = now;
    this.values[this.head] = value;
    this.head = (this.head + 1) % SLOTS;
    this.count = Math.min(this.count + 1, SLOTS);
    let min = Infinity;
    for (let i = 0; i < this.count; i++) if (now - this.times[i] <= WINDOW && this.values[i] < min) min = this.values[i];
    if (!this.ready) {
      this.offset = min;
      this.ready = true;
    } else {
      const dt = Math.max(now - this.lastNow, 0);
      // A smaller minimum (a faster path found) is taken at once; a larger one (the old minimum expired) glides.
      this.offset = min < this.offset ? min : this.offset + (min - this.offset) * (1 - Math.exp(-dt / GLIDE));
    }
    this.lastNow = now;
  }

  toHost(capture: number): number {
    return capture + this.offset;
  }

  toCapture(host: number): number {
    return host - this.offset;
  }

  reset(): void {
    this.ready = false;
    this.count = 0;
    this.head = 0;
    this.offset = 0;
  }
}
