import { describe, expect, it } from 'vitest';
import { AudioAnalyzer, FFT_SIZE } from '../analysis/AudioAnalyzer';
import { SignalGenerator, type TestSignal } from '../capture/testSignals';
import { MusicalStateTracker } from './MusicalState';
import { MusicContext } from './MusicContext';
import { SectionTrend } from './SectionTrend';
import { VisualResponse } from './VisualResponse';
import type { VisualResponseFrame } from '../../types/audio';

function run(signal: TestSignal, seconds: number, each: (r: VisualResponseFrame, time: number) => void) {
  const analyzer = new AudioAnalyzer();
  const response = new VisualResponse();
  const generator = new SignalGenerator(signal, 48000);
  const window = new Float32Array(FFT_SIZE);
  for (let f = 0; f < seconds * 60; f++) {
    window.copyWithin(0, 800);
    generator.fill(window, FFT_SIZE - 800, 800);
    each(response.update(analyzer.analyze(window, 48000, 1 / 60), 1 / 60), (f + 1) / 60);
  }
}

describe('section trends', () => {
  it('distinguishes a crescendo from the same final level held steady', () => {
    const rising = new SectionTrend();
    const steady = new SectionTrend();
    let trend = 0;
    for (let i = 0; i < 720; i++) {
      trend = rising.update(0.2 + 0.5 * i / 720, 1 / 60);
      expect(steady.update(0.7, 1 / 60)).toBe(0);
    }
    expect(trend).toBeGreaterThan(0.4);
    for (let i = 0; i < 2400; i++) trend = rising.update(0.7, 1 / 60);
    expect(Math.abs(trend)).toBeLessThan(0.01);
    rising.reset();
    expect(rising.update(0.2, 1 / 60)).toBe(0);
  });

  it('is independent of frame rate and rejects beat-scale alternation', () => {
    const at = (fps: number) => {
      const trend = new SectionTrend();
      let last = 0;
      for (let i = 0; i < 12 * fps; i++) last = trend.update(i / (12 * fps), 1 / fps);
      return last;
    };
    expect(Math.abs(at(30) - at(120))).toBeLessThan(0.015);
    const trend = new SectionTrend();
    let largest = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const value = trend.update(0.5 + 0.15 * Math.sin(i / 60 * Math.PI * 4), 1 / 60);
      if (i > 1200) largest = Math.max(largest, Math.abs(value));
    }
    expect(largest).toBeLessThan(0.04);
  });
});

describe('stable state and section lifecycle', () => {
  it('holds a state across threshold chatter and publishes the previous committed state', () => {
    const states = new MusicalStateTracker();
    const music = new MusicContext().frame;
    music.tonality = 0.5;
    for (let i = 0; i < 180; i++) states.update(1, music, 1 / 60);
    expect(states.state).toBe('active');
    for (let i = 0; i < 1200; i++) {
      music.intensity = Math.floor(i / 12) % 2 ? 0.81 : 0.83;
      states.update(1, music, 1 / 60);
      expect(states.state).toBe('active');
    }
    music.intensity = 0.95;
    for (let i = 0; i < 120; i++) states.update(1, music, 1 / 60);
    expect(states.state).toBe('peak');
    expect(states.previousState).toBe('active');
    expect(states.time).toBeGreaterThan(1);
    expect(states.confidence).toBeGreaterThan(0.8);
    for (let i = 0; i < 30; i++) states.update(0, music, 1 / 60);
    expect(states.state).toBe('silent');
    expect(states.previousState).toBe('peak');
  });

  it('keeps a settled groove active even when its relative section intensity is low', () => {
    const states = new MusicalStateTracker();
    const music = new MusicContext().frame;
    music.intensity = 0.1;
    music.tonality = 0.9;
    music.lowPercussion = 0.5;
    for (let i = 0; i < 600; i++) states.update(1, music, 1 / 60);
    expect(states.state).toBe('active');
    music.lowPercussion = 0;
    for (let i = 0; i < 300; i++) states.update(1, music, 1 / 60);
    expect(states.state).toBe('calm');
  });

  it('does not call a gain-only rise of a sustained tone a build or drop', () => {
    const response = new VisualResponse();
    const audio = new AudioAnalyzer().frame;
    audio.silent = false;
    audio.lowDb = audio.midDb = audio.highDb = -25;
    audio.bass = audio.energy = 0.5;
    audio.spectrum[20] = 0.8;
    for (let i = 0; i < 20 * 60; i++) {
      audio.loudness = 0.3 + 0.4 * i / (20 * 60);
      const r = response.update(audio, 1 / 60);
      expect(r.music.build).toBe(0);
      expect(r.music.drop).toBe(0);
    }
    expect(response.frame.music.energyTrend).toBeGreaterThan(0.2);
  });

  it('decays event memory and percussion in silence; a source reset clears section evidence', () => {
    const context = new MusicContext();
    const response = new VisualResponse().frame;
    const audio = new AudioAnalyzer().frame;
    context.frame.drop = context.frame.build = context.frame.lowPercussion = 1;
    context.frame.intensity = 0.9;
    const beats = context.frame.beats;
    for (let i = 0; i < 600; i++) context.update(audio, response, 1 / 60, true);
    expect(context.frame.drop).toBeLessThan(0.001);
    expect(context.frame.build).toBeLessThan(0.001);
    expect(context.frame.lowPercussion).toBeLessThan(0.04);
    expect(context.frame.beats).toBe(beats);
    context.reset();
    expect(context.frame.recentPeak).toBe(0);
    expect(context.frame.recentDrop).toBe(0);
    expect(context.frame.energyTrend).toBe(0);
    expect(context.frame.lowPercussion).toBe(0);
  });
});

