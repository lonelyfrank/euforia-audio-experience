import { describe, expect, it } from 'vitest';
import { SPECTRUM_BINS, WAVEFORM_SIZE } from '../analysis/AudioAnalyzer';
import { SHAPE_SIZE } from '../analysis/VoiceTracker';
import type { AudioFrame } from '../../types/audio';
import { hzToPosition } from './spectrum';
import { VisualResponse } from './VisualResponse';

type Region = 'low' | 'mid' | 'high';

function frame(values: Partial<AudioFrame> = {}, regions: Region[] = []): AudioFrame {
  const spectrum = new Float32Array(SPECTRUM_BINS);
  const lowEnd = hzToPosition(250);
  const midEnd = hzToPosition(2000);
  for (let b = 0; b < SPECTRUM_BINS; b++) {
    const p = (b + 0.5) / SPECTRUM_BINS;
    const region: Region = p < lowEnd ? 'low' : p < midEnd ? 'mid' : 'high';
    spectrum[b] = regions.includes(region) ? 0.8 : 0;
  }
  return {
    time: 0,
    sampleRate: 48000,
    silent: false,
    volume: 0,
    peak: 0,
    bass: 0,
    lowMid: 0,
    mid: 0,
    highMid: 0,
    treble: 0,
    energy: 0,
    spectrum,
    waveform: new Float32Array(WAVEFORM_SIZE),
    beat: false,
    beatPulse: 0,
    onset: 0,
    bpm: 0,
    tempoConfidence: 0,
    beatPhase: 0,
    lowFlux: 0,
    midFlux: 0,
    highFlux: 0,
    flatness: 0,
    loudness: 0,
    lowDb: -96,
    midDb: -96,
    highDb: -96,
    bassVoice: { pitch: 0, clarity: 0, shape: new Float32Array(SHAPE_SIZE) },
    leadVoice: { pitch: 0, clarity: 0, shape: new Float32Array(SHAPE_SIZE) },
    ...values,
  };
}

/** Feeds the same frame for `seconds` at `fps`. */
function run(response: VisualResponse, input: AudioFrame, seconds: number, fps = 60) {
  const steps = Math.round(seconds * fps);
  for (let i = 0; i < steps; i++) response.update(input, 1 / fps);
  return response.frame;
}

const LOW = frame({ bass: 0.9, lowMid: 0.6, energy: 0.6 }, ['low']);
const MID = frame({ lowMid: 0.3, mid: 0.9, highMid: 0.3, energy: 0.5 }, ['mid']);
const HIGH = frame({ highMid: 0.8, treble: 0.9, energy: 0.4 }, ['high']);
const QUIET = frame({}, ['low', 'mid', 'high']);

describe('VisualResponse', () => {
  it('maps strong lows to weight, not to detail', () => {
    const r = run(new VisualResponse(), LOW, 1);
    expect(r.weight).toBeGreaterThan(0.7);
    expect(r.detail).toBeLessThan(0.05);
    expect(r.shimmer).toBeLessThan(0.05);
    expect(r.lowShare).toBeGreaterThan(0.9);
  });

  it('maps strong mids to flow', () => {
    const r = run(new VisualResponse(), MID, 1.5);
    expect(r.flow).toBeGreaterThan(0.6);
    expect(r.weight).toBeLessThan(0.2);
    expect(r.detail).toBeLessThan(0.2);
  });

  it('maps strong highs to detail, not to weight', () => {
    const r = run(new VisualResponse(), HIGH, 1);
    expect(r.detail).toBeGreaterThan(0.7);
    expect(r.weight).toBeLessThan(0.05);
  });

  it('turns a sudden rise of the highs into shimmer, which then fades', () => {
    const response = new VisualResponse();
    run(response, QUIET, 1);
    response.update(HIGH, 1 / 60);
    const peak = Math.max(response.frame.shimmer, run(response, HIGH, 0.05).shimmer);
    expect(peak).toBeGreaterThan(0.3);
    expect(run(response, HIGH, 1).shimmer).toBeLessThan(0.05);
  });

  it('gives an absent region only a fraction of its band level', () => {
    // Bass band reports movement but the spectrum holds only highs (e.g. noise floor).
    const r = run(new VisualResponse(), frame({ bass: 0.8, treble: 0.8 }, ['high']), 2);
    expect(r.weight).toBeLessThan(0.05);
    expect(r.detail).toBeGreaterThan(0.5);
  });

  it('reacts to an onset or beat at once', () => {
    const response = new VisualResponse();
    run(response, QUIET, 0.5);
    response.update(frame({ beatPulse: 1 }, ['low']), 1 / 60);
    expect(response.frame.impact).toBeCloseTo(1, 5);
  });

  it('lets impact decay with its release time constant (0.16 s)', () => {
    const response = new VisualResponse();
    response.update(frame({ beatPulse: 1 }, ['low']), 1 / 60);
    const r = run(response, frame({}, ['low']), 0.16, 100);
    expect(r.impact).toBeCloseTo(Math.exp(-1), 2);
  });

  it('is frame-rate independent', () => {
    const at = (fps: number) => {
      const response = new VisualResponse();
      const rise = { ...run(response, LOW, 0.1, fps) };
      const fall = run(response, QUIET, 0.3, fps);
      return { weightRise: rise.weight, weightFall: fall.weight, lowShare: fall.lowShare };
    };
    const reference = at(60);
    for (const fps of [30, 120]) {
      const other = at(fps);
      // Within 2%: cascaded followers (share → weight) differ slightly with the step size.
      expect(Math.abs(other.weightRise - reference.weightRise)).toBeLessThan(0.02);
      expect(Math.abs(other.weightFall - reference.weightFall)).toBeLessThan(0.02);
      expect(Math.abs(other.lowShare - reference.lowShare)).toBeLessThan(0.02);
    }
  });

  it('goes to rest on silence', () => {
    const response = new VisualResponse();
    run(response, LOW, 1);
    const r = run(response, frame({ silent: true }), 5);
    for (const key of ['weight', 'flow', 'detail', 'shimmer', 'impact', 'density'] as const) expect(r[key]).toBeLessThan(0.01);
  });
});
