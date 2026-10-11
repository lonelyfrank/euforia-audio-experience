import { describe, expect, it } from 'vitest';
import { barsPath, Trace, tracePoints, traceRange, wavePoints } from './charts';

const points = (text: string): number[][] => text.trim().split(' ').filter(Boolean).map(pair => pair.split(',').map(Number));

describe('cockpit chart geometry', () => {
  it('draws a ring oldest to newest, whatever its head', () => {
    const trace = new Trace();
    for (let i = 0; i < trace.values.length + 7; i++) trace.push(i);
    const drawn = points(tracePoints(trace.values, trace.head, 0, trace.values.length + 6, 100, 100));
    expect(drawn).toHaveLength(trace.values.length);
    // Left to right and rising: the wrap of the ring is not a jump back in the line.
    for (let i = 1; i < drawn.length; i++) { expect(drawn[i][0]).toBeGreaterThan(drawn[i - 1][0]); expect(drawn[i][1]).toBeLessThan(drawn[i - 1][1]); }
    expect(drawn.at(-1)).toEqual([100, 0]);
  });

  it('a trace that is still filling grows from the right and leaves no point for what is missing', () => {
    const trace = new Trace();
    trace.push(0.5); trace.push(1);
    const drawn = points(tracePoints(trace.values, trace.head, 0, 1, 100, 30));
    expect(drawn).toHaveLength(2);
    expect(drawn[1]).toEqual([100, 0]);
    expect(drawn[0][0]).toBeGreaterThan(90);
    trace.reset();
    expect(tracePoints(trace.values, trace.head, 0, 1)).toBe('');
  });

  it('clamps to the range instead of drawing outside the box', () => {
    expect(points(tracePoints([-3, 0.5, 9], 0, 0, 1, 100, 30)).map(p => p[1])).toEqual([30, 15, 0]);
    // A degenerate range does not divide by zero.
    expect(tracePoints([2, 2], 0, 2, 2)).not.toContain('NaN');
  });

  it('a steady value sits inside its own range, and an empty trace has one', () => {
    const [min, max] = traceRange([60, 60, NaN, 60], [0, 0]);
    expect(min).toBeLessThan(60); expect(max).toBeGreaterThan(60);
    expect(traceRange(new Trace().values, [5, 5])).toEqual([0, 1]);
  });

  it('bars stand on the baseline, one per bin, and a silent bin draws nothing', () => {
    const d = barsPath([0, 0.5, 2, NaN], 0);
    expect(d).toBe('M1.00 100V50.0H2.00V100ZM2.00 100V0.0H3.00V100Z');
    expect(barsPath(new Float32Array(128))).toBe('');
  });

  it('a waveform is centred on zero and clipped at full scale', () => {
    expect(points(wavePoints([0, 1, -1, 4], 90, 100))).toEqual([[0, 50], [30, 0], [60, 100], [90, 0]]);
  });
});
