import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Color, Material, type ShaderMaterial, type WebGLRenderer } from 'three';
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
import type { QualityProfile, SceneClock, VisualizerPreset } from '../../types/visualizer';
import matterPreset from '../../visualizers/matter-field/preset.json';
import { matterFieldRecipe, type MatterFieldParams } from '../../visualizers/matter-field/recipe';
import { findVisualizer, registerLaboratory, visualizers } from '../../visualizers/registry';
import type { STRUCTURE_VIEWS, WirePolygonPrimitive } from '../primitives/WirePolygonPrimitive';
import { structuralLab, structureQuality, WIRE_SEGMENTS, wirePoint } from '../primitives/WirePolygonPrimitive';
import { RecipeVisualizer } from '../RecipeVisualizer';
import lab, { STRUCTURAL_LAB, structuralLabPreset } from './lab/index';
import { structuralLabRecipe } from './lab/recipe';
import { createTuning } from './StructuralTypes';

const SR = 48000;

/** The lab mounted as a layer would, on a renderer that draws nothing. */
function mount(quality: QualityProfile = QUALITY_PROFILES.high) {
  const renderer = { getPixelRatio: () => 1, extensions: { has: () => true }, getRenderTarget: () => null, setRenderTarget: vi.fn(), render: vi.fn() };
  const scene = new RecipeVisualizer(structuralLabPreset, structuralLabRecipe);
  scene.init({ renderer: renderer as unknown as WebGLRenderer, quality, width: 800, height: 600, addPass: () => undefined });
  scene.resize(800, 600);
  scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
  const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame, director = new VisualDirector(lab.direction);
  const clock: SceneClock = { time: 0, hits: { times: new Float64Array(8), strengths: new Float64Array(8), count: 0, size: 8 } as never, hitScale: 1, events: new EventStream(), light: 0.5 };
  const structure = scene.world.primitive<WirePolygonPrimitive>('structure')!;
  /** One frame: with a heard snapshot the world is live, without one there is no clock. */
  const frame = (time: number, dt: number, snapshot?: ExperienceSnapshot) => {
    clock.time = time; clock.experience = snapshot;
    scene.update(audio, dt, time, response, director.update(response, DEFAULT_DIRECTION, dt, undefined, snapshot), snapshot ? clock : undefined);
  };
  return { scene, structure, system: structure.system, clock, frame };
}

