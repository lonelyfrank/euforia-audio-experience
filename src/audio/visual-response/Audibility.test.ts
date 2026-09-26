import { describe, expect, it } from 'vitest';
import { AudioAnalyzer, FFT_SIZE } from '../analysis/AudioAnalyzer';
import { FADE_CUT, SignalGenerator, type TestSignal } from '../capture/testSignals';
import { VisualResponse } from './VisualResponse';

/** Runs a signal through the analysis at 60 fps; `each` sees the response every frame. */
function run(signal: TestSignal, seconds: number, each: (time: number, audible: number, low: number, high: number) => void): void {
  const generator = new SignalGenerator(signal, 48000);
  const analyzer = new AudioAnalyzer();
  const response = new VisualResponse();
  const window = new Float32Array(FFT_SIZE);
  for (let f = 0; f < seconds * 60; f++) {
    window.copyWithin(0, 800);
    generator.fill(window, FFT_SIZE - 800, 800);
    const r = response.update(analyzer.analyze(window, 48000, 1 / 60), 1 / 60);
    each((f + 1) / 60, r.audible, r.lowAudible, r.highAudible);
  }
}

describe('Audibility', { timeout: 30000 }, () => {
  it('follows a fade-out at its own speed, drops at once on a hard cut and comes back on the next attack', () => {
    const at = new Map<number, number>();
    const marks = [3.9, 5, 6, 7.5, 9.1, 10.9, FADE_CUT.cut + 0.3, FADE_CUT.cut + 0.9];
    run('fadeCut', 12, (time, audible) => {
      for (const mark of marks) if (Math.abs(time - mark) < 1 / 120) at.set(mark, audible);
    });
    // Full through the music, still mostly there early in the fade…
    expect(at.get(3.9)).toBeGreaterThan(0.95);
    expect(at.get(5)).toBeGreaterThan(0.8);
    // …then fading gradually with the sound.
    expect(at.get(6)!).toBeLessThan(at.get(5)!);
    expect(at.get(6)!).toBeGreaterThan(at.get(7.5)!);
    expect(at.get(7.5)).toBeLessThan(0.2);
    // Back at once when the music restarts.
    expect(at.get(9.1)).toBeGreaterThan(0.9);
    // A hard cut: gone within about a beat (percussive music holds through the gaps between hits).
    expect(at.get(10.9)).toBeGreaterThan(0.9);
    expect(at.get(FADE_CUT.cut + 0.9)).toBe(0);
  });

  it('does not flicker in the gaps between hits', () => {
    let lowestLow = 1;
    let lowestHigh = 1;
    run('bassPulse', 8, (time, _audible, low) => {
      if (time > 3) lowestLow = Math.min(lowestLow, low);
    });
    run('hats', 8, (time, _audible, _low, high) => {
      if (time > 4) lowestHigh = Math.min(lowestHigh, high);
    });
    expect(lowestLow).toBeGreaterThan(0.4);
    expect(lowestHigh).toBeGreaterThan(0.4);
  });

  it('keeps every part of an ordinary groove visible, hits and gaps alike', () => {
    let lowest = 1;
    let lowestLow = 1;
    let lowestHigh = 1;
    run('beat124', 10, (time, audible, low, high) => {
      if (time < 4) return;
      lowest = Math.min(lowest, audible);
      lowestLow = Math.min(lowestLow, low);
      lowestHigh = Math.min(lowestHigh, high);
    });
    expect(lowest).toBeGreaterThan(0.95);
    expect(lowestLow).toBeGreaterThan(0.8);
    expect(lowestHigh).toBeGreaterThan(0.5);
  });
});
