import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Material } from 'three';
import { createCues, type Cue, type CuesFrame } from '../../experience/MusicalCues';
import { createGeometry, type GeometryState } from '../../visual-engine/geometry/GeometryState';
import { branchPoint, createShape, forestLawGlsl, forestRoot, growTree, leafPoint, MAX_SEGMENTS, SPAN, type TreeState } from '../../visual-engine/primitives/forestLaw';
import { ForestField, forestParams, TRAIT_KEYS, type ForestSettings } from '../../visual-engine/primitives/forestGrowth';
import type { ForestPrimitive } from '../../visual-engine/primitives/ForestPrimitive';
import { createTerrain, PERIOD, terrainHeight, type TerrainValues } from '../../visual-engine/primitives/terrainLaw';
import { TerrainMotion, type TerrainParams } from '../../visual-engine/primitives/terrainMotion';
import type { RigCamera } from '../../visual-engine/RigCamera';
import type { TerrainPrimitive } from '../../visual-engine/primitives/TerrainPrimitive';
import { createWorld, type WorldState } from '../../world/WorldState';
import { WorldView } from '../../world/WorldView';
import { categoryOf, findVisualizer, scenesOf } from '../registry';
import { mountWorld, type WorldRun } from '../shared/worldHarness';
import forest from '.';
import preset from './preset.json';
import { TREES_SLOT } from './recipe';

/*
 * Resonant Forest (docs/generative-worlds.md): the law that anchors and grows a tree, the life the music gives the
 * forest, its memory of configurations, its budgets, and an observer that never flies into a tree.
 */

const P = preset.visual as unknown as TerrainParams & { forest: ForestSettings };
const ground = (set: Partial<TerrainValues> = {}): TerrainValues => ({ ...createTerrain(), cell: P.cell, relief: P.relief, rough: P.roughness, valley: P.valley, seedX: 7, seedY: 11, ...set });
const TRAITS = { branching: 0.5, spread: 0.6, upright: 0.25, height: 10, foliage: 0.75 };
const tree = (set: Partial<TreeState> = {}): TreeState => ({ J: 14, R: 60, growth: 1.25, lean: 0, around: Math.PI / 2, light: 1, decay: 0, resonance: 0, leaves: 1, flush: 0, ...set });

describe('forest law: a tree stands on the ground\'s own vertex and grows in the order of its depth', () => {
  it('its shape is a function of its seed and its traits: the same twice, another seed another tree, within its budget', () => {
    const a = growTree(1234, TRAITS, createShape()), b = growTree(1234, TRAITS, createShape()), c = growTree(4321, TRAITS, createShape());
    expect(Array.from(b.to)).toEqual(Array.from(a.to));
    expect(Array.from(c.to)).not.toEqual(Array.from(a.to));
    expect(a.segments).toBeGreaterThan(8); expect(a.segments).toBeLessThanOrEqual(MAX_SEGMENTS);
    expect(a.leaves).toBeGreaterThan(4);
    // Growth reaches the tips last: births never go down along the segments.
    for (let s = 1; s < a.segments; s++) expect(a.to[s * 4 + 3]).toBeGreaterThanOrEqual(a.to[(s - 1) * 4 + 3]);
    expect(a.top).toBeGreaterThan(TRAITS.height * 0.5); expect(a.top).toBeLessThan(TRAITS.height * 1.6);
  });

  it('its trunk starts on the ground\'s vertex at its lattice point, in every state of the ground, and travels with it', () => {
    const shape = growTree(77, TRAITS, createShape());
    for (const t of [ground({ row: 10, shift: 0.3, col: 2, shiftX: 0.4 }), ground({ row: 300, terrace: 1, lift: 1, relief: 7 }), ground({ row: PERIOD - 3, release: 0.8, bulge: 3, front: 30 })]) {
      const T = tree({ R: (t.row + 40) % PERIOD }), i = T.J - t.col, k = ((T.R - t.row) % PERIOD + PERIOD) % PERIOD;
      const base = branchPoint(t, { ...T, growth: 0.02 }, shape, 0, 0, 0), vertex = terrainHeight(t, i, k);
      // At the axis of its trunk (the prism's corners are round it): just under the ground's vertex.
      expect(forestRoot(t, T.J, T.R)[1]).toBeCloseTo(vertex - 0.08, 5);
      expect(base[1]).toBeCloseTo(vertex - 0.08, 5);
    }
  });

  it('grows depth after depth, tip last; a decaying tree drops its leaves and retracts', () => {
    const t = ground(), shape = growTree(9, TRAITS, createShape());
    const tip = shape.segments - 1, length = (g: number, s: number) => {
      const a = branchPoint(t, tree({ growth: g }), shape, s, 0, 0), b = branchPoint(t, tree({ growth: g }), shape, s, 0, 1);
      return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    };
    expect(length(0.5 * SPAN, 0)).toBeGreaterThan(0); expect(length(0.5 * SPAN, tip)).toBe(0);
    expect(length(1, tip)).toBeGreaterThan(0);
    // Leaves open past full growth, and fall as the tree decays.
    const leaf = shape.leaves - 1;
    const at = (g: number, decay: number) => leafPoint(t, tree({ growth: g, decay }), shape, leaf, 0);
    const closed = at(1, 0), open = at(1.25, 0), fallen = at(1.25, 1);
    expect(Math.hypot(open[0] - closed[0], open[2] - closed[2]) + Math.abs(open[1] - closed[1])).toBeGreaterThan(0);
    expect(fallen[1]).toBeLessThan(open[1] - 2);
  });

  it('leans rigidly about its root: every distance between its points is kept', () => {
    const t = ground(), shape = growTree(5, TRAITS, createShape());
    const points = (lean: number) => Array.from({ length: shape.segments }, (_, s) => branchPoint(t, tree({ lean }), shape, s, 0, 1));
    const straight = points(0), leaning = points(0.06);
    for (let s = 1; s < shape.segments; s++) {
      const d0 = Math.hypot(...straight[s].map((x, q) => x - straight[0][q]) as [number, number, number]);
      const d1 = Math.hypot(...leaning[s].map((x, q) => x - leaning[0][q]) as [number, number, number]);
      expect(d1).toBeCloseTo(d0, 5);
    }
    expect(forestLawGlsl).toContain('terrainHeight(i, k, d)');
  });
});