/** A test signal through the real analysis (WASM) and experience, to the lab, frame by frame. */
async function play(signal: TestSignal, seconds: number, each: (t: number, m: ReturnType<typeof mount>, snapshot: ExperienceSnapshot) => void, fps = 60) {
  const pcm = new Float32Array(seconds * SR * 2);
  new SignalGenerator(signal, SR).fillStereo(pcm, seconds * SR);
  const wasm = await WasmAnalysis.create(SR, 2), engine = new ExperienceEngine(), m = mount(), batch = 480;
  wasm.decoder.onFrame = (a) => engine.ingest(a); wasm.decoder.onOnset = (o) => engine.onset(o); wasm.decoder.onBeat = (b) => engine.beat(b); wasm.decoder.onSection = (s) => engine.section(s);
  m.clock.events = engine.events;
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

/** Bonds among the seeded polygon's own matter, and the size of the loop it closes (0: open). */
function figure(m: ReturnType<typeof mount>) {
  const s = m.system.state;
  let bonds = 0, loop = 0;
  for (let b = 0; b < s.bondCapacity; b++) if (s.bondAlive[b] && s.kin[s.bondA[b]] >= 0 && s.kin[s.bondB[b]] >= 0) bonds++;
  for (let L = 0; L < s.loops; L++) if (s.kin[s.loopCorners[L * s.maxSides]] >= 0) loop = s.loopSize[L];
  return { bonds, loop };
}

afterEach(() => { vi.restoreAllMocks(); Object.assign(structuralLab, { active: false, tuning: createTuning(), view: 'all', sides: 4, command: null }); });

describe('the law of a wire', () => {
  it('is a straight line without resonance, held at both ends with it, and bounded', { timeout: 60000 }, () => {
    const A = [0.2, -0.1, 0.3], B = [0.9, 0.4, 0.1];
    for (let k = 0; k <= 8; k++) {
      const s = k / 8, p = wirePoint(A[0], A[1], A[2], B[0], B[1], B[2], s, 0, 0, 0);
      for (let c = 0; c < 3; c++) expect(p[c]).toBeCloseTo(A[c] + (B[c] - A[c]) * s, 12);
    }
    for (const modes of [[0.06, 0, 0], [0.06, -0.04, 0.02], [-0.075, 0.045, 0.03]]) {
      const start = Array.from(wirePoint(A[0], A[1], A[2], B[0], B[1], B[2], 0, modes[0], modes[1], modes[2]));
      const end = Array.from(wirePoint(A[0], A[1], A[2], B[0], B[1], B[2], 1, modes[0], modes[1], modes[2]));
      for (let c = 0; c < 3; c++) { expect(start[c]).toBeCloseTo(A[c], 12); expect(end[c]).toBeCloseTo(B[c], 12); }
      const length = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
      let most = 0;
      for (let k = 1; k < WIRE_SEGMENTS; k++) {
        const s = k / WIRE_SEGMENTS, p = wirePoint(A[0], A[1], A[2], B[0], B[1], B[2], s, modes[0], modes[1], modes[2]);
        most = Math.max(most, Math.hypot(p[0] - (A[0] + (B[0] - A[0]) * s), p[1] - (A[1] + (B[1] - A[1]) * s), p[2] - (A[2] + (B[2] - A[2]) * s)));
      }
      expect(most).toBeGreaterThan(0.01 * length); expect(most).toBeLessThan(0.2 * length);
    }
    // A wire along the world's axis still has a plane to vibrate in, and a degenerate one is finite.
    for (const p of [wirePoint(0, 0, 0, 0, 0, 1, 0.5, 0.06, 0, 0), wirePoint(1, 1, 1, 1, 1, 1, 0.5, 0.06, 0.04, 0.02)]) for (let c = 0; c < 3; c++) expect(Number.isFinite(p[c])).toBe(true);
    expect(Math.abs(wirePoint(0, 0, 0, 0, 0, 1, 0.5, 0.06, 0, 0)[0])).toBeCloseTo(0.06, 6);
  });
});

describe('the Structural Lab', () => {
  it('is a development world, not a scene of the product', { timeout: 60000 }, () => {
    expect(visualizers.some((v) => v.id === STRUCTURAL_LAB)).toBe(false);
    expect(FIXTURES.some((f) => f.id === STRUCTURAL_LAB)).toBe(false);
    expect(findVisualizer(STRUCTURAL_LAB)).toBeUndefined();
    const scenes = appMenu('scene', DEFAULT_SETTINGS, false);
    expect(scenes?.items.some((item) => item.id === STRUCTURAL_LAB)).toBe(false);
    // The engine cockpit makes it mountable by id for as long as it is open, and withdraws it.
    const withdraw = registerLaboratory(lab);
    expect(findVisualizer(STRUCTURAL_LAB)).toBe(lab);
    expect(visualizers.some((v) => v.id === STRUCTURAL_LAB)).toBe(false);
    expect(appMenu('scene', DEFAULT_SETTINGS, false)).toEqual(scenes);
    expect(lab.create(lab.preset)).toBeInstanceOf(RecipeVisualizer);
    withdraw();
    expect(findVisualizer(STRUCTURAL_LAB)).toBeUndefined();
    // The scenes of the product still resolve, and the worlds that did not ask for it keep no resonance field.
    expect(findVisualizer('spectrum')?.id).toBe('spectrum');
    const matter = new RecipeVisualizer(matterPreset as VisualizerPreset<MatterFieldParams>, matterFieldRecipe);
    matter.init({ renderer: { getPixelRatio: () => 1, extensions: { has: () => true }, getRenderTarget: () => null, setRenderTarget: vi.fn(), render: vi.fn() } as unknown as WebGLRenderer, quality: QUALITY_PROFILES.low, width: 320, height: 240, addPass: () => undefined });
    expect(matter.world.resonance).toBeNull(); expect(matter.world.frame.resonance).toBeUndefined();
    matter.dispose();
  });

  it('is dark and still without sound: loose matter that tends to a square, and nothing moving', { timeout: 60000 }, () => {
    const m = mount(), s = m.system.state;
    expect(m.scene.world.mounted.map((x) => x.slot.id)).toEqual(['structure', 'shockwaves', 'lines']);
    expect(m.scene.world.resonance).not.toBeNull();
    expect(s.count).toBe(8 + structureQuality(structuralLabPreset.visual, QUALITY_PROFILES.high).elements);
    const start = Array.from(s.position);
    for (let f = 1; f <= 240; f++) m.frame(f / 60, 1 / 60);
    expect(Array.from(s.position)).toEqual(start);
    expect(s.bonds).toBe(0); expect(m.system.stats.kinetic).toBe(0);
    const look = m.structure.object.children[2] as unknown as { geometry: BufferGeometry };
    const light = look.geometry.attributes.aNode.array as Float32Array;
    for (let i = 0; i < s.count; i++) expect(light[i * 4 + 1]).toBe(0);
    // A silent snapshot (a clock, no sound) changes nothing either.
    const quiet = createSnapshot(newFrame());
    quiet.acoustic.silent = 1;
    for (let f = 241; f <= 600; f++) { quiet.world.time = quiet.state.time = f / 60; m.frame(f / 60, 1 / 60, quiet); }
    expect(s.bonds).toBe(0); expect(m.system.stats.kinetic).toBeLessThan(1e-9);
    m.scene.dispose();
  });

  it('draws from fixed buffers and releases everything it owns', { timeout: 60000 }, () => {
    const m = mount(), [faces, wires, nodes] = m.structure.object.children as unknown as { geometry: BufferGeometry & { instanceCount?: number }; material: ShaderMaterial }[];
    const arrays = [nodes.geometry.attributes.position.array, nodes.geometry.attributes.aNode.array, wires.geometry.attributes.aA.array, wires.geometry.attributes.aModes.array, faces.geometry.attributes.position.array];
    const snapshot = createSnapshot(newFrame());
    Object.assign(snapshot.acoustic, { presence: 1, silent: 0, harmonicity: 0.9 });
    Object.assign(snapshot.world, { coherence: 0.95, illumination: 0.8, excitation: 0.4 });
    snapshot.resonance.mesoLevel.fill(0.4); snapshot.resonance.meso.fill(0.3);
    structuralLab.active = true; structuralLab.command = 'form';
    for (let f = 1; f <= 600; f++) { snapshot.world.time = snapshot.state.time = f / 60; m.frame(f / 60, 1 / 60, snapshot); }
    // The polygon made whole by the development command is drawn: its wires and joints as instances, its face as triangles.
    expect(figure(m)).toEqual({ bonds: 8, loop: 4 });
    expect(wires.geometry.instanceCount).toBeGreaterThanOrEqual(8);
    expect(faces.geometry.drawRange.count).toBeGreaterThanOrEqual(12);
    expect(nodes.geometry.drawRange.count).toBe(m.system.state.count);
    expect([nodes.geometry.attributes.position.array, nodes.geometry.attributes.aNode.array, wires.geometry.attributes.aA.array, wires.geometry.attributes.aModes.array, faces.geometry.attributes.position.array])
      .toEqual(arrays);
    [nodes.geometry.attributes.position.array, nodes.geometry.attributes.aNode.array, wires.geometry.attributes.aA.array, wires.geometry.attributes.aModes.array, faces.geometry.attributes.position.array]
      .forEach((array, k) => expect(array).toBe(arrays[k]));
    for (const array of arrays) for (let k = 0; k < array.length; k++) expect(Number.isFinite(array[k])).toBe(true);
    // Its wires ring: string modes reach the GPU, bounded.
    const modes = wires.geometry.attributes.aModes.array as Float32Array;
    expect(Math.max(...Array.from(modes.subarray(0, 24), Math.abs))).toBeGreaterThan(0);
    expect(Math.max(...Array.from(modes, Math.abs))).toBeLessThan(0.1);
    expect(m.structure.vertices).toBe(m.system.state.capacity + m.system.state.bondCapacity * WIRE_SEGMENTS * 2 + m.system.state.loopCapacity * m.system.state.maxSides * 3);
    const geometries = vi.spyOn(BufferGeometry.prototype, 'dispose'), materials = vi.spyOn(Material.prototype, 'dispose');
    m.scene.dispose();
    for (const part of [faces, wires, nodes]) { expect(geometries.mock.contexts).toContain(part.geometry); expect(materials.mock.contexts).toContain(part.material); }
    expect(m.structure.object.children).toHaveLength(0);
  });

  it('follows the development cockpit only while it is open: overrides, the geometry singled out, the polygon, the commands', { timeout: 60000 }, () => {
    const m = mount(), s = m.system.state, nodes = (m.structure.object.children[2] as unknown as { geometry: BufferGeometry }).geometry;
    const snapshot = createSnapshot(newFrame());
    Object.assign(snapshot.acoustic, { presence: 1, silent: 0, harmonicity: 0.9 });
    Object.assign(snapshot.world, { coherence: 0.95, illumination: 0.8, excitation: 0.4 });
    snapshot.resonance.mesoLevel.fill(0.4); snapshot.resonance.meso.fill(0.3);
    let t = 0;
    const run = (seconds: number) => { for (let f = 0; f < seconds * 60; f++) { t += 1 / 60; snapshot.world.time = snapshot.state.time = t; m.frame(t, 1 / 60, snapshot); } };
    // Closed, the switch is ignored.
    Object.assign(structuralLab.tuning, { temperature: 1 }); structuralLab.command = 'form'; structuralLab.sides = 6;
    run(1);
    expect(m.system.tuning.temperature).toBeNull(); expect(s.bonds).toBe(0); expect(s.count).toBe(128);
    structuralLab.command = null; structuralLab.sides = 4; structuralLab.tuning = createTuning();
    // Open: a polygon of another order is seeded (the matter is replaced, the pools are not).
    structuralLab.active = true; structuralLab.sides = 6;
    const position = nodes.attributes.position.array;
    run(0.1);
    expect(s.count).toBe(12 + 120); expect(nodes.attributes.position.array).toBe(position);
    structuralLab.command = 'form'; run(0.5);
    expect(figure(m)).toEqual({ bonds: 12, loop: 6 }); expect(structuralLab.command).toBeNull();
    // Overrides reach the simulation: a fracture threshold near zero breaks it at once.
    structuralLab.tuning.fractureThreshold = 0.05; run(0.5);
    expect(m.system.tuning.fractureThreshold).toBe(0.05); expect(figure(m).bonds).toBe(0); expect(s.count).toBe(132);
    // Singling a geometry out only changes what is lit.
    const lit = (view: typeof STRUCTURE_VIEWS[number]) => {
      structuralLab.view = view; run(0.05);
      const look = nodes.attributes.aNode.array as Float32Array;
      let figureLight = 0, matterLight = 0;
      for (let i = 0; i < s.count; i++) { if (s.kin[i] >= 0) figureLight += look[i * 4 + 1]; else matterLight += look[i * 4 + 1]; }
      return { figureLight, matterLight };
    };
    expect(lit('all').figureLight).toBeGreaterThan(0); expect(lit('all').matterLight).toBeGreaterThan(0);
    expect(lit('polygon').matterLight).toBe(0); expect(lit('polygon').figureLight).toBeGreaterThan(0);
    expect(lit('particles').figureLight).toBe(0); expect(lit('particles').matterLight).toBeGreaterThan(0);
    expect(lit('edges')).toEqual({ figureLight: 0, matterLight: 0 });
    expect(lit('fragments').figureLight).toBeGreaterThan(0);
    m.scene.dispose();
  });

  it('scales its free matter with quality and keeps the figure', { timeout: 60000 }, () => {
    for (const [quality, elements] of [[QUALITY_PROFILES.high, 120], [QUALITY_PROFILES.medium, 78], [QUALITY_PROFILES.low, 42]] as const) {
      const m = mount(quality);
      expect(m.system.state.count).toBe(8 + elements);
      expect(m.system.state.capacity).toBeGreaterThanOrEqual(12 + elements);
      m.scene.dispose();
    }
  });
});

describe('the reference demonstration, on a real signal through the whole path', () => {
  it('ambient → build → drop: a square forms, vibrates, breaks with the drop into pieces that stay alive, and finds itself again', { timeout: 240000 }, async () => {
    const life = { formedAt: -1, brokenAt: -1, mostBefore: 0, leastAfter: 8, last: 0, swings: 0, lastSwing: 0, steps: 0 };
    let elements = 0, afterBreak: { excitation: number; kinetic: number } | null = null;
    const m = await play('buildDrop', 44, (t, mounted, snapshot) => {
      const now = figure(mounted), s = mounted.system.state, stats = mounted.system.stats;
      elements ||= s.count;
      expect(s.count).toBe(elements);
      life.steps = Math.max(life.steps, stats.steps);
      if (life.formedAt < 0 && now.loop === 4) life.formedAt = t;
      if (life.formedAt >= 0 && life.brokenAt < 0) {
        life.mostBefore = Math.max(life.mostBefore, now.bonds);
        // While it stands it swings with the sound: the corner's displacement changes sign.
        if (s.vibration[0] * life.lastSwing < 0) life.swings++;
        if (s.vibration[0] !== 0) life.lastSwing = s.vibration[0];
        if (now.bonds <= 4) life.brokenAt = t;
      }
      if (life.brokenAt >= 0) {
        life.leastAfter = Math.min(life.leastAfter, now.bonds);
        // Two seconds on, the pieces still answer the sound and still move with the field.
        if (!afterBreak && t > life.brokenAt + 2) {
          let excitation = 0, kinetic = 0;
          for (let i = 0; i < 8; i++) { excitation += s.excitation[i] / 8; kinetic += s.velocity[i * 3] ** 2 + s.velocity[i * 3 + 1] ** 2 + s.velocity[i * 3 + 2] ** 2; }
          afterBreak = { excitation, kinetic };
        }
      }
      life.last = now.bonds;
      if (Math.round(t * 60) % 30 === 0) {
        for (const value of [stats.order, stats.temperature, stats.stress, stats.kinetic, snapshot.resonance.mesoEnergy]) expect(Number.isFinite(value)).toBe(true);
        for (let i = 0; i < s.count; i++) expect(Math.hypot(s.position[i * 3], s.position[i * 3 + 1], s.position[i * 3 + 2])).toBeLessThan(8.001);
      }
    });
    // It was not there at the start: it formed out of loose matter during the ambient opening.
    expect(life.formedAt).toBeGreaterThan(3); expect(life.formedAt).toBeLessThan(13);
    expect(life.mostBefore).toBe(8); expect(life.swings).toBeGreaterThan(3);
    // The build and the drop break it.
    expect(life.brokenAt).toBeGreaterThan(life.formedAt + 1); expect(life.brokenAt).toBeLessThan(22);
    expect(life.leastAfter).toBeLessThanOrEqual(3);
    expect(afterBreak).not.toBeNull();
    expect(afterBreak!.excitation).toBeGreaterThan(0.05); expect(afterBreak!.kinetic).toBeGreaterThan(1e-3);
    // In the calmer music after it the pieces rejoin.
    expect(life.last).toBeGreaterThan(life.leastAfter + 2);
    expect(m.system.stats.fractures).toBeGreaterThan(10); expect(m.system.stats.formed).toBeGreaterThan(m.system.stats.fractures);
    expect(m.system.stats.repairs).toBe(0);
    expect(life.steps).toBeLessThanOrEqual(8);
    m.scene.dispose();
  });
});
