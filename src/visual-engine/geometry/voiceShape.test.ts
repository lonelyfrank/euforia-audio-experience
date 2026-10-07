import { describe, expect, it } from 'vitest';
import { createCycleShape, describeCycle } from './voiceShape';

const N = 128;
const cycle = (f: (phase: number) => number): Float32Array => Float32Array.from({ length: N }, (_, i) => f(i / N));
const sine = cycle((p) => Math.sin(2 * Math.PI * p));
const saw = cycle((p) => 2 * p - 1);
const square = cycle((p) => (p < 0.5 ? 1 : -1));
/** What the voice tracker's averaging leaves of an edge: the same shape, its jumps spread over a few samples. */
const smoothed = (source: Float32Array, width = 3): Float32Array => Float32Array.from(source, (_, i) => {
  let sum = 0;
  for (let k = -width; k <= width; k++) sum += source[(i + k + N) % N];
  return sum / (2 * width + 1);
});
const describe_ = (c: ArrayLike<number>) => ({ ...describeCycle(c, createCycleShape()) });

describe('the shape of a voice cycle', () => {
  it('puts a sine, a sawtooth and a square in different corners, without naming them', () => {
    const a = describe_(sine), b = describe_(saw), c = describe_(square);
    // A sine has no edge, no plateau, no lean, no ripple.
    expect(a.edge).toBe(0); expect(a.step).toBe(0); expect(a.skew).toBe(0); expect(a.ripple).toBeLessThan(0.01);
    // A sawtooth: a full edge, always moving, leaning one way.
    expect(b.edge).toBe(1); expect(b.step).toBe(0); expect(b.skew).toBeGreaterThan(0.9); expect(b.ripple).toBeLessThan(0.01);
    // A square: full edges both ways, flat in between, balanced.
    expect(c.edge).toBe(1); expect(c.step).toBeGreaterThan(0.9); expect(Math.abs(c.skew)).toBeLessThan(0.01); expect(c.ripple).toBeLessThan(0.01);
  });

  it('is continuous between the corners: a shape between a sine and a saw is in between', () => {
    let previous = -1;
    for (let mix = 0; mix <= 1.001; mix += 0.125) {
      const edge = describe_(cycle((p) => (1 - mix) * Math.sin(2 * Math.PI * p) + mix * (2 * ((p + 0.5) % 1) - 1))).edge;
      expect(edge).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = edge;
    }
    expect(previous).toBe(1);
  });

  it('still reads the edges of an averaged cycle, and which way a ramp falls', () => {
    const b = describe_(smoothed(saw)), c = describe_(smoothed(square));
    expect(b.edge).toBeGreaterThan(0.6); expect(b.skew).toBeGreaterThan(0.5);
    expect(c.edge).toBeGreaterThan(0.6); expect(c.step).toBeGreaterThan(0.5);
    // A bass sawtooth as the analysis really delivers it (band-limited: a spike that decays), sampled every fourth value.
    const heard = [0.17, 0.22, 0.26, 0.29, 0.3, 0.31, 0.3, 0.29, 0.28, 0.26, 0.23, 0.21, 0.18, 0.15, 0.12, 0.1, 0.07, 0.04, 0.02, 0, -0.02, -0.04, -0.09, -0.54, -0.98, -0.9, -0.62, -0.39, -0.23, -0.1, 0.01, 0.1];
    const real = describe_(Float32Array.from({ length: N }, (_, i) => heard[i >> 2] + (heard[((i >> 2) + 1) % 32] - heard[i >> 2]) * (i % 4) / 4));
    expect(real.edge).toBeGreaterThan(0.6); expect(real.skew).toBeGreaterThan(0.2); expect(real.step).toBeLessThan(0.35);
    // The mirrored ramp leans the other way.
    expect(describe_(cycle((p) => 1 - 2 * p)).skew).toBeLessThan(-0.9);
  });

  it('reads a busy, irregular cycle as ripple', () => {
    let seed = 1;
    const noise = cycle(() => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1);
    expect(describe_(noise).ripple).toBe(1);
    const wobbly = cycle((p) => Math.sin(2 * Math.PI * p) + 0.3 * Math.sin(2 * Math.PI * 9 * p));
    expect(describe_(wobbly).ripple).toBeGreaterThan(0.1);
    expect(describe_(wobbly).ripple).toBeLessThan(describe_(noise).ripple);
  });

  it('does not depend on level or offset, and gives nothing for a flat, short or corrupt cycle', () => {
    const quiet = describe_(saw.map((v) => 0.2 * v + 0.3));
    expect(quiet.edge).toBeCloseTo(1, 6); expect(quiet.skew).toBeCloseTo(describe_(saw).skew, 5);
    for (const empty of [new Float32Array(N), new Float32Array(N).fill(0.7), new Float32Array(4), new Float32Array(N).fill(NaN)]) {
      expect(describe_(empty)).toEqual({ edge: 0, step: 0, skew: 0, ripple: 0 });
    }
    const damaged = Float32Array.from(saw); damaged[10] = NaN; damaged[70] = Infinity;
    for (const value of Object.values(describe_(damaged))) expect(Number.isFinite(value)).toBe(true);
  });
});
