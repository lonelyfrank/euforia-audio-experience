import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Color, Material, Texture, WebGLRenderTarget, type ShaderMaterial, type Vector3, type Vector4, type WebGLRenderer } from 'three';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { AudioAnalyzer } from '../../audio/analysis/AudioAnalyzer';
import { newFrame } from '../../audio/features/decode';
import { VisualResponse } from '../../audio/visual-response/VisualResponse';
import { DEFAULT_DIRECTION } from '../../director/profiles';
import { VisualDirector } from '../../director/VisualDirector';
import { EventStream } from '../../experience/EventStream';
import { createSnapshot } from '../../experience/types';
import { MODES } from '../../physics/ResonantPhysics';
import { FeedbackPass } from '../../render-systems/feedback/FeedbackPass';
import { QUALITY_PROFILES } from '../../renderer/quality';
import { fixtureById } from '../../show/fixtures';
import { relationship } from '../../show/relationships';
import type { QualityProfile, SceneClock, VisualizerDefinition, VisualizerPreset } from '../../types/visualizer';
import { shellAge, type WaveSurfacePrimitive } from '../../visual-engine/primitives/WaveSurfacePrimitive';
import { RecipeVisualizer, type RecipeBuilder } from '../../visual-engine/RecipeVisualizer';
import matterField from '../matter-field/index';
import matterPreset from '../matter-field/preset.json';
import { matterFieldRecipe, type MatterFieldParams } from '../matter-field/recipe';
import { findVisualizer } from '../registry';
import shellScene from './index';
import preset from './preset.json';
import { shellCount, spectralShellRecipe, type SpectralShellParams } from './recipe';

const typed = preset as VisualizerPreset<SpectralShellParams>;
const uniformsOf = (object: unknown) => (object as { material: ShaderMaterial }).material.uniforms;
const positionsOf = (object: unknown) => (object as { geometry: BufferGeometry }).geometry.getAttribute('position').array as Float32Array;

/** A recipe mounted as a layer would, on a renderer that records what it is asked to draw; sound, world and membrane are set by hand. */
function mount<T>(scenePreset: VisualizerPreset<T>, recipe: RecipeBuilder<T>, quality: QualityProfile = QUALITY_PROFILES.medium) {
  const renderer = { getPixelRatio: () => 1, extensions: { has: () => true }, getRenderTarget: () => null, setRenderTarget: vi.fn(), render: vi.fn() };
  const passes: Pass[] = [];
  const scene = new RecipeVisualizer(scenePreset, recipe);
  scene.init({ renderer: renderer as unknown as WebGLRenderer, quality, width: 800, height: 600, addPass: (pass) => { passes.push(pass); } });
  scene.resize(800, 600);
  scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
  const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame, director = new VisualDirector(shellScene.direction);
  const experience = createSnapshot(newFrame()), events = new EventStream(), world = experience.world;
  const clock: SceneClock = { time: 0, hits: { times: new Float64Array(8), strengths: new Float64Array(8), count: 0, size: 8 } as never, hitScale: 1, experience, events, light: 0 };
  /** The membrane as the audio engine would leave it at the heard time: here a known function of that time. */
  let ringing: ((time: number, modes: Float32Array) => void) | null = null;
  const update = (seconds = 1, live = true, fps = 60) => {
    for (let i = 0; i < Math.round(seconds * fps); i++) {
      world.time += 1 / fps; world.travel += world.speed / fps; world.angle += world.spin / fps;
      clock.time = world.time;
      if (ringing) ringing(world.time, experience.physics.modes); else experience.physics.modes.fill(0);
      const modulation = director.update(response, DEFAULT_DIRECTION, 1 / fps, undefined, live ? experience : undefined);
      scene.update(audio, 1 / fps, world.time, response, modulation, live ? clock : undefined);
    }
  };
  const sound = (entropy = 0.4) => {
    experience.acoustic.presence = 1; experience.acoustic.silent = 0; experience.acoustic.harmonicity = 0.9;
    Object.assign(experience.morphology, { periodicity: 0.8, harmonicity: 0.9, stability: 0.9, richness: 0.8, density: 0.6, confidence: 1 });
    Object.assign(experience.state, { resonance: 0.8, flow: 0.7, pressure: 0.6, motion: 0.5, density: 0.6, visualEntropy: entropy, fatigue: 0 });
    experience.plan.desiredEntropy = entropy;
    Object.assign(world, { coherence: 0.9, illumination: 0.8 });
    response.presence = response.audible = 1;
  };
  const silence = () => {
    experience.acoustic.presence = 0; experience.acoustic.silent = 1; experience.acoustic.harmonicity = 0;
    Object.assign(experience.morphology, { periodicity: 0, harmonicity: 0, stability: 1, richness: 0, density: 0, confidence: 0 });
    Object.assign(experience.state, { resonance: 0, flow: 0, pressure: 0, motion: 0, density: 0, visualEntropy: 0 });
    experience.plan.desiredEntropy = 0;
    Object.assign(world, { coherence: 1, illumination: 0, spin: 0, speed: 0, radialVelocity: 0, biasVelocity: 0, turbulence: 0, excitation: 0, shimmer: 0, potential: 0 });
    response.presence = response.audible = 0;
    ringing = null;
  };
  const ring = (law: typeof ringing) => { ringing = law; };
  const dispose = () => { scene.dispose(); for (const pass of passes) pass.dispose(); };
  return { scene, renderer, passes, world, experience, events, clock, response, update, sound, silence, ring, dispose };
}

