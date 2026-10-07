import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('the ring of a dial menu', () => {
  it('gives an odd full ring room for the two labels at its foot, and leaves every other ring as it was', async () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    const { ringRadius } = await import('./Dial');
    // Even rings and arcs never have two items side by side at the same height.
    for (const count of [2, 4, 8, 10, 12]) expect(ringRadius(count, undefined, 110)).toBe(110);
    for (const count of [2, 3, 5, 11]) expect(ringRadius(count, 'arc', 110)).toBe(110);
    // Small odd rings already have the room.
    for (const count of [1, 3, 5, 7]) expect(ringRadius(count, undefined, 110)).toBe(110);
    // Eleven scenes: the two at the foot are at least a label apart, and the ring never shrinks as it fills.
    const eleven = ringRadius(11, undefined, 110);
    expect(2 * eleven * Math.sin(Math.PI / 11)).toBeGreaterThanOrEqual(78 - 1e-9);
    expect(eleven).toBeGreaterThan(110); expect(eleven).toBeLessThan(150);
    expect(ringRadius(13, undefined, 110)).toBeGreaterThan(eleven);
  });
});
