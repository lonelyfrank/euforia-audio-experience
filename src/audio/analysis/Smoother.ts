/**
 * Frame-rate independent attack/release smoothing coefficients.
 * `smoothing` is the user-facing 0..1 amount.
 */
export class Smoother {
  attack = 0;
  release = 0;

  configure(smoothing: number, dt: number): void {
    const s = Math.min(Math.max(smoothing, 0), 1);
    // Rises are near-instant so hits land on time; falls carry the smoothing.
    const attackTau = 0.004 + s * 0.02;
    const releaseTau = 0.02 + s * 0.22;
    this.attack = 1 - Math.exp(-dt / attackTau);
    this.release = 1 - Math.exp(-dt / releaseTau);
  }

  apply(previous: number, target: number): number {
    return previous + (target - previous) * (target > previous ? this.attack : this.release);
  }
}

/** Below this a level is treated as silence (dBFS). */
export const SILENCE_DB = -96;

/**
 * Maps a level in dB to 0..1 following the music, whatever the playback
 * volume. Two views are blended:
 * - absolute: position between the recent loudest (peak) and a slow floor,
 *   so loud sections look bigger than quiet ones;
 * - relative: distance from the running mean in units of the running
 *   deviation, so every hit and dip moves, even in a steady mix.
 */
export class DynamicRange {
  private peak = Number.NEGATIVE_INFINITY;
  private floor = 0;
  private mean = 0;
  private deviation = 0;

  constructor(
    /** Smallest peak–floor distance (dB), so steady signals don't flicker. */
    private readonly minRange = MIN_RANGE_DB,
    /** Weight of the relative view (0 = absolute only). */
    private readonly relativeWeight = RELATIVE_WEIGHT,
  ) {}

  /** `sensitivity` > 1 makes levels reach 1 sooner. */
  normalize(db: number, dt: number, sensitivity: number): number {
    if (db < SILENCE_DB) return 0;
    if (!Number.isFinite(this.peak)) {
      this.peak = db;
      this.floor = db - this.minRange;
      this.mean = db;
      this.deviation = MIN_DEVIATION_DB;
    }
    // Absolute: instant peak with a slow fall, floor eased towards the quiet parts.
    this.peak = Math.max(db, this.peak - PEAK_FALL * dt);
    this.floor += (db - this.floor) * (1 - Math.exp(-dt / (db < this.floor ? FLOOR_DOWN_TAU : FLOOR_UP_TAU)));
    this.floor = Math.min(this.floor, this.peak - this.minRange);
    const absolute = (db - this.floor) / ((this.peak - this.floor) / sensitivity);

    // Relative: running mean and mean absolute deviation.
    const k = 1 - Math.exp(-dt / RELATIVE_TAU);
    this.mean += (db - this.mean) * k;
    this.deviation += (Math.abs(db - this.mean) - this.deviation) * k;
    const relative = 0.5 + ((db - this.mean) * sensitivity) / (2.5 * Math.max(this.deviation, MIN_DEVIATION_DB));

    const v = absolute * (1 - this.relativeWeight) + relative * this.relativeWeight;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  reset(): void {
    this.peak = Number.NEGATIVE_INFINITY;
  }
}

const MIN_RANGE_DB = 18;
const RELATIVE_WEIGHT = 0.5;
/** dB per second the peak falls back after a loud passage. */
const PEAK_FALL = 3;
/** Floor time constants (s): it follows quiet parts fairly quickly, loud parts slowly. */
const FLOOR_DOWN_TAU = 1.5;
const FLOOR_UP_TAU = 6;
/** Time constant (s) of the running mean/deviation. */
const RELATIVE_TAU = 1.5;
/** Deviation floor (dB) so near-constant signals don't get amplified into noise. */
const MIN_DEVIATION_DB = 1.5;

/**
 * Slowly decaying peak follower in linear units (used to auto-scale the
 * waveform). `floor` keeps near-silence from being amplified into noise.
 */
export class PeakTracker {
  private peak: number;

  constructor(
    private readonly floor: number,
    /** Seconds for the peak to decay by ~63%. */
    private readonly decay = 4,
  ) {
    this.peak = floor;
  }

  get value(): number {
    return this.peak;
  }

  update(value: number, dt: number): void {
    this.peak = Math.max(value, this.floor, this.peak * Math.exp(-dt / this.decay));
  }

  reset(): void {
    this.peak = this.floor;
  }
}
