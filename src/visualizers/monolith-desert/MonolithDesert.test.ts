import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';
import { QUALITY_PROFILES } from '../../renderer/quality';
import type { RigCamera } from '../../visual-engine/RigCamera';
import type { EmergencePrimitive } from '../../visual-engine/primitives/EmergencePrimitive';
import { SHAPE } from '../../visual-engine/primitives/emergenceLaw';
import { emergenceParams } from '../../visual-engine/primitives/terrainEmergence';
import { PERIOD, terrainMeander } from '../../visual-engine/primitives/terrainLaw';
import type { TerrainPrimitive } from '../../visual-engine/primitives/TerrainPrimitive';
import { categoryOf, findVisualizer, scenesOf } from '../registry';
import { mountWorld, type WorldRun } from '../shared/worldHarness';
import desert from '.';
import preset from './preset.json';
import { MONOLITHS_SLOT } from './recipe';

/*
 * Monolith Desert (docs/generative-worlds.md): Generative Terrain's ground as a plain, the terrain's emergence standing
 * across it, an observer that glides and hovers. What it must do and what it never does.
 */

const parts = (r: WorldRun) => ({
  ground: r.scene.world.primitive<TerrainPrimitive>('ground')!,
  monoliths: r.scene.world.primitive<EmergencePrimitive>(MONOLITHS_SLOT)!,
  camera: r.scene.world.recipe.camera as RigCamera,
});
/** A steady groove with the world moving on, from the first frame. */
const groove = (w: { speed: number; excitation: number; potential: number; illumination: number }) => { w.speed = 2.5; w.excitation = 0.6; w.potential = w.potential || 0.2; w.illumination = 0.6; };
let mounted: WorldRun[] = [];
const mount = (...args: Parameters<typeof mountWorld>): WorldRun => { const r = mountWorld(...args); mounted.push(r); return r; };
afterEach(() => { for (const r of mounted) r.dispose(); mounted = []; vi.restoreAllMocks(); });

