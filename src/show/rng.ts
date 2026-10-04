/** Small deterministic PRNG (mulberry32): the same seed gives the same choices. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** 0 ≤ x < 1. */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An index drawn with the given weights (≥ 0); -1 if all are zero. */
  pick(weights: ArrayLike<number>): number {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += Math.max(0, weights[i]);
    if (total <= 0) return -1;
    let x = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      x -= Math.max(0, weights[i]);
      if (x < 0) return i;
    }
    return weights.length - 1;
  }
}

/** Mixes integers into a 32-bit seed (FNV-1a over their bytes). */
export function seedOf(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const v of values) {
    let x = Math.round(v) | 0;
    for (let i = 0; i < 4; i++) {
      h ^= x & 0xff;
      h = Math.imul(h, 0x01000193);
      x >>>= 8;
    }
  }
  return h >>> 0;
}