/** The ground's motion and the forest over a hand-set world, cues and geometry, at any frame rate. */
function walk(settings: ForestSettings = P.forest, seed = 20261018) {
  const world = createWorld(), view = new WorldView(), geometry = createGeometry(), motion = new TerrainMotion(P), cues = createCues();
  const field = new ForestField(settings, seed);
  world.time = 10; cues.silent = false; cues.live = true; cues.phase = 'groove'; cues.groove = 0.7; cues.stability = 0.8;
  view.update(world, { motion: 1, expansion: 1, turbulence: 1 });
  const push = (kind: Cue['kind'], status: Cue['status'], time: number): void => {
    const seq = ++cues.seq;
    Object.assign(cues.cues[seq % cues.cues.length], { seq, kind, status, time, expected: 0, strength: 0.9, confidence: 1, ref: 1 });
  };
  const run = (seconds: number, set?: (world: WorldState, cues: CuesFrame, g: GeometryState, t: number) => void, fps = 60, each?: () => void, timed = true): void => {
    const from = world.time;
    for (let k = 1; k <= Math.round(seconds * fps); k++) {
      world.time = from + k / fps;
      world.speed = 1.2;
      set?.(world, cues, geometry, world.time - 0.5 / fps);
      world.travel += world.speed / fps;
      view.update(timed ? world : undefined, { motion: 1, expansion: 1, turbulence: 1 });
      const v = motion.step(1 / fps, view, geometry, undefined, world.time);
      field.step(1 / fps, v, view, geometry, v.row + v.shift, P.rows, P.columns, timed ? cues : undefined, world.time);
      each?.();
    }
  };
  const anchors = (): string[] => { const out: string[] = []; for (let s = 0; s < 40; s++) if (field.phase[s]) out.push(`${field.J[s]}:${field.R[s]}`); return out.sort(); };
  return { world, view, motion, field, cues, geometry, push, run, anchors };
}
const timbre = (g: GeometryState, x: number) => { for (const key of TRAIT_KEYS) g[key] = x; };

