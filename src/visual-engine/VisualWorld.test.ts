import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Color, Material, Texture, WebGLRenderTarget, type ShaderMaterial, type Vector4, type WebGLRenderer } from 'three';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { AudioAnalyzer } from '../audio/analysis/AudioAnalyzer';
import { newFrame } from '../audio/features/decode';
import { VisualResponse } from '../audio/visual-response/VisualResponse';
import { DEFAULT_DIRECTION } from '../director/profiles';
import { VisualDirector } from '../director/VisualDirector';
import { EventStream } from '../experience/EventStream';
import { createSnapshot } from '../experience/types';
import { FeedbackPass } from '../render-systems/feedback/FeedbackPass';
import { FIELD } from '../render-systems/fields/fieldLaw';
import { QUALITY_PROFILES } from '../renderer/quality';
import { fixtureById } from '../show/fixtures';
import { relationship } from '../show/relationships';
import type { QualityProfile, SceneClock, VisualizerDefinition, VisualizerPreset } from '../types/visualizer';
import matterField from '../visualizers/matter-field/index';
import matterPreset from '../visualizers/matter-field/preset.json';
import { matterFieldRecipe, type MatterFieldParams } from '../visualizers/matter-field/recipe';
import { findVisualizer } from '../visualizers/registry';
import resonantPreset from '../visualizers/resonant-field/preset.json';
import { resonantFieldRecipe } from '../visualizers/resonant-field/recipe';
import type { ConnectionGraphPrimitive } from './primitives/ConnectionGraphPrimitive';
import type { MatterPrimitive } from './primitives/MatterPrimitive';
import type { WaveSurfacePrimitive } from './primitives/WaveSurfacePrimitive';
import { RecipeVisualizer, type RecipeBuilder } from './RecipeVisualizer';
import { BUDGET_GAIN, worldLab } from './VisualWorld';

const STRUCTURES = ['shockwaves', 'filaments', 'surface', 'graph'];
const uniformsOf = (object: unknown) => (object as { material: ShaderMaterial }).material.uniforms;

/** A recipe mounted as a layer would, on a renderer that records what it is asked to draw; the sound is set by hand. */
function mount<T>(preset: VisualizerPreset<T>, recipe: RecipeBuilder<T>, quality: QualityProfile = QUALITY_PROFILES.medium, direction = matterField.direction) {
  const renderer = { getPixelRatio: () => 1, extensions: { has: () => true }, getRenderTarget: () => null, setRenderTarget: vi.fn(), render: vi.fn() };
  const passes: Pass[] = [];
  const scene = new RecipeVisualizer(preset, recipe);
  scene.init({ renderer: renderer as unknown as WebGLRenderer, quality, width: 800, height: 600, addPass: (pass) => { passes.push(pass); } });
  scene.resize(800, 600);
  scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
  const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame, director = new VisualDirector(direction);
  const experience = createSnapshot(newFrame()), events = new EventStream();
  const clock: SceneClock = { time: 0, hits: { times: new Float64Array(8), strengths: new Float64Array(8), count: 0, size: 8 } as never, hitScale: 1, experience, events, light: 0 };
  const world = experience.world;
  const update = (seconds = 1, live = true, fps = 60) => {
    for (let i = 0; i < Math.round(seconds * fps); i++) {
      world.time += 1 / fps; world.travel += world.speed / fps; world.angle += world.spin / fps;
      clock.time = world.time;
      const modulation = director.update(response, DEFAULT_DIRECTION, 1 / fps, undefined, live ? experience : undefined);
      scene.update(audio, 1 / fps, world.time, response, modulation, live ? clock : undefined);
    }
  };
  /** A present, ordered, sustained sound, with as much structure as `entropy` allows. */
  const sound = (entropy: number) => {
    experience.acoustic.presence = 1; experience.acoustic.silent = 0; experience.acoustic.harmonicity = 0.9;
    Object.assign(experience.morphology, { periodicity: 0.8, harmonicity: 0.9, stability: 0.9, richness: 0.8, confidence: 1 });
    Object.assign(experience.state, { resonance: 0.8, flow: 0.7, pressure: 0.6, motion: 0.5, visualEntropy: entropy, fatigue: 0 });
    experience.plan.desiredEntropy = entropy;
    Object.assign(world, { coherence: 0.9, illumination: 0.8 });
    response.presence = response.audible = 1; response.music.leadVoice = 1; response.music.leadPitch = 220;
    for (let i = 0; i < response.music.leadLine.length; i++) response.music.leadLine[i] = Math.sin(2 * Math.PI * i / response.music.leadLine.length);
  };
  const silence = () => {
    experience.acoustic.presence = 0; experience.acoustic.silent = 1; experience.acoustic.harmonicity = 0;
    Object.assign(experience.morphology, { periodicity: 0, harmonicity: 0, stability: 1, richness: 0, confidence: 0 });
    Object.assign(experience.state, { resonance: 0, flow: 0, pressure: 0, motion: 0, visualEntropy: 0 });
    experience.plan.desiredEntropy = 0;
    Object.assign(world, { coherence: 1, illumination: 0, spin: 0, speed: 0, turbulence: 0, excitation: 0 });
    response.presence = response.audible = 0; response.music.leadVoice = 0;
  };
  /** Layer.dispose: the scene, then the passes it was given. */
  const dispose = () => { scene.dispose(); for (const pass of passes) pass.dispose(); };
  const presences = () => Object.fromEntries(scene.world.mounted.map((m) => [m.slot.id, m.presence.value]));
  return { scene, renderer, passes, world, experience, events, clock, response, update, sound, silence, dispose, presences };
}

