import { describe, expect, it } from 'vitest';
import { LoopbackMeter } from './LoopbackMeter';

describe('LoopbackMeter', () => {
  it('measures the median delay of detected clicks and ignores other attacks', () => {
    const meter = new LoopbackMeter();
    for (let i = 0; i < 20; i++) {
      meter.emit(i * 0.5);
      // Detected 23 ms late, ±2 ms, plus an unrelated attack in between.
      meter.detect(i * 0.5 + 0.023 + ((i % 3) - 1) * 0.002);
      meter.detect(i * 0.5 + 0.25);
    }
    expect(meter.count).toBe(20);
    expect(meter.median).toBeCloseTo(0.023, 4);
    expect(meter.spread).toBeLessThanOrEqual(0.002 + 1e-9);
  });

  it('reports nothing before a match', () => {
    const meter = new LoopbackMeter();
    meter.detect(3);
    expect(meter.count).toBe(0);
    expect(meter.median).toBe(0);
  });
});
