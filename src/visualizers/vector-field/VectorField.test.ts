import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Color, Material, Texture, WebGLRenderTarget, type ShaderMaterial, type Vector4, type WebGLRenderer } from 'three';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { AudioAnalyzer } from '../../audio/analysis/AudioAnalyzer';
import { newFrame } from '../../audio/features/decode';
import { VisualResponse } from '../../audio/visual-response/VisualResponse';
import { DEFAULT_DIRECTION } from '../../director/profiles';
import { VisualDirector } from '../../director/VisualDirector';
import { EventStream } from '../../experience/EventStream';
import { createSnapshot } from '../../experience/types';
import { FeedbackPass } from '../../render-systems/feedback/FeedbackPass';
import { FIELD, FIELD_VALUES, packFields, packWaves, PHASE_PERIOD } from '../../render-systems/fields/fieldLaw';
import { createFields, deriveFields } from '../../render-systems/fields/SpatialFields';
import { deriveTopology, EDDIES, FIELD_SPAN, TOPOLOGY, TOPOLOGY_VALUES } from '../../render-systems/fields/vectorField';
import { substeps } from '../../render-systems/particles/matterLaw';
import { TracerProbe, type TracerMeasure } from '../../render-systems/particles/TracerProbe';
import { seedTracers } from '../../render-systems/particles/TracerSeeds';
import { matterLayout } from '../../render-systems/particles/MatterSeeds';
import { MAX_WAVES, WaveField } from '../../render-systems/waves/WaveField';
import { QUALITY_PROFILES } from '../../renderer/quality';
import { fixtureById } from '../../show/fixtures';
import { relationship } from '../../show/relationships';
import type { QualityProfile, SceneClock, VisualizerDefinition, VisualizerPreset } from '../../types/visualizer';
import { SonicGeometryMapper } from '../../visual-engine/geometry/SonicGeometryMapper';
import type { FieldLinePrimitive } from '../../visual-engine/primitives/FieldLinePrimitive';
import type { FieldTracerPrimitive } from '../../visual-engine/primitives/FieldTracerPrimitive';
import { RecipeVisualizer } from '../../visual-engine/RecipeVisualizer';
import { WorldView } from '../../world/WorldView';
import { findVisualizer } from '../registry';
import fieldScene from './index';
import preset from './preset.json';
import { vectorFieldRecipe, type VectorFieldParams } from './recipe';

const NEUTRAL = { motion: 1, expansion: 1, turbulence: 1 };
const typed = preset as VisualizerPreset<VectorFieldParams>;

/** A present, sustained, ordered sound in a lit world; the tests then set what the world does. */
function alive(experience: ReturnType<typeof createSnapshot>, response: VisualResponse['frame'], entropy = 0.4): void {
  experience.acoustic.presence = 1; experience.acoustic.silent = 0; experience.acoustic.harmonicity = 0.8;
  Object.assign(experience.morphology, { periodicity: 0.7, harmonicity: 0.8, stability: 0.8, richness: 0.6, confidence: 1 });
  Object.assign(experience.state, { resonance: 0.6, flow: 0.6, pressure: 0.5, motion: 0.5, visualEntropy: entropy, fatigue: 0 });
  experience.plan.desiredEntropy = entropy;
  Object.assign(experience.world, { coherence: 0.9, illumination: 0.8 });
  response.presence = response.audible = 1;
}

function silent(experience: ReturnType<typeof createSnapshot>, response: VisualResponse['frame']): void {
  experience.acoustic.presence = 0; experience.acoustic.silent = 1; experience.acoustic.harmonicity = 0;
  Object.assign(experience.morphology, { periodicity: 0, harmonicity: 0, stability: 1, richness: 0, confidence: 0 });
  Object.assign(experience.state, { resonance: 0, flow: 0, pressure: 0, motion: 0, visualEntropy: 0 });
  experience.plan.desiredEntropy = 0;
  // A world that has come to rest: its velocities and fast fields are gone; where pressure left it does not matter here.
  Object.assign(experience.world, { coherence: 1, illumination: 0, spin: 0, speed: 0, radialVelocity: 0, biasVelocity: 0, turbulence: 0, excitation: 0, shimmer: 0, potential: 0 });
  response.presence = response.audible = 0;
}

