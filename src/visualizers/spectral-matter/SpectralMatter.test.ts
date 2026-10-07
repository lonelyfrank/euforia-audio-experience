import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Color, Material, Texture, WebGLRenderTarget, type WebGLRenderer } from 'three';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { AudioAnalyzer } from '../../audio/analysis/AudioAnalyzer';
import { newFrame } from '../../audio/features/decode';
import { VisualResponse } from '../../audio/visual-response/VisualResponse';
import { DEFAULT_DIRECTION } from '../../director/profiles';
import { VisualDirector } from '../../director/VisualDirector';
import { EventStream } from '../../experience/EventStream';
import { createSnapshot } from '../../experience/types';
import { FeedbackPass } from '../../render-systems/feedback/FeedbackPass';
import { FORM } from '../../render-systems/forms/formLaw';
import { SIGNAL_ROWS, SIGNAL_SIZE } from '../../render-systems/forms/SignalForm';
import { FIELD } from '../../render-systems/fields/fieldLaw';
import { QUALITY_PROFILES } from '../../renderer/quality';
import { fixtureById } from '../../show/fixtures';
import { relationship } from '../../show/relationships';
import type { QualityProfile, SceneClock } from '../../types/visualizer';
import { findVisualizer } from '../registry';
import definition from './index';
import { matterQuality, type SpectralMatterParams } from './mapping';
import preset from './preset.json';
import { SpectralMatterVisualizer } from './SpectralMatterVisualizer';
import type { MatterPrimitive } from '../../visual-engine/primitives/MatterPrimitive';

const params: SpectralMatterParams = preset.visual;

/** The scene mounted as a layer would, on a renderer that records what it is asked to draw. */
function mount(quality: QualityProfile) {
  const renderer = {
    getPixelRatio: () => 1, extensions: { has: () => true }, getRenderTarget: () => null,
    setRenderTarget: vi.fn(), render: vi.fn(),
  };
  const passes: Pass[] = [];
  const scene = new SpectralMatterVisualizer(preset);
  scene.init({ renderer: renderer as unknown as WebGLRenderer, quality, width: 800, height: 600, addPass: (pass) => { passes.push(pass); } });
  scene.resize(800, 600);
  scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
  const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame;
  const director = new VisualDirector(definition.direction);
  const experience = createSnapshot(newFrame());
  experience.acoustic.presence = 1;
  const events = new EventStream();
  const clock: SceneClock = { time: 0, hits: { times: new Float64Array(8), strengths: new Float64Array(8), count: 0, size: 8 } as never, hitScale: 1, experience, events, light: 0 };
  const world = experience.world;
  const update = (seconds = 1, live = true) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      world.time += 1 / 60; world.travel += world.speed / 60; world.angle += world.spin / 60;
      clock.time = world.time;
      const modulation = director.update(response, DEFAULT_DIRECTION, 1 / 60, undefined, live ? experience : undefined);
      scene.update(audio, 1 / 60, world.time, response, modulation, live ? clock : undefined);
    }
  };
  /** Layer.dispose: the scene, then the passes it was given. */
  const dispose = () => { scene.dispose(); for (const pass of passes) pass.dispose(); };
  /** The world's body: the matter primitive (its simulation, forms and emission). */
  const matter = scene.world.primitive<MatterPrimitive>('matter')!;
  const uniforms = (matter.simulation as unknown as { material: { uniforms: Record<string, { value: Float32Array & { version: number; image: { data: Float32Array } } }> } }).material.uniforms;
  const field = (key: keyof typeof FIELD) => uniforms.uField.value[FIELD[key]];
  return { scene, renderer, passes, world, events, clock, update, dispose, field, response, matter, uniforms };
}

afterEach(() => vi.restoreAllMocks());

