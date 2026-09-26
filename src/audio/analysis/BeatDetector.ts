/*
 * Beat tracking in two stages:
 * 1. Onsets: rises of the kick (low-frequency) level above its running
 *    average that cross an adaptive threshold. Immediate but noisy: bass
 *    notes between kicks also produce onsets.
 * 2. Tempo & phase: the onset strength is resampled at 100 Hz; its
 *    autocorrelation over the last seconds gives the beat period, and a
 *    predicted beat time is kept. Onsets near the prediction become beats
 *    (and correct the phase); if one is missing the tracker keeps time.
 *    Until a tempo is found, onsets are reported as beats directly.
 */

const MIN_ONSET_INTERVAL = 0.2; // s
/** Time constant (s) of the running average the kick is compared to. */
const AVERAGE_TAU = 0.35;
/** Smallest rise over the average (dB) that can count as an onset. */
const MIN_RISE_DB = 3;
/** Fraction of the recent strongest rise an onset must reach. */
const RELATIVE_THRESHOLD = 0.45;
/** Seconds for the strongest-rise memory to decay by ~63%. */
const RISE_MEMORY = 2;

/** Onset-strength history used for the tempo estimate. */
const RATE = 100; // Hz
const HISTORY = 6 * RATE;
const MIN_BPM = 70;
const MAX_BPM = 180;
/** Tempo prior: the estimate prefers periods near this BPM (resolves double/half time). */
const PREFERRED_BPM = 120;
const RETEMPO_INTERVAL = 0.5; // s
/** An onset within this fraction of the period from the prediction is taken as the beat. */
const PHASE_WINDOW = 0.25;
/** How much an accepted onset pulls the phase (0 = ignore, 1 = snap). */
const PHASE_CORRECTION = 0.6;
/** Predicted beats kept without any supporting onset before tracking stops. */
const MAX_MISSED = 4;
const PULSE_DECAY = 8; // 1/s

export class BeatDetector {
  beat = false;
  pulse = 0;
  onset = 0;
  bpm = 0;

  private average = Number.NaN;
  private previousRise = 0;
  private strongestRise = MIN_RISE_DB * 2;
  private lastOnset = -1;

  private readonly history = new Float32Array(HISTORY);
  private historyIndex = 0;
  private historyTime = 0;
  private filled = 0;
  private sinceRetempo = 0;
  private period = 0;
  private nextBeat = 0;
  private missed = 0;

  /** `kickDb`: level of the kick band over the last few milliseconds. */
  update(kickDb: number, silent: boolean, time: number, dt: number): void {
    if (Number.isNaN(this.average)) this.average = kickDb;
    const rise = silent ? 0 : Math.max(kickDb - this.average, 0);
    this.average += (kickDb - this.average) * (1 - Math.exp(-dt / AVERAGE_TAU));
    this.strongestRise = Math.max(rise, this.strongestRise * Math.exp(-dt / RISE_MEMORY), MIN_RISE_DB * 2);
    this.onset = Math.min(rise / this.strongestRise, 1);

    const threshold = Math.max(MIN_RISE_DB, this.strongestRise * RELATIVE_THRESHOLD);
    const isOnset =
      rise > threshold && this.previousRise <= threshold && (this.lastOnset < 0 || time - this.lastOnset > MIN_ONSET_INTERVAL);
    this.previousRise = rise;
    if (isOnset) this.lastOnset = time;

    this.record(this.onset, dt);
    this.sinceRetempo += dt;
    if (this.sinceRetempo >= RETEMPO_INTERVAL) {
      this.sinceRetempo = 0;
      this.estimateTempo(silent, time);
    }

    this.beat = this.track(isOnset, silent, time);
    this.pulse = this.beat ? 1 : this.pulse * Math.exp(-dt * PULSE_DECAY);
  }

  reset(): void {
    this.average = Number.NaN;
    this.previousRise = 0;
    this.strongestRise = MIN_RISE_DB * 2;
    this.lastOnset = -1;
    this.history.fill(0);
    this.historyIndex = 0;
    this.historyTime = 0;
    this.filled = 0;
    this.sinceRetempo = 0;
    this.period = 0;
    this.missed = 0;
    this.pulse = 0;
    this.bpm = 0;
    this.beat = false;
  }

  /** Returns whether a beat falls on this frame. */
  private track(isOnset: boolean, silent: boolean, time: number): boolean {
    const period = this.period;
    if (period === 0) return isOnset;

    if (isOnset) {
      // Signed distance to the nearest predicted beat (the one just passed or the next).
      const error = time - this.nextBeat;
      const nearest = error < -period / 2 ? error + period : error;
      if (Math.abs(nearest) < period * PHASE_WINDOW) {
        this.nextBeat = time - nearest * (1 - PHASE_CORRECTION) + period;
        this.missed = 0;
        // Fire unless the predicted beat already fired a moment ago (onset slightly late).
        return error >= 0 || nearest <= 0;
      }
      return false;
    }
    if (time >= this.nextBeat) {
      // No onset at the predicted time: keep the rhythm going for a while.
      this.nextBeat += period;
      if (silent || ++this.missed > MAX_MISSED) {
        this.period = 0;
        this.bpm = 0;
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Bins since the last beat of the grid (spacing `lag`) that collects the
   * most onset strength: the accents define the downbeat side.
   */
  private phaseAgo(lag: number, start: number, n: number): number {
    const newest = start + n - 1;
    let best = 0;
    let bestSum = -1;
    for (let p = 0; p < lag; p++) {
      let sum = 0;
      for (let i = newest - p; i >= start; i -= lag) sum += this.history[i % HISTORY];
      if (sum > bestSum) {
        bestSum = sum;
        best = p;
      }
    }
    return best;
  }

  /** Writes onset strength into the 100 Hz history, holding it across frame gaps. */
  private record(value: number, dt: number): void {
    this.historyTime += dt;
    while (this.historyTime >= 1 / RATE) {
      this.historyTime -= 1 / RATE;
      this.history[this.historyIndex] = value;
      this.historyIndex = (this.historyIndex + 1) % HISTORY;
      this.filled = Math.min(this.filled + 1, HISTORY);
    }
  }

  private estimateTempo(silent: boolean, time: number): void {
    if (silent || this.filled < 3 * RATE) return;
    const { history } = this;
    const n = this.filled;
    const start = (this.historyIndex - n + HISTORY) % HISTORY;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += history[(start + i) % HISTORY];
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) energy += (history[(start + i) % HISTORY] - mean) ** 2;
    if (energy <= 0) return;

    const minLag = Math.round((60 / MAX_BPM) * RATE);
    const maxLag = Math.round((60 / MIN_BPM) * RATE);
    let bestLag = 0;
    let bestScore = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let r = 0;
      for (let i = lag; i < n; i++) {
        r += (history[(start + i) % HISTORY] - mean) * (history[(start + i - lag) % HISTORY] - mean);
      }
      const bpm = (60 * RATE) / lag;
      // Log-normal prior around the preferred tempo.
      const prior = Math.exp(-0.5 * (Math.log2(bpm / PREFERRED_BPM) / 0.9) ** 2);
      const score = (r / energy) * prior;
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }
    // Weak periodicity: no reliable tempo.
    if (bestScore < 0.08) return;
    const period = bestLag / RATE;
    if (this.period === 0) {
      this.period = period;
      this.nextBeat = time - this.phaseAgo(bestLag, start, n) / RATE + period;
      this.missed = 0;
    } else {
      this.period += (period - this.period) * 0.3;
    }
    this.bpm = 60 / this.period;
  }
}