const shell = (quality?: QualityProfile) => {
  const r = mount(typed, spectralShellRecipe, quality);
  return { ...r, shell: r.scene.world.primitive<WaveSurfacePrimitive>('shell')! };
};
/** Modes that turn slowly, each at its own rate: what a membrane driven by sustained sound does. */
const turning = (time: number, modes: Float32Array) => { for (let i = 0; i < MODES; i++) modes[i] = 0.2 * Math.sin((0.8 + 0.3 * i) * time); };

afterEach(() => vi.restoreAllMocks());

describe('Spectral Shell (the scene)', () => {
  it('is a scene like any other: registered, a fixture of the show, known to the scene graph, a recipe of three primitives', () => {
    expect(findVisualizer('spectral-shell')).toBe(shellScene);
    expect(fixtureById('spectral-shell')?.cost).toBeGreaterThan(0);
    expect(relationship('spectral-shell', 'resonant-field')).toBeGreaterThan(relationship('spectral-shell', 'tunnel'));
    expect((shellScene as VisualizerDefinition).create(shellScene.preset)).toBeInstanceOf(RecipeVisualizer);
    const r = shell();
    expect(r.scene.world.mounted.map((m) => m.slot.id)).toEqual(['shell', 'shockwaves', 'dust']);
    r.dispose();
  });

  it('is the circular graph of Matter Field: the same primitive, the same disc, the same height law for the live membrane', () => {
    const r = shell(), field = mount(matterPreset as VisualizerPreset<MatterFieldParams>, matterFieldRecipe);
    const surface = field.scene.world.primitive<WaveSurfacePrimitive>('surface')!;
    expect(r.shell.constructor).toBe(surface.constructor);
    // The live membrane is sampled where Matter Field's is; the shells come after it.
    const own = positionsOf(surface.object), live = positionsOf(r.shell.object).subarray(0, own.length);
    expect(Array.from(live)).toEqual(Array.from(own));
    const a = uniformsOf(r.shell.object), b = uniformsOf(surface.object);
    for (const name of ['uPlace', 'uExposure', 'uAxial'] as const) expect(JSON.stringify(a[name].value)).toBe(JSON.stringify(b[name].value));
    // The same sound and the same world give both the same membrane: the first twelve modes and every shaping uniform.
    for (const s of [r, field]) { s.sound(0.6); s.ring(turning); Object.assign(s.world, { potential: 0.3, openness: 0.5, turbulence: 0.2 }); s.update(8); }
    for (const name of ['uRelief', 'uShape', 'uPlace', 'uGrain', 'uTime'] as const) expect(JSON.stringify(a[name].value), name).toBe(JSON.stringify(b[name].value));
    // (The ripple's phase is rendering history: Matter Field's membrane only counts it while it is there.)
    const texture = (u: typeof a) => { const { x, y, w } = u.uTexture.value as Vector4; return [x, y, w]; };
    expect(texture(a)).toEqual(texture(b));
    expect(Array.from((a.uModes.value as Float32Array).subarray(0, MODES))).toEqual(Array.from(b.uModes.value as Float32Array));
    expect(a.uField.value).toBe(r.scene.world.uField); expect(a.uWaveA.value).toBe(r.scene.world.uWaveA);
    // Matter Field's own membrane keeps no past: one layer, twelve modes, no shells.
    expect(surface.layers).toBe(1); expect((b.uModes.value as Float32Array).length).toBe(MODES); expect(surface.shells).toEqual({ spread: 0, bend: 0, reach: 0 });
    r.dispose(); field.dispose();
  });

  it('is dark and flat without sound, and without a clock nothing of it is dated', () => {
    const r = shell(), u = uniformsOf(r.shell.object);
    r.ring(turning);
    r.update(2, false);
    expect((u.uShow.value as Vector4).x).toBe(0);
    expect(Array.from(u.uModes.value as Float32Array).every((value) => value === 0)).toBe(true);
    expect(r.scene.world.presence('dust')).toBe(0);
    r.silence(); r.update(2);
    expect((u.uShow.value as Vector4).x).toBe(0);
    expect(Array.from(u.uModes.value as Float32Array).every((value) => value === 0)).toBe(true);
    r.dispose();
  });

  it('keeps its past round it: each shell is the membrane as it rang its age ago, the same at any frame rate', () => {
    const layers = shellCount(typed.visual.shells, QUALITY_PROFILES.medium);
    const run = (fps: number) => {
      const r = shell();
      r.sound(); r.ring(turning);
      r.update(4, true, fps);
      const modes = Array.from(uniformsOf(r.shell.object).uModes.value as Float32Array), time = r.world.time;
      const shells = { ...r.shell.shells };
      r.dispose();
      return { modes, time, shells };
    };
    const reference = run(60), expected = new Float32Array(MODES);
    expect(reference.modes).toHaveLength(MODES * (1 + layers));
    for (let k = 0; k <= layers; k++) {
      turning(reference.time - shellAge(k, layers, typed.visual.span), expected);
      for (let i = 0; i < MODES; i++) expect(reference.modes[k * MODES + i], `shell ${k}, mode ${i}`).toBeCloseTo(expected[i], 2);
    }
    // The oldest shell is far from the live membrane: it shows another moment.
    expect(Math.abs(reference.modes[layers * MODES + 3] - reference.modes[3])).toBeGreaterThan(0.05);
    for (const fps of [30, 144]) {
      const other = run(fps);
      expect(other.time).toBeCloseTo(reference.time, 6);
      for (let i = 0; i < other.modes.length; i++) expect(other.modes[i], `${fps} fps, value ${i}`).toBeCloseTo(reference.modes[i], 2);
      for (const key of ['spread', 'bend', 'reach'] as const) expect(other.shells[key]).toBeCloseTo(reference.shells[key], 2);
    }
  });

  it('the world decides how the shells stand: potential draws them in and closes them, openness holds them apart, a release throws them open', () => {
    const stand = (set: Record<string, number>) => {
      const r = shell();
      r.sound(); r.ring(turning);
      Object.assign(r.world, set);
      r.update(3);
      const out = { ...r.shell.shells, modes: Array.from(uniformsOf(r.shell.object).uModes.value as Float32Array), relief: (uniformsOf(r.shell.object).uRelief.value as Vector4).x };
      r.dispose();
      return out;
    };
    const calm = stand({}), tense = stand({ potential: 0.9 }), open = stand({ openness: 1 }), released = stand({ releaseTime: 2.9, releaseStrength: 0.9 });
    expect(tense.spread).toBeLessThan(calm.spread * 0.8); expect(tense.bend).toBeGreaterThan(calm.bend * 1.3);
    // Stored potential also draws the membrane itself taut.
    expect(tense.relief).toBeLessThan(calm.relief);
    expect(open.spread).toBeGreaterThan(calm.spread * 1.3);
    expect(released.spread).toBeGreaterThan(calm.spread * 1.5); expect(released.bend).toBeLessThan(calm.bend);
    // The world never writes the shape: what rings is the sound's, in every one of these worlds.
    for (const other of [tense, open, released]) expect(other.modes).toEqual(calm.modes);
    for (const s of [calm, tense, open, released]) { expect(s.spread).toBeGreaterThan(0); expect(s.bend).toBeGreaterThan(0); expect(s.bend).toBeLessThanOrEqual(Math.PI / 2 + 1e-9); }
  });

  it('settles in silence: the memory empties, every shell lies flat and the light goes', () => {
    const r = shell(), u = uniformsOf(r.shell.object), modes = u.uModes.value as Float32Array;
    r.sound(); r.ring(turning);
    r.update(4);
    expect(Math.max(...Array.from(modes).map(Math.abs))).toBeGreaterThan(0.1); expect((u.uShow.value as Vector4).x).toBeGreaterThan(0.2);
    r.silence();
    // The membrane itself has rung out (here at once): its shells still show what it was, each for its own age.
    r.update(0.3);
    expect(Math.max(...Array.from(modes.subarray(0, MODES)).map(Math.abs))).toBe(0);
    expect(Math.max(...Array.from(modes.subarray(MODES * (r.shell.layers - 1))).map(Math.abs))).toBeGreaterThan(0.05);
    r.update(typed.visual.span + 0.2);
    expect(Array.from(modes).every((value) => value === 0)).toBe(true);
    const phase = (u.uTexture.value as Vector4).z, field = Array.from(r.scene.world.uField);
    r.update(40);
    // Nothing moves on its own afterwards, and what light is left is the last of the ember.
    expect((u.uTexture.value as Vector4).z).toBe(phase); expect(Array.from(r.scene.world.uField)).toEqual(field);
    expect((u.uShow.value as Vector4).x).toBeLessThan(0.002);
    expect(r.scene.world.presence('dust')).toBeLessThan(0.01);
    r.dispose();
  });

  it('a new session starts from a flat past', () => {
    const r = shell(), modes = uniformsOf(r.shell.object).uModes.value as Float32Array;
    r.sound(); r.ring(turning);
    r.update(4);
    // The clock starts again: the shells of the previous session are not this one's.
    r.world.time = 0;
    r.update(0.1);
    expect(Math.max(...Array.from(modes.subarray(0, MODES)).map(Math.abs))).toBeGreaterThan(0);
    expect(Array.from(modes.subarray(MODES * (r.shell.layers - 1))).every((value) => value === 0)).toBe(true);
    r.dispose();
  });

  it('scales with quality: fewer shells and rings, the same membrane and the same ages; the memory pass above Low', () => {
    const [high, medium, low] = [QUALITY_PROFILES.high, QUALITY_PROFILES.medium, QUALITY_PROFILES.low].map((quality) => shell(quality));
    expect([high, medium, low].map((r) => r.shell.layers)).toEqual([5, 4, 3]);
    expect(high.shell.vertices).toBeGreaterThan(medium.shell.vertices); expect(medium.shell.vertices).toBeGreaterThan(low.shell.vertices);
    expect(high.shell.vertices).toBeLessThan(40_000);
    for (const r of [high, medium, low]) {
      const layer = uniformsOf(r.shell.object).uLayer.value as Vector3[];
      expect(layer[0].toArray()).toEqual([0, 0, 1]);
      // The oldest shell is always the whole span old; shells alternate above and below the membrane.
      expect(layer[layer.length - 1].x).toBeCloseTo(typed.visual.span, 6); expect(layer[layer.length - 1].y).toBe(1);
      expect(layer.slice(1).map((l) => l.z)).toEqual(layer.slice(1).map((_, i) => (i % 2 === 0 ? 1 : -1)));
    }
    expect([high, medium, low].map((r) => r.passes.filter((pass) => pass instanceof FeedbackPass).length)).toEqual([1, 1, 0]);
    for (const r of [high, medium, low]) r.dispose();
  });

  it('runs a long session with a changing world: finite, bounded, the same objects, nothing recreated', () => {
    const r = shell(QUALITY_PROFILES.low), w = r.scene.world, u = uniformsOf(r.shell.object), modes = u.uModes.value;
    const materials = vi.spyOn(Material.prototype, 'dispose');
    for (let section = 0; section < 40; section++) {
      const phase = section % 5;
      if (phase === 4) r.silence(); else { r.sound(0.1 + 0.15 * phase); r.ring(turning); }
      Object.assign(r.world, { spin: phase === 2 ? 2.5 : -0.4, speed: phase, turbulence: phase === 3 ? 0.95 : 0.1, potential: phase === 1 ? 0.9 : 0, radius: 0.25 * phase - 0.3, radialVelocity: phase - 1.5, bias: phase === 1 ? 0.7 : 0, biasVelocity: phase - 2, shimmer: phase === 0 ? 0.9 : 0, openness: phase / 4 });
      for (let beat = 0; beat < 12; beat++) {
        if (phase !== 4) r.events.push(beat % 6 === 0 ? 'drop' : 'impact', r.world.time, 0.5 + 0.04 * beat, 1, beat % 8, 0.6);
        if (beat === 6 && phase === 2) Object.assign(r.world, { releaseTime: r.world.time, releaseStrength: 1 });
        r.update(0.5, true, 30);
      }
      for (const value of [...w.uField, ...w.uWaveA, ...w.uWaveB, ...(u.uModes.value as Float32Array), ...Object.values(r.shell.shells), ...Object.values(r.shell.shape), ...Object.values(r.scene.debug)]) expect(Number.isFinite(value)).toBe(true);
      for (const name of ['uShell', 'uEcho', 'uShow', 'uRelief', 'uTexture', 'uPlace', 'uShape'] as const) for (const value of (u[name].value as Vector4).toArray()) expect(Number.isFinite(value)).toBe(true);
      expect(r.shell.shells.spread).toBeLessThanOrEqual(0.85 * 2.2 + 1e-9); expect(r.shell.shells.bend).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
      expect(Math.max(...Array.from(u.uModes.value as Float32Array).map(Math.abs))).toBeLessThanOrEqual(0.2 + 1e-6);
    }
    expect(u.uModes.value).toBe(modes); expect(w.mounted).toHaveLength(3);
    expect(materials).not.toHaveBeenCalled();
    r.dispose();
  }, 60_000);

  it('is deterministic by construction: nothing it draws depends on Math.random', () => {
    const run = (random: () => number) => {
      vi.spyOn(Math, 'random').mockImplementation(random);
      const r = shell(QUALITY_PROFILES.low);
      r.sound(); r.ring(turning); r.world.spin = 1; r.world.turbulence = 0.6;
      r.events.push('impact', 0.2, 0.9, 1, 3, 0.7);
      r.update(3);
      const uniforms = Object.entries(uniformsOf(r.shell.object)).filter(([name]) => !name.startsWith('uColor')).map(([, uniform]) => JSON.stringify(uniform.value));
      const out = JSON.stringify([Array.from(positionsOf(r.shell.object).subarray(0, 6000)), uniforms, Array.from(r.scene.world.uField), r.scene.camera.position.toArray()]);
      r.dispose();
      vi.restoreAllMocks();
      return out;
    };
    let n = 0;
    const first = run(() => 0.123), second = run(() => (n = (n * 7 + 0.31) % 1));
    expect(second).toBe(first);
    expect(first.length).toBeGreaterThan(20_000);
  });

  it('releases every GPU resource when unmounted, at every quality', () => {
    for (const quality of [QUALITY_PROFILES.high, QUALITY_PROFILES.medium, QUALITY_PROFILES.low]) {
      const targets = vi.spyOn(WebGLRenderTarget.prototype, 'dispose'), textures = vi.spyOn(Texture.prototype, 'dispose');
      const materials = vi.spyOn(Material.prototype, 'dispose'), geometries = vi.spyOn(BufferGeometry.prototype, 'dispose');
      const r = shell(quality);
      r.sound(); r.update(0.5);
      const memory = quality.density >= 0.6;
      for (const spy of [targets, textures, materials, geometries]) spy.mockClear();
      r.dispose();
      // The dust's ping-pong targets (+ the memory's two).
      expect(targets).toHaveBeenCalledTimes(memory ? 4 : 2);
      // The dust's seed and form textures and the world's voice cycles.
      expect(textures.mock.contexts.filter((texture) => (texture as Texture & { isDataTexture?: boolean }).isDataTexture)).toHaveLength(6);
      // Shell, fronts, the dust's simulation and points (+ the memory's two).
      expect(materials).toHaveBeenCalledTimes(4 + (memory ? 2 : 0));
      // Shell, fronts and dust; the full-screen triangles are extra.
      expect(geometries.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(r.scene.scene.children).toHaveLength(0); expect(r.scene.world.mounted).toHaveLength(0);
      vi.restoreAllMocks();
    }
  });
});

describe('Matter Field after the extraction', () => {
  it('still carries the circular graph as its surface, in the same place of its recipe', () => {
    const field = mount(matterPreset as VisualizerPreset<MatterFieldParams>, matterFieldRecipe);
    expect(findVisualizer('matter-field')).toBe(matterField);
    expect(field.scene.world.mounted.map((m) => m.slot.id)).toEqual(['matter', 'shockwaves', 'filaments', 'surface', 'graph']);
    const surface = field.scene.world.primitive<WaveSurfacePrimitive>('surface')!, u = uniformsOf(surface.object);
    expect((u.uPlace.value as Vector4).toArray().slice(0, 3)).toEqual([1.35, 1, 1]); expect(u.uAxial.value).toBe(1); expect(u.uExposure.value).toBe(0.6);
    expect((u.uRelief.value as Vector4).w).toBe(1);
    field.dispose();
  });
});
