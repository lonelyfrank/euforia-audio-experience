import { describe, expect, it } from 'vitest';
import { AudioAnalyzer, FFT_SIZE, VOICE_WINDOW } from '../analysis/AudioAnalyzer';
import { SignalGenerator, type TestSignal } from '../capture/testSignals';
import { HOP, SCENE_FIELDS as F } from './layout';
import { WasmAnalysis } from './WasmAnalysis';

/*
 * The scenes' graphic analysis runs in Rust (spectrum_analysis::scene) at a fixed cadence on the
 * capture clock. It is a port of the TypeScript AudioAnalyzer, which used to run on the frame loop:
 * these tests feed both the same windows and require the same numbers, so what the scenes read
 * (Spectrum first of all) means exactly what it meant.
 *
 * Both compute in f64 and store in f32 at the same points. The only possible differences are the
 * last digit of the math library (exp, log10, pow, sin… of the JS engine against Rust's): at most a
 * few 1e-14 on a dB value before it is rounded or smoothed. The tolerance leaves room for another
 * engine's library, nothing more: a wrong constant or a reordered sum is orders of magnitude above it.
 */
const TOLERANCE = 1e-9;

interface Options {
  sampleRate?: number;
  channels?: 1 | 2;
  seconds?: number;
  sensitivity?: number;
  smoothing?: number;
  every?: number;
}

/** Runs `signal` through the WASM analysis and, window by window, through the reference; returns the largest differences. */
async function compare(signal: TestSignal, options: Options = {}) {
  const { sampleRate = 48000, channels = 1, seconds = 8, sensitivity = 1, smoothing = 0.5, every = 0 } = options;
  const analysis = await WasmAnalysis.create(sampleRate, channels);
  analysis.setScene(sensitivity, smoothing, every);
  const generator = new SignalGenerator(signal, sampleRate);
  const reference = new AudioAnalyzer();
  Object.assign(reference.settings, { sensitivity, smoothing });
  const frames = 800;
  const total = Math.ceil((seconds * sampleRate) / frames) * frames;
  // The mono mix of everything pushed, after VOICE_WINDOW samples of the silence that preceded it.
  const mono = new Float32Array(VOICE_WINDOW + total);
  const window = new Float32Array(VOICE_WINDOW);
  const worst = { scalar: 0, array: 0, field: '' };
  const samples: number[] = [];
  let beats = 0;
  let pitched = 0;
  analysis.decoder.onScene = (data, at) => {
    const sample = data[at + F.sample[0]];
    const dt = (sample - (samples.at(-1) ?? 0)) / sampleRate;
    samples.push(sample);
    window.set(mono.subarray(sample, sample + VOICE_WINDOW));
    const frame = reference.analyze(window.subarray(VOICE_WINDOW - FFT_SIZE), sampleRate, dt, window);
    const scalar = (name: keyof typeof F, value: number) => {
      const d = Math.abs(data[at + F[name][0]] - value);
      if (!(d <= worst.scalar)) { worst.scalar = d; worst.field = name; }
    };
    const array = (name: keyof typeof F, values: Float32Array) => {
      const [offset, length] = F[name];
      expect(values.length).toBe(length);
      for (let i = 0; i < length; i++) {
        const d = Math.abs(data[at + offset + i] - values[i]);
        if (!(d <= worst.array)) { worst.array = d; worst.field = name; }
      }
    };
    // What decides something (a beat, a silence) must agree exactly.
    expect(data[at + F.silent[0]]).toBe(frame.silent ? 1 : 0);
    expect(data[at + F.beat[0]]).toBe(frame.beat ? 1 : 0);
    scalar('centroidHz', frame.centroidHz); scalar('rolloffHz', frame.rolloffHz); scalar('spreadHz', frame.spreadHz);
    scalar('rms', frame.rms); scalar('volume', frame.volume); scalar('peak', frame.peak); scalar('bass', frame.bass);
    scalar('lowMid', frame.lowMid); scalar('mid', frame.mid); scalar('highMid', frame.highMid); scalar('treble', frame.treble);
    scalar('energy', frame.energy); scalar('beatPulse', frame.beatPulse); scalar('onset', frame.onset); scalar('bpm', frame.bpm);
    scalar('tempoConfidence', frame.tempoConfidence); scalar('beatPhase', frame.beatPhase);
    scalar('lowFlux', frame.lowFlux); scalar('midFlux', frame.midFlux); scalar('highFlux', frame.highFlux);
    scalar('flatness', frame.flatness); scalar('loudness', frame.loudness);
    scalar('lowDb', frame.lowDb); scalar('midDb', frame.midDb); scalar('highDb', frame.highDb);
    scalar('bassPitch', frame.bassVoice.pitch); scalar('bassClarity', frame.bassVoice.clarity);
    scalar('leadPitch', frame.leadVoice.pitch); scalar('leadClarity', frame.leadVoice.clarity);
    array('spectrum', frame.spectrum); array('waveform', frame.waveform);
    array('bassShape', frame.bassVoice.shape); array('leadShape', frame.leadVoice.shape);
    if (frame.beat) beats++;
    if (frame.bassVoice.pitch > 0 || frame.leadVoice.pitch > 0) pitched++;
  };
  const chunk = new Float32Array(frames * channels);
  for (let done = 0; done < total; done += frames) {
    if (channels === 1) generator.fill(chunk, 0, frames);
    else generator.fillStereo(chunk, frames);
    for (let i = 0; i < frames; i++) {
      mono[VOICE_WINDOW + done + i] = channels === 1 ? chunk[i] : Math.fround(chunk[2 * i] + chunk[2 * i + 1]) * 0.5;
    }
    analysis.decoder.begin();
    analysis.push(chunk);
  }
  analysis.dispose();
  return { worst, samples, beats, pitched, frame: reference.frame };
}

