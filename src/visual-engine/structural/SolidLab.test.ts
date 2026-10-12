import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Color, Material, type BufferAttribute, type ShaderMaterial, type WebGLRenderer } from 'three';
import { appMenu } from '../../app/menus';
import { AudioAnalyzer } from '../../audio/analysis/AudioAnalyzer';
import { SignalGenerator, type TestSignal } from '../../audio/capture/testSignals';
import { newFrame } from '../../audio/features/decode';
import { WasmAnalysis } from '../../audio/features/WasmAnalysis';
import { VisualResponse } from '../../audio/visual-response/VisualResponse';
import { DEFAULT_DIRECTION } from '../../director/profiles';
import { VisualDirector } from '../../director/VisualDirector';
import { EventStream } from '../../experience/EventStream';
import { ExperienceEngine } from '../../experience/ExperienceEngine';
import { createSnapshot, type ExperienceSnapshot } from '../../experience/types';
import { QUALITY_PROFILES } from '../../renderer/quality';
import { FIXTURES } from '../../show/fixtures';
import { DEFAULT_SETTINGS } from '../../stores/settingsStore';
import type { QualityProfile, SceneClock } from '../../types/visualizer';
import { findVisualizer, registerLaboratory, visualizers } from '../../visualizers/registry';
import { resetSolidLab, setSolidProfile, SOLID_DRAW_CALLS, SOLID_LAB_BUDGET, SOLID_LAB_ELEMENTS, SOLID_VIEWS, solidLab, type SolidPrimitive, type SolidView } from '../primitives/SolidPrimitive';
import { structuralLab } from '../primitives/WirePolygonPrimitive';
import { RecipeVisualizer } from '../RecipeVisualizer';
import lab, { SOLID_LAB, solidLabPreset, solidLabRecipe } from './lab/solid';
import { createReadout } from './SolidDynamics';
import { createFractureTuning, createSolidTuning, INTACT, PULSE_LIMIT, SOLID_KINDS, solidProfile } from './SolidTypes';
import { createTuning } from './StructuralTypes';

const SR = 48000;

/** The laboratory's world mounted as a layer would, on a renderer that draws nothing. */
function mount(quality: QualityProfile = QUALITY_PROFILES.high) {
  const renderer = { getPixelRatio: () => 1, extensions: { has: () => true }, getRenderTarget: () => null, setRenderTarget: vi.fn(), render: vi.fn() };
  const scene = new RecipeVisualizer(solidLabPreset, solidLabRecipe);
  scene.init({ renderer: renderer as unknown as WebGLRenderer, quality, width: 800, height: 600, addPass: () => undefined });
  scene.resize(800, 600);
  scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
  const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame, director = new VisualDirector(lab.direction);
  const clock: SceneClock = { time: 0, hits: { times: new Float64Array(8), strengths: new Float64Array(8), count: 0, size: 8 } as never, hitScale: 1, events: new EventStream(), light: 0.5 };
  const solid = scene.world.primitive<SolidPrimitive>('solid')!;
  /** One frame: with a heard snapshot the world is live, without one there is no clock. */
  const frame = (time: number, dt: number, snapshot?: ExperienceSnapshot) => {
    clock.time = time; clock.experience = snapshot;
    scene.update(audio, dt, time, response, director.update(response, DEFAULT_DIRECTION, dt, undefined, snapshot), snapshot ? clock : undefined);
  };
  const [faces, lines, nodes] = solid.object.children as unknown as { geometry: BufferGeometry; material: ShaderMaterial }[];
  return { scene, solid, system: solid.system, solids: solid.system.solids!, clock, frame, faces, lines, nodes };
}
type Mounted = ReturnType<typeof mount>;

/** A snapshot of a living, ordered, sounding world. */
function alive(): ExperienceSnapshot {
  const snapshot = createSnapshot(newFrame());
  Object.assign(snapshot.acoustic, { presence: 1, silent: 0, harmonicity: 0.9 });
  Object.assign(snapshot.world, { coherence: 0.95, illumination: 0.8, excitation: 0.4 });
  snapshot.resonance.mesoLevel.fill(0.4); snapshot.resonance.meso.fill(0.3);
  return snapshot;
}

