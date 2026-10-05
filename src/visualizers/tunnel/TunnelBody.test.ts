import { describe, expect, it } from 'vitest';
import { HitLog } from '../../dynamics/HitLog';
import { DampedOscillator, Momentum } from '../../physics/primitives';
import { TunnelBody, type TunnelForces } from './TunnelBody';

/** 7 s: the sound opens at 2 s (radius 0.9 → 1.3), hits at 1, 3.25 and 4.5 s, motion from 0.5 s, silence from 5 s. */
const opening = (t: number) => (t < 2 ? 0.9 : 1.3);
const speed = (t: number) => (t >= 0.5 && t < 5 ? 1.5 : 0);
const HITS = [1, 3.25, 4.5];

function run(fps: number) {
  const body = new TunnelBody(), hits = new HitLog();
  const f: TunnelForces = { rest: 1, expand: 0, speed: 0, pace: 0, surge: 0.5, roll: 0 };
  const frames: { t: number; physical: number; direct: number; travel: number; velocity: number }[] = [];
  for (let k = 0; k <= 7 * fps; k++) {
    const t = k / fps;
    for (const h of HITS) if (h <= t && h > t - 1 / fps) hits.record(h, 1);
    f.rest = opening(t); f.speed = speed(t);
    body.advance(t, f, hits, 1);
    frames.push({ t, physical: body.wall.x, direct: opening(t), travel: body.travel.position, velocity: body.travel.velocity });
  }
  return frames;
}
const at = (frames: ReturnType<typeof run>, t: number) => frames.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));

describe('tunnel: direct mapping vs physical response', () => {
  const f60 = run(60);

  it('moves continuously where the direct mapping teleports', () => {
    let directJump = 0, physicalJump = 0;
    for (let i = 1; i < f60.length; i++) {
      directJump = Math.max(directJump, Math.abs(f60[i].direct - f60[i - 1].direct));
      // Excluding hit kicks: the opening step alone.
      if (f60[i].t > 1.9 && f60[i].t < 3) physicalJump = Math.max(physicalJump, Math.abs(f60[i].physical - f60[i - 1].physical));
    }
    expect(directJump).toBeCloseTo(0.4, 9);
    expect(physicalJump).toBeLessThan(0.1 * directJump);
    // It still arrives: within 2% of the new opening a second later, after one soft overshoot.
    expect(Math.abs(at(f60, 3.2).physical - 1.3)).toBeLessThan(0.02 * 1.3);
    const overshoot = Math.max(...f60.filter((x) => x.t > 2 && x.t < 3.2).map((x) => x.physical)) - 1.3;
    expect(overshoot).toBeGreaterThan(0.01);
    expect(overshoot).toBeLessThan(0.1);
  });

  it('breathes on hits at their audio time and settles back, where the direct mapping does not respond', () => {
    const before = at(f60, 3.24).physical;
    const peak = Math.max(...f60.filter((x) => x.t > 3.25 && x.t < 3.8).map((x) => x.physical));
    expect(peak - before).toBeGreaterThan(0.05);
    expect(Math.abs(at(f60, 4.45).physical - 1.3)).toBeLessThan(0.01);
    expect(at(f60, 3.5).direct).toBe(at(f60, 3.2).direct);
  });

  it('keeps momentum, then is static in silence', () => {
    // Travel reaches the asked speed, and falls below 1% of it within 2 s of silence (no drift without audio).
    expect(at(f60, 3.2).velocity).toBeCloseTo(1.5, 2);
    // A hit's surge is still dissipating 0.75 s later.
    expect(at(f60, 4).velocity).toBeGreaterThan(1.55);
    expect(Math.abs(at(f60, 7).velocity)).toBeLessThan(0.01 * 1.5);
    const settled = at(f60, 7).travel;
    // Over the last half second it moves less than 2% of what it covered at cruise speed.
    expect(settled - at(f60, 6.5).travel).toBeLessThan(0.02 * 1.5 * 0.5);
  });

  it('gives the same trajectory at 30, 60 and 144 fps', () => {
    const f30 = run(30), f144 = run(144);
    for (const t of [1.5, 2.5, 3.5, 4.75, 6]) {
      for (const other of [f30, f144]) {
        expect(Math.abs(at(other, t).physical - at(f60, t).physical)).toBeLessThan(0.02);
        expect(Math.abs(at(other, t).travel - at(f60, t).travel)).toBeLessThan(0.03);
      }
    }
  });

  it('applies a hit logged late instead of losing it, and restarts after a clock jump', () => {
    const body = new TunnelBody(), hits = new HitLog();
    const f: TunnelForces = { rest: 1, expand: 0, speed: 0, pace: 0, surge: 0, roll: 0 };
    body.advance(0, f, hits, 1);
    body.advance(1, f, hits, 1);
    hits.record(0.99, 1);
    body.advance(1.02, f, hits, 1);
    expect(body.wall.v).toBeGreaterThan(0.4);
    body.advance(10, f, hits, 1);
    expect(body.wall.v).toBe(0);
  });
});

describe('physical primitives', () => {
  it('are exact for constant forces whatever the step', () => {
    const a = new DampedOscillator(5, 0.3), b = new DampedOscillator(5, 0.3);
    a.impulse(1); b.impulse(1);
    for (let i = 0; i < 100; i++) a.step(0.01, 0, 2);
    for (let i = 0; i < 7; i++) b.step(1 / 7, 0, 2);
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(a.v).toBeCloseTo(b.v, 9);
    const m = new Momentum(2), n = new Momentum(2);
    for (let i = 0; i < 144; i++) m.step(1 / 144, 3);
    n.step(0.5, 3); n.step(0.5, 3);
    expect(m.position).toBeCloseTo(n.position, 9);
    expect(m.velocity).toBeCloseTo(1.5 * (1 - Math.exp(-2)), 9);
  });
});
