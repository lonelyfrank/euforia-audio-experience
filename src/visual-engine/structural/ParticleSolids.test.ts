import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Color, Material, type WebGLRenderer } from 'three';
import { AudioAnalyzer } from '../../audio/analysis/AudioAnalyzer';
import { newFrame } from '../../audio/features/decode';
import { VisualResponse } from '../../audio/visual-response/VisualResponse';
import { DEFAULT_DIRECTION } from '../../director/profiles';
import { VisualDirector } from '../../director/VisualDirector';
import { EventStream } from '../../experience/EventStream';
import { MusicalCues, type Cue } from '../../experience/MusicalCues';
import { createSnapshot, type ExperienceSnapshot } from '../../experience/types';
import { QUALITY_PROFILES } from '../../renderer/quality';
import type { SceneClock } from '../../types/visualizer';
import matterField from '../../visualizers/matter-field';
import { visualizers } from '../../visualizers/registry';
import { MIXED_POPULATION, solidSlot, SOLIDS_SLOT } from '../primitives/solidSlot';
import { SOLID_STAGES, type SolidPopulation, type SolidPrimitive, type SolidStage } from '../primitives/SolidPrimitive';
import type { RecipeVisualizer } from '../RecipeVisualizer';
import { PULSE_LIMIT } from './SolidTypes';

/*
 * Solids among the particles (docs/scene-families.md): Matter Field with a few bodies of the structural engine mounted
 * beside its matter, as the development experiment does. One solver (SolidSystem), the cycle free matter → aggregate →
 * form → solid → fracture → fragments → reorganisation made by its physics, the fracture decided by the musical cues.
 */

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