/** A test signal through the real analysis (WASM) and experience, to the laboratory, frame by frame. */
async function play(signal: TestSignal, seconds: number, each: (t: number, m: Mounted, snapshot: ExperienceSnapshot) => void, before?: (m: Mounted) => void, fps = 60, calibrated = true) {
  const pcm = new Float32Array(seconds * SR * 2);
  new SignalGenerator(signal, SR).fillStereo(pcm, seconds * SR);
  const wasm = await WasmAnalysis.create(SR, 2), engine = new ExperienceEngine(), m = mount(), batch = 480;
  engine.calibration.enabled = calibrated;
  wasm.decoder.onFrame = (a) => engine.ingest(a); wasm.decoder.onOnset = (o) => engine.onset(o); wasm.decoder.onBeat = (b) => engine.beat(b); wasm.decoder.onSection = (s) => engine.section(s);
  m.clock.events = engine.events;
  before?.(m);
  let captured = 0;
  for (let f = 1; f <= seconds * fps; f++) {
    const t = f / fps;
    wasm.decoder.begin();
    while (captured + batch <= Math.floor(t * SR + 1e-6)) { wasm.push(pcm.subarray(captured * 2, (captured + batch) * 2)); captured += batch; }
    const snapshot = engine.present(t - 0.1);
    if (!snapshot) continue;
    m.frame(t - 0.1, 1 / fps, snapshot);
    each(t, m, snapshot);
  }
  wasm.dispose();
  return m;
}

afterEach(() => { vi.restoreAllMocks(); resetSolidLab(); });