const field = (quality?: QualityProfile) => mount(matterPreset as VisualizerPreset<MatterFieldParams>, matterFieldRecipe, quality);

afterEach(() => { vi.restoreAllMocks(); worldLab.only = null; });

describe('a visual world (Matter Field)', () => {
  it('is a scene like any other: registered, a fixture of the show, known to the scene graph', () => {
    expect(findVisualizer('matter-field')).toBe(matterField);
    expect(fixtureById('matter-field')?.cost).toBeGreaterThan(0);
    expect(relationship('matter-field', 'spectral-matter')).toBeGreaterThan(relationship('matter-field', 'oscilloscope'));
    const scene = (matterField as VisualizerDefinition).create(matterField.preset);
    expect(scene).toBeInstanceOf(RecipeVisualizer);
  });

  it('starts as its body alone and stays dark and still without sound', () => {
    const r = field();
    r.update(1, false);
    expect(r.scene.world.mounted.map((m) => m.slot.id)).toEqual(['matter', ...STRUCTURES]);
    const p = r.presences();
    expect(p.matter).toBe(1);
    for (const id of STRUCTURES) { expect(p[id]).toBe(0); expect(r.scene.world.primitive(id)!.object.visible).toBe(false); }
    expect(r.scene.world.primitive('matter')!.object.visible).toBe(true);
    expect(r.scene.world.materials.state.emissive).toBe(0);
    expect(r.scene.world.budget.value).toBe(0);
    expect(r.scene.world.uField[FIELD.vortex]).toBe(0); expect(r.scene.world.uField[FIELD.turbulence]).toBe(0);
    r.dispose();
  });

  it('grows structure with the music in the recipe\'s order, without rebuilding anything, and lets it dissolve', () => {
    const r = field();
    const disposed = vi.spyOn(Material.prototype, 'dispose'), targets = vi.spyOn(WebGLRenderTarget.prototype, 'dispose');
    const instances = r.scene.world.mounted.map((m) => m.primitive);
    const history: Record<string, number>[] = [];
    let jump = 0;
    const run = (seconds: number) => {
      for (let i = 0; i < seconds * 10; i++) {
        const before = r.presences();
        r.update(0.1);
        const after = r.presences();
        // Structures are tracked at every frame of the last tenth of a second: none may pop in or out.
        for (const id of STRUCTURES) jump = Math.max(jump, Math.abs(after[id] - before[id]));
        history.push(after);
      }
    };
    // A sparse moment: little entropy fills only the first slots.
    r.sound(0.08); run(8);
    const sparse = r.presences();
    expect(sparse.shockwaves).toBeGreaterThan(0.9); expect(sparse.filaments).toBeGreaterThan(0.05); expect(sparse.filaments).toBeLessThan(0.8);
    expect(sparse.surface).toBe(0); expect(sparse.graph).toBe(0);
    // A full mix carries most of the world, the densest moments all of it.
    r.sound(0.3); run(10);
    const full = r.presences();
    expect(full.filaments).toBeGreaterThan(0.9); expect(full.surface).toBeGreaterThan(0.5); expect(full.graph).toBeLessThan(0.6);
    r.sound(0.6); run(10);
    const dense = r.presences();
    for (const id of STRUCTURES) expect(dense[id], id).toBeGreaterThan(0.9);
    // Every structure formed after the one before it in the recipe.
    const formedAt = (id: string) => history.findIndex((h) => h[id] > 0.3);
    expect(formedAt('shockwaves')).toBeLessThan(formedAt('filaments')); expect(formedAt('filaments')).toBeLessThan(formedAt('surface'));
    expect(formedAt('surface')).toBeLessThan(formedAt('graph'));
    // Silence: the budget empties, structures dissolve, the light goes; the body stays.
    r.silence(); run(40);
    const after = r.presences();
    for (const id of STRUCTURES) { expect(after[id], id).toBeLessThan(0.01); expect(r.scene.world.primitive(id)!.object.visible).toBe(false); }
    expect(after.matter).toBe(1);
    expect(r.scene.world.materials.state.emissive).toBe(0); expect(r.scene.world.materials.state.ember).toBeLessThan(0.01);
    // No pops, and nothing was torn down or created along the way: the same primitives, the same GPU resources.
    expect(jump).toBeLessThan(0.12);
    expect(r.scene.world.mounted.map((m) => m.primitive)).toEqual(instances);
    expect(disposed).not.toHaveBeenCalled(); expect(targets).not.toHaveBeenCalled();
    r.dispose();
  });

  it('what a structure cools down with is the light it had: a faint ember that fades over seconds', () => {
    const r = field();
    r.sound(0.6); r.update(6);
    r.silence(); r.update(1);
    const ember = r.scene.world.materials.state.ember;
    expect(r.scene.world.materials.state.emissive).toBe(0);
    expect(ember).toBeGreaterThan(0.01); expect(ember).toBeLessThan(0.08);
    r.update(30);
    expect(r.scene.world.materials.state.ember).toBeLessThan(0.001);
    r.dispose();
  });

  it('gives every primitive the same fields and fronts: one vortex, one release, one front for all', () => {
    const r = field(QUALITY_PROFILES.high);
    const w = r.scene.world;
    r.sound(0.6); r.update(4);
    for (const id of ['shockwaves', 'filaments', 'surface']) {
      const u = uniformsOf(w.primitive(id)!.object);
      expect(u.uField.value).toBe(w.uField); expect(u.uWaveA.value).toBe(w.uWaveA); expect(u.uWaveB.value).toBe(w.uWaveB);
    }
    const matter = w.primitive<MatterPrimitive>('matter')!;
    const own = uniformsOf({ material: (matter.simulation as unknown as { material: ShaderMaterial }).material });
    // The world spins: the matter's own packed fields and the shared ones say the same.
    r.world.spin = 1.5; r.world.potential = 0.8;
    r.update(1 / 60);
    expect(w.uField[FIELD.vortex]).toBeGreaterThan(0.5);
    for (const key of ['vortex', 'radius', 'gather', 'turbulence', 'lateral'] as const) expect((own.uField.value as Float32Array)[FIELD[key]]).toBe(w.uField[FIELD[key]]);
    // The disorder phase advances at the same rate for the simulated and the stateless.
    expect((own.uField.value as Float32Array)[FIELD.form + 1]).toBeCloseTo(w.uField[FIELD.form + 1], 4);
    // A heard impact is one front: it pushes the matter and is what the others draw and are displaced by.
    r.events.push('impact', r.world.time, 0.9, 1, 1, 0.7);
    r.update(0.1);
    expect(w.debug.waves).toBe(1);
    expect(Math.max(...w.uWaveB.filter((_, i) => i % 4 === 0))).toBeGreaterThan(0.2);
    expect(Array.from(own.uWaveB.value as Float32Array)).toEqual(Array.from(w.uWaveB));
    // A release opens the cage and the forms together.
    r.world.releaseTime = r.world.time; r.world.releaseStrength = 0.6;
    r.update(1 / 60);
    expect(w.primitive<ConnectionGraphPrimitive>('graph')!.state.fracture).toBeGreaterThan(0.9);
    expect(matter.forms!.state.fracture).toBe(w.mapper.state.fracture);
    // The clock is lost: no front lingers anywhere.
    r.update(0.1, false);
    expect(Math.max(...w.uWaveB)).toBe(0); expect(Math.max(...(own.uWaveB.value as Float32Array))).toBe(0);
    r.dispose();
  });

  it('keeps its structure under the ceiling the show gives the fixture', () => {
    const free = field(), held = field();
    held.clock.structure = 0.25;
    for (const r of [free, held]) { r.sound(0.6); r.update(12); }
    expect(free.scene.world.budget.value).toBeGreaterThan(0.95);
    expect(held.scene.world.budget.value).toBeCloseTo(0.25, 2);
    expect(held.scene.world.ceiling).toBe(0.25);
    expect(held.presences().graph).toBe(0); expect(held.presences().shockwaves).toBeGreaterThan(0.9);
    // The budget is the planner's entropy, gained and bounded.
    const low = field(); low.sound(0.1); low.update(12);
    expect(low.scene.world.budget.value).toBeCloseTo(Math.min(1, BUDGET_GAIN * 0.1), 2);
    for (const r of [free, held, low]) r.dispose();
  });

  it('scales with quality: fewer elements in every primitive, the same primitives, the memory pass', () => {
    const [high, medium, low] = [QUALITY_PROFILES.high, QUALITY_PROFILES.medium, QUALITY_PROFILES.low].map(field);
    for (const id of ['matter', 'filaments', 'surface', 'graph']) {
      const count = (r: typeof high) => r.scene.world.primitive(id)!.vertices;
      expect(count(high), id).toBeGreaterThan(count(medium)); expect(count(medium), id).toBeGreaterThan(count(low));
      expect(count(low), id).toBeGreaterThan(0);
    }
    expect(high.scene.world.primitive('matter')!.elements).toBeLessThanOrEqual(70_000);
    expect([high, medium, low].map((r) => r.passes.filter((pass) => pass instanceof FeedbackPass).length)).toEqual([1, 1, 0]);
    expect(high.scene.debug.vertices).toBe(high.scene.world.mounted.reduce((n, m) => n + m.primitive.vertices, 0));
    expect(high.scene.debug.primitives).toBe(5);
    for (const r of [high, medium, low]) r.dispose();
  });

  it('primitives can be mounted, removed and mounted again while the world runs', () => {
    const r = field();
    const w = r.scene.world, geometries = vi.spyOn(BufferGeometry.prototype, 'dispose');
    r.sound(0.6); r.update(8);
    const vertices = w.debug.vertices, slot = w.mounted.find((m) => m.slot.id === 'graph')!.slot;
    expect(w.remove('graph')).toBe(true); expect(w.remove('graph')).toBe(false);
    expect(geometries).toHaveBeenCalledTimes(2);
    expect(w.primitive('graph')).toBeUndefined(); expect(w.debug.primitives).toBe(4); expect(w.debug.vertices).toBeLessThan(vertices);
    r.update(1);
    // Mounted again, it forms from nothing, with the world's palette.
    const again = w.add(slot);
    expect(w.presence('graph')).toBe(0); expect(again.object.visible).toBe(false);
    expect((uniformsOf(again.object.children[0]).uColorB.value as Color).getHex()).toBe(new Color('cyan').getHex());
    r.update(6);
    expect(w.presence('graph')).toBeGreaterThan(0.8); expect(w.debug.vertices).toBe(vertices);
    r.dispose();
  });

  it('a new session forgets what the world learned of the old one, without tearing down what is on screen', () => {
    const r = field();
    r.sound(0.6); r.update(8);
    r.events.push('impact', r.world.time, 0.9, 1, 1, 0.7);
    r.update(0.1);
    const w = r.scene.world, before = r.presences();
    expect(w.debug.waves).toBe(1); expect(w.mapper.state.tonalShape).toBeGreaterThan(0.5);
    // The capture clock starts again.
    r.world.time = 0; r.events.reset(); r.silence();
    r.update(1 / 60);
    expect(w.debug.waves).toBe(0);
    expect(w.mapper.state.tonalShape).toBe(0);
    expect(w.primitive<MatterPrimitive>('matter')!.forms!.signal.level[1]).toBe(0);
    // Structures dissolve from where they were.
    for (const id of STRUCTURES) expect(r.presences()[id]).toBeGreaterThan(before[id] * 0.9);
    r.dispose();
  });

  it('runs for a long session with a changing world: finite, bounded, the same objects, nothing recreated', () => {
    const r = field(QUALITY_PROFILES.low);
    const w = r.scene.world, uField = w.uField, frame = w.frame, geometry = w.mapper.state;
    const materials = vi.spyOn(Material.prototype, 'dispose');
    let k = 0;
    // Ten minutes at 30 frames per second: sections that come and go, events, silences.
    for (let section = 0; section < 60; section++) {
      const phase = section % 6;
      if (phase === 5) r.silence(); else r.sound(0.1 + 0.15 * phase);
      Object.assign(r.world, { spin: phase === 2 ? 2 : -0.4, speed: phase, turbulence: phase === 4 ? 0.9 : 0.1, potential: phase === 3 ? 0.9 : 0, radius: 0.2 * phase - 0.3, bias: phase === 1 ? 0.7 : 0 });
      for (let beat = 0; beat < 20; beat++) {
        if (phase !== 5) r.events.push(beat % 8 === 0 ? 'drop' : 'impact', r.world.time, 0.4 + 0.5 * ((k++ * 7) % 10) / 10, 1, beat % 8, 0.6);
        if (beat === 10 && phase === 3) { r.world.releaseTime = r.world.time; r.world.releaseStrength = 0.7; }
        r.update(0.5, true, 30);
      }
      for (const value of [...w.uField, ...w.uWaveA, ...w.uWaveB, ...Object.values(w.mapper.state), ...Object.values(w.materials.state), ...Object.values(r.scene.debug)]) expect(Number.isFinite(value)).toBe(true);
      for (const id of STRUCTURES) { expect(w.presence(id)).toBeGreaterThanOrEqual(0); expect(w.presence(id)).toBeLessThanOrEqual(1); }
      expect(Math.abs(w.uField[FIELD.radius])).toBeLessThanOrEqual(1.7); expect(Math.abs(w.uField[FIELD.vortex])).toBeLessThanOrEqual(2.4);
    }
    expect(r.world.time).toBeGreaterThan(590);
    expect(w.uField).toBe(uField); expect(w.frame).toBe(frame); expect(w.mapper.state).toBe(geometry);
    expect(uniformsOf(w.primitive('filaments')!.object).uField.value).toBe(uField);
    expect(w.mounted).toHaveLength(5);
    expect(materials).not.toHaveBeenCalled();
    r.dispose();
  }, 60_000);

  it('is deterministic by construction: nothing it computes depends on Math.random', () => {
    const run = (random: () => number) => {
      vi.spyOn(Math, 'random').mockImplementation(random);
      const r = field();
      r.sound(0.5); r.world.spin = 1; r.world.turbulence = 0.6;
      r.events.push('impact', 0.2, 0.9, 1, 3, 0.7);
      r.update(3);
      const w = r.scene.world;
      const attributes = w.mounted.flatMap((m) => {
        const out: number[][] = [];
        m.primitive.object.traverse((child) => {
          const geometry = (child as { geometry?: BufferGeometry }).geometry;
          if (geometry) for (const [name, attribute] of Object.entries(geometry.attributes)) if (name !== 'position' || m.slot.id === 'surface') out.push(Array.from(attribute.array as Float32Array).slice(0, 4000));
        });
        return out;
      });
      const uniforms = ['filaments', 'surface', 'shockwaves'].map((id) => Object.entries(uniformsOf(w.primitive(id)!.object)).filter(([name]) => !name.startsWith('t') && !name.startsWith('uColor')).map(([, u]) => JSON.stringify(u.value)));
      const out = JSON.stringify([attributes, uniforms, Array.from(w.uField), Array.from(w.uWaveA), w.mapper.state, w.materials.state, r.presences(), r.scene.camera.position.toArray()]);
      r.dispose();
      vi.restoreAllMocks();
      return out;
    };
    let n = 0;
    const first = run(() => 0.123), second = run(() => (n = (n * 7 + 0.31) % 1));
    expect(second).toBe(first);
    expect(first.length).toBeGreaterThan(50_000);
  });

  it('releases every GPU resource when unmounted, at every quality', () => {
    for (const quality of [QUALITY_PROFILES.high, QUALITY_PROFILES.medium, QUALITY_PROFILES.low]) {
      const targets = vi.spyOn(WebGLRenderTarget.prototype, 'dispose'), textures = vi.spyOn(Texture.prototype, 'dispose');
      const materials = vi.spyOn(Material.prototype, 'dispose'), geometries = vi.spyOn(BufferGeometry.prototype, 'dispose');
      const r = field(quality);
      r.sound(0.6); r.update(0.5);
      const drawn = quality.density >= 0.6;
      for (const spy of [targets, textures, materials, geometries]) spy.mockClear();
      r.dispose();
      // The simulation's ping-pong targets (+ the memory's two).
      expect(targets).toHaveBeenCalledTimes(drawn ? 4 : 2);
      // The matter's three seed textures and two forms' data, and the world's voice cycles.
      expect(textures.mock.contexts.filter((texture) => (texture as Texture & { isDataTexture?: boolean }).isDataTexture)).toHaveLength(6);
      // Simulation, points (+ bonds, facets), shockwaves, filaments, surface, the graph's two, (+ the memory's two).
      expect(materials).toHaveBeenCalledTimes(2 + (drawn ? 2 : 0) + 5 + (drawn ? 2 : 0));
      // Points (+ bonds, facets), rings, filaments, surface, joints and nodes; the full-screen triangles are extra.
      expect(geometries.mock.calls.length).toBeGreaterThanOrEqual(1 + (drawn ? 2 : 0) + 5);
      expect(r.scene.scene.children).toHaveLength(0); expect(r.scene.world.mounted).toHaveLength(0);
      vi.restoreAllMocks();
    }
  });

  it('in development, a world can be pinned to some of its primitives', () => {
    const r = field();
    worldLab.only = new Set(['surface']);
    r.update(0.5, false);
    expect(r.presences()).toEqual({ matter: 0, shockwaves: 0, filaments: 0, surface: 1, graph: 0 });
    worldLab.only = null;
    r.update(8, false);
    expect(r.presences().surface).toBeLessThan(0.1); expect(r.presences().matter).toBe(1);
    r.dispose();
  });
});