describe('Spectral Matter', () => {
  it('is a registered scene and a fixture of the show', () => {
    expect(findVisualizer('spectral-matter')).toBe(definition);
    expect(fixtureById('spectral-matter')?.cost).toBeGreaterThan(0);
    // Known to the scene graph (an unknown scene would get the neutral 0.5 from every side).
    expect(relationship('galaxy', 'spectral-matter')).not.toBe(0.5);
    expect(relationship('spectral-matter', 'particle-field')).toBeGreaterThan(relationship('spectral-matter', 'oscilloscope'));
  });

  it('scales with quality: elements, bonds, turbulence detail and the memory pass', () => {
    const low = matterQuality(params, QUALITY_PROFILES.low), medium = matterQuality(params, QUALITY_PROFILES.medium);
    const high = matterQuality(params, QUALITY_PROFILES.high), auto = matterQuality(params, QUALITY_PROFILES.auto);
    expect(high.count).toBe(params.count);
    expect(high.count).toBeGreaterThanOrEqual(50_000); expect(high.count).toBeLessThanOrEqual(100_000);
    expect(medium.count).toBeLessThan(high.count); expect(low.count).toBeLessThan(medium.count);
    expect(low.count).toBeGreaterThan(20_000);
    expect([high.feedback, medium.feedback, low.feedback]).toEqual(['full', 'half', 'off']);
    expect([high.detail, medium.detail, low.detail]).toEqual([true, true, false]);
    expect(high.links).toBeGreaterThan(medium.links); expect(medium.links).toBeGreaterThan(0); expect(low.links).toBe(0);
    expect(high.facets).toBeGreaterThan(medium.facets); expect(medium.facets).toBeGreaterThan(0); expect(low.facets).toBe(0);
    // Fewer elements each carry more light.
    expect(low.exposure).toBeGreaterThan(high.exposure);
    expect(auto).toEqual(high);
    // A device reporting nonsense still gets a small, valid body.
    expect(matterQuality(params, { ...QUALITY_PROFILES.low, density: 0 }).count).toBeGreaterThan(1000);
    expect(matterQuality(params, { ...QUALITY_PROFILES.low, density: 99 }).count).toBe(params.count);

    const mounted = [QUALITY_PROFILES.high, QUALITY_PROFILES.medium, QUALITY_PROFILES.low].map(mount);
    expect(mounted.map((m) => m.passes.filter((pass) => pass instanceof FeedbackPass).length)).toEqual([1, 1, 0]);
    expect(mounted[0].scene.debug.particles).toBeGreaterThan(mounted[1].scene.debug.particles);
    expect(mounted[1].scene.debug.particles).toBeGreaterThan(mounted[2].scene.debug.particles);
    // Bonds and facets are drawn at High and Medium only: at Low the matter and its forms are points.
    expect(mounted.map((m) => m.matter.object.children.length)).toEqual([3, 3, 1]);
    expect(mounted[0].scene.debug.vertices).toBeGreaterThan(mounted[1].scene.debug.vertices);
    expect(mounted[2].scene.debug.vertices).toBe(mounted[2].scene.debug.particles);
    for (const m of mounted) m.dispose();
  });

  it('turns the world into fields, never into positions, and keeps no world of its own', () => {
    const r = mount(QUALITY_PROFILES.medium);
    r.update(0.5);
    const radius = r.field('radius');
    expect(r.field('vortex')).toBe(0);
    r.world.radius = 0.6; r.world.spin = 1.5; r.world.turbulence = 0.8; r.world.coherence = 0.3;
    r.update(1 / 60);
    expect(r.field('radius')).toBeGreaterThan(radius + 0.2);
    expect(r.field('vortex')).toBeGreaterThan(0.5);
    expect(r.field('turbulence')).toBeGreaterThan(0.4);
    const gather = r.field('gather');
    r.world.potential = 1;
    r.update(1 / 60);
    expect(r.field('gather')).toBeGreaterThan(gather + 0.5);
    expect(r.field('radius')).toBeLessThan(radius + 0.2);
    // The world rests: the fields rest with it at once (the matter keeps its own inertia, on the GPU).
    r.world.radius = r.world.spin = r.world.turbulence = r.world.potential = 0; r.world.coherence = 1;
    r.update(1 / 60);
    expect(r.field('vortex')).toBe(0);
    expect(r.field('turbulence')).toBe(0);
    expect(r.field('radius')).toBeCloseTo(radius, 6);
    r.dispose();
  });

  it('a heard impact becomes a travelling front; its light is what the flash guard admitted', () => {
    const r = mount(QUALITY_PROFILES.high);
    r.world.illumination = 0.8;
    r.update(1);
    expect(r.scene.debug.waves).toBe(0);
    const emission = r.matter.emission;
    const quiet = emission.wave;
    r.events.push('impact', r.world.time + 0.05, 0.9, 1, 1, 0.7);
    r.update(0.03);
    // Not heard yet.
    expect(r.scene.debug.waves).toBe(0);
    r.clock.light = 0.5;
    r.update(0.1);
    expect(r.scene.debug.waves).toBe(1);
    const reduced = emission.wave;
    r.clock.light = 1;
    r.update(0.1);
    expect(reduced).toBeGreaterThan(quiet);
    expect(emission.wave).toBeGreaterThan(reduced);
    // The front ends by itself.
    r.clock.light = 0;
    r.update(5);
    expect(r.scene.debug.waves).toBe(0);
    r.dispose();
  });

  it('a front does not linger when the clock is lost while it travels', () => {
    const r = mount(QUALITY_PROFILES.low);
    r.update(0.5);
    r.events.push('impact', r.world.time, 0.9, 1, 1, 0.7);
    r.update(0.1);
    const waveB = r.uniforms.uWaveB.value;
    expect(Math.max(...waveB.filter((_, i) => i % 4 === 0))).toBeGreaterThan(0.2);
    // The capture stalls: no clock, no experience. The matter must not keep being pushed by the last front seen.
    r.update(0.1, false);
    expect(Math.max(...waveB.filter((_, i) => i % 4 === 0))).toBe(0);
    r.dispose();
  });

  it('simulates on the GPU every frame without a clock too, and stays dark and still at rest', () => {
    const r = mount(QUALITY_PROFILES.low);
    r.update(0.5, false);
    // One sub-step per 60 Hz frame (plus nothing else: no feedback at Low).
    expect(r.renderer.render).toHaveBeenCalledTimes(30);
    const emission = r.matter.emission;
    expect(emission.base).toBe(0);
    expect(emission.spark).toBe(0);
    expect(r.field('surge')).toBe(0);
    expect(r.field('advection')).toBe(0);
    r.dispose();
  });

  it('gives the simulation the forms of the sound: shares, the signal\'s history and the partials\' network, uploaded only when they change', () => {
    const r = mount(QUALITY_PROFILES.high);
    const u = r.uniforms, forms = r.matter.forms!;
    r.update(0.5);
    // Nothing periodic, nothing tonal: free matter, and the law is told so.
    expect(u.uForm.value[FORM.wave]).toBe(0); expect(u.uForm.value[FORM.harmonic]).toBe(0);
    // A steady rich tone is heard, with a voice to draw.
    const a = r.clock.experience!.acoustic, music = r.response.music;
    Object.assign(r.clock.experience!.morphology, { periodicity: 0.9, harmonicity: 0.9, richness: 0.8, stability: 0.9, confidence: 1 });
    [220, 440, 660, 880].forEach((hz, i) => { a.partialHz[i] = hz; a.partialLevel[i] = 0.9 / (i + 1); });
    for (let i = 0; i < music.leadLine.length; i++) music.leadLine[i] = 2 * i / music.leadLine.length - 1;
    music.leadVoice = 1; music.leadPitch = 220; r.response.presence = r.response.audible = 1;
    r.world.coherence = 0.9;
    r.update(1);
    expect(forms.state.wave).toBeGreaterThan(0.2); expect(forms.state.harmonic).toBeGreaterThan(0.2);
    expect(forms.harmonic.active).toBe(4);
    expect(u.uForm.value[FORM.wave]).toBeCloseTo(forms.state.wave, 6);
    expect(u.uForm.value[FORM.head]).toBe(forms.signal.head);
    // The textures are the forms' own arrays: no copy per frame, and the draw knows the shares too.
    expect(u.tSignal.value.image.data[(SIGNAL_ROWS + forms.signal.head) * SIGNAL_SIZE + 96]).toBeCloseTo(0.5, 5);
    expect(u.tHarmonic.value.image.data[3]).toBeGreaterThan(0);
    expect(r.matter.emission.waveShare).toBe(forms.state.wave);
    expect(r.scene.debug.wave).toBeCloseTo(forms.state.wave, 6); expect(r.scene.debug.nodes).toBe(4);
    expect(r.scene.debug.free).toBeCloseTo(1 - forms.state.wave - forms.state.harmonic, 6);
    const uploaded = u.tSignal.value.version;
    r.update(0.1);
    expect(u.tSignal.value.version).toBeGreaterThan(uploaded);
    // The clock is lost: the forms let go at once, the network fades (the matter relaxes by itself, on the GPU).
    r.update(0.1, false);
    expect(forms.state.wave).toBe(0); expect(forms.state.harmonic).toBe(0);
    r.update(3, false);
    expect(forms.harmonic.active).toBe(0);
    r.dispose();
  });

  it('is deterministic by construction: nothing it computes depends on Math.random', () => {
    // three.js draws object ids from Math.random; the matter, its fields and its fronts must not notice.
    const run = (random: () => number) => {
      vi.spyOn(Math, 'random').mockImplementation(random);
      const r = mount(QUALITY_PROFILES.medium);
      r.world.spin = 1; r.world.turbulence = 0.7; r.world.shimmer = 0.5; r.world.illumination = 0.6;
      r.events.push('impact', 0.2, 0.9, 1, 3, 0.7);
      r.update(1);
      const u = r.uniforms, seeds = r.matter.simulation.seeds;
      const state = [seeds.home, seeds.trait, seeds.form, u.uField.value, u.uForm.value, u.uWaveA.value, u.uWaveB.value].map((v) => Array.from(v));
      const out = JSON.stringify([state, r.matter.emission, r.scene.world.memory, r.scene.world.mapper.state, r.scene.camera.position.toArray()]);
      r.dispose();
      vi.restoreAllMocks();
      return out;
    };
    let n = 0;
    const first = run(() => 0.123), second = run(() => (n = (n * 7 + 0.31) % 1));
    expect(second).toBe(first);
    expect(first.length).toBeGreaterThan(100_000);
  });

  it('releases every GPU resource when unmounted, at every quality', () => {
    for (const quality of [QUALITY_PROFILES.high, QUALITY_PROFILES.medium, QUALITY_PROFILES.low]) {
      const targets = vi.spyOn(WebGLRenderTarget.prototype, 'dispose'), textures = vi.spyOn(Texture.prototype, 'dispose');
      const materials = vi.spyOn(Material.prototype, 'dispose'), geometries = vi.spyOn(BufferGeometry.prototype, 'dispose');
      const r = mount(quality);
      r.update(0.2);
      const feedback = quality.density >= 0.6, links = quality.density >= 0.6, facets = links;
      for (const spy of [targets, textures, materials, geometries]) spy.mockClear();
      r.dispose();
      // Simulation ping-pong targets (+ the memory's two).
      expect(targets).toHaveBeenCalledTimes(feedback ? 4 : 2);
      // The three seed textures, the two forms' data and the world's voice cycles (render-target textures go with their targets).
      expect(textures.mock.contexts.filter((texture) => (texture as Texture & { isDataTexture?: boolean }).isDataTexture)).toHaveLength(6);
      // Simulation, points (+ bonds, facets), and the memory's two materials.
      expect(materials).toHaveBeenCalledTimes(2 + (links ? 1 : 0) + (facets ? 1 : 0) + (feedback ? 2 : 0));
      // Points (+ bonds, facets) draw counts; full-screen triangles of the simulation (+ memory).
      expect(geometries.mock.calls.length).toBeGreaterThanOrEqual(2 + (links ? 1 : 0) + (facets ? 1 : 0));
      expect(r.scene.scene.children).toHaveLength(0);
      vi.restoreAllMocks();
    }
  });
});