describe('the Solid Dynamics laboratory', () => {
  it('is a development world, not a scene of the product', { timeout: 60000 }, () => {
    expect(visualizers.some((v) => v.id === SOLID_LAB)).toBe(false);
    expect(FIXTURES.some((f) => f.id === SOLID_LAB)).toBe(false);
    expect(findVisualizer(SOLID_LAB)).toBeUndefined();
    const scenes = appMenu('scene', DEFAULT_SETTINGS, false);
    expect(scenes?.items.some((item) => item.id === SOLID_LAB)).toBe(false);
    // The laboratory makes it mountable by id for as long as it is open, and withdraws it.
    const withdraw = registerLaboratory(lab);
    expect(findVisualizer(SOLID_LAB)).toBe(lab);
    expect(visualizers.some((v) => v.id === SOLID_LAB)).toBe(false);
    expect(appMenu('scene', DEFAULT_SETTINGS, false)).toEqual(scenes);
    expect(lab.create(lab.preset)).toBeInstanceOf(RecipeVisualizer);
    withdraw();
    expect(findVisualizer(SOLID_LAB)).toBeUndefined();
    // No scene of the product holds a solid, and none of them is a recipe with that slot.
    for (const definition of visualizers) {
      const scene = definition.create(definition.preset);
      if (!(scene instanceof RecipeVisualizer)) continue;
      scene.init({ renderer: { getPixelRatio: () => 1, extensions: { has: () => true }, getRenderTarget: () => null, setRenderTarget: vi.fn(), render: vi.fn() } as unknown as WebGLRenderer, quality: QUALITY_PROFILES.low, width: 320, height: 240, addPass: () => undefined });
      expect(scene.world.primitive('solid')).toBeUndefined();
      scene.dispose();
    }
  });

  it('holds one real body, still and unlit without sound, and the same body at every quality', { timeout: 60000 }, () => {
    const m = mount(), s = m.solids.state;
    expect(m.scene.world.mounted.map((x) => x.slot.id)).toEqual(['solid', 'shockwaves', 'lines']);
    expect(m.scene.world.resonance).not.toBeNull();
    expect(m.solids.read(0, null, createReadout())).toMatchObject({ kind: 'tetrahedron', vertices: 4, edgesIntact: 6, facesHolding: 4, cellsHolding: 1, sealed: true, form: 'volume' });
    const start = Array.from(m.system.state.position);
    for (let f = 1; f <= 240; f++) m.frame(f / 60, 1 / 60);
    const quiet = createSnapshot(newFrame());
    quiet.acoustic.silent = 1;
    for (let f = 241; f <= 600; f++) { quiet.world.time = quiet.state.time = f / 60; m.frame(f / 60, 1 / 60, quiet); }
    expect(Array.from(m.system.state.position)).toEqual(start);
    expect(m.solids.stats).toMatchObject({ kinetic: 0, fractures: 0, repairs: 0 });
    // Outside the laboratory nothing lights it without sound: the lamp is the laboratory's.
    const light = m.lines.geometry.attributes.aLine.array as Float32Array;
    for (let k = 0; k < s.links; k++) expect(light[k * 6]).toBe(0);
    m.scene.dispose();
    // Quality changes how much of the field is drawn round the body, never the body or its pools.
    for (const quality of [QUALITY_PROFILES.high, QUALITY_PROFILES.medium, QUALITY_PROFILES.low]) {
      const at = mount(quality), state = at.solids.state;
      expect([at.system.state.count, at.system.state.capacity, state.links, state.faces, state.cells, at.solids.budget.iterations])
        .toEqual([4, SOLID_LAB_ELEMENTS, 6, 4, 1, SOLID_LAB_BUDGET.iterations]);
      expect([state.linkCapacity, state.faceCapacity, state.cellCapacity]).toEqual([SOLID_LAB_BUDGET.links, SOLID_LAB_BUDGET.faces, SOLID_LAB_BUDGET.cells]);
      at.scene.dispose();
    }
  });

  it('draws the state of the simulation from fixed buffers, and releases everything it owns', { timeout: 60000 }, () => {
    const m = mount(), s = m.solids.state, matter = m.system.state, snapshot = alive();
    const buffers = () => [m.nodes.geometry.attributes.position.array, m.nodes.geometry.attributes.aNode.array, m.lines.geometry.attributes.position.array,
      m.lines.geometry.attributes.aLine.array, m.faces.geometry.attributes.position.array, m.faces.geometry.attributes.aFace.array];
    const arrays = buffers();
    expect(m.solid.object.children).toHaveLength(SOLID_DRAW_CALLS);
    expect(m.solid.vertices).toBe(SOLID_LAB_ELEMENTS + SOLID_LAB_BUDGET.links * 2 + SOLID_LAB_BUDGET.faces * 3);
    // The body as it always was: what this looks at is the path from the simulation to the buffers, whatever the material.
    solidLab.active = true; solidLab.view = 'all'; setSolidProfile('legacy');
    let t = 0;
    const run = (seconds: number) => { for (let f = 0; f < seconds * 60; f++) { t += 1 / 60; snapshot.world.time = snapshot.state.time = t; m.frame(t, 1 / 60, snapshot); } };
    for (const kind of SOLID_KINDS) {
      solidLab.kind = kind; run(0.5);
      solidLab.command = 'impulse'; run(0.5);
      const r = m.solids.read(0, m.solid.environment, createReadout());
      expect(r.kind).toBe(kind); expect(r.response).toBeGreaterThan(1e-3);
      // What is drawn is what holds: every vertex, every intact link, every triangle that holds.
      expect(m.nodes.geometry.drawRange.count).toBe(matter.count);
      expect(m.lines.geometry.drawRange.count).toBe(2 * m.solids.stats.intact);
      expect(m.faces.geometry.drawRange.count).toBe(3 * m.solids.stats.faces);
      expect(m.solid.drawn).toEqual({ points: matter.count, lines: m.solids.stats.intact, triangles: m.solids.stats.faces });
      // A drawn position is a position of the simulation carried by its own velocity over less than a step: nothing else moves a vertex.
      const shown = m.nodes.geometry.attributes.position.array as Float32Array, line = m.lines.geometry.attributes.position.array as Float32Array, face = m.faces.geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < matter.count; i++) for (let k = 0; k < 3; k++) expect(shown[i * 3 + k]).toBeCloseTo(matter.position[i * 3 + k] + matter.velocity[i * 3 + k] * m.system.alpha, 6);
      let segment = 0;
      for (let l = 0; l < s.links; l++) {
        if (s.linkState[l] !== INTACT) continue;
        for (let k = 0; k < 3; k++) { expect(line[segment * 6 + k]).toBe(shown[s.linkA[l] * 3 + k]); expect(line[segment * 6 + 3 + k]).toBe(shown[s.linkB[l] * 3 + k]); }
        segment++;
      }
      for (let f = 0; f < s.faces; f++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) expect(face[f * 9 + c * 3 + k]).toBe(shown[s.faceCorners[f * 3 + c] * 3 + k]);
      // Only the part of each pool in use is sent.
      expect((m.lines.geometry.attributes.position as BufferAttribute).updateRanges).toEqual([{ start: 0, count: 6 * m.solids.stats.intact }]);
    }
    buffers().forEach((array, k) => expect(array).toBe(arrays[k]));
    for (const array of arrays) for (let k = 0; k < array.length; k++) expect(Number.isFinite(array[k])).toBe(true);
    const geometries = vi.spyOn(BufferGeometry.prototype, 'dispose'), materials = vi.spyOn(Material.prototype, 'dispose');
    m.scene.dispose();
    for (const part of [m.faces, m.lines, m.nodes]) { expect(geometries.mock.contexts).toContain(part.geometry); expect(materials.mock.contexts).toContain(part.material); }
    expect(m.solid.object.children).toHaveLength(0);
  });

  it('follows the laboratory only while it is open: overrides, the solid, the tools, the views', { timeout: 60000 }, () => {
    const m = mount(), s = m.solids.state, snapshot = alive(), r = createReadout();
    let t = 0;
    const run = (seconds: number) => { for (let f = 0; f < seconds * 60; f++) { t += 1 / 60; snapshot.world.time = snapshot.state.time = t; m.frame(t, 1 / 60, snapshot); } };
    // Closed, the switch is ignored.
    Object.assign(solidLab, { kind: 'cube', command: 'fracture', view: 'vertices' }); solidLab.tuning.fractureThreshold = 0.2; solidLab.material.mass = 3;
    run(1);
    expect(m.solids.read(0, null, r).kind).toBe('tetrahedron'); expect(m.solids.stats.fractures).toBe(0);
    expect(m.system.tuning.fractureThreshold).toBe(1); expect(m.solids.tuning.mass).toBe(1); expect(solidLab.command).toBe('fracture');
    expect(m.lines.geometry.drawRange.count).toBe(12);
    resetSolidLab();
    // Open (on the legacy material: these are the tools as they were): another solid is seeded into the same pools.
    solidLab.active = true; solidLab.kind = 'cube'; setSolidProfile('legacy');
    const position = m.nodes.geometry.attributes.position.array;
    run(0.2);
    expect(m.solids.read(0, null, r)).toMatchObject({ kind: 'cube', vertices: 8, sealed: true }); expect(s.bodies).toBe(1); expect(m.nodes.geometry.attributes.position.array).toBe(position);
    // Overrides reach the simulation; the mass is the elements' own, scaled.
    const mass = r.mass;
    solidLab.material.mass = 2; solidLab.material.stiffness = 0.5; solidLab.tuning.environmentCoupling = 0.5; run(0.1);
    expect(m.solids.read(0, null, r).mass).toBeCloseTo(2 * mass, 4); expect(m.solids.tuning.stiffness).toBe(0.5); expect(m.system.tuning.environmentCoupling).toBe(0.5);
    solidLab.material = createSolidTuning(); solidLab.tuning = createTuning(); run(0.1);
    expect(m.solids.read(0, null, r).mass).toBeCloseTo(mass, 4);
    // The tools are impulses: the frame of the command moves no vertex further than its velocity, then the body answers.
    solidLab.command = 'twist'; run(0.3);
    expect(solidLab.command).toBeNull(); expect(m.solids.read(0, null, r).response).toBeGreaterThan(2e-3); expect(m.solids.stats.fractures).toBe(0);
    solidLab.command = 'reset'; run(0.1);
    expect(m.solids.read(0, null, r)).toMatchObject({ sealed: true, pieces: 1 }); expect(m.solids.stats.kinetic).toBeLessThan(0.05);
    // The fracture experiment changes the topology; the elements are the same eight.
    solidLab.command = 'fracture'; run(1.5);
    m.solids.read(0, null, r);
    expect(m.solids.stats.fractures).toBeGreaterThan(0); expect(r.broken).toBeGreaterThan(0); expect(r.sealed).toBe(false); expect(m.system.state.count).toBe(8);
    // Views single out parts of what is there; none of them changes the simulation.
    const drawn = (view: SolidView) => { solidLab.view = view; run(0.05); return { ...m.solid.drawn }; };
    const intact = () => m.solids.stats.intact, edges = () => { let n = 0; for (let l = 0; l < s.links; l++) if (s.linkState[l] === INTACT && s.linkKind[l] === 0) n++; return n; };
    const broken = () => m.solids.stats.broken;
    expect(drawn('vertices')).toEqual({ points: 8, lines: 0, triangles: 0 });
    expect(drawn('edges')).toEqual({ points: 0, lines: edges(), triangles: 0 });
    expect(drawn('faces')).toEqual({ points: 0, lines: 0, triangles: m.solids.stats.faces });
    expect(drawn('wireframe')).toEqual({ points: 8, lines: edges(), triangles: m.solids.stats.faces });
    // The constraints view shows what the others hide: braces, and the links that are only remembered.
    expect(drawn('constraints')).toEqual({ points: 8, lines: intact() + broken(), triangles: 0 });
    expect(drawn('fragments')).toEqual({ points: 8, lines: edges() + broken(), triangles: m.solids.stats.faces });
    expect(drawn('all')).toEqual({ points: 8, lines: intact() + broken(), triangles: m.solids.stats.faces });
    expect(SOLID_VIEWS).toHaveLength(7);
    // In the fragments view the pieces take colours apart.
    solidLab.view = 'fragments'; run(0.05);
    const look = m.nodes.geometry.attributes.aNode.array as Float32Array, hues = new Set<number>(), pieces = new Set<number>();
    for (let i = 0; i < 8; i++) { hues.add(look[i * 4 + 2]); pieces.add(s.component[i]); }
    expect(pieces.size).toBe(s.bodyPieces[0]); expect(hues.size).toBe(pieces.size);
    // Seeded loose, it forms by itself in the living world of the laboratory.
    solidLab.kind = 'tetrahedron'; solidLab.command = 'seed'; solidLab.view = 'wireframe'; run(0.1);
    expect(m.solids.read(0, null, r)).toMatchObject({ kind: 'tetrahedron', pieces: 4, form: 'free', edgesIntact: 0 });
    // The laboratory lights its subject without waiting for the sound; the other laboratory's switch is not touched.
    expect((m.nodes.geometry.attributes.aNode.array as Float32Array)[1]).toBeGreaterThan(0.2); expect(structuralLab.active).toBe(false);
    m.scene.dispose();
  });
});