/**
 * The scene's CPU path without a GPU, as VisualWorld and the tracer primitive
 * run it: world → view → geometry → fields (+ the recipe's tune) → packed
 * fields, fronts and topology → the tracers on the reference laws.
 */
function stage(count = 384, seed = 7) {
  const view = new WorldView(), mapper = new SonicGeometryMapper(), fields = createFields(), waves = new WaveField();
  const shared = { uField: new Float32Array(FIELD_VALUES), uWaveA: new Float32Array(MAX_WAVES * 4), uWaveB: new Float32Array(MAX_WAVES * 4), topology: new Float32Array(TOPOLOGY_VALUES) };
  const probe = new TracerProbe(count, seed, shared);
  const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame;
  const experience = createSnapshot(newFrame()), events = new EventStream(), world = experience.world;
  const tune = vectorFieldRecipe(typed.visual, QUALITY_PROFILES.low).tune!;
  let phase = 0;
  const frame = (dt: number): TracerMeasure => {
    world.time += dt; world.travel += world.speed * dt; world.angle += world.spin * dt;
    view.update(world, NEUTRAL);
    const geometry = mapper.update(dt, view, audio, response, experience);
    deriveFields(fields, view, geometry, experience.intents);
    tune(fields, geometry);
    waves.update(world.time, events, view.lateral, 1);
    phase = (phase + fields.phaseRate * Math.min(dt, 0.1)) % PHASE_PERIOD;
    packFields(shared.uField, fields, phase);
    packWaves(shared.uWaveA, shared.uWaveB, waves, world.time);
    deriveTopology(shared.topology, geometry, fields);
    probe.step(dt);
    return probe.measure(fields.lateral, fields.radius);
  };
  const run = (seconds: number, fps = 60): TracerMeasure => {
    let m = probe.measure();
    for (let i = 0; i < Math.round(seconds * fps); i++) m = frame(1 / fps);
    return { ...m };
  };
  return { probe, shared, fields, experience, events, world, response, frame, run };
}

