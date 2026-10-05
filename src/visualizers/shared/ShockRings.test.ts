import { describe, expect, it } from 'vitest';
import { HitLog } from '../../dynamics/HitLog';
import { ShockRings } from './ShockRings';

/** Rings sampled at `fps` on hits every 0.5 s: [time, ages[0], heights[0]] once per 0.05 s of audio. */
function run(fps: number, seconds: number) {
  const hits = new HitLog();
  const rings = new ShockRings(4, 0.5, 0.15);
  const samples: number[][] = [];
  let nextHit = 0.25;
  let sample = 1;
  for (let t = 0; t <= seconds; t += 1 / fps) {
    // Predicted beats are logged ahead of time, like the CueScheduler does.
    while (nextHit < t + 0.3) {
      hits.record(nextHit, 0.9);
      nextHit += 0.5;
    }
    // Sample exactly on the sample grid (the frame lands wherever it does).
    while (sample * 0.05 <= t && sample * 0.05 <= seconds - 0.5) {
      rings.update(sample * 0.05, hits, 1);
      samples.push([sample * 0.05, rings.ages[0], rings.heights[0]]);
      sample++;
    }
    rings.update(t, hits, 1);
  }
  return samples;
}

describe('ShockRings', () => {
  it('starts a ring at the hit time, not when a frame sees it', () => {
    const hits = new HitLog();
    const rings = new ShockRings(4, 0.5, 0.15);
    hits.record(1, 1);
    rings.update(0.99, hits, 1);
    expect(rings.heights[0]).toBe(0);
    // First frame 25 ms after the hit: the ring is already 25 ms old.
    rings.update(1.025, hits, 1);
    expect(rings.ages[0]).toBeCloseTo(0.025, 9);
    expect(rings.heights[0]).toBeCloseTo(Math.exp(-0.025 * 2.5), 9);
  });

  it('gives the same rings at 30, 60 and 144 fps', () => {
    const a = run(30, 4);
    for (const fps of [60, 144]) {
      const b = run(fps, 4);
      expect(b.length).toBe(a.length);
      for (let i = 0; i < a.length; i++) for (let k = 0; k < 3; k++) expect(b[i][k]).toBeCloseTo(a[i][k], 9);
    }
  });

  it('skips weak hits and hits too close to the previous ring', () => {
    const hits = new HitLog();
    const rings = new ShockRings(4, 0.5, 0.15);
    hits.record(1, 0.9);
    hits.record(1.1, 0.9);
    hits.record(1.3, 0.3);
    rings.update(2, hits, 1);
    expect(rings.ages[0]).toBeCloseTo(1, 9);
    expect(rings.heights[1]).toBe(0);
    // A scene that takes transients more weakly sees fewer rings.
    rings.update(2, hits, 0.5);
    expect(rings.heights[0]).toBe(0);
  });

  it('orders hits logged out of order (a predicted beat before a late attack)', () => {
    const hits = new HitLog();
    const rings = new ShockRings(4, 0.5, 0.15);
    hits.record(2, 0.8);
    hits.record(1.5, 0.8);
    rings.update(2.1, hits, 1);
    expect(rings.ages[0]).toBeCloseTo(0.1, 9);
    expect(rings.ages[1]).toBeCloseTo(0.6, 9);
  });

  it('adds the release ring with its own height', () => {
    const hits = new HitLog();
    const rings = new ShockRings(4, 0.5, 0.15);
    rings.update(3, hits, 1, 2.9);
    expect(rings.heights[0]).toBeCloseTo(1.6 * Math.exp(-0.1 * 2.5), 9);
  });
});