describe('the reference demonstration, on a real signal through the whole path', () => {
  it('legacy material, ambient → build → drop: the body rings whole through the opening, gives way with the drop, and its pieces start to find each other', { timeout: 240000 }, async () => {
    for (const kind of SOLID_KINDS) {
      const r = createReadout(), opening = { deformed: 0, low: 1, high: 1, meso: 0, stress: 0, signs: 0, last: 0, fractures: 0 };
      const life = { brokenAt: -1, least: Infinity, steps: 0, kinetic: 0, excitation: 0 };
      let elements = 0;
      const m = await play('buildDrop', 32, (t, mounted, snapshot) => {
        const solids = mounted.solids, matter = mounted.system.state;
        solids.read(0, mounted.solid.environment, r);
        elements ||= matter.count;
        expect(matter.count).toBe(elements);
        life.steps = Math.max(life.steps, mounted.system.stats.steps);
        if (t < 11) {
          // The ambient opening: the music reaches the body through its resonance and deforms it, whole.
          opening.deformed = Math.max(opening.deformed, r.response); opening.meso = Math.max(opening.meso, r.meso); opening.stress = Math.max(opening.stress, r.peak);
          opening.low = Math.min(opening.low, r.volume / r.volumeReference); opening.high = Math.max(opening.high, r.volume / r.volumeReference);
          opening.fractures = solids.stats.fractures;
          // Its links swing with the sound: their strain changes sign.
          const strain = solids.state.linkStrain[0];
          if (strain * opening.last < 0) opening.signs++;
          if (strain !== 0) opening.last = strain;
        }
        if (life.brokenAt < 0 && solids.stats.fractures > 0) life.brokenAt = t;
        if (life.brokenAt >= 0) {
          life.least = Math.min(life.least, solids.stats.intact);
          // Two seconds on, the pieces still answer the sound and still move.
          if (t > life.brokenAt + 2 && t < life.brokenAt + 2.1) { life.kinetic = r.kinetic; life.excitation = r.meso; }
        }
        if (Math.round(t * 60) % 30 === 0) {
          for (const value of [r.kinetic, r.elastic, r.stress, r.volume, r.response, snapshot.resonance.mesoEnergy]) expect(Number.isFinite(value)).toBe(true);
          for (let i = 0; i < matter.count; i++) expect(Math.hypot(matter.position[i * 3], matter.position[i * 3 + 1], matter.position[i * 3 + 2])).toBeLessThan(8.001);
        }
      }, () => { solidLab.active = true; solidLab.kind = kind; setSolidProfile('legacy'); });
      const stats = m.solids.stats, links = m.solids.state.links;
      // Whole through the opening, and observably deformed by it: a few per cent of its links' length, a few of its volume.
      expect(opening.fractures).toBe(0); expect(opening.meso).toBeGreaterThan(0.3);
      expect(opening.deformed).toBeGreaterThan(0.02); expect(opening.deformed).toBeLessThan(0.15); expect(opening.signs).toBeGreaterThan(10);
      expect(opening.low).toBeGreaterThan(0.85); expect(opening.high).toBeLessThan(1.15); expect(opening.high - opening.low).toBeGreaterThan(0.03);
      expect(opening.stress).toBeLessThan(0.9);
      // The build and the drop break it: most of its links, none of its elements.
      expect(life.brokenAt).toBeGreaterThan(11); expect(life.brokenAt).toBeLessThan(20);
      expect(life.least).toBeLessThanOrEqual(0.4 * links);
      expect(life.excitation).toBeGreaterThan(0.2); expect(life.kinetic).toBeGreaterThan(1e-3);
      // Nothing was created or removed: every link is holding, remembered or forgotten, and no more formed again than broke.
      expect(stats.intact + stats.broken + stats.lost).toBe(links); expect(stats.reforms).toBeLessThanOrEqual(stats.fractures);
      expect(stats.repairs).toBe(0); expect(life.steps).toBeLessThanOrEqual(8);
      // In the calmer music after it the pieces of the simpler bodies rejoin, link by link.
      if (kind === 'tetrahedron') { expect(stats.reforms).toBeGreaterThanOrEqual(3); expect(stats.intact).toBeGreaterThan(life.least + 2); }
      m.scene.dispose();
      resetSolidLab();
    }
  });

  it('rigid material, ambient → build → drop: it keeps its shape and pulses through the opening and the build, breaks once at the drop, and finds itself again', { timeout: 300000 }, async () => {
    for (const kind of SOLID_KINDS) {
      const r = createReadout(), whole = { deviation: 0, low: 1, high: 1, fractures: 0 }, life = { brokenAt: -1, least: Infinity, pieces: 0, wholeAt: -1, jump: 0 };
      const last = new Float64Array(SOLID_LAB_ELEMENTS * 3);
      let elements = 0, learned = 1;
      const m = await play('buildDrop', 44, (t, mounted, snapshot) => {
        const solids = mounted.solids, matter = mounted.system.state;
        solids.read(0, mounted.solid.environment, r);
        elements ||= matter.count;
        expect(matter.count).toBe(elements);
        // Nothing ever moves further in a frame than the fastest matter can: not at the fracture, not when it comes together.
        for (let i = 0; i < matter.count * 3; i++) { if (t > 0.2) life.jump = Math.max(life.jump, Math.abs(matter.position[i] - last[i])); last[i] = matter.position[i]; }
        if (life.brokenAt < 0 && solids.stats.fractures > 0) { life.brokenAt = t; learned = snapshot.calibration.confidence; }
        if (life.brokenAt < 0) {
          whole.deviation = Math.max(whole.deviation, r.deviation); whole.low = Math.min(whole.low, r.scale); whole.high = Math.max(whole.high, r.scale);
        } else {
          life.least = Math.min(life.least, solids.stats.intact); life.pieces = Math.max(life.pieces, r.pieces);
          if (life.wholeAt < 0 && r.sealed) life.wholeAt = t;
        }
        // The pulse of every piece that is one shape stays within the limit, all the way.
        expect(r.scale).toBeLessThanOrEqual(1 + PULSE_LIMIT + 1e-9); expect(r.scale).toBeGreaterThanOrEqual(1 - PULSE_LIMIT - 1e-9);
        expect(Math.abs(r.pulse)).toBeLessThanOrEqual(PULSE_LIMIT);
        if (Math.round(t * 60) % 30 === 0) for (const value of [r.kinetic, r.deviation, r.scale, r.volume, snapshot.calibration.gain, snapshot.calibration.energy]) expect(Number.isFinite(value)).toBe(true);
      }, () => { solidLab.active = true; solidLab.kind = kind; });
      const stats = m.solids.stats, links = m.solids.state.links;
      // The laboratory opens on the rigid body that breaks on events.
      expect(m.solids.tuning).toEqual(solidProfile('rigid')); expect(m.solids.gate.tuning.mode).toBe('events');
      // Whole through the ambient opening and the build, itself to a twentieth of a per cent, and pulsing by several per cent.
      expect(whole.deviation, kind).toBeLessThan(0.002); expect(whole.high - whole.low, kind).toBeGreaterThan(0.05);
      // It breaks once the track is known, at the drop: by an event, in part, into a few pieces.
      expect(life.brokenAt, kind).toBeGreaterThan(18); expect(life.brokenAt, kind).toBeLessThan(23); expect(learned).toBeGreaterThan(0.5);
      expect(stats.events, kind).toBeGreaterThanOrEqual(1); expect(stats.events, kind).toBeLessThanOrEqual(2);
      expect(life.least, kind).toBeGreaterThanOrEqual(0.4 * links); expect(life.least, kind).toBeLessThan(links); expect(life.pieces, kind).toBeLessThanOrEqual(4);
      expect(m.solids.gate.stats.threshold, kind).toBeGreaterThan(50);
      // In the music after it the pieces come together again by their own memory, with no jump, and the body is whole and itself.
      expect(stats.reforms, kind).toBeGreaterThan(0); expect(life.wholeAt, kind).toBeGreaterThan(life.brokenAt + 1.5); expect(life.wholeAt, kind).toBeLessThan(44);
      expect(life.jump, kind).toBeLessThanOrEqual(12 / 60 + 1e-6); expect(life.jump, kind).toBeLessThan(0.1);
      expect(m.solids.read(0, m.solid.environment, r), kind).toMatchObject({ pieces: 1, sealed: true, form: 'volume' }); expect(r.deviation, kind).toBeLessThan(0.005);
      expect(stats.intact + stats.broken + stats.lost).toBe(links); expect(stats.repairs).toBe(0);
      m.scene.dispose();
      resetSolidLab();
    }
  });

  it('the calibration is what makes it answer: switched off, the same sound moves it far less and breaks nothing', { timeout: 300000 }, async () => {
    const life = async (calibrated: boolean) => {
      const r = createReadout(), seen = { low: 1, high: 1, drive: 0 };
      // The same seed, the same signal, the same steps: only the calibration differs.
      const m = await play('buildDrop', 30, (t, mounted, snapshot) => {
        expect(snapshot.calibration.phase === 'off').toBe(!calibrated);
        mounted.solids.read(0, mounted.solid.environment, r);
        // Once the first seconds have passed: the uncalibrated lows have then risen to their level and stay there.
        if (t > 16 && mounted.solids.stats.fractures === 0) { seen.low = Math.min(seen.low, r.scale); seen.high = Math.max(seen.high, r.scale); seen.drive = Math.max(seen.drive, mounted.solid.environment.pulse); }
      }, () => { solidLab.active = true; solidLab.kind = 'cube'; }, 60, calibrated);
      const out = { ...seen, events: m.solids.stats.events, fired: m.solids.gate.stats.fired, offered: m.solids.gate.stats.offered };
      m.scene.dispose(); resetSolidLab();
      return out;
    };
    const on = await life(true), off = await life(false);
    // Uncalibrated, every attack is its own strength: all of them reach the gate, and none of them stands out.
    expect(off.offered).toBeGreaterThanOrEqual(on.offered); expect(on.fired).toBeGreaterThan(0); expect(off.fired).toBe(0); expect(off.events).toBe(0);
    expect(on.high - on.low).toBeGreaterThan(2 * (off.high - off.low));
  });
});

