import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Material } from 'three';
import { createGeometry } from '../../visual-engine/geometry/GeometryState';
import { createOcean, oceanBound, oceanHeight, oceanLawGlsl, WAVES } from '../../visual-engine/primitives/oceanLaw';
import { FRONT_SPEED, OceanMotion, type OceanParams } from '../../visual-engine/primitives/oceanMotion';
import type { OceanPrimitive } from '../../visual-engine/primitives/OceanPrimitive';
import type { RigCamera } from '../../visual-engine/RigCamera';
import { createWorld, type WorldState } from '../../world/WorldState';
import { WorldView } from '../../world/WorldView';
import { categoryOf, findVisualizer, scenesOf } from '../registry';
import { mountWorld, type WorldRun } from '../shared/worldHarness';
import ocean from '.';
import preset from './preset.json';
import { SEA_SLOT } from './recipe';

/*
 * Pulse Ocean (docs/generative-worlds.md): the ocean law, the sea's reading of the world on three scales, the observer
 * that glides, rides the swell and wanders. What it does, and what it never does.
 */

const P = preset.visual as unknown as OceanParams;
const NEUTRAL = { motion: 1, expansion: 1, turbulence: 1 };

/** The sea's motion over a scripted world at `fps`, the world's travel integrated finely; returns what each frame left. */
function sail(fps: number, seconds: number, script: (w: WorldState, t: number) => void, each?: (m: OceanMotion, t: number) => void, motion = new OceanMotion(P)) {
  const world = createWorld(), view = new WorldView(), geometry = createGeometry();
  world.time = 10; script(world, 0); view.update(world, NEUTRAL);
  for (let k = 1; k <= Math.round(seconds * fps); k++) {
    const t = k / fps;
    world.time = 10 + t;
    // What the world holds through a frame is its value inside that frame: every frame rate sees the same steps.
    script(world, t - 0.5 / fps);
    view.update(world, NEUTRAL);
    motion.step(1 / fps, view, geometry, 4 / fps);
    each?.(motion, t);
  }
  return motion;
}
const amplitudes = (m: OceanMotion): number[] => Array.from({ length: WAVES }, (_, n) => m.swell[n * 4 + 3]);

let mounted: WorldRun[] = [];
const mount = (...args: Parameters<typeof mountWorld>): WorldRun => { const r = mountWorld(...args); mounted.push(r); return r; };
afterEach(() => { for (const r of mounted) r.dispose(); mounted = []; vi.restoreAllMocks(); });

describe('Pulse Ocean: the ocean law', () => {
  it('a still sea is flat; any sea stays within its bound; the GLSL is the same law', () => {
    const o = { ...createOcean(), cell: 1.6 }, still = new Float32Array(WAVES * 4);
    for (let n = 0; n < WAVES; n++) still.set([0.2 * n, -0.1 * n, n, 0], n * 4);
    for (let i = -40; i <= 40; i += 7) for (let k = 0; k < 150; k += 11) expect(oceanHeight(o, still, i, k)).toBe(0);
    const rough = new Float32Array(WAVES * 4);
    for (let n = 0; n < WAVES; n++) rough.set([0.2 * n, -0.13 * n, 2 * n, 1.5], n * 4);
    const busy = { ...o, chop: 1, release: 1, bulge: 4, front: 20 }, bound = oceanBound(busy, rough);
    for (let i = -40; i <= 40; i += 3) for (let k = 0; k < 150; k += 3) expect(Math.abs(oceanHeight(busy, rough, i, k))).toBeLessThanOrEqual(bound);
    for (const term of ['uSwell', 'oceanBand', 'oceanGrain', 'O_CHOP', 'uWaveA']) expect(oceanLawGlsl).toContain(term);
  });
});