describe('forest: the life the music gives the trees', () => {
  it('keeps the initial sowing until a musical phase actually asks for trees', () => {
    const f = walk({ ...P.forest, density: 1 });
    // Acquisition can be audible before cognition has left silence. No row travels in this check.
    f.run(1, (world, cues) => { world.speed = 0; cues.silent = false; cues.phase = 'silence'; });
    expect(f.field.stats.spawned).toBe(0);
    f.run(1, (world, cues) => { world.speed = 0; cues.phase = 'groove'; });
    expect(f.field.stats.spawned).toBeGreaterThan(3);
    const count = f.field.stats.spawned;
    f.run(1, world => { world.speed = 0; });
    expect(f.field.stats.spawned).toBe(count);
  });

  it('a new session cannot replay the previous session\'s flowering light', () => {
    const f = walk({ ...P.forest, grow: 2 });
    f.run(30, world => { world.speed = 0; });
    f.push('release', 'confirmed', f.world.time);
    f.run(0.1, world => { world.speed = 0; });
    expect(Math.max(...Array.from({ length: 40 }, (_, s) => f.field.treeLean[s * 4 + 3]))).toBeGreaterThan(0.5);
    f.field.reset(); f.world.time = 0;
    f.run(0.1, (world, cues) => { world.speed = 0; cues.seq = 0; cues.silent = true; cues.phase = 'silence'; });
    expect(Math.max(...Array.from({ length: 40 }, (_, s) => f.field.treeLean[s * 4 + 3]))).toBe(0);
  });

  it('without a clock, or in silence, nothing is seeded and nothing grows', () => {
    const f = walk();
    f.run(30, undefined, 60, undefined, false);
    expect(f.field.stats.spawned).toBe(0);
    const g = walk();
    g.run(30);
    expect(g.field.stats.spawned).toBeGreaterThan(0);
    const growth = Array.from(g.field.growth), spawned = g.field.stats.spawned;
    g.run(15, (world, cues) => { cues.silent = true; cues.phase = 'silence'; world.speed = 0; });
    expect(Array.from(g.field.growth)).toEqual(growth);
    expect(g.field.stats.spawned).toBe(spawned);
  });

  it('a steady groove grows a forest of a few trees, whatever its level; a steadier groove grows them faster', () => {
    const grown = (stability: number, light: number) => {
      const f = walk();
      f.run(40, (world, cues) => { cues.stability = stability; world.excitation = light; world.illumination = light; });
      return { spawned: f.field.stats.spawned, growth: Array.from(f.field.growth).reduce((a, b) => a + b, 0) };
    };
    const quiet = grown(0.9, 0.3), loud = grown(0.9, 1), shaky = grown(0.2, 1);
    expect(loud.spawned).toBe(quiet.spawned); expect(loud.growth).toBeCloseTo(quiet.growth, 6);
    expect(quiet.spawned).toBeGreaterThan(3);
    expect(shaky.growth).toBeLessThan(quiet.growth);
  });

  it('remembers: trees grown in one music resonate again when that music comes back and repeats, not in another', () => {
    const f = walk({ ...P.forest, span: 1000 });
    // An A section long enough for trees to grow, then a B section, then A again.
    f.run(70, (_, cues, g) => { timbre(g, 0.2); cues.repetition = 0.9; cues.groove = 0.4; });
    const grownInA = Array.from({ length: 40 }, (_, s) => s).filter((s) => f.field.phase[s] >= 3);
    expect(grownInA.length).toBeGreaterThan(0);
    f.run(20, (_, cues, g) => { timbre(g, 0.85); cues.repetition = 0.9; cues.groove = 0.4; });
    expect(f.field.stats.remembering).toBe(0);
    let remembered = 0;
    f.run(15, (_, cues, g) => { timbre(g, 0.2); cues.repetition = 0.9; cues.groove = 0.4; }, 60, () => { remembered = Math.max(remembered, f.field.stats.remembering); });
    expect(remembered).toBeGreaterThan(0);
    // Not a repetition, no memory: the same timbre without the music repeating wakes nothing.
    const g = walk({ ...P.forest, span: 1000 });
    g.run(70, (_, cues, geo) => { timbre(geo, 0.2); cues.repetition = 0; cues.groove = 0.4; }, 60, () => expect(g.field.stats.remembering).toBe(0));
  });

  it('only cues act: a prediction buds, a release heard flushes and seeds; a breakdown brings trees down one by one', () => {
    const f = walk();
    f.run(60);
    expect(f.field.in('mature') + f.field.in('resonance')).toBeGreaterThan(0);
    f.push('prepare', 'predicted', f.world.time);
    f.run(0.2);
    expect(f.field.stats.prepares).toBe(1);
    expect(Math.max(...Array.from({ length: 40 }, (_, s) => f.field.phase[s] >= 3 ? f.field.treeLean[s * 4 + 1] : 0))).toBeGreaterThanOrEqual(0.5);
    const spawned = f.field.stats.spawned;
    f.push('release', 'confirmed', f.world.time);
    f.run(4);
    expect(f.field.stats.bursts).toBe(1);
    expect(f.field.stats.spawned).toBeGreaterThan(spawned);
    const standing = () => f.field.in('mature') + f.field.in('resonance');
    const before = standing(), decayed = f.field.stats.decayed;
    f.run(20, (world, cues) => { cues.phase = 'breakdown'; world.speed = 0.2; });
    expect(f.field.stats.decayed).toBeGreaterThan(decayed);
    expect(standing()).toBeLessThan(before);
  });

  it('budgets hold whatever the music asks; a tree lives its span and its place is recycled', () => {
    const f = walk({ ...P.forest, capacity: 12, growing: 3, density: 1, rate: 4, span: 30 });
    let most = 0, growingMost = 0;
    // The first sowing of the ground in view grows all at once (capacity still holds); after it, so many grow at a time.
    f.run(150, (world, cues) => { cues.phase = 'rising'; cues.tension = 0.9; world.speed = 2; }, 60, () => {
      most = Math.max(most, f.field.live());
      if (f.world.time > 40) growingMost = Math.max(growingMost, f.field.in('seed') + f.field.in('growth'));
    });
    expect(most).toBeLessThanOrEqual(12); expect(growingMost).toBeLessThanOrEqual(3 + 4);
    expect(f.field.stats.aged + f.field.stats.passed).toBeGreaterThan(0);
    expect(f.field.stats.recycled).toBeGreaterThan(0);
  });

  it('the same forest at 30, 60 and 144 frames per second, and the same twice', () => {
    const at = (fps: number) => { const f = walk(); f.run(40, (_, cues, g, t) => { timbre(g, 0.3 + 0.2 * Math.sin(t * 0.05)); cues.tension = t > 30 ? 0.6 : 0.2; }, fps); return f.anchors(); };
    const a = at(60);
    expect(a.length).toBeGreaterThan(0);
    expect(at(60)).toEqual(a); expect(at(30)).toEqual(a); expect(at(144)).toEqual(a);
  });

  it('settings are bounded', () => {
    expect(forestParams({ capacity: 999, lean: 3, low: 50, high: 2 })).toMatchObject({ capacity: 40, lean: 0.15, low: 30, high: 30 });
  });
});