describe('the tracers of a field (CPU reference)', () => {
  it('are seeded through the whole space of the field, deterministically, and never move in a world that never sounded', () => {
    const a = seedTracers(matterLayout(512), 7), b = seedTracers(matterLayout(512), 7), c = seedTracers(matterLayout(512), 8);
    expect(a.home).toEqual(b.home); expect(a.trait).toEqual(b.trait); expect(a.home).not.toEqual(c.home);
    let far = 0;
    for (let i = 0; i < a.layout.count; i++) {
      const r = Math.hypot(a.home[i * 4], a.home[i * 4 + 1], a.home[i * 4 + 2]);
      expect(r).toBeLessThanOrEqual(1.0001);
      if (r * FIELD_SPAN > 1.3) far++;
    }
    // Most of them are outside the body: the field is the space round it.
    expect(far / a.layout.count).toBeGreaterThan(0.5);

    const s = stage();
    const start = s.run(1 / 60), first = Float32Array.from(s.probe.position);
    const end = s.run(10);
    expect(end.kinetic).toBe(0); expect(end.speed).toBe(0);
    expect(Array.from(s.probe.position)).toEqual(Array.from(first));
    expect(start.radius).toBeGreaterThan(1.2);
  });

  it('reveal what the world does: a turning world is circulation, a breathing one a source and a sink', () => {
    const turning = stage(), opening = stage(), closing = stage();
    // Loosely held, so the shells stay out of it: what is left is the world's own flows.
    for (const s of [turning, opening, closing]) { alive(s.experience, s.response); s.world.coherence = 0.45; }
    turning.world.spin = 1.5; opening.world.radialVelocity = 1.2; closing.world.radialVelocity = -1.2;
    const t = turning.run(2), o = opening.run(2), c = closing.run(2);
    expect(t.circulation).toBeGreaterThan(0.05);
    expect(o.outward).toBeGreaterThan(0.15); expect(c.outward).toBeLessThan(-0.15);
    // Tracers have inertia: a vortex flings them outwards a little, far less than a source does.
    expect(t.outward).toBeGreaterThan(0); expect(t.outward).toBeLessThan(o.outward * 0.6);
    expect(Math.abs(o.circulation)).toBeLessThan(0.02);
    // The other way round is the mirror image.
    const back = stage();
    alive(back.experience, back.response); back.world.coherence = 0.45; back.world.spin = -1.5;
    expect(back.run(2).circulation).toBeLessThan(-0.05);
  });

  it('change structure with the world: disorder wakes eddies, order and held potential gather the body into sheets', () => {
    const calm = stage(), wild = stage(), held = stage();
    for (const s of [calm, wild, held]) alive(s.experience, s.response);
    // No global flow at all in the three of them: what moves is the topology.
    Object.assign(calm.world, { coherence: 0.45, turbulence: 0 });
    Object.assign(wild.world, { coherence: 0.15, turbulence: 0.9 });
    Object.assign(held.world, { coherence: 1, potential: 0.9, turbulence: 0 });
    const c = calm.run(4), w = wild.run(4), h = held.run(4);
    expect(calm.shared.topology[TOPOLOGY.eddies]).toBe(0); expect(wild.shared.topology[TOPOLOGY.eddies]).toBeGreaterThan(EDDIES - 1);
    expect(w.kinetic).toBeGreaterThan(0.01); expect(c.kinetic).toBeLessThan(w.kinetic * 0.05);
    expect(held.shared.topology[TOPOLOGY.well]).toBeGreaterThan(1.5); expect(calm.shared.topology[TOPOLOGY.well]).toBe(0);
    // The tracers inside the body have come onto its shells; those of the calm field are where they were.
    const inBody = (s: ReturnType<typeof stage>) => {
      let n = 0, off = 0;
      const radius = s.fields.radius;
      for (let i = 0; i < s.probe.count; i++) {
        const r = Math.hypot(s.probe.position[i * 4] - s.fields.lateral, s.probe.position[i * 4 + 1], s.probe.position[i * 4 + 2]) / radius;
        if (r < 0.5 || r > 1.25) continue;
        const shell = (r - 0.55) / 0.3;
        off += Math.abs(shell - Math.round(shell)); n++;
      }
      return off / n;
    };
    expect(inBody(held)).toBeLessThan(inBody(calm) * 0.5);
    expect(h.kinetic).toBeLessThan(0.01);
  });

  it('a heard event is a front that crosses them: it leaves energy where it passes and pushes outwards, never before its time', () => {
    const s = stage();
    alive(s.experience, s.response); s.world.coherence = 0.45;
    s.run(0.5);
    s.events.push('impact', s.world.time + 0.2, 0.9, 1, 1, 0.7);
    const before = s.run(0.15);
    expect(before.energy).toBe(0); expect(before.kinetic).toBeLessThan(1e-9);
    const after = s.run(0.6);
    expect(after.energy).toBeGreaterThan(0.01); expect(after.outward).toBeGreaterThan(0.005);
    // The front fades and the tracers come to rest again.
    const later = s.run(8);
    expect(later.energy).toBeLessThan(after.energy * 0.01); expect(later.kinetic).toBeLessThan(after.kinetic * 0.01);
  });

  it('settle in silence: the kinetic energy only falls, nothing new is made, and what is left is where it stopped', () => {
    const s = stage();
    alive(s.experience, s.response);
    Object.assign(s.world, { spin: 1.6, speed: 2.5, radialVelocity: 0.8, turbulence: 0.7, coherence: 0.3, excitation: 0.6, shimmer: 0.5 });
    const lively = s.run(3);
    expect(lively.kinetic).toBeGreaterThan(0.05);
    silent(s.experience, s.response);
    let last = Infinity;
    for (let i = 0; i < 40; i++) {
      const m = s.run(0.25);
      expect(m.kinetic).toBeLessThanOrEqual(last + 1e-12);
      last = m.kinetic;
    }
    expect(last).toBeLessThan(lively.kinetic * 1e-6);
    const stopped = Float32Array.from(s.probe.position);
    s.run(5);
    let moved = 0;
    for (let i = 0; i < stopped.length; i += 4) moved = Math.max(moved, Math.hypot(s.probe.position[i] - stopped[i], s.probe.position[i + 1] - stopped[i + 1], s.probe.position[i + 2] - stopped[i + 2]));
    expect(moved).toBeLessThan(1e-4);
    // The field itself is zero: every flow, the eddies and the shells.
    for (const key of ['surge', 'vortex', 'advection', 'drift', 'turbulence', 'shimmer', 'lifetimeRate'] as const) expect(s.shared.uField[FIELD[key]]).toBe(0);
    expect(Array.from(s.shared.topology)).toEqual([0, 0, 0, 0]);
  });

  it('is the same field at 30, 60 and 144 frames per second, and the same run twice', () => {
    const play = (fps: number) => {
      const s = stage(256);
      alive(s.experience, s.response);
      Object.assign(s.world, { spin: 1.2, speed: 1.5, radialVelocity: 0.5, turbulence: 0.4, coherence: 0.6, potential: 0.3 });
      s.events.push('impact', 0.5, 0.8, 1, 2, 0.7);
      const m = s.run(3, fps);
      return { m, position: Float32Array.from(s.probe.position) };
    };
    const [a, b, c, again] = [play(60), play(30), play(144), play(60)];
    expect(Array.from(again.position)).toEqual(Array.from(a.position));
    for (const other of [b, c]) {
      // The cloud as a whole is the same; single tracers differ by what a turbulent path amplifies of the step.
      expect(other.m.radius).toBeCloseTo(a.m.radius, 2); expect(other.m.spread).toBeCloseTo(a.m.spread, 2);
      expect(Math.abs(other.m.circulation - a.m.circulation)).toBeLessThan(0.05 * Math.abs(a.m.circulation) + 0.002);
      expect(Math.abs(other.m.kinetic - a.m.kinetic)).toBeLessThan(0.08 * a.m.kinetic);
      let off = 0;
      for (let i = 0; i < a.position.length; i += 4) off += Math.hypot(other.position[i] - a.position[i], other.position[i + 1] - a.position[i + 1], other.position[i + 2] - a.position[i + 2]);
      expect(off / (a.position.length / 4)).toBeLessThan(0.05);
    }
  });

  it('stays finite and inside the field for any world, also a broken one', () => {
    const s = stage(192);
    alive(s.experience, s.response);
    const worlds = [
      { spin: 3, speed: 6, radialVelocity: 2.5, turbulence: 1, coherence: 0, potential: 1, radius: 0.9, bias: 1, biasVelocity: 2, excitation: 1, shimmer: 1 },
      { spin: -3, speed: 0, radialVelocity: -2.5, turbulence: 1, coherence: 1, potential: 0, radius: -0.6, bias: -1, biasVelocity: -2 },
      { spin: NaN, speed: Infinity, radialVelocity: -Infinity, turbulence: NaN, coherence: NaN, potential: Infinity, radius: NaN, bias: NaN },
    ];
    for (const world of worlds) {
      Object.assign(s.world, world);
      for (let beat = 0; beat < 8; beat++) {
        s.events.push(beat % 4 === 0 ? 'drop' : 'impact', s.world.time, 1, 1, beat % 8, 0.9);
        s.run(0.5, 30);
      }
      for (const value of [...s.shared.uField, ...s.shared.topology, ...s.probe.position, ...s.probe.velocity]) expect(Number.isFinite(value)).toBe(true);
      for (let i = 0; i < s.probe.count; i++) {
        expect(Math.hypot(s.probe.position[i * 4], s.probe.position[i * 4 + 1], s.probe.position[i * 4 + 2])).toBeLessThan(5.5);
        expect(Math.hypot(s.probe.velocity[i * 4], s.probe.velocity[i * 4 + 1], s.probe.velocity[i * 4 + 2])).toBeLessThanOrEqual(6.0001);
      }
    }
  });
});