describe('Pulse Ocean: the sea\'s reading of the world', () => {
  it('a silent world: the waves flatten and their time stops; the sea stands still', () => {
    const m = sail(60, 20, (w) => { w.excitation = 0.7; w.shimmer = 0.6; w.openness = 0.6; w.potential = 0.4; });
    expect(Math.max(...amplitudes(m))).toBeGreaterThan(0.3);
    sail(60, 60, (w) => { w.excitation = w.shimmer = w.openness = w.potential = w.radius = 0; }, undefined, m);
    expect(Math.max(...amplitudes(m))).toBeLessThan(1e-3);
    expect(m.life).toBe(0);
    const phases = Array.from({ length: WAVES }, (_, n) => m.swell[n * 4 + 2]);
    // No travel either (advance is the observer's, given here as a constant: only the sea's own time is checked).
    const world = createWorld(), view = new WorldView();
    world.time = 200; view.update(world, NEUTRAL); world.time = 201; view.update(world, NEUTRAL);
    m.step(1, view, createGeometry(), 0);
    expect(Array.from({ length: WAVES }, (_, n) => m.swell[n * 4 + 2])).toEqual(phases);
  });

  it('three scales apart: a kick rings the groove, not the swell; a hat stirs the ripples, not the groove', () => {
    let swellJump = 0, grooveSeen = 0, rippleSeen = 0, last = [0, 0, 0];
    sail(60, 30, (w, t) => {
      const beat = (t % 0.5) / 0.5;
      w.excitation = 0.3 + 0.6 * Math.exp(-beat * 6); w.shimmer = 0; w.openness = 0.4; w.potential = 0.2;
    }, (m, t) => {
      const a = amplitudes(m), s = a[0] + a[1], g = a[2] + a[3] + a[4], r = a[5] + a[6];
      if (t > 10) { swellJump = Math.max(swellJump, Math.abs(s - last[0])); grooveSeen = Math.max(grooveSeen, g); rippleSeen = Math.max(rippleSeen, r); }
      last = [s, g, r];
    });
    // The swell follows over seconds: a kick moves it by a hair a frame; the groove carries the kicks; no highs, no ripples.
    expect(swellJump).toBeLessThan(0.005);
    expect(grooveSeen).toBeGreaterThan(0.5);
    expect(rippleSeen).toBe(0);
  });

  it('the same sea at 30, 60 and 144 frames per second, held inputs followed exactly', () => {
    const script = (w: WorldState, t: number) => { w.excitation = t < 4 ? 0.8 : 0.3; w.shimmer = t < 2 ? 0.7 : 0.1; w.openness = 0.6; w.potential = t < 5 ? 0.5 : 0.1; };
    // Compared as the sea it makes, at a time every frame rate reaches and the sea is not on a row's edge.
    const [a, b, c] = [30, 60, 144].map((fps) => {
      const m = sail(fps, 7.5, script), out: number[] = [];
      for (let i = -40; i <= 40; i += 8) for (let k = 0; k < 150; k += 10) out.push(oceanHeight(m.values, m.swell, i, k));
      return out;
    });
    for (let i = 0; i < a.length; i++) { expect(b[i]).toBeCloseTo(a[i], 3); expect(c[i]).toBeCloseTo(a[i], 3); }
  });

  it('a release: a front that runs away from the viewer, and the sea\'s configuration changes over seconds, never in a frame', () => {
    let jump = 0, before: number[] = [], released = Infinity;
    const m = sail(60, 20, (w, t) => {
      w.excitation = 0.6; w.openness = 0.5; w.potential = 0.3;
      if (t >= 10 && w.releaseTime < 0) { w.releaseTime = w.time; w.releaseStrength = 0.8; released = w.time - 10; }
    }, (motion, t) => {
      const a = amplitudes(motion);
      if (t > 1) jump = Math.max(jump, ...a.map((x, n) => Math.abs(x - before[n])));
      before = a;
      // The front is where its age has carried it, away from the viewer.
      if (t > released) expect(motion.values.front).toBeCloseTo(FRONT_SPEED * (t - released), 6);
    });
    expect(m.values.release).toBeGreaterThan(0);
    expect(jump).toBeLessThan(0.05);
  });

  it('phases stay exact however far the sea has been travelled', () => {
    const m = new OceanMotion(P);
    m.position = 3e7;
    sail(60, 2, (w) => { w.excitation = 0.6; }, undefined, m);
    for (let n = 0; n < WAVES; n++) { const phase = m.swell[n * 4 + 2]; expect(phase).toBeGreaterThanOrEqual(0); expect(phase).toBeLessThan(2 * Math.PI + 1e-6); }
    expect(Number.isFinite(m.values.shift)).toBe(true);
  });
});

describe('Pulse Ocean: a scene of the Worlds family', { timeout: 30_000 }, () => {
  it('is registered as a world with a gliding, drifting observer', () => {
    expect(findVisualizer('pulse-ocean')).toBe(ocean);
    expect(categoryOf('pulse-ocean')).toBe('worlds');
    expect(ocean.locomotion).toEqual(['glide', 'drift']);
    expect(scenesOf('worlds').map((v) => v.id)).toContain('pulse-ocean');
  });

  it('glides over the sea by the world\'s travel, rides its long swell, wanders within its corridor; in silence all stands still', () => {
    const r = mount('pulse-ocean');
    const sea = r.scene.world.primitive<OceanPrimitive>(SEA_SLOT)!, camera = r.scene.world.recipe.camera as RigCamera;
    r.sound();
    let lowest = Infinity, highest = -Infinity, widest = 0;
    r.run(40, (w) => { w.speed = 3; w.excitation = 0.6; w.openness = 0.7; w.potential = 0.4; w.turbulence = 0.5; w.coherence = 0.5; }, 60, () => {
      lowest = Math.min(lowest, camera.rig.pose.y); highest = Math.max(highest, camera.rig.pose.y); widest = Math.max(widest, Math.abs(camera.rig.pose.x));
    });
    expect(sea.motion.position).toBeGreaterThan(20);
    expect(highest - lowest).toBeGreaterThan(0.05);
    expect(highest - lowest).toBeLessThan(2);
    expect(widest).toBeLessThanOrEqual((preset.visual.camera.drift.corridor) + 1e-6);
    r.silence();
    r.run(40);
    const row = sea.motion.position, pose = { ...camera.rig.pose };
    r.run(5);
    expect(sea.motion.position).toBe(row);
    expect(camera.rig.motion).toBeLessThan(1e-3);
    expect(camera.rig.pose.y).toBeCloseTo(pose.y, 4);
  });

  it('releases what it made when it is disposed', () => {
    const r = mountWorld('pulse-ocean');
    const geometry = vi.spyOn(BufferGeometry.prototype, 'dispose'), material = vi.spyOn(Material.prototype, 'dispose');
    r.dispose();
    expect(geometry).toHaveBeenCalledTimes(2); expect(material).toHaveBeenCalledTimes(2);
  });
});