describe('Monolith Desert: a scene of the Worlds family', () => {
  it('is registered as a world after Generative Terrain, with its locomotion, and keeps the ids before it', () => {
    expect(findVisualizer('monolith-desert')).toBe(desert);
    expect(categoryOf('monolith-desert')).toBe('worlds');
    expect(desert.locomotion).toEqual(['glide', 'hover']);
    const worlds = scenesOf('worlds').map((v) => v.id);
    expect(worlds.slice(0, 3)).toEqual(['tunnel', 'terrain', 'monolith-desert']);
  });

  it('reuses the terrain: the same ground primitive and the same emergence, placed across the plain, never in the corridor', () => {
    const r = mount('monolith-desert');
    const { ground, monoliths } = parts(r);
    expect(ground.constructor.name).toBe('TerrainPrimitive');
    expect(monoliths.field.params).toMatchObject({ placement: 'plain', modes: 'anchored', fracture: false, keep: 3 });
    r.sound();
    r.run(60, (w) => groove(w));
    const f = monoliths.field, P = ground.params;
    expect(f.stats.spawned).toBeGreaterThan(2);
    for (let s = 0; s < f.count; s++) {
      const J = f.anchor[s * 4], R = f.anchor[s * 4 + 1], shape = f.anchor[s * 4 + 3];
      // Across the floor, outside the corridor the viewer flies, inside the plain.
      const across = Math.abs(J * P.cell - terrainMeander(R));
      expect(across).toBeGreaterThanOrEqual(preset.visual.emergence.corridor - P.cell);
      expect(across).toBeLessThanOrEqual(P.valley + 2 + P.cell);
      expect([SHAPE.block, SHAPE.pillar, SHAPE.prism]).toContain(shape);
    }
  });

  it('a release heard makes monoliths emerge; it breaks none (the desert is emergence and scale), and a prediction alone emerges nothing', () => {
    const r = mount('monolith-desert');
    const f = parts(r).monoliths.field;
    r.sound();
    r.run(20, (w) => groove(w));
    r.push('prepare', 'predicted', r.world.time, 4);
    r.run(4, (w, cues) => { groove(w); cues.phase = 'rising'; w.potential = 0.7; });
    expect(f.stats.bursts).toBe(0);
    const before = f.stats.spawned;
    r.push('release', 'confirmed', r.world.time);
    r.run(6, (w, cues) => { groove(w); cues.phase = 'release'; });
    expect(f.stats.bursts).toBe(1);
    expect(f.stats.spawned).toBeGreaterThan(before);
    expect(f.stats.fractured + f.in('fracture')).toBe(0);
    expect(f.gate.stats.offered).toBe(0);
  });

  it('a breakdown brings the smaller ones down and leaves the tallest standing: the landmarks of the place', () => {
    const settings = emergenceParams({ ...preset.visual.emergence, density: 0.6, keep: 2 });
    const r = mount('monolith-desert', { emergence: settings });
    const f = parts(r).monoliths.field;
    r.sound();
    r.run(50, (w, cues) => { groove(w); cues.phase = 'rising'; w.potential = 0.6; });
    const standing = (): number => f.in('active') + f.in('resonance');
    expect(standing()).toBeGreaterThan(2);
    // Slow enough that nothing passes behind the viewer during the breakdown: what leaves, retreats.
    r.run(30, (w, cues) => { w.speed = 0.3; cues.phase = 'breakdown'; });
    expect(f.stats.retreated).toBeGreaterThan(0);
    expect(standing()).toBe(2);
  });

  it('in silence nothing new rises and nothing moves: the ground stops, the observer settles', () => {
    const r = mount('monolith-desert');
    const { ground, monoliths, camera } = parts(r);
    r.sound();
    r.run(30, (w) => groove(w));
    r.silence();
    r.run(25);
    const spawned = monoliths.field.stats.spawned, row = ground.motion.values.row + ground.motion.values.shift, pose = { ...camera.rig.pose };
    r.run(10);
    expect(monoliths.field.stats.spawned).toBe(spawned);
    expect(ground.motion.values.row + ground.motion.values.shift).toBe(row);
    expect(camera.rig.motion).toBeLessThan(1e-3);
    for (const key of ['x', 'y', 'z', 'tx', 'ty', 'tz'] as const) expect(camera.rig.pose[key]).toBeCloseTo(pose[key], 3);
  });

  it('glides when the music drives and hovers when it is calm; while it hovers the ground goes by more slowly', () => {
    const r = mount('monolith-desert');
    const { ground, camera } = parts(r);
    r.sound();
    r.run(10, (w) => { groove(w); w.speed = 0.5; });
    const calm = { hover: camera.debug.hover, pace: ground.motion.pace };
    r.run(10, (w) => { groove(w); w.speed = 6; });
    expect(calm.hover).toBeGreaterThan(0.7); expect(camera.debug.hover).toBeLessThan(0.05);
    expect(calm.pace).toBeLessThan(0.75); expect(ground.motion.pace).toBeGreaterThan(0.97);
  });

  it('turns its eye to the monolith the place is showing, as a head turns: the observer itself stays where it is', () => {
    const r = mount('monolith-desert', { emergence: emergenceParams({ ...preset.visual.emergence, density: 1, rate: 2 }) });
    const { camera } = parts(r);
    r.sound();
    let looked = 0;
    r.run(80, (w) => { groove(w); w.speed = 1.2; }, 60, () => { looked = Math.max(looked, camera.debug.focus); });
    expect(looked).toBeGreaterThan(0.2);
    // Where it looks moved towards the subject; the observer moved only as hover lets it (a little up and aside).
    expect(Math.abs(camera.rig.pose.x)).toBeLessThan(2); expect(Math.abs(camera.rig.pose.y)).toBeLessThan(3);
    const ahead = new Vector3(0, 0, -1).applyQuaternion(r.camera.quaternion);
    expect(ahead.z).toBeLessThan(-0.95);
  });

  it('is the same at 30, 60 and 144 frames per second, and the same twice', () => {
    const anchors = (fps: number): string[] => {
      const r = mount('monolith-desert');
      r.sound();
      r.run(40, (w, cues, t) => { groove(w); if (Math.abs(t - 30) < 0.5 / fps) r.push('release', 'confirmed', t); cues.phase = t > 25 ? 'rising' : 'groove'; }, fps);
      const f = parts(r).monoliths.field, out: string[] = [];
      for (let s = 0; s < f.count; s++) out.push(`${f.anchor[s * 4]}:${f.anchor[s * 4 + 1]}`);
      return out.sort();
    };
    const at60 = anchors(60);
    expect(at60.length).toBeGreaterThan(0);
    expect(anchors(60)).toEqual(at60);
    expect(anchors(30)).toEqual(at60);
    expect(anchors(144)).toEqual(at60);
  });

  it('at every quality the same structures stand: Low draws their edges only', () => {
    const at = (quality: keyof typeof QUALITY_PROFILES) => {
      const r = mount('monolith-desert', {}, QUALITY_PROFILES[quality]);
      r.sound(); r.run(40, (w) => groove(w));
      const m = parts(r).monoliths;
      return { spawned: m.field.stats.spawned, draws: m.drawCalls };
    };
    const low = at('low'), high = at('high');
    expect(low.draws).toBe(1); expect(high.draws).toBe(2);
    expect(low.spawned).toBeGreaterThan(0);
  });

  it('switched off, the desert is the plain alone; disposed, it releases what it made', () => {
    const r = mount('monolith-desert', { emergence: { ...preset.visual.emergence, enabled: false } });
    expect(r.scene.world.mounted.map((m) => m.slot.id)).toEqual(['ground']);
    r.sound(); r.run(5, (w) => groove(w));
    const full = mountWorld('monolith-desert');
    const disposed = vi.fn();
    full.scene.world.object.traverse((o) => {
      const mesh = o as unknown as { geometry?: { addEventListener(type: string, f: () => void): void }; material?: { addEventListener(type: string, f: () => void): void } };
      mesh.geometry?.addEventListener('dispose', disposed); mesh.material?.addEventListener('dispose', disposed);
    });
    full.dispose();
    // Ground: two geometries and two materials; monoliths at Medium: two of each.
    expect(disposed.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(PERIOD).toBe(1024);
  });
});