const uniformsOf = (object: unknown) => (object as { material: ShaderMaterial }).material.uniforms;

/** The scene mounted as a layer would, on a renderer that records what it is asked to draw; the world is set by hand. */
function mount(quality: QualityProfile = QUALITY_PROFILES.medium) {
  const renderer = { getPixelRatio: () => 1, extensions: { has: () => true }, getRenderTarget: () => null, setRenderTarget: vi.fn(), render: vi.fn() };
  const passes: Pass[] = [];
  const scene = new RecipeVisualizer(typed, vectorFieldRecipe);
  scene.init({ renderer: renderer as unknown as WebGLRenderer, quality, width: 800, height: 600, addPass: (pass) => { passes.push(pass); } });
  scene.resize(800, 600);
  scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
  const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame, director = new VisualDirector(fieldScene.direction);
  const experience = createSnapshot(newFrame()), events = new EventStream(), world = experience.world;
  const clock: SceneClock = { time: 0, hits: { times: new Float64Array(8), strengths: new Float64Array(8), count: 0, size: 8 } as never, hitScale: 1, experience, events, light: 0 };
  const update = (seconds = 1, live = true, fps = 60) => {
    for (let i = 0; i < Math.round(seconds * fps); i++) {
      world.time += 1 / fps; world.travel += world.speed / fps; world.angle += world.spin / fps;
      clock.time = world.time;
      const modulation = director.update(response, DEFAULT_DIRECTION, 1 / fps, undefined, live ? experience : undefined);
      scene.update(audio, 1 / fps, world.time, response, modulation, live ? clock : undefined);
    }
  };
  const tracers = scene.world.primitive<FieldTracerPrimitive>('tracers')!, lines = scene.world.primitive<FieldLinePrimitive>('lines')!;
  const dispose = () => { scene.dispose(); for (const pass of passes) pass.dispose(); };
  return { scene, renderer, passes, world, experience, events, clock, response, update, dispose, tracers, lines };
}

