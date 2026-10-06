/** Flashes remembered (enough for any window the guard looks at). */
const SIZE = 16;
/** Flashes closer than this (s) are one flash (several fixtures on the same beat). */
const SAME = 0.02;

export interface FlashLimits {
  /** Shortest time (s) between two flashes. */
  gap: number;
  /** Strongest flash allowed. */
  max: number;
}

/**
 * Photosensitivity: no more than 3 flashes in any second (WCAG 2.3.1, the
 * general flash threshold), always.
 */
export const STANDARD_FLASHES: FlashLimits = { gap: 1 / 3, max: 1 };
/** "Reduce flashing": at most one flash a second, at half strength. */
export const REDUCED_FLASHES: FlashLimits = { gap: 1, max: 0.5 };
/**
 * A transient below this is a shimmer, not a flash (less than a 10%
 * brightness change): it is never counted, only capped.
 */
export const SUBTLE = 0.1;

/**
 * Rate limit on every light transient of the rig (the glow pulse that
 * drives the scenes' impacts, fixture strobes), checked on the audio
 * timestamps they are scheduled at, so the limit holds whatever the frame
 * rate or the order events arrive in (predicted beats come ahead, attacks
 * late). Flashes at least `gap` apart pass; one too close to an admitted
 * flash is turned into a shimmer. Several fixtures flashing on the same beat
 * are one flash. Pure logic, allocation-free.
 */
export class FlashGuard {
  private readonly times = new Float64Array(SIZE).fill(-Infinity);
  private next = 0;
  /** Flashes turned into shimmers so far (diagnostics). */
  limited = 0;

  constructor(public limits: FlashLimits = STANDARD_FLASHES) {}

  /** The amount a transient at `time` may have. */
  admit(time: number, amount: number): number {
    const max = this.limits.max;
    if (amount < SUBTLE) return Math.min(amount, max);
    let clash = false;
    for (let i = 0; i < SIZE; i++) {
      const d = Math.abs(time - this.times[i]);
      if (d < SAME) return Math.min(amount, max);
      if (d < this.limits.gap) clash = true;
    }
    if (clash) {
      this.limited++;
      return Math.min(amount, SUBTLE * 0.9);
    }
    this.times[this.next] = time;
    this.next = (this.next + 1) % SIZE;
    return Math.min(amount, max);
  }

  reset(): void {
    this.times.fill(-Infinity);
    this.next = 0;
  }
}