describe('scene analysis (Rust) against the TypeScript AudioAnalyzer', { timeout: 120000 }, () => {
  const signals: TestSignal[] = ['beat124', 'synthPop', 'buildDrop', 'harmonicSeries', 'whiteNoise', 'startStop', 'fadeCut'];
  for (const signal of signals) {
    it(`gives the same frame for the same window: ${signal}`, async () => {
      const { worst, samples } = await compare(signal);
      expect(samples.length).toBeGreaterThan(450);
      expect(worst.scalar, worst.field).toBeLessThan(TOLERANCE);
      // Spectrum, waveform and voice shapes are stored in f32 on both sides.
      expect(worst.array, worst.field).toBeLessThan(TOLERANCE);
    });
  }

  it('measures something: beats, voices and a moving spectrum on a groove', async () => {
    const { beats, pitched, frame } = await compare('synthPop', { seconds: 10 });
    expect(beats).toBeGreaterThan(10);
    expect(pitched).toBeGreaterThan(100);
    expect(Math.max(...frame.spectrum)).toBeGreaterThan(0.5);
    expect(frame.bpm).toBeGreaterThan(60);
  });

  it('runs every three hops at 44.1 and 48 kHz (about 60 frames per second), on hop boundaries of the capture clock', async () => {
    for (const sampleRate of [44100, 48000]) {
      const { samples, worst } = await compare('beat124', { sampleRate, seconds: 4 });
      samples.forEach((sample, i) => expect(sample).toBe((i + 1) * 3 * HOP));
      expect(worst.scalar, `${sampleRate} ${worst.field}`).toBeLessThan(TOLERANCE);
      expect(worst.array, `${sampleRate} ${worst.field}`).toBeLessThan(TOLERANCE);
    }
  });

  it('draws the mono mix of a stereo capture', async () => {
    const { worst } = await compare('stereoWidth', { channels: 2, seconds: 6 });
    expect(worst.scalar, worst.field).toBeLessThan(TOLERANCE);
    expect(worst.array, worst.field).toBeLessThan(TOLERANCE);
  });

  it("follows the user's reactivity and smoothing, and the cadence the host asks for", async () => {
    const { worst, samples } = await compare('buildDrop', { sensitivity: 1.6, smoothing: 0.15, every: 2, seconds: 6 });
    samples.forEach((sample, i) => expect(sample).toBe((i + 1) * 2 * HOP));
    expect(worst.scalar, worst.field).toBeLessThan(TOLERANCE);
    expect(worst.array, worst.field).toBeLessThan(TOLERANCE);
  });
});
