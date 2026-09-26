import { describe, expect, it } from 'vitest';
import { SignalGenerator, type TestSignal } from '../capture/testSignals';
import { VisualResponse } from '../visual-response/VisualResponse';
import { AudioAnalyzer, FFT_SIZE } from './AudioAnalyzer';

const SAMPLE_RATE = 48000;
const FPS = 60;

/**
 * Runs a test signal through the real analyzer and the visual response at
 * 60 fps; returns the per-role maxima over the last `measure` seconds.
 */
function analyze(signal: TestSignal, seconds = 4, measure = 2) {
  const generator = new SignalGenerator(signal, SAMPLE_RATE);
  const analyzer = new AudioAnalyzer();
  const response = new VisualResponse();
  const window = new Float32Array(FFT_SIZE);
  const perFrame = SAMPLE_RATE / FPS;
  const max = { weight: 0, flow: 0, detail: 0, shimmer: 0, impact: 0, bass: 0, treble: 0 };
  const frames = Math.round(seconds * FPS);
  for (let f = 0; f < frames; f++) {
    window.copyWithin(0, perFrame);
    generator.fill(window, FFT_SIZE - perFrame, perFrame);
    const audio = analyzer.analyze(window, SAMPLE_RATE, 1 / FPS);
    const r = response.update(audio, 1 / FPS);
    if (f < frames - measure * FPS) continue;
    max.weight = Math.max(max.weight, r.weight);
    max.flow = Math.max(max.flow, r.flow);
    max.detail = Math.max(max.detail, r.detail);
    max.shimmer = Math.max(max.shimmer, r.shimmer);
    max.impact = Math.max(max.impact, r.impact);
    max.bass = Math.max(max.bass, audio.bass);
    max.treble = Math.max(max.treble, audio.treble);
  }
  return max;
}

describe('analysis → visual response isolation', () => {
  it('a low tone moves weight, not the highs', () => {
    const r = analyze('low');
    expect(r.weight).toBeGreaterThan(0.3);
    expect(r.detail).toBeLessThan(0.1);
    expect(r.shimmer).toBeLessThan(0.05);
  });

  it('a mid tone moves flow, not weight or detail', () => {
    const r = analyze('mid');
    expect(r.flow).toBeGreaterThan(0.3);
    expect(r.weight).toBeLessThan(0.1);
    expect(r.detail).toBeLessThan(0.1);
  });

  it('a high tone moves detail, not weight', () => {
    const r = analyze('high');
    expect(r.detail).toBeGreaterThan(0.3);
    expect(r.weight).toBeLessThan(0.1);
    expect(r.flow).toBeLessThan(0.1);
  });

  it('hi-hat transients produce shimmer without weight or impact', () => {
    const r = analyze('hats');
    expect(r.shimmer).toBeGreaterThan(0.2);
    expect(r.weight).toBeLessThan(0.15);
    expect(r.impact).toBeLessThan(0.15);
  });

  it('a bass pulse produces weight and impact, not detail', () => {
    const r = analyze('bassPulse');
    expect(r.weight).toBeGreaterThan(0.4);
    expect(r.impact).toBeGreaterThan(0.4);
    expect(r.detail).toBeLessThan(0.1);
  });

  it('the full beat moves every role', () => {
    const r = analyze('beat124');
    for (const role of ['weight', 'flow', 'detail', 'shimmer', 'impact'] as const) expect(r[role]).toBeGreaterThan(0.3);
  });

  it('silence leaves everything at rest', () => {
    const r = analyze('silence');
    for (const value of Object.values(r)) expect(value).toBe(0);
  });
});
