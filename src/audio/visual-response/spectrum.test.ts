import { describe, expect, it } from 'vitest';
import { MAX_FREQ, MIN_FREQ } from '../analysis/AudioAnalyzer';
import { hzToPosition, sampleSpectrum, sampleSpectrumRange } from './spectrum';

describe('spectrum helpers', () => {
  it('maps frequencies log-wise onto 0..1', () => {
    expect(hzToPosition(MIN_FREQ)).toBe(0);
    expect(hzToPosition(MAX_FREQ)).toBe(1);
    expect(hzToPosition(Math.sqrt(MIN_FREQ * MAX_FREQ))).toBeCloseTo(0.5, 6);
    expect(hzToPosition(5)).toBe(0);
    expect(hzToPosition(40000)).toBe(1);
  });

  it('interpolates between bin centres', () => {
    const s = new Float32Array([0, 1, 0, 0]);
    expect(sampleSpectrum(s, 1.5 / 4)).toBeCloseTo(1);
    expect(sampleSpectrum(s, 2 / 4)).toBeCloseTo(0.5);
    expect(sampleSpectrum(s, 0)).toBe(0);
    expect(sampleSpectrum(s, 1)).toBe(0);
  });

  it('averages a range with partial bins weighted by overlap', () => {
    const s = new Float32Array([1, 0, 0, 1]);
    expect(sampleSpectrumRange(s, 0, 0.25)).toBeCloseTo(1);
    expect(sampleSpectrumRange(s, 0, 0.5)).toBeCloseTo(0.5);
    expect(sampleSpectrumRange(s, 0.125, 0.375)).toBeCloseTo(0.5);
    expect(sampleSpectrumRange(s, 0, 1)).toBeCloseTo(0.5);
  });
});