afterEach(() => vi.restoreAllMocks());

describe('Vector Field (the scene)', () => {
  it('is a scene like any other: registered, a fixture of the show, known to the scene graph, a recipe of two primitives', () => {
    expect(findVisualizer('vector-field')).toBe(fieldScene);
    expect(fixtureById('vector-field')?.cost).toBeGreaterThan(0);
    expect(relationship('vector-field', 'matter-field')).toBeGreaterThan(relationship('vector-field', 'oscilloscope'));
    expect((fieldScene as VisualizerDefinition).create(fieldScene.preset)).toBeInstanceOf(RecipeVisualizer);
    const r = mount();
    expect(r.scene.world.mounted.map((m) => m.slot.id)).toEqual(['tracers', 'lines']);
    r.dispose();
  });

  it('is dark and still without sound: no field, no lines, tracers that show nothing', () => {
    const r = mount();
    r.update(2, false);
    const w = r.scene.world;
    expect(w.presence('lines')).toBe(0); expect(r.lines.object.visible).toBe(false);
    expect(r.tracers.state).toMatchObject({ motion: 0, rest: 0 });
    for (const key of ['surge', 'vortex', 'advection', 'drift', 'turbulence', 'shimmer'] as const) expect(w.uField[FIELD[key]]).toBe(0);
    expect(Array.from(uniformsOf(r.lines.object).uTopology.value as Float32Array)).toEqual([0, 0, 0, 0]);
    // With a clock but no sound it is the same.
    silent(r.experience, r.response); r.update(2);
    expect(r.tracers.state.motion).toBe(0); expect(w.presence('lines')).toBe(0);
    r.dispose();
  });

  it('tracers and lines read one field: the same packed fields, fronts and topology, the world\'s own arrays', () => {
    const r = mount(), w = r.scene.world;
    const simulation = uniformsOf({ material: (r.tracers.simulation as unknown as { material: ShaderMaterial }).material }), lines = uniformsOf(r.lines.object);
    expect(simulation.uField.value).toBe(w.uField); expect(lines.uField.value).toBe(w.uField);
    expect(simulation.uWaveA.value).toBe(w.uWaveA); expect(lines.uWaveB.value).toBe(w.uWaveB);
    expect(simulation.uTopology.value).toBe(lines.uTopology.value);
    alive(r.experience, r.response);
    Object.assign(r.world, { spin: 1.5, turbulence: 0.9, coherence: 0.2 });
    r.update(2);
    const topology = lines.uTopology.value as Float32Array;
    expect(w.uField[FIELD.vortex]).toBeGreaterThan(0.5);
    expect(topology[TOPOLOGY.eddies]).toBeGreaterThan(2); expect(topology[TOPOLOGY.eddy]).toBeGreaterThan(0.5); expect(topology[TOPOLOGY.well]).toBe(0);
    // Order and held potential: the eddies go back to sleep, the shells form.
    Object.assign(r.world, { turbulence: 0, coherence: 1, potential: 0.8 });
    r.update(1 / 60);
    expect(topology[TOPOLOGY.eddies]).toBe(0); expect(topology[TOPOLOGY.well]).toBeGreaterThan(1);
    // A heard event is one front for both.
    r.events.push('impact', r.world.time, 0.9, 1, 1, 0.7);
    r.update(0.1);
    expect(w.debug.waves).toBe(1); expect(Math.max(...w.uWaveB.filter((_, i) => i % 4 === 0))).toBeGreaterThan(0.2);
    r.dispose();
  });

  it('the world\'s light shows the field, the music\'s structure brings the lines, and silence takes both away again', () => {
    const r = mount(), w = r.scene.world, show = uniformsOf(r.lines.object).uShow.value as Vector4;
    alive(r.experience, r.response, 0.4);
    r.world.speed = 2;
    r.update(6);
    expect(r.tracers.state.motion).toBeGreaterThan(0.2); expect(r.tracers.state.rest).toBeLessThan(r.tracers.state.motion * 0.2);
    expect(w.presence('lines')).toBeGreaterThan(0.6); expect(r.lines.object.visible).toBe(true); expect(show.x).toBeGreaterThan(0.1);
    expect(r.lines.shape.reach).toBeGreaterThan(0); expect(r.lines.shape.step).toBeGreaterThan(0);
    // Light is not motion: a darker world shows less of the same field.
    const vortex = w.uField[FIELD.vortex], advection = w.uField[FIELD.advection], lit = r.tracers.state.motion;
    r.world.illumination = 0.2;
    r.update(1 / 60);
    expect(r.tracers.state.motion).toBeLessThan(lit * 0.6);
    expect(w.uField[FIELD.vortex]).toBeCloseTo(vortex, 3); expect(w.uField[FIELD.advection]).toBeCloseTo(advection, 3);
    silent(r.experience, r.response);
    r.update(40);
    expect(w.presence('lines')).toBeLessThan(0.01); expect(r.lines.object.visible).toBe(false);
    expect(r.tracers.state.motion).toBeLessThan(0.001); expect(r.tracers.state.rest).toBe(0);
    r.dispose();
  });

  it('advances the tracers by the same sub-steps at any frame rate, and not at all in a frame of no time', () => {
    const r = mount();
    for (const fps of [30, 60, 144]) {
      r.renderer.render.mockClear();
      r.update(1, true, fps);
      expect(r.renderer.render).toHaveBeenCalledTimes(fps * substeps(1 / fps));
    }
    r.renderer.render.mockClear();
    r.scene.update(new AudioAnalyzer().frame, 0, r.world.time, r.response, undefined, r.clock);
    expect(r.renderer.render).not.toHaveBeenCalled();
    r.dispose();
  });

  it('scales with quality: fewer tracers and lines, the same field; the memory pass above Low', () => {
    const [high, medium, low] = [QUALITY_PROFILES.high, QUALITY_PROFILES.medium, QUALITY_PROFILES.low].map(mount);
    for (const pick of [(r: typeof high) => r.tracers.vertices, (r: typeof high) => r.lines.vertices]) {
      expect(pick(high)).toBeGreaterThan(pick(medium)); expect(pick(medium)).toBeGreaterThan(pick(low)); expect(pick(low)).toBeGreaterThan(0);
    }
    expect(high.tracers.elements).toBeLessThanOrEqual(40_000);
    expect([high, medium, low].map((r) => r.passes.filter((pass) => pass instanceof FeedbackPass).length)).toEqual([1, 1, 0]);
    for (const r of [high, medium, low]) r.dispose();
  });

  it('runs a long session with a changing world: finite, bounded, the same objects, nothing recreated', () => {
    const r = mount(QUALITY_PROFILES.low), w = r.scene.world, topology = uniformsOf(r.lines.object).uTopology.value as Float32Array;
    const materials = vi.spyOn(Material.prototype, 'dispose');
    for (let section = 0; section < 40; section++) {
      const phase = section % 5;
      if (phase === 4) silent(r.experience, r.response); else alive(r.experience, r.response, 0.1 + 0.15 * phase);
      Object.assign(r.world, { spin: phase === 2 ? 2.5 : -0.4, speed: phase, turbulence: phase === 3 ? 0.95 : 0.1, potential: phase === 1 ? 0.9 : 0, radius: 0.25 * phase - 0.3, radialVelocity: phase - 1.5, bias: phase === 1 ? 0.7 : 0 });
      for (let beat = 0; beat < 12; beat++) {
        if (phase !== 4) r.events.push(beat % 6 === 0 ? 'drop' : 'impact', r.world.time, 0.5 + 0.04 * beat, 1, beat % 8, 0.6);
        r.update(0.5, true, 30);
      }
      for (const value of [...w.uField, ...w.uWaveA, ...w.uWaveB, ...topology, ...Object.values(r.tracers.state), ...Object.values(r.lines.shape), ...Object.values(r.scene.debug)]) expect(Number.isFinite(value)).toBe(true);
      for (const name of ['uShow', 'uGlow'] as const) for (const value of (uniformsOf(r.tracers.object.children[0])[name].value as Vector4).toArray()) expect(Number.isFinite(value)).toBe(true);
      expect(topology[TOPOLOGY.eddies]).toBeLessThanOrEqual(EDDIES); expect(w.uField[FIELD.radius]).toBeLessThanOrEqual(1.9);
      expect(r.tracers.state.motion).toBeLessThanOrEqual(1); expect(w.presence('lines')).toBeLessThanOrEqual(1);
    }
    expect(uniformsOf(r.lines.object).uTopology.value).toBe(topology); expect(w.mounted).toHaveLength(2);
    expect(materials).not.toHaveBeenCalled();
    r.dispose();
  }, 60_000);

  it('is deterministic by construction: nothing it draws depends on Math.random', () => {
    const run = (random: () => number) => {
      vi.spyOn(Math, 'random').mockImplementation(random);
      const r = mount(QUALITY_PROFILES.low);
      alive(r.experience, r.response); r.world.spin = 1; r.world.turbulence = 0.6;
      r.events.push('impact', 0.2, 0.9, 1, 3, 0.7);
      r.update(3);
      const seeds = r.tracers.simulation.seeds;
      const attributes = Object.values((r.lines.object as unknown as { geometry: BufferGeometry }).geometry.attributes).map((a) => Array.from(a.array as Float32Array).slice(0, 4000));
      const uniforms = [r.tracers.object.children[0], r.lines.object].map((object) => Object.entries(uniformsOf(object)).filter(([name]) => !name.startsWith('t') && !name.startsWith('uColor')).map(([, u]) => JSON.stringify(u.value)));
      const out = JSON.stringify([Array.from(seeds.home.subarray(0, 4000)), Array.from(seeds.trait.subarray(0, 4000)), attributes, uniforms, Array.from(r.scene.world.uField), r.scene.camera.position.toArray()]);
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
      const r = mount(quality);
      alive(r.experience, r.response); r.update(0.5);
      const memory = quality.density >= 0.6;
      for (const spy of [targets, textures, materials, geometries]) spy.mockClear();
      r.dispose();
      // The simulation's ping-pong targets (+ the memory's two).
      expect(targets).toHaveBeenCalledTimes(memory ? 4 : 2);
      // The tracers' two seed textures and the world's voice cycles.
      expect(textures.mock.contexts.filter((texture) => (texture as Texture & { isDataTexture?: boolean }).isDataTexture)).toHaveLength(3);
      // Simulation, streaks, heads, lines (+ the memory's two).
      expect(materials).toHaveBeenCalledTimes(4 + (memory ? 2 : 0));
      // Streaks, heads and lines; the full-screen triangles are extra.
      expect(geometries.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(r.scene.scene.children).toHaveLength(0); expect(r.scene.world.mounted).toHaveLength(0);
      vi.restoreAllMocks();
    }
  });
});
