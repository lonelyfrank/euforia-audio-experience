import { describe, expect, it } from 'vitest';
import { AudioAnalyzer } from '../../audio/analysis/AudioAnalyzer';
import { newFrame } from '../../audio/features/decode';
import { VisualResponse } from '../../audio/visual-response/VisualResponse';
import { createSnapshot } from '../../experience/types';
import { REST_VIEW, WorldView } from '../../world/WorldView';
import { createGeometry, GEOMETRY_KEYS, SIGNED_TRAITS, type GeometryState } from './GeometryState';
import { SonicGeometryMapper } from './SonicGeometryMapper';

const NEUTRAL = { motion: 1, expansion: 1, turbulence: 1 };
const N = 128;
const SHAPES = {
  sine: (p: number) => Math.sin(2 * Math.PI * p),
  saw: (p: number) => 2 * p - 1,
  square: (p: number) => (p < 0.5 ? 1 : -1),
};

/** A mapper with a sound to hear: the snapshot, the world and the voices are set by hand, as the layers before it would. */
function stage() {
  const mapper = new SonicGeometryMapper(), view = new WorldView();
  const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame, snapshot = createSnapshot(newFrame());
  const music = response.music;
  const voice = (line: Float32Array, shape: (p: number) => number) => { for (let i = 0; i < N; i++) line[i] = shape(i / N); };
  /** A present, tonal sound with a clear lead of the given shape. */
  const sound = (shape: keyof typeof SHAPES | null, set: Partial<typeof snapshot.morphology> = {}) => {
    snapshot.acoustic.presence = 1; snapshot.acoustic.silent = 0; snapshot.acoustic.harmonicity = 0.9;
    Object.assign(snapshot.morphology, { periodicity: 0.9, harmonicity: 0.9, stability: 0.9, richness: 0.5, confidence: 1, noisiness: 0, sharpness: 0.3, transientness: 0, ...set });
    snapshot.world.coherence = 0.9; snapshot.world.illumination = 0.7; snapshot.world.time = 1;
    response.presence = response.audible = 1;
    music.leadVoice = shape ? 1 : 0; music.leadPitch = 440;
    if (shape) voice(music.leadLine, SHAPES[shape]);
  };
  const silence = () => {
    snapshot.acoustic.presence = 0; snapshot.acoustic.silent = 1; snapshot.acoustic.harmonicity = 0;
    Object.assign(snapshot.morphology, { periodicity: 0, harmonicity: 0, stability: 1, richness: 0, noisiness: 0, sharpness: 0, transientness: 0, density: 0, roughness: 0, spatialWidth: 0, confidence: 0 });
    Object.assign(snapshot.world, { coherence: 1, illumination: 0, turbulence: 0, excitation: 0, shimmer: 0, potential: 0, openness: 0, radius: 0, spin: 0, speed: 0 });
    Object.assign(snapshot.state, { complexity: 0, density: 0, resonance: 0, flow: 0, pressure: 0, motion: 0, visualEntropy: 0 });
    snapshot.plan.desiredEntropy = 0;
    response.presence = response.audible = response.weight = response.lowShare = 0; music.leadVoice = music.bassVoice = 0;
  };
  const run = (seconds = 1, fps = 60): GeometryState => {
    for (let i = 0; i < Math.round(seconds * fps); i++) {
      snapshot.world.time += 1 / fps;
      view.update(snapshot.world, NEUTRAL);
      mapper.update(1 / fps, view, audio, response, snapshot);
    }
    return mapper.state;
  };
  return { mapper, view, audio, response, snapshot, sound, silence, run };
}

