import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type WebGLRenderer } from 'three';
import { createCues, type Cue, type CuePhase, type CuesFrame } from '../../experience/MusicalCues';
import { packWaves } from '../../render-systems/fields/fieldLaw';
import { MAX_WAVES, WaveField } from '../../render-systems/waves/WaveField';
import { QUALITY_PROFILES } from '../../renderer/quality';
import { createGeometry } from '../../visual-engine/geometry/GeometryState';
import { emergenceLawGlsl, emergentOut, emergentPoint, groundVertex, PIECES, SHAPE, type Emergent } from '../../visual-engine/primitives/emergenceLaw';
import { DEFAULT_EMERGENCE, EmergenceField, emergenceParams, MAX_STRUCTURES, type EmergenceSettings } from '../../visual-engine/primitives/terrainEmergence';
import { createTerrain, PERIOD, terrainHeight, type TerrainValues } from '../../visual-engine/primitives/terrainLaw';
import { TerrainMotion, type TerrainParams } from '../../visual-engine/primitives/terrainMotion';
import type { RecipeVisualizer } from '../../visual-engine/RecipeVisualizer';
import { PULSE_LIMIT } from '../../visual-engine/structural/SolidTypes';
import { createWorld, type WorldState } from '../../world/WorldState';
import { WorldView } from '../../world/WorldView';
import terrain from '.';
import preset from './preset.json';
import { type GenerativeTerrainParams } from './recipe';
import { terrainDigest } from './terrainDigest';

/*
 * Structures that rise out of Generative Terrain (docs/scene-families.md): the law that anchors them to the ground's own
 * law, the life the music gives them, their budgets, and what they never do (float, drift, break on a prediction or on
 * the experience's drop, grow without bound, depend on the frame rate).
 */

const P = preset.visual as unknown as GenerativeTerrainParams;
const ground = (set: Partial<TerrainValues> = {}): TerrainValues => ({ ...createTerrain(), cell: P.cell, relief: P.relief, rough: P.roughness, valley: P.valley, seedX: 7, seedY: 11, ...set });
const structure = (set: Partial<Emergent> = {}): Emergent => ({ J: 18, R: 60, mode: 1, shape: SHAPE.pillar, height: 5, width: 0.4, rise: 1, pulse: 0, age: -1, seed: 0.37, light: 1, turn: 0.4, ...set });
/** Grounds in many states: travelled, terraced, plates lifted, a release passing, fronts crossing. */
function grounds(): { t: TerrainValues; a?: Float32Array; b?: Float32Array }[] {
  const waves = new WaveField(), a = new Float32Array(MAX_WAVES * 4), b = new Float32Array(MAX_WAVES * 4);
  waves.spawn(5, 1, 0, 1.6, 0.22, 1.4); waves.spawn(5.2, 0.8, 0.3, 1.2, 0.18, 0.6, -0.4);
  packWaves(a, b, waves, 5.5);
  return [
    { t: ground({ row: 10, shift: 0.3, col: 2, shiftX: 0.4 }) },
    { t: ground({ row: 40, shift: 0.7, col: -1, shiftX: 0.9, terrace: 1, throat: 0.6, lift: 1.1, ridge: 0.8, crest: 1.4, relief: 11 }), a, b },
    { t: ground({ row: PERIOD - 3, shift: 0.1, col: 5, shiftX: 0.2, release: 0.8, bulge: 3, front: 30, quake: 0.3, lean: -0.8 }), a, b },
  ];
}
/** The ground's surface under a point of the mesh (column x, row z, fractional), as the mesh's triangles make it: the diagonal alternates. */
function surface(t: Readonly<TerrainValues>, x: number, z: number, a?: Float32Array, b?: Float32Array): number {
  const i = Math.floor(x), k = Math.floor(z), u = x - i, v = z - k, h = (di: number, dk: number): number => terrainHeight(t, i + di, k + dk, a, b);
  // Mesh vertex columns are counted from the middle; the parity of the alternation follows the mesh's own (columns even).
  const flip = (((i + P.columns / 2) + k) % 2 + 2) % 2 === 1;
  if (!flip) return u >= v ? h(0, 0) + (h(1, 0) - h(0, 0)) * u + (h(1, 1) - h(1, 0)) * v : h(0, 0) + (h(1, 1) - h(0, 1)) * u + (h(0, 1) - h(0, 0)) * v;
  return u + v <= 1 ? h(0, 0) + (h(1, 0) - h(0, 0)) * u + (h(0, 1) - h(0, 0)) * v : h(1, 1) + (h(1, 1) - h(0, 1)) * (u - 1) + (h(1, 1) - h(1, 0)) * (v - 1);
}