describe('the laboratory: materials and the ways of breaking', () => {
  it('opens on the rigid body, changes material in place, and breaks by its tool through the gate', { timeout: 60000 }, () => {
    const m = mount(), snapshot = alive(), r = createReadout();
    let t = 0;
    const run = (seconds: number) => { for (let f = 0; f < seconds * 60; f++) { t += 1 / 60; snapshot.world.time = snapshot.state.time = t; m.frame(t, 1 / 60, snapshot); } };
    expect(solidLab).toMatchObject({ profile: 'rigid', material: solidProfile('rigid'), fracture: { mode: 'events' } });
    // Closed, a body of the product is the body it always was.
    run(0.2);
    expect(m.solids.tuning).toEqual(createSolidTuning()); expect(m.solids.gate.tuning).toEqual(createFractureTuning());
    solidLab.active = true; solidLab.kind = 'cube'; run(0.2);
    expect(m.solids.tuning.shapeRetention).toBe(0.9); expect(m.solids.gate.tuning.mode).toBe('events');
    // The same blow on the rigid body and on the legacy one, in the same world: a tenth of the deformation.
    const hit = (): number => { solidLab.command = 'reset'; run(0.3); solidLab.command = 'impulse'; let peak = 0; for (let k = 0; k < 30; k++) { run(1 / 60); peak = Math.max(peak, m.solids.read(0, m.solid.environment, r).deviation); } return peak; };
    const rigid = hit();
    setSolidProfile('legacy'); const legacy = hit();
    setSolidProfile('elastic'); const elastic = hit();
    expect(rigid).toBeLessThan(0.2 * legacy); expect(elastic).toBeGreaterThan(rigid); expect(elastic).toBeLessThan(legacy);
    expect(solidLab.fracture.mode).toBe('events'); expect(m.solids.stats.fractures).toBe(0);
    // The fracture tool on a body that breaks on events only: one fracture, through the gate, at once.
    setSolidProfile('rigid'); solidLab.command = 'reset'; run(0.2);
    solidLab.command = 'fracture'; run(0.2);
    expect(m.solids.gate.stats).toMatchObject({ manual: 1, verdict: 'manual' }); expect(m.solids.stats.events).toBe(1); expect(m.solids.stats.fractures).toBeGreaterThan(0);
    expect(m.solids.read(0, m.solid.environment, r).sealed).toBe(false); expect(m.system.state.count).toBe(8);
    // On the legacy material the same tool is the blow it was, and the gate is not asked.
    setSolidProfile('legacy'); solidLab.command = 'reset'; run(0.2);
    expect(m.solids.gate.tuning.mode).toBe('load');
    solidLab.command = 'fracture'; run(1.5);
    expect(m.solids.gate.stats.manual).toBe(0); expect(m.solids.stats.events).toBe(0); expect(m.solids.stats.fractures).toBeGreaterThan(0);
    // The sliders of the gate reach it, within their bounds.
    setSolidProfile('rigid'); solidLab.fracture.threshold = 0.9; solidLab.fracture.cooldown = 8; solidLab.fracture.confidence = 0.7; run(0.1);
    expect(m.solids.gate.tuning).toMatchObject({ mode: 'events', threshold: 0.9, cooldown: 8, confidence: 0.7 });
    m.scene.dispose();
  });

  it('hears the events of the session by their own time, from when it is mounted, and pulses with the calibrated lows', { timeout: 60000 }, () => {
    const m = mount(), snapshot = alive(), r = createReadout(), events = m.clock.events!;
    let t = 0;
    const run = (seconds: number, each?: () => void) => { for (let f = 0; f < Math.round(seconds * 60); f++) { t += 1 / 60; snapshot.world.time = snapshot.state.time = t; each?.(); m.frame(t, 1 / 60, snapshot); } };
    // What the session held before the body was there does not strike it.
    events.push('impact', 0.01, 0.9, 1, 1, 0.9, 0, 1);
    solidLab.active = true; solidLab.kind = 'icosahedron';
    run(4);
    expect(m.solids.gate.stats.offered).toBe(0); expect(m.solids.stats.fractures).toBe(0);
    // Ordinary attacks of the track pass through the gate and are refused; the body is whole.
    for (let k = 0; k < 6; k++) { events.push('impact', t, 0.3, 0.9, 1, 0.4, 0, 0.4); run(0.5); }
    expect(m.solids.gate.stats).toMatchObject({ offered: 6, threshold: 6, fired: 0 }); expect(m.solids.stats.fractures).toBe(0);
    // One that stands out, dated a little ahead of what is heard: it is taken when its time is reached, not when it arrives.
    events.push('impact', t + 0.3, 0.6, 0.9, 1, 0.8, 0, 0.95);
    run(0.2);
    expect(m.solids.stats.events).toBe(0);
    run(0.3);
    expect(m.solids.stats.events).toBe(1); expect(m.solids.gate.stats.fired).toBe(1); expect(m.solids.gate.time).toBeCloseTo(t - 0.2, 1);
    // Without a clock no event is heard at all.
    events.push('impact', t, 0.6, 0.9, 1, 0.8, 0, 1);
    const offered = m.solids.gate.stats.offered;
    for (let f = 0; f < 30; f++) { t += 1 / 60; m.frame(t, 1 / 60); }
    expect(m.solids.gate.stats.offered).toBe(offered);
    // The pulse: the lows as the calibration hands them over reach the body through the geometry, and nothing else does.
    solidLab.command = 'reset'; run(0.5);
    let high = 0, low = 0;
    run(6, () => { const beat = t % 0.5; snapshot.calibration.low = beat < 0.12 ? 0.9 : 0.15; snapshot.calibration.energy = 0.6; });
    run(2, () => { const beat = t % 0.5; snapshot.calibration.low = beat < 0.12 ? 0.9 : 0.15; high = Math.max(high, m.solids.pulseOf(0)); low = Math.min(low, m.solids.pulseOf(0)); });
    expect(m.solid.environment.pulse).toBeGreaterThan(0); expect(high).toBeGreaterThan(0.015); expect(low).toBeLessThan(-0.005);
    expect(m.solids.read(0, m.solid.environment, r).deviation).toBeLessThan(0.01);
    snapshot.calibration.low = 0; snapshot.calibration.energy = 0; run(10);
    expect(Math.abs(m.solids.pulseOf(0))).toBeLessThan(1e-3);
    m.scene.dispose();
  });
});