describe('sound and world → geometry', () => {
  it('rests when nothing sounds: every trait is zero and the world is whole', () => {
    const mapper = new SonicGeometryMapper();
    const g = mapper.update(1 / 60, REST_VIEW, new AudioAnalyzer().frame, new VisualResponse().frame);
    // A world nothing disturbs is whole, and whole matter holds its shape: everything else is zero.
    expect(g).toEqual({ ...createGeometry(), rigidity: 0.55 });
    expect(g.coherence).toBe(1);
  });

  it('a sine, a sawtooth, a square and noise ask for different geometry', () => {
    const of = (shape: keyof typeof SHAPES | null, set = {}) => { const s = stage(); s.sound(shape, set); return { ...s.run() }; };
    const sine = of('sine'), saw = of('saw'), square = of('square');
    const noise = of(null, { periodicity: 0, harmonicity: 0.05, stability: 0.1, noisiness: 0.95, sharpness: 0.8 });
    // Smooth, repeating sound: round unbroken lines, no corners.
    expect(sine.curvature).toBeGreaterThan(0.6); expect(sine.edgeHardness).toBeLessThan(0.2); expect(sine.tonalShape).toBeGreaterThan(0.7);
    // A sawtooth: corners that point one way, never flat.
    expect(saw.edgeHardness).toBeGreaterThan(sine.edgeHardness + 0.5); expect(saw.curvature).toBeLessThan(0.5 * sine.curvature);
    expect(saw.skew).toBeGreaterThan(0.5); expect(saw.stepping).toBeLessThan(0.1);
    // A square: corners both ways with flat stretches between them.
    expect(square.stepping).toBeGreaterThan(0.6); expect(Math.abs(square.skew)).toBeLessThan(0.1); expect(square.edgeHardness).toBeGreaterThan(0.6);
    // Noise: no shape of its own, rough, nothing to join.
    expect(noise.noiseShape).toBeGreaterThan(0.6); expect(noise.tonalShape).toBeLessThan(0.1); expect(noise.curvature).toBeLessThan(0.2);
    expect(noise.surfaceRoughness).toBeGreaterThan(sine.surfaceRoughness + 0.2); expect(noise.connectionRadius).toBeLessThan(sine.connectionRadius);
  });

  it('low sound is long waves and heavy matter, bright sound fine detail; width opens the space', () => {
    const low = stage(), high = stage();
    low.sound('sine', { sharpness: 0.05 }); low.response.lowShare = 0.8; low.response.weight = 0.9;
    high.sound('sine', { sharpness: 0.95 }); high.response.lowShare = 0.02; high.response.weight = 0.05;
    const a = { ...low.run() }, b = { ...high.run() };
    expect(a.waveScale).toBeGreaterThan(b.waveScale + 0.5); expect(a.particleMass).toBeGreaterThan(b.particleMass + 0.5);
    const wide = stage(); wide.sound('sine', { spatialWidth: 0.9 }); wide.snapshot.world.openness = 0.8;
    const c = { ...wide.run() };
    expect(c.stereoSpread).toBeCloseTo(0.9, 5); expect(c.particleSpread).toBeGreaterThan(a.particleSpread + 0.5); expect(c.spatialDepth).toBeGreaterThan(a.spatialDepth + 0.3);
  });

  it('takes structure from the planner and events from the world, and detects nothing itself', () => {
    const s = stage(); s.sound('sine');
    s.snapshot.plan.desiredEntropy = 0.8; s.snapshot.state.visualEntropy = 0.7; s.snapshot.state.fatigue = 0;
    expect(s.run().topologyComplexity).toBeCloseTo(0.6 * 0.8 + 0.4 * 0.7, 5);
    // A tired picture carries less.
    s.snapshot.state.fatigue = 1;
    expect(s.run(0.1).topologyComplexity).toBeCloseTo(0.6 * 0.8 + 0.4 * 0.7 * 0.5, 5);
    // An impact and a release are the world's own facts: they ring and fade by their age.
    expect(s.mapper.state.impulse).toBe(0); expect(s.mapper.state.fracture).toBe(0);
    s.snapshot.world.impulseTime = s.snapshot.world.time; s.snapshot.world.impulseStrength = 0.9;
    s.snapshot.world.releaseTime = s.snapshot.world.time; s.snapshot.world.releaseStrength = 0.6;
    const struck = { ...s.run(1 / 60) };
    expect(struck.impulse).toBeGreaterThan(0.8); expect(struck.fracture).toBeGreaterThan(0.9);
    const later = { ...s.run(0.5) };
    expect(later.impulse).toBeLessThan(0.15); expect(later.fracture).toBeLessThan(struck.fracture); expect(later.fracture).toBeGreaterThan(0.3);
    expect(s.run(6).fracture).toBeLessThan(0.01);
    // The world's stored potential is tension, its lateral force a signed bias.
    s.snapshot.world.potential = 0.8; s.snapshot.world.bias = -0.6;
    const held = s.run(1 / 60);
    expect(held.tension).toBeCloseTo(0.8, 5); expect(held.lateralBias).toBeCloseTo(-0.6, 5); expect(held.viscosity).toBeGreaterThan(0.4);
  });

  it('stays finite and in range for any input', () => {
    const s = stage(); s.sound('saw');
    const bad = [NaN, Infinity, -Infinity, 1e9, -1e9, -3, 7];
    let k = 0;
    const next = () => bad[k++ % bad.length];
    for (let round = 0; round < 40; round++) {
      for (const target of [s.snapshot.morphology, s.snapshot.state, s.snapshot.world, s.snapshot.plan, s.response] as unknown as Record<string, unknown>[]) {
        for (const key of Object.keys(target)) if (typeof target[key] === 'number' && (round + key.length) % 3 === 0) target[key] = next();
      }
      s.response.music.leadVoice = next(); s.response.music.bassVoice = next(); s.response.music.leadLine[round] = next(); s.response.music.bassLine[round * 2] = next();
      s.snapshot.acoustic.presence = next();
      s.view.update(s.snapshot.world, NEUTRAL);
      const g = s.mapper.update(round % 5 === 0 ? next() : 1 / 60, s.view, s.audio, s.response, round % 7 === 6 ? undefined : s.snapshot);
      for (const key of GEOMETRY_KEYS) {
        expect(Number.isFinite(g[key]), key).toBe(true);
        expect(g[key], key).toBeGreaterThanOrEqual(SIGNED_TRAITS.includes(key) ? -1 : 0);
        expect(g[key], key).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is deterministic, and the same at 30, 60 and 144 frames per second', () => {
    const at = (fps: number) => { const s = stage(); s.sound('sine'); s.run(0.5, fps); s.sound('saw'); return { ...s.run(1, fps) }; };
    const a = at(60), b = at(60), slow = at(30), fast = at(144);
    expect(b).toEqual(a);
    for (const key of GEOMETRY_KEYS) {
      expect(slow[key], key).toBeCloseTo(a[key], 3);
      expect(fast[key], key).toBeCloseTo(a[key], 3);
    }
  });

  it('a voice that changes shape glides: no trait jumps from one frame to the next', () => {
    const s = stage(); s.sound('sine'); s.run(1);
    let previous = { ...s.mapper.state }, largest = 0;
    s.sound('square');
    for (let i = 0; i < 60; i++) {
      const g = s.run(1 / 60);
      for (const key of GEOMETRY_KEYS) largest = Math.max(largest, Math.abs(g[key] - previous[key]));
      previous = { ...g };
    }
    expect(largest).toBeLessThan(0.15);
    expect(previous.stepping).toBeGreaterThan(0.6);
  });

  it('decays to rest by itself when the sound stops and the world settles', () => {
    const s = stage(); s.sound('saw'); s.snapshot.plan.desiredEntropy = 0.8; s.snapshot.world.turbulence = 0.5;
    const sounding = { ...s.run(1) };
    expect(sounding.edgeHardness).toBeGreaterThan(0.5); expect(sounding.energy).toBeGreaterThan(0.3);
    s.silence();
    const after = s.run(1.5), rest = createGeometry();
    for (const key of GEOMETRY_KEYS) expect(after[key], key).toBeCloseTo(key === 'rigidity' ? 0.55 : rest[key], 3);
    // A new session forgets the voices' shapes at once.
    s.sound('saw'); s.run(0.5); s.mapper.reset();
    expect(s.mapper.state).toEqual(rest);
  });
});