describe('emergence law: what stands on the ground is placed by the ground\'s own law', () => {
  it('a raised cell: the four corners of its base are the ground\'s own vertices, in every state of the ground, and its top is above them', () => {
    let checked = 0;
    for (const { t, a, b } of grounds()) {
      for (const [J, R] of [[18, t.row + 20], [-9, t.row + 77], [3, t.row + 130]]) {
        const e = structure({ J, R: R % PERIOD, mode: 0, shape: SHAPE.block }), i = J - t.col, k = ((R % PERIOD) - t.row + PERIOD) % PERIOD;
        const corners: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
        for (let c = 0; c < 6; c++) {
          const [di, dk] = corners[Math.min(c, 3)], base = emergentPoint(t, e, c, 0, 0, a, b), vertex = groundVertex(t, i + di, k + dk, a, b);
          expect(base).toEqual(vertex);
          const top = emergentPoint(t, e, c, 1, PIECES - 1, a, b);
          expect(top[1]).toBeGreaterThan(Math.max(...corners.map(([x, z]) => groundVertex(t, i + x, k + z, a, b)[1])) + 0.99 * e.height);
          checked++;
        }
      }
    }
    expect(checked).toBe(54);
  });

  it('a solid in the ground: no part of its base is ever above the facets under it; risen it stands clear of them, at rest it is wholly buried', () => {
    for (const { t, a, b } of grounds()) {
      for (const [J, R, shape] of [[16, t.row + 30, SHAPE.pillar], [-14, t.row + 60, SHAPE.crystal], [12, t.row + 100, SHAPE.prism]]) {
        const risen = structure({ J, R: R % PERIOD, shape, width: 0.85 }), i = J - t.col, k = ((R % PERIOD) - t.row + PERIOD) % PERIOD;
        for (let c = 0; c < 6; c++) {
          const base = emergentPoint(t, risen, c, 0, 0, a, b);
          // Where the base corner is, in the mesh's columns and rows (the ground is laid out from them).
          const x = i + (base[0] - groundVertex(t, i, k, a, b)[0]) / t.cell, z = k + (-base[2] - (-groundVertex(t, i, k, a, b)[2])) / t.cell;
          expect(base[1]).toBeLessThanOrEqual(surface(t, x, z, a, b) + 1e-6);
          const buried = emergentPoint(t, { ...risen, rise: 0 }, c, 1, PIECES - 1, a, b);
          expect(buried[1]).toBeLessThanOrEqual(surface(t, x, z, a, b) + 1e-6);
        }
        let high = -Infinity;
        for (let di = -1; di <= 1; di++) for (let dk = -1; dk <= 1; dk++) high = Math.max(high, terrainHeight(t, i + di, k + dk, a, b));
        expect(emergentPoint(t, risen, 0, 1, PIECES - 1, a, b)[1]).toBeGreaterThan(high);
      }
    }
  });

  it('it travels with the ground: as the mesh slides over the lattice it stays on the same lattice point, at the ground\'s height there', () => {
    const e = structure({ J: 14, R: 300, mode: 1 }), seen: number[] = [];
    for (let s = 0; s < 40; s++) {
      const t = ground({ row: 200 + s * 2, shift: (s * 0.37) % 1, col: (s % 5) - 2, shiftX: (s * 0.21) % 1 });
      const k = ((e.R - t.row) % PERIOD + PERIOD) % PERIOD, i = e.J - t.col, at = groundVertex(t, i, k), p = emergentPoint(t, e, 0, 0, 0);
      // Its base is where its own lattice point is, however far the viewer has come; the offset from it never changes.
      seen.push(Math.round((p[0] - at[0]) * 1e6), Math.round((p[2] - at[2]) * 1e6));
      expect(emergentOut.base[0]).toBeCloseTo(at[0], 9); expect(emergentOut.base[2]).toBeCloseTo(at[2], 9);
    }
    expect(new Set(seen.filter((_, n) => n % 2 === 0)).size).toBe(1); expect(new Set(seen.filter((_, n) => n % 2 === 1)).size).toBe(1);
  });

  it('rigid: a pulse is one uniform change of scale within the limit; broken, every piece keeps its shape, the lowest stays, the others fall and sink', () => {
    const t = ground({ row: 5 }), e = structure({ shape: SHAPE.prism }), pulse = structure({ shape: SHAPE.prism, pulse: PULSE_LIMIT });
    for (let c = 0; c < 6; c++) for (let p = 0; p < PIECES; p++) {
      const a = emergentPoint(t, e, c, 1, p), base = emergentOut.base, b = emergentPoint(t, pulse, c, 1, p);
      for (let q = 0; q < 3; q++) expect(b[q] - base[q]).toBeCloseTo((a[q] - base[q]) * (1 + PULSE_LIMIT), 9);
    }
    const piece = (age: number, p: number): number[][] => [0, 1, 2, 3, 4, 5].flatMap((c) => [emergentPoint(t, { ...e, age }, c, 0, p), emergentPoint(t, { ...e, age }, c, 1, p)]);
    const distances = (points: number[][]): number[] => points.flatMap((x, n) => points.slice(n + 1).map((y) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])));
    for (const p of [1, 2]) {
      const whole = distances(piece(-1, p));
      for (const age of [0.2, 0.7, 1.5, 2.5]) distances(piece(age, p)).forEach((d, n) => expect(d).toBeCloseTo(whole[n], 6));
    }
    expect(piece(2.5, 0)).toEqual(piece(-1, 0));
    // Thrown up first, back on the ground and into it later.
    const centre = (age: number, p: number): number => piece(age, p).reduce((s, x) => s + x[1], 0) / 12;
    expect(centre(0.3, 2)).toBeGreaterThan(centre(-1, 2));
    emergentPoint(t, e, 0, 0, 0);
    expect(centre(2.8, 1)).toBeLessThan(emergentOut.floor + 0.5);
  });

  it('the GLSL is the same law: it calls the terrain law for the ground, and carries the same constants', () => {
    expect(emergenceLawGlsl).toContain('terrainHeight(i, k, terrainDepth(k))');
    expect(emergenceLawGlsl).not.toContain('BURY_PLACEHOLDER');
    for (const constant of ['16.0', '1.1', '2.5', '0.45', '0.05']) expect(emergenceLawGlsl).toContain(constant);
  });
});

