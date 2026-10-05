import type { HitLog } from '../../dynamics/HitLog';

/** Decay rate of a ring's height (1/s). */
const FADE = 2.5;

/**
 * Rings sent out by hits, computed from timestamps: each ring's age is
 * `now − hit time`, so it starts at the hit's exact audio time and looks the
 * same at any frame rate (no per-frame edge detection, no accumulated age).
 * The newest `count` qualifying hits are the live rings; a release (drop)
 * adds a big one. Pure logic, allocation-free.
 */
export class ShockRings {
  /** Per ring: age (s) and current height. */
  readonly ages: Float64Array;
  readonly heights: Float64Array;
  private readonly picked: Float64Array;
  private readonly pickedStrength: Float64Array;

  constructor(
    readonly count: number,
    /** A hit sends a ring when its strength × scale reaches this. */
    private readonly threshold: number,
    /** Hits closer than this (s) to the previous ring send none. */
    private readonly minInterval: number,
  ) {
    this.ages = new Float64Array(count).fill(1e3);
    this.heights = new Float64Array(count);
    this.picked = new Float64Array(16);
    this.pickedStrength = new Float64Array(16);
  }

  /**
   * `scale`: how much this scene takes transients. `release`: audio time of
   * a drop's release ring (or -Infinity), with its fixed height.
   */
  update(now: number, hits: HitLog, scale: number, release = -Infinity, releaseHeight = 1.6): void {
    // Candidates: hits that have happened and are strong enough, in time order.
    let n = 0;
    for (let i = 0; i < hits.size; i++) {
      const t = hits.times[i];
      const s = hits.strengths[i] * scale;
      if (t > now || s < this.threshold) continue;
      n = this.insert(n, t, s);
    }
    if (release <= now) n = this.insert(n, release, -releaseHeight);
    // Spacing: a hit too close after the previous ring is part of it (the release always counts).
    let kept = 0;
    let last = -Infinity;
    for (let i = 0; i < n; i++) {
      const t = this.picked[i];
      if (this.pickedStrength[i] > 0 && t - last < this.minInterval) continue;
      this.picked[kept] = t;
      this.pickedStrength[kept++] = this.pickedStrength[i];
      last = t;
    }
    // The newest rings are the live ones.
    for (let r = 0; r < this.count; r++) {
      const i = kept - 1 - r;
      if (i < 0) {
        this.ages[r] = 1e3;
        this.heights[r] = 0;
        continue;
      }
      const age = now - this.picked[i];
      this.ages[r] = age;
      this.heights[r] = Math.abs(this.pickedStrength[i]) * Math.exp(-age * FADE);
    }
  }

  /** Inserts in time order; a release is stored with a negative strength. */
  private insert(n: number, time: number, strength: number): number {
    if (n >= this.picked.length) return n;
    let i = n;
    while (i > 0 && this.picked[i - 1] > time) {
      this.picked[i] = this.picked[i - 1];
      this.pickedStrength[i] = this.pickedStrength[i - 1];
      i--;
    }
    this.picked[i] = time;
    this.pickedStrength[i] = strength;
    return n + 1;
  }
}
