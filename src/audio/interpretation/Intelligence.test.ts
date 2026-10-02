import { describe, expect, it } from 'vitest';
import { AudioAnalyzer, FFT_SIZE } from '../analysis/AudioAnalyzer';
import { measureSpectralShape } from '../analysis/SpectralFeatures';
import { SignalGenerator, type TestSignal } from '../capture/testSignals';
import { DynamicsMemory } from './DynamicsMemory';
import { MusicInterpreter } from './MusicInterpreter';

describe('physical spectral features', () => {
  it('measures a known power distribution, ignoring gain and silence', () => {
    const bins = new Float32Array(1024); bins[10] = 2; bins[30] = 2;
    const shape = { centroidHz: 0, spreadHz: 0, rolloffHz: 0 };
    measureSpectralShape(bins, 20, shape);
    expect(shape).toEqual({ centroidHz: 400, spreadHz: 200, rolloffHz: 600 });
    bins[10] = bins[30] = 0.02;
    measureSpectralShape(bins, 20, shape);
    expect(shape.centroidHz).toBeCloseTo(400, 6);
    measureSpectralShape(bins, 20, shape, true);
    expect(shape).toEqual({ centroidHz: 0, spreadHz: 0, rolloffHz: 0 });
  });
  it.each([60, 1000, 8000])('locates an actual %i Hz PCM tone before display equalization', (hz) => {
    const a = new AudioAnalyzer(); const pcm = new Float32Array(FFT_SIZE);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i * Math.PI * 2 * hz / 48000) * 0.2;
    const f = a.analyze(pcm, 48000, 1 / 60);
    expect(Math.abs(f.centroidHz - hz)).toBeLessThan(10);
    expect(f.spreadHz).toBeLessThan(35);
    expect(f.rms).toBeGreaterThan(0.12);
    expect(f.rms).toBeLessThan(0.16);
  });
  it('keeps quiet, sudden loud, impulse, noise and silence finite', () => {
    const a = new AudioAnalyzer(); const interpreter = new MusicInterpreter();
    const pcm = new Float32Array(FFT_SIZE);
    let seed = 17;
    for (const level of [0, 1e-7, 0.001, 0.8, 0]) {
      for (let i = 0; i < pcm.length; i++) { seed = (1664525 * seed + 1013904223) >>> 0; pcm[i] = (seed / 4294967296 * 2 - 1) * level; }
      const f = a.analyze(pcm, 48000, 1 / 60);
      const m = interpreter.update(f, 1 / 60);
      for (const [key, value] of Object.entries(m)) if (typeof value === 'number') expect(Number.isFinite(value), key).toBe(true);
      if (level === 0.8) { expect(f.centroidHz).toBeGreaterThan(6000); expect(f.spreadHz).toBeGreaterThan(3000); }
    }
    pcm.fill(0); pcm[1024] = 1;
    expect(a.analyze(pcm, 48000, 1 / 60).rolloffHz).toBeGreaterThan(12000);
  });
});

describe('musical dynamics and clock', () => {
  it('distinguishes attack, plateau and decay and decays the range memory', () => {
    const d = new DynamicsMemory(); const m = new MusicInterpreter().frame;
    d.update(0.2, 1 / 60, m);
    for (let i = 0; i < 6; i++) d.update(0.8, 1 / 60, m);
    expect(m.attack).toBeGreaterThan(0.8);
    expect(m.dynamicRange).toBe(1);
    for (let i = 0; i < 1200; i++) d.update(0.8, 1 / 60, m);
    expect(m.attack).toBeLessThan(0.01);
    expect(m.dynamicRange).toBeLessThan(0.25);
    for (let i = 0; i < 6; i++) d.update(0.2, 1 / 60, m);
    expect(m.decay).toBeGreaterThan(0.8);
  });
  it.each(['beat124', 'pad'] as TestSignal[])('keeps the interpreted phase continuous for %s', (signal) => {
    const analyzer = new AudioAnalyzer(); const interpreter = new MusicInterpreter();
    const generator = new SignalGenerator(signal, 48000); const pcm = new Float32Array(FFT_SIZE);
    let previous = 0;
    for (let i = 0; i < 900; i++) {
      pcm.copyWithin(0, 800); generator.fill(pcm, FFT_SIZE - 800, 800);
      const m = interpreter.update(analyzer.analyze(pcm, 48000, 1 / 60), 1 / 60);
      const delta = ((m.beatPhase - previous + 1.5) % 1) - 0.5;
      expect(Math.abs(delta)).toBeLessThan(0.08);
      previous = m.beatPhase;
    }
    if (signal === 'pad') expect(interpreter.frame.rhythmicConfidence).toBeLessThan(0.2);
    else expect(interpreter.frame.rhythmicConfidence).toBeGreaterThan(0.5);
  });
});