/** The ground's motion and the emergence over a hand-set world and hand-set cues, at any frame rate. */
function flight(settings: EmergenceSettings = {}, seed = 20261013) {
  const world = createWorld(), view = new WorldView(), geometry = createGeometry(), motion = new TerrainMotion(P as TerrainParams), cues = createCues();
  const field = new EmergenceField(settings, seed);
  world.time = 10; cues.silent = false; cues.live = true; cues.phase = 'groove';
  view.update(world, { motion: 1, expansion: 1, turbulence: 1 });
  const push = (kind: Cue['kind'], status: Cue['status'], time: number, ref = 0): void => {
    const seq = ++cues.seq;
    Object.assign(cues.cues[seq % cues.cues.length], { seq, kind, status, time, expected: 0, strength: 0.9, confidence: 1, ref });
  };
  const run = (seconds: number, set?: (world: WorldState, cues: CuesFrame, t: number) => void, fps = 60, each?: () => void, timed = true): void => {
    const from = world.time;
    for (let k = 1; k <= Math.round(seconds * fps); k++) {
      world.time = from + k / fps;
      world.speed = 1.5; world.potential = world.potential || 0.2;
      set?.(world, cues, world.time);
      world.travel += world.speed / fps;
      view.update(timed ? world : undefined, { motion: 1, expansion: 1, turbulence: 1 });
      const v = motion.step(1 / fps, view, geometry, undefined, world.time);
      field.step(1 / fps, v, view, v.row + v.shift, P.rows, P.columns, motion.ring, motion.tension, timed ? cues : undefined, world.time);
      each?.();
    }
  };
  const anchors = (): string[] => { const out: string[] = []; for (let s = 0; s < field.count; s++) out.push(`${field.anchor[s * 4]}:${field.anchor[s * 4 + 1]}`); return out.sort(); };
  return { world, view, motion, field, cues, push, run, anchors };
}

