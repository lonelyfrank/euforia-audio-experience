import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Material } from 'three';
import { createCues, type Cue, type CuesFrame } from '../../experience/MusicalCues';
import { createGeometry, type GeometryState } from '../../visual-engine/geometry/GeometryState';
import { barkGlsl, barkPoint, createShape, forestLawGlsl, forestRoot, growTree, leafPoint, SPAN, TREE_DETAIL, twigPoint, type TreeShape, type TreeState } from '../../visual-engine/primitives/forestLaw';
import { EMISSION, ForestField, forestParams, NODES, TRAIT_KEYS, type ForestSettings } from '../../visual-engine/primitives/forestGrowth';
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

describe('forest law: a crystalline tree stands on the ground\'s own vertex and grows in the order of its depth', () => {
  const grow = (seed: number, traits = TRAITS, detail = TREE_DETAIL.high) => growTree(seed, traits, detail, createShape(detail));
  const used = (shape: TreeShape) => Array.from(shape.point.subarray(0, shape.bark * 3));

  it('its shape is a function of its seed and its traits: the same twice, another seed another tree, within its budget', () => {
    const a = grow(1234), b = grow(1234), c = grow(4321);
    expect(used(b)).toEqual(used(a));
    expect(used(c)).not.toEqual(used(a));
    for (const detail of [TREE_DETAIL.low, TREE_DETAIL.medium, TREE_DETAIL.high]) {
      // Whole triangles and whole lines, within the slot: a slot's part of the buffers starts on a primitive.
      expect(detail.bark % 3).toBe(0); expect(detail.twig % 2).toBe(0);
      for (const seed of [3, 11, 47, 1234]) {
        const s = grow(seed, TRAITS, detail);
        expect(s.bark % 3).toBe(0); expect(s.bark).toBeGreaterThan(90); expect(s.bark).toBeLessThanOrEqual(detail.bark);
        expect(s.twigs % 2).toBe(0); expect(s.twigs).toBeLessThanOrEqual(detail.twig);
        expect(s.leaves).toBeGreaterThan(2);
      }
    }
    // Low simplifies the same tree; it does not remove it.
    expect(grow(1234, TRAITS, TREE_DETAIL.low).bark).toBeLessThan(a.bark / 2);
    // Growth reaches the tips last: births never go down along the bark.
    for (let v = 1; v < a.bark; v++) expect(a.base[v * 4 + 3]).toBeGreaterThanOrEqual(a.base[(v - 1) * 4 + 3]);
    expect(a.top).toBeGreaterThan(TRAITS.height * 0.8); expect(a.top).toBeLessThan(TRAITS.height * 2.6);
    expect(a.anchors).toBeGreaterThan(0);
  });

  it('glows from the stone, more at the foot of the trunk; its veins run along whole edges', () => {
    let low = 0, high = 0, lowFaces = 0, highFaces = 0, veins = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const s = grow(seed);
      for (let v = 0; v < s.bark; v += 3) {
        // The trunk: the first segment, born at 0 from the point under the root.
        if (s.base[v * 4 + 3] !== 0 || s.base[v * 4] !== 0 || s.base[v * 4 + 2] !== 0) continue;
        const y = (s.point[v * 3 + 1] + s.point[v * 3 + 4] + s.point[v * 3 + 7]) / 3, glowing = s.glow[v * 4 + 1] > 0 ? 1 : 0;
        // (A vein's column glows as often anywhere.)
        if (s.vein[v * 3 + 2] === 0 && y < 0.25 * s.top) { low += glowing; lowFaces++; } else if (s.vein[v * 3 + 2] === 0 && y > 0.4 * s.top) { high += glowing; highFaces++; }
        // A vein lights two corners of a triangle (an edge) or none.
        const edge = s.vein[v * 3 + 1] + s.vein[v * 3 + 4] + s.vein[v * 3 + 7];
        expect([0, 2]).toContain(edge);
        if (edge === 2) veins++;
      }
    }
    expect(low / lowFaces).toBeGreaterThan(2 * (high / Math.max(1, highFaces)));
    expect(veins).toBeGreaterThan(30);
  });

  it('its trunk starts on the ground\'s vertex at its lattice point, in every state of the ground, and travels with it', () => {
    const shape = grow(77);
    for (const t of [ground({ row: 10, shift: 0.3, col: 2, shiftX: 0.4 }), ground({ row: 300, terrace: 1, lift: 1, relief: 7 }), ground({ row: PERIOD - 3, release: 0.8, bulge: 3, front: 30 })]) {
      const T = tree({ R: (t.row + 40) % PERIOD }), i = T.J - t.col, k = ((T.R - t.row) % PERIOD + PERIOD) % PERIOD;
      const vertex = terrainHeight(t, i, k);
      expect(forestRoot(t, T.J, T.R)[1]).toBeCloseTo(vertex - 0.08, 5);
      // Unborn, the trunk is the point it grows out of: half its radius under the root.
      const seed = barkPoint(t, { ...T, growth: 0 }, shape, 0);
      expect(seed[1]).toBeCloseTo(vertex - 0.08 - 0.5 * shape.radius, 5);
    }
  });

  it('grows depth after depth, tip last; a decaying tree drops its blossoms and retracts', () => {
    const t = ground(), shape = grow(9);
    const span = (g: number, v: number) => {
      const a = barkPoint(t, tree({ growth: g }), shape, v), b = barkPoint(t, tree({ growth: 0 }), shape, v);
      return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    };
    const tip = shape.bark - 1;
    expect(span(0.5 * SPAN, 0)).toBeGreaterThan(0); expect(span(0.5 * SPAN, tip)).toBe(0);
    expect(span(1, tip)).toBeGreaterThan(0);
    // Twigs come with the blossoms, past full growth.
    const twig = (g: number) => { const a = twigPoint(t, tree({ growth: g }), shape, 1), b = twigPoint(t, tree({ growth: g }), shape, 0); return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); };
    expect(twig(1)).toBe(0); expect(twig(1.25)).toBeGreaterThan(0);
    // Blossoms open past full growth, and fall as the tree decays.
    let leaf = shape.leaves - 1;
    while (shape.leafLook[leaf * 4 + 2] > 0.5) leaf--;
    const at = (g: number, decay: number) => leafPoint(t, tree({ growth: g, decay }), shape, leaf, 0);
    const closed = at(1, 0), open = at(1.25, 0), fallen = at(1.25, 1);
    expect(Math.hypot(open[0] - closed[0], open[2] - closed[2]) + Math.abs(open[1] - closed[1])).toBeGreaterThan(0);
    expect(fallen[1]).toBeLessThan(open[1] - 2);
  });

  it('leans rigidly about its root: every distance between its points is kept', () => {
    const t = ground(), shape = grow(5);
    const points = (lean: number) => Array.from({ length: shape.bark / 9 | 0 }, (_, n) => barkPoint(t, tree({ lean }), shape, n * 9));
    const straight = points(0), leaning = points(0.06);
    for (let s = 1; s < straight.length; s++) {
      const d0 = Math.hypot(...straight[s].map((x, q) => x - straight[0][q]) as [number, number, number]);
      const d1 = Math.hypot(...leaning[s].map((x, q) => x - leaning[0][q]) as [number, number, number]);
      expect(d1).toBeCloseTo(d0, 4);
    }
    expect(forestLawGlsl).toContain('terrainHeight(i, k, d)');
    expect(barkGlsl).toContain('aBase.xyz + (position - aBase.xyz) * grown');
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

  it('the structure glows as the phase asks, settles and holds; a release heard peaks it; the level never drives it', () => {
    const settle = (phase: CuesFrame['phase'], light = 0.5) => {
      const f = walk();
      f.run(12, (world, cues) => { cues.phase = phase; cues.silent = phase === 'silence'; world.excitation = light; world.illumination = light; });
      return { emission: f.field.emission, nodes: f.field.nodes };
    };
    expect(settle('silence').emission).toBeCloseTo(EMISSION.silence, 3);
    expect(settle('breakdown').emission).toBeCloseTo(EMISSION.breakdown, 3);
    expect(settle('groove').emission).toBeCloseTo(EMISSION.groove, 3);
    expect(settle('rising').emission).toBeCloseTo(EMISSION.rising, 3);
    expect(settle('rising').nodes).toBeCloseTo(NODES.rising, 3);
    expect(settle('groove', 1).emission).toBeCloseTo(settle('groove', 0.2).emission, 9);
    // Settled, it holds: nothing moves at rest.
    const f = walk();
    f.run(15);
    const held = f.field.emission;
    f.run(2);
    expect(f.field.emission).toBe(held);
    // A release heard: at its peak at once, back to the phase's level over a few seconds.
    f.push('release', 'confirmed', f.world.time);
    f.run(0.05);
    expect(f.field.emission).toBeGreaterThan(0.97);
    f.run(15);
    expect(f.field.emission).toBeCloseTo(EMISSION.groove, 2);
    // Without a clock the forest rests at the silence's level.
    const g = walk();
    g.run(12, undefined, 60, undefined, false);
    expect(g.field.emission).toBeCloseTo(EMISSION.silence, 6);
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
        const shape = field.shapes[s];
        for (let n = 0; n < shape.bark; n += 2) { closest = Math.min(closest, Math.abs(barkPoint(t, state, shape, n)[0]) - drift); checked++; }
        for (let n = 0; n < shape.twigs; n++) { closest = Math.min(closest, Math.abs(twigPoint(t, state, shape, n)[0]) - drift); checked++; }
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
    // Ground: two of each; trees at Medium: four of each (bark, twigs, blossoms, filaments).
    expect(geometry).toHaveBeenCalledTimes(6); expect(material).toHaveBeenCalledTimes(6);
  });
});
