import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Color, Material, type WebGLRenderer } from 'three';
import { AudioAnalyzer } from '../../audio/analysis/AudioAnalyzer';
import { SignalGenerator, type TestSignal } from '../../audio/capture/testSignals';
import { newFrame } from '../../audio/features/decode';
import { WasmAnalysis } from '../../audio/features/WasmAnalysis';
import { VisualResponse } from '../../audio/visual-response/VisualResponse';
import { DEFAULT_DIRECTION } from '../../director/profiles';
import { VisualDirector } from '../../director/VisualDirector';
import { EventStream } from '../../experience/EventStream';
import { ExperienceEngine } from '../../experience/ExperienceEngine';
import { forEachCue, MusicalCues, type Cue } from '../../experience/MusicalCues';
import { createSnapshot, type ExperienceSnapshot } from '../../experience/types';
import { QUALITY_PROFILES } from '../../renderer/quality';
import type { SceneClock } from '../../types/visualizer';
import matterField from '../../visualizers/matter-field';
import { visualizers } from '../../visualizers/registry';
import { MIXED_POPULATION, solidSlot, SOLIDS_SLOT } from '../primitives/solidSlot';
import { SOLID_STAGES, stageOf, type SolidPopulation, type SolidPrimitive, type SolidStage } from '../primitives/SolidPrimitive';
import type { RecipeVisualizer } from '../RecipeVisualizer';
import { createReadout } from './SolidDynamics';
import { PULSE_LIMIT } from './SolidTypes';

/*
 * Solids among the particles (docs/scene-families.md): Matter Field with a few bodies of the structural engine mounted
 * beside its matter, as the development experiment does. One solver (SolidSystem), the cycle free matter → aggregate →
 * form → solid → fracture → fragments → reorganisation made by its physics, the fracture decided by the musical cues.
 */

const SR = 48000;
const renderer = () => ({ getPixelRatio: () => 1, extensions: { has: () => true }, getRenderTarget: () => null, setRenderTarget: vi.fn(), render: vi.fn() }) as unknown as WebGLRenderer;

function mount(population?: Readonly<SolidPopulation>) {
  const scene = matterField.create(matterField.preset) as RecipeVisualizer<unknown>;
  scene.init({ renderer: renderer(), quality: QUALITY_PROFILES.low, width: 800, height: 600, addPass: () => undefined });
  scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
  const before = scene.world.mounted.map((m) => m.slot.id);
  const solid = scene.world.add(solidSlot(population)) as SolidPrimitive;
  const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame, director = new VisualDirector(matterField.direction);
  const clock: SceneClock = { time: 0, hits: { times: new Float64Array(8), strengths: new Float64Array(8), count: 0, size: 8 } as never, hitScale: 1, events: new EventStream(), light: 0.5 };
  const frame = (time: number, dt: number, snapshot?: ExperienceSnapshot): void => {
    clock.time = time; clock.experience = snapshot;
    scene.update(audio, dt, time, response, director.update(response, DEFAULT_DIRECTION, dt, undefined, snapshot), snapshot ? clock : undefined);
  };
  const stages = (): SolidStage[] => Array.from(solid.stages.subarray(0, solid.system.solids!.state.bodies), (s) => SOLID_STAGES[s]);
  return { scene, solid, solids: solid.system.solids!, clock, frame, before, stages };
}

interface Run { m: ReturnType<typeof mount>; releases: number[]; drops: number[]; fractures: number[]; stagesAt: Map<number, SolidStage[]>; worst: { deviation: number; pulse: number } }

/** A test signal through the WASM analysis and the experience engine, presented 0.1 s late at `fps`. */
async function play(signal: TestSignal, seconds: number, fps = 60): Promise<Run> {
  const pcm = new Float32Array(seconds * SR * 2);
  new SignalGenerator(signal, SR).fillStereo(pcm, seconds * SR);
  const wasm = await WasmAnalysis.create(SR, 2), engine = new ExperienceEngine(), m = mount();
  wasm.decoder.onFrame = (a) => engine.ingest(a); wasm.decoder.onOnset = (o) => engine.onset(o); wasm.decoder.onBeat = (b) => engine.beat(b); wasm.decoder.onSection = (s) => engine.section(s);
  m.clock.events = engine.events;
  const run: Run = { m, releases: [], drops: [], fractures: [], stagesAt: new Map(), worst: { deviation: 0, pulse: 0 } };
  const readout = createReadout(), cursor = { time: -Infinity, seq: 0 };
  let captured = 0, cues = 0, fired = 0;
  for (let f = 1; f <= seconds * fps; f++) {
    const t = f / fps;
    wasm.decoder.begin();
    while (captured + 480 <= Math.floor(t * SR + 1e-6)) { wasm.push(pcm.subarray(captured * 2, (captured + 480) * 2)); captured += 480; }
    const snapshot = engine.present(t - 0.1);
    if (!snapshot) continue;
    m.frame(t - 0.1, 1 / fps, snapshot);
    cues = forEachCue(snapshot.cues, cues, (c: Readonly<Cue>) => { if (c.kind === 'release') run.releases.push(c.time); });
    engine.events.forEachHeard(cursor, t - 0.1, (e) => { if (e.type === 'drop') run.drops.push(e.audioTime); });
    if (m.solids.gate.stats.fired > fired) { fired = m.solids.gate.stats.fired; run.fractures.push(m.solids.gate.time); }
    if (f % fps === 0) {
      run.stagesAt.set(Math.round(t), m.stages());
      for (let b = 0; b < m.solids.state.bodies; b++) {
        const r = m.solids.read(b, null, readout);
        // A body is rigid while it is whole: what it shows of its shape and of its pulse.
        if (stageOf(r, true) === 'solid') { run.worst.deviation = Math.max(run.worst.deviation, r.deviation); run.worst.pulse = Math.max(run.worst.pulse, Math.abs(r.pulse)); }
      }
    }
  }
  wasm.dispose();
  return run;
}