describe('deterministic PCM scenarios', { timeout: 60000 }, () => {
  it('learns hum as background, while a clearly audible steady tone remains present', () => {
    let hum = 1;
    let tone = 0;
    run('hum', 10, (r) => { hum = r.presence; });
    run('tone400', 10, (r) => { tone = r.presence; });
    expect(hum).toBeLessThan(0.05);
    expect(tone).toBeGreaterThan(0.95);
  });

  it('responds immediately to restart and settles after a hard cut', () => {
    run('startStop', 18, (r, t) => {
      if (t > 3 && t < 4) expect(r.presence).toBeLessThan(0.01);
      if (Math.abs(t - 4.15) < 0.001 || Math.abs(t - 16.15) < 0.001) expect(r.presence).toBeGreaterThan(0.95);
      if (t > 15 && t < 16) {
        expect(r.motion).toBeLessThan(0.08);
        expect(r.audible).toBe(0);
        expect(r.music.drop).toBeLessThan(0.01);
      }
    });
  });

  it('separates music from a learned hiss floor before and after the phrase', () => {
    run('noiseMusic', 28, (r, t) => {
      if (t > 7 && t < 8 || t > 27) expect(r.presence).toBeLessThan(0.1);
      if (t > 8.2 && t < 20) expect(r.presence).toBeGreaterThan(0.95);
      if (t > 27) expect(r.motion).toBeLessThan(0.02);
    });
  });

  it('exposes positive energy trend through a PCM crescendo, then approaches zero on the plateau', () => {
    let rising = 0;
    let plateau = 0;
    run('crescendo', 24, (r, t) => {
      if (t > 8 && t < 12) rising = Math.max(rising, r.music.energyTrend);
      if (t > 23) plateau = Math.max(plateau, Math.abs(r.music.energyTrend));
    });
    expect(rising).toBeGreaterThan(0.3);
    expect(plateau).toBeLessThan(rising * 0.4);
  });

  it('builds stable tension, lands one release per cycle and distinguishes breakdown from peak', () => {
    const drops: number[] = [];
    let early = 0;
    let late = 0;
    let falling = false;
    run('breakdown', 40, (r, t) => {
      if (r.music.drop === 1) drops.push(t);
      if (t > 23 && t < 24) early = Math.max(early, r.tension);
      if (t > 26 && t < 28) late = Math.max(late, r.tension);
      if (t > 14 && t < 20 && (r.state === 'falling' || r.state === 'calm')) falling = true;
    });
    expect(falling).toBe(true);
    expect(late).toBeGreaterThan(early + 0.1);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toBeGreaterThan(27.9);
    expect(drops[0]).toBeLessThan(29.5);
  });
});
