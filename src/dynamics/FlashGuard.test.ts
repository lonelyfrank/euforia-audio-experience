import { describe, expect, it } from 'vitest';
import { FlashGuard, REDUCED_FLASHES, SUBTLE } from './FlashGuard';

/** Most flashes (≥ SUBTLE) in any one-second window, sliding in 1 ms steps. */
function maxPerSecond(flashes: [number, number][]): number {
  const times = flashes.filter(([, a]) => a >= SUBTLE).map(([t]) => t);
  // Same-time flashes (several fixtures) count once.
  const distinct = times.sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - all[i - 1] >= 0.02);
  let most = 0;
  for (let start = 0; start < 10; start += 0.001) most = Math.max(most, distinct.filter((t) => t >= start && t < start + 1).length);
  return most;
}

describe('FlashGuard', () => {
  it('lets beats at dance tempos through', () => {
    const guard = new FlashGuard();
    for (let t = 0; t < 8; t += 60 / 174) expect(guard.admit(t, 0.9)).toBe(0.9);
    expect(guard.limited).toBe(0);
  });

  it('never allows more than three flashes a second, however they arrive', () => {
    const guard = new FlashGuard();
    const out: [number, number][] = [];
    // 16ths at 174 BPM (11.6 Hz): predicted beats scheduled ahead, attacks reported late, out of order.
    const events: number[] = [];
    for (let t = 0; t < 8; t += 60 / 174 / 4) events.push(t);
    for (let i = 0; i < events.length; i += 2) {
      if (events[i + 1] !== undefined) out.push([events[i + 1], guard.admit(events[i + 1], 1)]);
      out.push([events[i], guard.admit(events[i], 1)]);
    }
    expect(maxPerSecond(out)).toBeLessThanOrEqual(3);
    expect(guard.limited).toBeGreaterThan(0);
    // Limited flashes become shimmers, not silence.
    for (const [, a] of out) expect(a === 1 || (a > 0 && a < SUBTLE)).toBe(true);
  });

  it('counts several fixtures on the same beat as one flash', () => {
    const guard = new FlashGuard();
    expect(guard.admit(1, 0.8)).toBe(0.8);
    expect(guard.admit(1.005, 0.6)).toBe(0.6);
    expect(guard.admit(1.2, 0.8)).toBeLessThan(SUBTLE);
  });

  it('reduced flashing: one a second at half strength', () => {
    const guard = new FlashGuard(REDUCED_FLASHES);
    const out: [number, number][] = [];
    for (let t = 0; t < 8; t += 60 / 128) out.push([t, guard.admit(t, 1)]);
    expect(maxPerSecond(out)).toBeLessThanOrEqual(1);
    for (const [, a] of out) expect(a).toBeLessThanOrEqual(0.5);
  });
});