/** A snapshot of a living, ordered, sounding world, with the cues of an engine that hears nothing (the tests offer theirs). */
function alive(): ExperienceSnapshot {
  const snapshot = createSnapshot(newFrame());
  Object.assign(snapshot.acoustic, { presence: 1, silent: 0, harmonicity: 0.9 });
  Object.assign(snapshot.world, { coherence: 0.95, illumination: 0.8, excitation: 0.4 });
  snapshot.resonance.mesoLevel.fill(0.4); snapshot.resonance.meso.fill(0.3);
  return snapshot;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('solids among the particles: the experiment on Matter Field', () => {
  it('is mounted beside the matter and taken away again: without it Matter Field is the scene it always was', () => {
    const m = mount(), world = m.scene.world;
    expect(m.before).toEqual(['matter', 'shockwaves', 'filaments', 'surface', 'graph']);
    expect(world.mounted.map((x) => x.slot.id)).toEqual([...m.before, SOLIDS_SLOT]);
    // No product recipe holds it: the experiment adds it to a running world.
    for (const definition of visualizers) {
      const scene = definition.create(definition.preset);
      if (!('world' in scene)) continue;
      scene.init({ renderer: renderer(), quality: QUALITY_PROFILES.low, width: 320, height: 240, addPass: () => undefined });
      expect((scene as RecipeVisualizer<unknown>).world.primitive(SOLIDS_SLOT), definition.id).toBeUndefined();
      scene.dispose();
    }
    const geometry = vi.spyOn(BufferGeometry.prototype, 'dispose'), material = vi.spyOn(Material.prototype, 'dispose');
    expect(world.remove(SOLIDS_SLOT)).toBe(true);
    expect(world.mounted.map((x) => x.slot.id)).toEqual(m.before);
    expect(geometry).toHaveBeenCalledTimes(3); expect(material).toHaveBeenCalledTimes(3);
    expect(world.remove(SOLIDS_SLOT)).toBe(false);
    m.scene.dispose();
  });

  it('a limited population of real bodies (one solver: the structural engine), seeded apart: free matter at first', () => {
    const m = mount();
    expect(m.solids.state.bodies).toBe(MIXED_POPULATION.bodies.length);
    expect(m.solid.system.state.count).toBe(4 + 8 + 12);
    expect(m.stages()).toEqual(['free', 'free', 'free']);
    expect(m.solids.tuning.shapeRetention).toBe(0.9); expect(m.solids.tuning.maxPulse).toBe(PULSE_LIMIT);
    expect(m.solids.gate.tuning.mode).toBe('events');
    // Whole from the first frame when a scene skips the first steps.
    const whole = mount({ ...MIXED_POPULATION, start: 'solid' });
    expect(whole.stages()).toEqual(['solid', 'solid', 'solid']);
  });

  it('in silence nothing forms and nothing breaks: the silence creates no energy', () => {
    const m = mount(), silent = createSnapshot(newFrame());
    const start = Float32Array.from(m.solid.system.state.position.subarray(0, 24 * 3));
    for (let f = 1; f <= 600; f++) m.frame(f / 60, 1 / 60, silent);
    expect(m.stages()).toEqual(['free', 'free', 'free']);
    expect(m.solids.stats.fractures).toBe(0);
    const p = m.solid.system.state.position;
    let moved = 0;
    for (let i = 0; i < start.length; i++) moved = Math.max(moved, Math.abs(p[i] - start[i]));
    expect(moved).toBeLessThan(0.05);
  });

  it('breaks only on a release heard, offered as the session\'s own would be; a prediction or an accent breaks nothing', () => {
    const m = mount({ ...MIXED_POPULATION, start: 'solid' }), snapshot = alive(), cues = new MusicalCues();
    snapshot.cues = cues.frame;
    const push = (kind: Cue['kind'], status: Cue['status'], time: number): void => {
      const f = cues.frame, seq = ++f.seq;
      Object.assign(f.cues[seq % f.cues.length], { seq, kind, status, time, expected: 0, strength: 0.9, confidence: 1, ref: 0 });
    };
    let t = 0;
    const run = (seconds: number): void => { for (let k = 0; k < seconds * 60; k++) { t += 1 / 60; snapshot.cues.time = t; m.frame(t, 1 / 60, snapshot); } };
    run(3);
    push('prepare', 'predicted', t); push('accent', 'observed', t); push('withdraw', 'refuted', t);
    run(2);
    expect(m.solids.gate.stats.offered).toBe(0); expect(m.solids.stats.fractures).toBe(0);
    push('release', 'confirmed', t);
    run(2);
    expect(m.solids.gate.stats.fired).toBe(1);
    expect(m.solid.cuesTaken).toEqual({ releases: 1, accents: 0 });
    expect(m.stages()).toContain('fragments');
    // A scene that breaks on accents too, and one that never breaks.
    const accents = mount({ ...MIXED_POPULATION, start: 'solid', fracture: 'accent' });
    accents.solid.cue({ seq: 1, kind: 'accent', status: 'observed', time: 1, expected: 0, strength: 0.9, confidence: 1, ref: 0 });
    expect(accents.solid.cuesTaken.accents).toBe(1);
    const never = mount({ ...MIXED_POPULATION, start: 'solid', fracture: 'none' });
    never.solid.cue({ seq: 1, kind: 'release', status: 'confirmed', time: 1, expected: 0, strength: 0.9, confidence: 1, ref: 0 });
    expect(never.solid.cuesTaken.releases).toBe(0);
  });

  it('the same seed and the same frames are the same bodies; a reseed starts the cycle again from the same matter', () => {
    const a = mount(), b = mount(), snapshot = alive();
    for (let f = 1; f <= 600; f++) { a.frame(f / 60, 1 / 60, snapshot); b.frame(f / 60, 1 / 60, snapshot); }
    expect(Array.from(a.solid.system.state.position.subarray(0, 72))).toEqual(Array.from(b.solid.system.state.position.subarray(0, 72)));
    const seeded = mount();
    a.solid.reseed();
    expect(Array.from(a.solid.system.state.position.subarray(0, 72))).toEqual(Array.from(seeded.solid.system.state.position.subarray(0, 72)));
    expect(a.stages()).toEqual(['free', 'free', 'free']);
  });
});

describe('solids among the particles, on test signals through the WASM analysis', () => {
  it('ambient → build → drop: free matter forms solids, they keep their shape, break at the two releases heard (never at the experience\'s drops off them), and find each other again', { timeout: 300000 }, async () => {
    const r = await play('buildDrop', 58);
    expect(r.releases).toHaveLength(2);
    // Formed before the first drop, every body.
    expect(r.stagesAt.get(2)).toEqual(['free', 'free', 'free']);
    expect(r.stagesAt.get(17)).toEqual(['solid', 'solid', 'solid']);
    // Two fractures, each at a release heard; the experience's drops 2 s before and after them broke nothing.
    expect(r.fractures).toHaveLength(2);
    for (const [i, at] of r.fractures.entries()) expect(Math.abs(at - r.releases[i])).toBeLessThan(0.05);
    expect(r.drops.length).toBeGreaterThanOrEqual(2);
    for (const drop of r.drops) expect(r.fractures.every((at) => Math.abs(at - drop) > 1)).toBe(true);
    // Fragments, then the pieces find each other: whole again before the second drop.
    expect(r.stagesAt.get(21)).toContain('fragments');
    expect(r.stagesAt.get(45)).toEqual(['solid', 'solid', 'solid']);
    expect(r.m.solids.stats.reforms).toBeGreaterThan(0);
    // Rigid: while whole a body is its own shape, its pulse within the limit.
    expect(r.worst.deviation).toBeLessThan(0.02); expect(r.worst.pulse).toBeLessThanOrEqual(PULSE_LIMIT + 1e-9);
  });

  it('a steady groove and music that stops and starts: bodies form and stay whole, nothing breaks', { timeout: 300000 }, async () => {
    for (const signal of ['beat124', 'startStop'] as const) {
      const r = await play(signal, 40);
      expect(r.fractures, signal).toEqual([]);
      expect(r.stagesAt.get(39), signal).toEqual(['solid', 'solid', 'solid']);
    }
  });

  it('the same at 30 and 60 frames per second: the same fractures at the same audio times, the same stages', { timeout: 300000 }, async () => {
    const [slow, fast] = [await play('buildDrop', 30, 30), await play('buildDrop', 30, 60)];
    expect(slow.fractures.length).toBe(fast.fractures.length);
    for (let i = 0; i < slow.fractures.length; i++) expect(slow.fractures[i]).toBeCloseTo(fast.fractures[i], 1);
    expect(slow.stagesAt.get(17)).toEqual(fast.stagesAt.get(17));
  });
});