describe('emergence: the life the music gives the structures', () => {
  it('without a clock, or in silence, nothing new rises and nothing moves', () => {
    const f = flight();
    f.run(20, undefined, 60, undefined, false);
    expect(f.field.stats.spawned).toBe(0); expect(f.field.count).toBe(0);
    const g = flight();
    g.run(15);
    const before = [Array.from(g.field.body.subarray(0, g.field.count * 4)), g.field.stats.spawned];
    expect(before[1]).toBeGreaterThan(0);
    // A silence: the world stands still (no travel), and so does everything on the ground.
    g.run(10, (world, cues) => { cues.silent = true; cues.phase = 'silence'; world.speed = 0; });
    expect([Array.from(g.field.body.subarray(0, g.field.count * 4)), g.field.stats.spawned]).toEqual(before);
  });

  it('a steady groove keeps a few persistent structures, whatever its loudness; none breaks', () => {
    const counts = (light: number): number[] => {
      const f = flight(), seen: number[] = [];
      f.run(60, (world) => { world.illumination = light; world.excitation = light; world.radius = 0.3 * light; }, 60, () => seen.push(f.field.count));
      expect(f.field.stats.fractured + f.field.in('fracture')).toBe(0);
      return seen;
    };
    const quiet = counts(0.3), loud = counts(1);
    // Not the volume: the same structures at both levels (the density reads the music's slow state, never its level).
    expect(loud).toEqual(quiet);
    // A fast flight (twelve rows a second): the density is per ground travelled, so this is about the most a groove keeps.
    const later = quiet.slice(20 * 60);
    expect(Math.max(...later)).toBeLessThanOrEqual(10); expect(Math.min(...later)).toBeGreaterThanOrEqual(1);
  });

  it('a predicted release prepares structures that wait in formation; withdrawn, they go back; it never makes one emerge or break', () => {
    const f = flight();
    f.run(10);
    f.push('prepare', 'predicted', f.world.time, 7);
    f.run(8, (world, cues) => { cues.phase = 'rising'; world.potential = 0.6; });
    expect(f.field.in('formation')).toBeGreaterThan(0);
    const waiting = f.field.in('formation'), retreated = f.field.stats.retreated;
    f.push('withdraw', 'refuted', f.world.time, 7);
    f.run(0.1);
    // Still at the ground, a formation goes back at once.
    expect(f.field.in('formation')).toBe(0);
    expect(f.field.stats.retreated - retreated).toBe(waiting);
    expect(f.field.stats.bursts).toBe(0); expect(f.field.gate.stats.offered).toBe(0);
  });

  it('a release heard: what waited emerges, the next rows fill, and the gate breaks some at the release\'s own time', () => {
    const f = flight();
    f.run(25);
    f.push('prepare', 'predicted', f.world.time, 3);
    f.run(4, (world, cues) => { cues.phase = 'rising'; world.potential = 0.6; });
    const spawned = f.field.stats.spawned, at = f.world.time - 0.05;
    f.push('release', 'confirmed', at);
    f.run(0.5, (_, cues) => { cues.phase = 'release'; });
    expect(f.field.in('formation')).toBe(0);
    expect(f.field.stats.bursts).toBe(1); expect(f.field.gate.stats.fired).toBe(1);
    expect(f.field.in('fracture')).toBeGreaterThan(0);
    // Dated at the event: its age is the time since the release, not since the frame it was read in.
    for (let s = 0; s < f.field.count; s++) if (f.field.brk[s * 4] >= 0) expect(f.field.brk[s * 4]).toBeCloseTo(f.world.time - at, 6);
    f.run(3);
    expect(f.field.stats.spawned).toBeGreaterThan(spawned + 2);
    expect(f.field.stats.fractured).toBeGreaterThan(0);
  });

  it('only cues act: an accent lights, an experience drop does nothing, and a breakdown brings the structures down one by one', () => {
    const f = flight();
    f.run(25);
    expect(f.field.in('active') + f.field.in('resonance')).toBeGreaterThan(0);
    f.push('accent', 'observed', f.world.time);
    f.run(0.1);
    expect(f.field.stats.accents).toBe(1); expect(f.field.in('fracture')).toBe(0);
    // A breakdown: nothing new; what stands goes back into the ground (one every 1.2 s) or passes behind the viewer.
    const spawned = f.field.stats.spawned, retreated = f.field.stats.retreated;
    const standing: number[] = [];
    f.run(12, (_, cues) => { cues.phase = 'breakdown'; }, 60, () => standing.push(f.field.in('formation') + f.field.in('emergence') + f.field.in('active') + f.field.in('resonance')));
    expect(f.field.stats.spawned).toBe(spawned);
    expect(f.field.stats.retreated).toBeGreaterThan(retreated);
    expect(standing.at(-1)).toBe(0);
    for (let k = 1; k < standing.length; k++) expect(standing[k]).toBeLessThanOrEqual(standing[k - 1]);
  });

  it('budgets are kept whatever the music asks: at most so many structures, so many forming, so many breaking; memory does not grow', () => {
    const f = flight({ capacity: 10, emerging: 3, fragments: 2, density: 1, rate: 4 }), live = new Set<number>();
    let forming = 0;
    f.run(40, (world, cues, t) => {
      cues.phase = 'rising'; world.potential = 0.9;
      if (Math.round(t * 60) % 120 === 0) f.push('release', 'confirmed', t);
    }, 60, () => { live.add(f.field.count); forming = Math.max(forming, f.field.in('formation') + f.field.in('emergence')); expect(f.field.in('fracture')).toBeLessThanOrEqual(2); });
    expect(Math.max(...live)).toBeLessThanOrEqual(10);
    expect(f.field.stats.refused).toBeGreaterThan(0);
    // Bursts may bring emergences beyond the forming budget; between them, the budget holds.
    expect(forming).toBeLessThanOrEqual(10);
    expect(f.field.anchor.length).toBe(MAX_STRUCTURES * 4);
    expect(emergenceParams({ capacity: 999, pulse: 1, modes: 'nonsense', low: 0.5, high: 0.1 })).toMatchObject({ capacity: MAX_STRUCTURES, pulse: PULSE_LIMIT, modes: DEFAULT_EMERGENCE.modes, low: 0.5, high: 0.5 });
  });

  it('the same seed and the same music are the same structures; at 30, 60 and 144 fps the same ones rise', () => {
    const script = (world: WorldState, cues: CuesFrame, t: number): void => {
      const phase: CuePhase = t < 25 ? 'groove' : t < 35 ? 'rising' : 'groove';
      cues.phase = phase; world.potential = phase === 'rising' ? 0.7 : 0.2;
    };
    const sets = [30, 60, 144].map((fps) => { const f = flight(); f.run(45, script, fps); return { anchors: f.anchors(), spawned: f.field.stats.spawned }; });
    expect(sets[1]).toEqual(sets[0]); expect(sets[2]).toEqual(sets[0]);
    const again = flight(); again.run(45, script, 60);
    expect(again.anchors()).toEqual(sets[1].anchors);
    const other = flight({}, 7); other.run(45, script, 60);
    expect(other.anchors()).not.toEqual(sets[1].anchors);
  });

  it('they pass under the viewer and go back to the pool; a new session sends back what waited for the last one\'s release', () => {
    const f = flight();
    f.run(90);
    expect(f.field.stats.passed).toBeGreaterThan(0);
    expect(f.field.stats.recycled).toBe(f.field.stats.passed + f.field.stats.retreated + f.field.stats.fractured);
    f.push('prepare', 'predicted', f.world.time, 9);
    f.run(6, (world, cues) => { cues.phase = 'rising'; world.potential = 0.7; });
    expect(f.field.in('formation')).toBeGreaterThan(0);
    f.field.reset();
    f.run(0.1);
    expect(f.field.in('formation')).toBe(0);
    f.field.clear();
    expect([f.field.count, f.field.stats.spawned]).toEqual([0, 0]);
  });
});

describe('Generative Terrain with and without emergence', () => {
  beforeEach(() => vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 }));
  afterEach(() => vi.unstubAllGlobals());

  it('off: the scene is the ground alone, its motion untouched by what would stand on it', () => {
    const off = terrain.create({ ...terrain.preset, visual: { ...terrain.preset.visual, emergence: { enabled: false } } }) as RecipeVisualizer<unknown>;
    off.init({ renderer: { getPixelRatio: () => 1 } as WebGLRenderer, quality: QUALITY_PROFILES.low, width: 800, height: 600, addPass: () => undefined });
    expect(off.world.mounted.map((m) => m.slot.id)).toEqual(['ground']);
    off.dispose();
    // The ground's motion is the motion module's alone: with or without the emergence the same digest.
    const params = P as TerrainParams;
    expect(terrainDigest({ ...params, response: undefined }, 60)).toBe(terrainDigest(params, 60));
  });
});
