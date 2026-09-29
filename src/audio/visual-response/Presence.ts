import { SILENCE_DB } from '../analysis/Smoother';

/** Where the learned noise floor starts (dB, region power ≈ dBFS). */
const FLOOR_START = -70;
/** …never follows a fade's tail below this (the tail then counts as gone)… */
const FLOOR_MIN = -75;
/** …and never rises above this: anything louder is always sound (quiet music, not hiss). */
const FLOOR_MAX = -48;
/** The floor only learns levels this close above it (dB)… */
const FLOOR_TRACK = 24;
/** …that are also steady: within this of their own ~0.5 s average (hiss, hum, fans — not music). */
const FLOOR_STEADY = 3;
/** Floor learning speed (dB/s) upwards; downwards it follows at once. */
const FLOOR_RISE = 5;
const STEADY_TAU = 0.5;
/** Hysteresis above the floor (dB): sound appears above OPEN, is gone below CLOSE for longer than HOLD s. */
const OPEN = 8;
const CLOSE = 4;
const HOLD = 0.3;
/** Presence materializes fast and collapses slowly (s). */
const ATTACK = 0.025;
const RELEASE = 1.1;

/**
 * Whether sound is really there, independent of how loud it is: the level of
 * the mix compared with a learned noise floor (hiss, hum, a quiet room),
 * gated with hysteresis and followed with a fast attack and a slow release.
 * `value` is 0 in silence and over a steady noise floor, 1 while sound plays.
 * The floor persists across songs: it describes the input, not the music.
 * Frame-rate independent, allocation-free.
 */
export class Presence {
  value = 0;
  open = false;
  floor = FLOOR_START;
  private steady = SILENCE_DB;
  private closingFor = 0;

  /** `db`: raw level of the mix (region power sum), SILENCE_DB when digitally silent. */
  update(db: number, silent: boolean, dt: number): number {
    if (silent || db <= SILENCE_DB) {
      this.open = false;
      this.closingFor = 0;
      this.steady = SILENCE_DB;
    } else {
      this.steady = this.steady <= SILENCE_DB ? db : this.steady + (db - this.steady) * (1 - Math.exp(-dt / STEADY_TAU));
      if (db < this.floor) this.floor = Math.max(db, FLOOR_MIN);
      else if (db < this.floor + FLOOR_TRACK && Math.abs(db - this.steady) < FLOOR_STEADY) {
        this.floor = Math.min(this.floor + FLOOR_RISE * dt, db, FLOOR_MAX);
      }
      if (db > this.floor + OPEN) {
        this.open = true;
        this.closingFor = 0;
      } else if (this.open && db < this.floor + CLOSE) {
        this.closingFor += dt;
        if (this.closingFor > HOLD) this.open = false;
      } else {
        this.closingFor = 0;
      }
    }
    const target = this.open ? 1 : 0;
    const tau = target > this.value ? ATTACK : RELEASE;
    this.value += (target - this.value) * (1 - Math.exp(-dt / tau));
    return this.value;
  }

  /** Forgets the sound state; the learned floor is kept unless `floor` is true. */
  reset(floor = false): void {
    this.value = 0;
    this.open = false;
    this.closingFor = 0;
    this.steady = SILENCE_DB;
    if (floor) this.floor = FLOOR_START;
  }
}

/** Power sum of the three region levels (dB). */
export function mixDb(low: number, mid: number, high: number): number {
  if (low <= SILENCE_DB && mid <= SILENCE_DB && high <= SILENCE_DB) return SILENCE_DB;
  return 10 * Math.log10(10 ** (low / 10) + 10 ** (mid / 10) + 10 ** (high / 10));
}
