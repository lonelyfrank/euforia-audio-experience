import { describe, expect, it } from 'vitest';
import { AudioAnalyzer, FFT_SIZE } from '../analysis/AudioAnalyzer';
import { PHRASE_SECONDS, SignalGenerator, type TestSignal } from '../capture/testSignals';
import type { MusicalState, VisualResponseFrame } from '../../types/audio';
import { VisualResponse } from './VisualResponse';

/** Runs a signal through the analysis and the response at 60 fps; `each` sees the response every frame. */
function run(signal: TestSignal, seconds: number, each: (time: number, r: VisualResponseFrame) => void = () => undefined): VisualResponseFrame {
  const generator = new SignalGenerator(signal, 48000);
  const analyzer = new AudioAnalyzer();
  const response = new VisualResponse();
  const window = new Float32Array(FFT_SIZE);
  for (let f = 0; f < seconds * 60; f++) {
    window.copyWithin(0, 800);
    generator.fill(window, FFT_SIZE - 800, 800);
    each((f + 1) / 60, response.update(analyzer.analyze(window, 48000, 1 / 60), 1 / 60));
  }
  return response.frame;
}

/** Maxima of some roles over the last `measure` seconds of `seconds`. */
function peaks(signal: TestSignal, seconds = 6, measure = 3) {
  const max = { weight: 0, flow: 0, detail: 0, impact: 0, trace: 0, motion: 0, openness: 0 };
  run(signal, seconds, (time, r) => {
    if (time <= seconds - measure) return;
    for (const key of Object.keys(max) as (keyof typeof max)[]) max[key] = Math.max(max[key], r[key]);
  });
  return max;
}

describe('presence', { timeout: 30000 }, () => {
  it('treats a steady noise floor as silence once it is learned', () => {
    const r = run('hiss', 8);
    expect(r.presence).toBeLessThan(0.05);
    expect(r.audible).toBeLessThan(0.05);
    for (const role of ['weight', 'flow', 'detail', 'impact', 'density', 'motion'] as const) expect(r[role]).toBeLessThan(0.02);
    expect(r.state).toBe('silent');
  });

  it('materializes at once with the sound and collapses slowly in the gaps between phrases', () => {
    const at = new Map<number, number>();
    const start = PHRASE_SECONDS * 4; // third phrase: the floor is learned by now
    const marks = [start + 0.1, start + 2, start + PHRASE_SECONDS + 0.5, start + PHRASE_SECONDS + 3.5];
    run('phrases', start + PHRASE_SECONDS * 2, (time, r) => {
      for (const mark of marks) if (Math.abs(time - mark) < 1 / 120) at.set(mark, r.presence);
    });
    expect(at.get(marks[0])).toBeGreaterThan(0.9);
    expect(at.get(marks[1])).toBeCloseTo(1, 3);
    // Hiss alone: still fading half a second in, gone after a few seconds.
    expect(at.get(marks[2])).toBeGreaterThan(0.4);
    expect(at.get(marks[2])).toBeLessThan(0.95);
    expect(at.get(marks[3])).toBeLessThan(0.1);
  });

  it('keeps sound that is quiet but not steady (a fading beat) present', () => {
    let min = 1;
    run('fadeCut', 5, (time, r) => {
      if (time > 1) min = Math.min(min, r.presence);
    });
    expect(min).toBeCloseTo(1, 3);
  });
});

describe('sonic grammar on test tones', { timeout: 30000 }, () => {
  it('low tones give mass, not detail or impact', () => {
    for (const signal of ['tone50', 'tone120'] as const) {
      const r = peaks(signal);
      expect(r.weight).toBeGreaterThan(0.3);
      expect(r.detail).toBeLessThan(0.05);
      expect(r.impact).toBeLessThan(0.05);
    }
  });

  it('a 400 Hz tone gives body, a 4 kHz tone detail, neither mass', () => {
    const mid = peaks('tone400');
    expect(mid.flow).toBeGreaterThan(0.15);
    expect(mid.weight).toBeLessThan(0.05);
    const high = peaks('tone4k');
    expect(high.detail).toBeGreaterThan(0.3);
    expect(high.weight).toBeLessThan(0.05);
  });

  it('a sustained bass is steady mass; a pulsing bass also makes impacts that leave a trace', () => {
    const steady = peaks('tone50');
    const pulse = peaks('bassPulse');
    expect(steady.impact).toBeLessThan(0.05);
    expect(steady.trace).toBeLessThan(0.05);
    expect(steady.motion).toBeLessThan(0.1);
    expect(pulse.impact).toBeGreaterThan(0.5);
    expect(pulse.trace).toBeGreaterThan(0.5);
    expect(pulse.motion).toBeGreaterThan(0.3);
  });

  it('openness grows with how much of the spectrum is covered', () => {
    const tone = peaks('tone400').openness;
    const beat = peaks('beat124').openness;
    const full = peaks('synthPop').openness;
    expect(tone).toBeLessThan(beat);
    expect(beat).toBeLessThan(full);
    expect(full).toBeGreaterThan(0.7);
  });
});

describe('musical state', { timeout: 60000 }, () => {
  it('follows ambient → build → drop without flickering', () => {
    const seen = new Set<MusicalState>();
    let changes = 0;
    let last: MusicalState = 'silent';
    run('buildDrop', 64, (time, r) => {
      if (time < 34) return; // the second cycle: the song's references are settled
      seen.add(r.state);
      if (r.state !== last) changes++;
      last = r.state;
    });
    for (const state of ['calm', 'rising', 'peak'] as const) expect(seen).toContain(state);
    // One 32 s cycle: a handful of section changes, not a nervous stream.
    expect(changes).toBeLessThanOrEqual(6);
  });

  it('is silent in silence', () => {
    expect(run('silence', 2).state).toBe('silent');
  });
});