let mounted: WorldRun[] = [];
const mount = (...args: Parameters<typeof mountWorld>): WorldRun => { const r = mountWorld(...args); mounted.push(r); return r; };
afterEach(() => { for (const r of mounted) r.dispose(); mounted = []; vi.restoreAllMocks(); });

describe('Resonant Forest: a scene of the Worlds family', { timeout: 60_000 }, () => {
  it('is registered as the last world, with a gliding, drifting observer', () => {
    expect(findVisualizer('resonant-forest')).toBe(forest);
    expect(categoryOf('resonant-forest')).toBe('worlds');
    expect(forest.locomotion).toEqual(['glide', 'drift']);
    expect(scenesOf('worlds').map((v) => v.id)).toEqual(['tunnel', 'terrain', 'monolith-desert', 'fractured-expanse', 'pulse-ocean', 'resonant-forest']);
  });

  it('the observer never flies into a tree: every branch near it stays out of the corridor it wanders in', () => {
    const r = mount('resonant-forest', { forest: { ...P.forest, density: 0.9, low: 10, high: 16 } });
    const trees = r.scene.world.primitive<ForestPrimitive>(TREES_SLOT)!, camera = r.scene.world.recipe.camera as RigCamera, field = trees.field;
    const groundPrim = r.scene.world.primitive<TerrainPrimitive>('ground')!;
    const drift = (preset.visual.camera.drift.corridor);
    r.sound();
    let closest = Infinity, checked = 0;
    r.run(150, (w, cues) => { w.speed = 3; w.excitation = 0.6; w.turbulence = 0.8; w.coherence = 0.2; cues.groove = 0.8; cues.stability = 0.9; }, 30, () => {
      expect(Math.abs(camera.rig.pose.x)).toBeLessThanOrEqual(drift + 1e-6);
      const t = groundPrim.motion.values;
      for (let s = 0; s < 40; s++) {
        if (!field.phase[s]) continue;
        const k = ((field.R[s] - t.row) % PERIOD + PERIOD) % PERIOD;
        if (k > 12) continue;
        const state = tree({ J: field.J[s], R: field.R[s], growth: field.growth[s], lean: field.trees[s * 4 + 1] });
        for (let n = 0; n < field.shapes[s].segments; n++) for (let c = 0; c < 3; c++) {
          const x = branchPoint(t, state, field.shapes[s], n, c, 1)[0];
          closest = Math.min(closest, Math.abs(x) - drift); checked++;
        }
      }
    });
    expect(checked).toBeGreaterThan(100);
    expect(closest).toBeGreaterThan(1.5);
  });

  it('switched off, the forest is the hills alone; disposed, it releases what it made', () => {
    const r = mount('resonant-forest', { forest: { ...P.forest, enabled: false } });
    expect(r.scene.world.mounted.map((m) => m.slot.id)).toEqual(['ground']);
    const full = mountWorld('resonant-forest');
    const geometry = vi.spyOn(BufferGeometry.prototype, 'dispose'), material = vi.spyOn(Material.prototype, 'dispose');
    full.dispose();
    // Ground: two of each; trees at Medium: three of each.
    expect(geometry).toHaveBeenCalledTimes(5); expect(material).toHaveBeenCalledTimes(5);
  });
});
