import { describe, expect, it } from 'vitest';
import { SignalGenerator, type TestSignal } from '../audio/capture/testSignals';
import { newFrame } from '../audio/features/decode';
import { WasmAnalysis } from '../audio/features/WasmAnalysis';
import { createMorphology, MORPHOLOGY_KEYS, MorphologyEngine, type SoundMorphology } from './SoundMorphology';

const SR = 48000;

/** The morphology of a test signal through the real DSP: its mean over seconds 3–6 (the engine runs per hop, as in the app). */
async function hear(signal: TestSignal, chunk = 800): Promise<SoundMorphology> {
  const analysis = await WasmAnalysis.create(SR, 1);
  const engine = new MorphologyEngine();
  const mean = createMorphology();
  mean.stability = 0;
  let last = 0, n = 0;
  analysis.decoder.onFrame = (a) => {
    engine.update(a, last ? a.time - last : 256 / SR);
    last = a.time;
    if (a.time < 3) return;
    n++;
    for (const key of MORPHOLOGY_KEYS) mean[key] += engine.state[key];
  };
  const generator = new SignalGenerator(signal, SR), samples = new Float32Array(chunk);
  for (let fed = 0; fed < 6 * SR; fed += chunk) { generator.fill(samples, 0, chunk); analysis.decoder.begin(); analysis.push(samples); }
  analysis.dispose();
  for (const key of MORPHOLOGY_KEYS) mean[key] /= n;
  return mean;
}

describe('sound morphology', { timeout: 60000 }, () => {
  it('places a sine, a sawtooth, a square, a chord and noise in different corners, without naming any of them', async () => {
    const [sine, saw, square, chord, noise] = await Promise.all((['mid', 'sawBass', 'squareLead', 'pad', 'whiteNoise'] as const).map((s) => hear(s)));
    // One cycle that repeats: every pitched single voice; a chord has several periods, noise none.
    for (const voice of [sine, saw, square]) expect(voice.periodicity).toBeGreaterThan(0.5);
    expect(chord.periodicity).toBeLessThan(0.45);
    expect(noise.periodicity).toBeLessThan(0.05);
    // How the partials are stacked: none beside the fundamental, a full series, the odd ones, three notes.
    expect(sine.richness).toBeLessThan(0.05);
    expect(saw.richness).toBeGreaterThan(square.richness + 0.15);
    expect(square.richness).toBeGreaterThan(0.4);
    expect(chord.richness).toBeGreaterThan(0.6);
    // Noise has many spectral peaks but no partials.
    expect(noise.richness).toBeLessThan(0.1);
    expect(noise.noisiness).toBeGreaterThan(0.8);
    for (const tonal of [sine, saw, square, chord]) expect(tonal.noisiness).toBeLessThan(0.2);
    for (const tonal of [sine, saw, square, chord]) expect(tonal.harmonicity).toBeGreaterThan(0.5);
    expect(noise.harmonicity).toBeLessThan(0.1);
    // Edges: a square is sharper than a sine at a comparable pitch; noise is the sharpest and the densest.
    expect(square.sharpness).toBeGreaterThan(sine.sharpness + 0.2);
    expect(noise.sharpness).toBeGreaterThan(square.sharpness);
    expect(noise.density).toBeGreaterThan(saw.density);
    expect(saw.density).toBeGreaterThan(sine.density + 0.3);
    // A held tone is steady, noise never is.
    expect(sine.stability).toBeGreaterThan(0.95);
    expect(noise.stability).toBeLessThan(0.1);
  });

  it('tells sudden events from sustained sound', async () => {
    const [tone, harmonics, kicks, hats, groove] = await Promise.all((['tone120', 'harmonicSeries', 'kicks', 'hats', 'beat124'] as const).map((s) => hear(s)));
    // A low, rich, perfectly static tone flickers in a short window: it must not read as transient.
    expect(tone.transientness).toBeLessThan(0.05);
    expect(harmonics.transientness).toBeLessThan(0.05);
    for (const percussive of [kicks, hats, groove]) expect(percussive.transientness).toBeGreaterThan(0.5);
    // A kick is a pitched sweep with an empty, flat mid band: not noise. A hi-hat is.
    expect(kicks.noisiness).toBeLessThan(0.4);
    expect(hats.noisiness).toBeGreaterThan(0.6);
    expect(hats.sharpness).toBeGreaterThan(kicks.sharpness + 0.5);
  });

  it('is zero in silence, steady, and does not depend on how the audio is batched', async () => {
    const silence = await hear('silence');
    for (const key of MORPHOLOGY_KEYS) expect(silence[key]).toBe(key === 'stability' ? 1 : 0);
    const [small, large] = await Promise.all([hear('synthPop', 256), hear('synthPop', 4800)]);
    for (const key of MORPHOLOGY_KEYS) expect(large[key]).toBeCloseTo(small[key], 9);
  });

  it('stays bounded and finite on corrupted measurements, and resets', () => {
    const engine = new MorphologyEngine();
    const a = newFrame();
    a.presence = 1; a.timbreConfidence = 1;
    for (const value of [NaN, Infinity, -Infinity, 1e9, -1e9]) {
      a.harmonicity = a.phaseCoherence = a.flatness = a.phaseDeviation = a.sharpness = a.roughness = a.entropy = a.complexChange = a.width = a.onsetDensity = value;
      a.partialLevel.fill(value); a.bandLevel.fill(value); a.bandTransient.fill(value);
      for (let i = 0; i < 50; i++) engine.update(a, 256 / SR);
      for (const key of MORPHOLOGY_KEYS) {
        expect(Number.isFinite(engine.state[key]), `${key} with ${value}`).toBe(true);
        expect(engine.state[key]).toBeGreaterThanOrEqual(0);
        expect(engine.state[key]).toBeLessThanOrEqual(1);
      }
    }
    engine.reset();
    expect(engine.state).toEqual(createMorphology());
  });
});
