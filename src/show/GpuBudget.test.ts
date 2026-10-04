import { describe, expect, it } from 'vitest';
import { GpuBudget } from './GpuBudget';

const run = (budget: GpuBudget, fps: number, seconds: number, level: 'low' | 'medium' | 'high' = 'low') => {
  for (let t = 0; t < seconds; t += 0.1) budget.update(fps, 0.1, level);
  return budget.units;
};

describe('GpuBudget', () => {
  it('earns fixtures while the frame rate holds, up to the quality limit', () => {
    const b = new GpuBudget();
    expect(run(b, 60, 9)).toBe(1);
    expect(run(b, 60, 2)).toBe(2);
    expect(run(b, 60, 30)).toBe(3);
    expect(run(new GpuBudget(), 60, 60, 'high')).toBe(1.6);
  });

  it('gives one back quickly when the frame rate drops, and does not oscillate', () => {
    const b = new GpuBudget();
    run(b, 60, 25);
    expect(b.units).toBe(3);
    expect(run(b, 40, 2.5)).toBe(2);
    // The frame rate recovers with fewer fixtures: no new one for a minute.
    expect(run(b, 60, 50)).toBe(2);
    expect(run(b, 60, 25)).toBe(3);
  });
});
