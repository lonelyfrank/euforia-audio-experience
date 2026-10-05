/** Hits remembered (scheduled predicted beats and recent attacks). */
const SIZE = 8;
/** Two hits closer than this (s) are the same hit. */
const SAME = 0.02;

/**
 * The timed hits of the rig (predicted beats and fast-path attacks), as
 * audio-clock timestamps: scenes that start something on a hit (a shock
 * ring, a burst) read its age as `now − time`, so it starts at the hit's
 * exact time and evolves the same at any frame rate. Predicted beats are
 * logged ahead of time; a hit whose time has not come yet is not started.
 * Pure data, allocation-free.
 */
export class HitLog {
  readonly times = new Float64Array(SIZE).fill(-Infinity);
  readonly strengths = new Float64Array(SIZE);
  /** Hits logged so far (the newest is at `(count − 1) % size`). */
  count = 0;

  get size(): number {
    return SIZE;
  }

  record(time: number, strength: number): void {
    for (let i = 0; i < SIZE; i++) {
      if (Math.abs(this.times[i] - time) < SAME) {
        this.strengths[i] = Math.max(this.strengths[i], strength);
        return;
      }
    }
    const slot = this.count++ % SIZE;
    this.times[slot] = time;
    this.strengths[slot] = strength;
  }

  clear(): void {
    this.times.fill(-Infinity);
    this.strengths.fill(0);
    this.count = 0;
  }
}
