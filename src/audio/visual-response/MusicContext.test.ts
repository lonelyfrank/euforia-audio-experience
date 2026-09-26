import { describe, expect, it } from 'vitest';
import { AudioAnalyzer, FFT_SIZE } from '../analysis/AudioAnalyzer';
import { SignalGenerator, type TestSignal } from '../capture/testSignals';
import type { AudioFrame, MusicContextFrame } from '../../types/audio';
import { VisualResponse } from './VisualResponse';

const SAMPLE_RATE = 48000;

/** Feeds test signals through the real analyzer and visual response; `each` sees every frame. */
class Rig {
  readonly analyzer = new AudioAnalyzer();
  readonly response = new VisualResponse();
  private readonly window = new Float32Array(FFT_SIZE);
  private generator: SignalGenerator;

  constructor(
    signal: TestSignal,
    private readonly fps = 60,
  ) {
    this.generator = new SignalGenerator(signal, SAMPLE_RATE);
  }

  play(signal: TestSignal): void {
    this.generator = new SignalGenerator(signal, SAMPLE_RATE);
  }

  run(seconds: number, each?: (music: MusicContextFrame, audio: AudioFrame, time: number) => void): MusicContextFrame {
    const perFrame = Math.round(SAMPLE_RATE / this.fps);
    const frames = Math.round(seconds * this.fps);
    for (let f = 0; f < frames; f++) {
      this.window.copyWithin(0, perFrame);
      this.generator.fill(this.window, FFT_SIZE - perFrame, perFrame);
      const audio = this.analyzer.analyze(this.window, SAMPLE_RATE, 1 / this.fps);
      const music = this.response.update(audio, 1 / this.fps).music;
      each?.(music, audio, audio.time);
    }
    return this.response.frame.music;
  }
}

describe('MusicContext', () => {
  it('follows the tempo: slow songs move slower than fast ones', () => {
    const slow = new Rig('beat90').run(16);
    const fast = new Rig('beat174').run(16);
    expect(slow.tempoLock).toBeGreaterThan(0.9);
    expect(fast.tempoLock).toBeGreaterThan(0.9);
    expect(Math.abs(slow.tempo - 90) / 90).toBeLessThan(0.04);
    expect(Math.abs(fast.tempo - 174) / 174).toBeLessThan(0.04);
    expect(fast.pace).toBeGreaterThan(slow.pace * 1.6);
  });

  it('does not lock to a beatless texture', () => {
    let maxLock = 0;
    new Rig('pad').run(20, (m) => (maxLock = Math.max(maxLock, m.tempoLock)));
    expect(maxLock).toBeLessThan(0.2);
  });

  it('keeps the beat clock monotonic and aligned to the detected beats', () => {
    let previous = -1;
    let backwards = 0;
    let error = 0;
    let samples = 0;
    new Rig('beat124').run(20, (m, audio, time) => {
      if (m.beats < previous) backwards++;
      previous = m.beats;
      if (time > 12 && audio.bpm > 0) {
        let e = Math.abs(audio.beatPhase - (m.beats - Math.floor(m.beats)));
        if (e > 0.5) e = 1 - e;
        error += e;
        samples++;
      }
    });
    expect(backwards).toBe(0);
    expect(error / samples).toBeLessThan(0.05);
  });

  it('is frame-rate independent', () => {
    const at30 = new Rig('beat124', 30).run(16);
    const at120 = new Rig('beat124', 120).run(16);
    expect(Math.abs(at30.tempo - at120.tempo)).toBeLessThan(3);
    expect(Math.abs(at30.intensity - at120.intensity)).toBeLessThan(0.1);
  });

  it('tells which regions are percussive', () => {
    const hats = new Rig('hats').run(10);
    expect(hats.highPercussion).toBeGreaterThan(0.6);
    expect(hats.lowPercussion).toBeLessThan(0.2);
    const pad = new Rig('pad').run(10);
    expect(Math.max(pad.lowPercussion, pad.midPercussion, pad.highPercussion)).toBeLessThan(0.1);
    expect(pad.tonality).toBeGreaterThan(0.8);
    expect(hats.tonality).toBeLessThan(0.7);
  });

  it('detects a build-up and the drop that follows, and nothing in a steady groove', () => {
    const drops: number[] = [];
    let buildInBuild = 0;
    new Rig('buildDrop').run(66, (m, _audio, time) => {
      if (m.drop === 1) drops.push(time);
      // Second cycle: build between 42 and 50 s.
      if (time > 42 && time < 50) buildInBuild = Math.max(buildInBuild, m.build);
    });
    expect(buildInBuild).toBeGreaterThan(0.4);
    expect(drops.some((t) => t > 49.5 && t < 51.5)).toBe(true);
    expect(drops.every((t) => (t > 17 && t < 20) || (t > 49.5 && t < 51.5))).toBe(true);

    let steadyDrops = 0;
    let steadyBuild = 0;
    new Rig('beat124').run(40, (m) => {
      if (m.drop === 1) steadyDrops++;
      steadyBuild = Math.max(steadyBuild, m.build);
    });
    expect(steadyDrops).toBe(0);
    expect(steadyBuild).toBeLessThan(0.2);
  });

  it('gives the same song the same variation, different songs different ones', () => {
    const a = new Rig('beat124').run(16).variation.slice();
    const b = new Rig('beat124').run(16).variation.slice();
    const pad = new Rig('pad').run(16).variation.slice();
    const hats = new Rig('hats').run(16).variation.slice();
    const distance = (x: Float32Array, y: Float32Array) => x.reduce((sum, v, i) => sum + Math.abs(v - y[i]), 0);
    expect(distance(a, b)).toBeLessThan(0.01);
    expect(distance(a, pad)).toBeGreaterThan(0.8);
    expect(distance(a, hats)).toBeGreaterThan(0.8);
    expect(distance(pad, hats)).toBeGreaterThan(0.8);
  });

  it('starts a new song after a silence gap and learns it again', () => {
    const rig = new Rig('beat124');
    const first = rig.run(14);
    const song = first.song;
    expect(first.songLock).toBe(1);
    rig.play('silence');
    rig.run(2);
    rig.play('pad');
    const second = rig.run(3);
    expect(second.song).toBe(song + 1);
    expect(second.songLock).toBeLessThan(0.5);
  });
});