describe('Resonant Field as a recipe', () => {
  const membrane = () => mount(resonantPreset, resonantFieldRecipe, QUALITY_PROFILES.low, findVisualizer('resonant-field')!.direction);

  it('is the registered scene, a world of one primitive, turned and tilted as the scene was', () => {
    const scene = findVisualizer('resonant-field')!.create(resonantPreset) as RecipeVisualizer<unknown>;
    expect(scene).toBeInstanceOf(RecipeVisualizer);
    const r = membrane();
    expect(r.scene.world.mounted.map((m) => m.slot.id)).toEqual(['membrane']);
    expect(r.scene.world.object.rotation.x).toBe(-0.5); expect(r.scene.world.object.rotation.z).toBe(Math.PI / 4);
    expect(r.passes).toHaveLength(0);
    // A fixed view: the camera stands where the scene put it, whatever the world does.
    r.sound(0.5); r.world.spin = 2; r.world.radius = 0.8; r.update(3);
    expect(r.scene.camera.position.toArray()).toEqual([0, 0, resonantPreset.camera.distance]);
    r.dispose();
  });

  it('takes its height from the shared physics at the heard time, lies flat without a clock, and keeps its light while it rings', () => {
    const r = membrane();
    const surface = r.scene.world.primitive<WaveSurfacePrimitive>('membrane')!, u = uniformsOf(surface.object);
    r.sound(0.3);
    r.experience.physics.modes.set([0.3, -0.2, 0.1]); r.experience.physics.waves.set([0.2, -0.1, 1.5, 0.8]); r.experience.physics.energy = 2;
    r.update(0.5);
    expect(Array.from(u.uModes.value as Float32Array).slice(0, 3)).toEqual([0.3, -0.2, 0.1].map(Math.fround));
    expect((u.uPulses.value as Vector4[])[0].toArray()).toEqual([0.2, -0.1, 1.5, 0.8].map(Math.fround));
    expect(u.uTime.value).toBe(r.world.time);
    expect((u.uRelief.value as Vector4).x).toBeGreaterThan(0.5);
    const lit = (u.uShow.value as Vector4).x;
    expect(lit).toBeGreaterThan(0.2);
    // The sound stops but the membrane still rings: it keeps a light of its own.
    r.silence(); r.experience.physics.energy = 2; r.update(0.5);
    expect((u.uShow.value as Vector4).x).toBeGreaterThan(0.02); expect((u.uShow.value as Vector4).x).toBeLessThan(lit);
    // The clock is lost: nothing is dated, the membrane lies flat.
    r.update(0.1, false);
    expect(Math.max(...(u.uModes.value as Float32Array).map(Math.abs))).toBe(0);
    expect((u.uPulses.value as Vector4[]).every((pulse) => pulse.w === 0)).toBe(true);
    r.dispose();
  });

  it('follows the shared world: pressure sizes it, the turn carries it, width stretches it, a stepped voice terraces it', () => {
    const r = membrane(), w = r.scene.world;
    const surface = w.primitive<WaveSurfacePrimitive>('membrane')!, u = uniformsOf(surface.object);
    r.sound(0.3); r.update(1);
    const radius = w.uField[FIELD.radius], turn = w.uField[FIELD.form + 2];
    r.world.radius = 0.6; r.world.spin = 1.5; r.experience.morphology.spatialWidth = 0.8;
    r.update(2);
    expect(w.uField[FIELD.radius]).toBeGreaterThan(radius + 0.15); expect(w.uField[FIELD.form + 2]).not.toBe(turn);
    expect((u.uPlace.value as Vector4).toArray().slice(0, 3)).toEqual([3, 0.4, 1]);
    expect((u.uShape.value as Vector4).y).toBeGreaterThan(0.2);
    expect(surface.shape.terraces).toBeLessThan(0.05);
    for (let i = 0; i < r.response.music.leadLine.length; i++) r.response.music.leadLine[i] = i < r.response.music.leadLine.length / 2 ? 1 : -1;
    r.update(1);
    // By a share: the scene stays the membrane it was.
    expect(surface.shape.terraces).toBeGreaterThan(0.3); expect(surface.shape.terraces).toBeLessThanOrEqual(0.6);
    r.dispose();
  });
});
