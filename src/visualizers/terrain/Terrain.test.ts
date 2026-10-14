import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Color, LineSegments, Material, Mesh, Texture, type ShaderMaterial, type WebGLRenderer } from 'three';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { AudioAnalyzer } from '../../audio/analysis/AudioAnalyzer';
import { newFrame } from '../../audio/features/decode';
import { VisualResponse } from '../../audio/visual-response/VisualResponse';
import { DEFAULT_DIRECTION } from '../../director/profiles';
import { VisualDirector } from '../../director/VisualDirector';
import { EventStream } from '../../experience/EventStream';
import { createSnapshot } from '../../experience/types';
import { packWaves } from '../../render-systems/fields/fieldLaw';
import { MAX_WAVES, WaveField } from '../../render-systems/waves/WaveField';
import { QUALITY_PROFILES } from '../../renderer/quality';
import { FIXTURES } from '../../show/fixtures';
import type { Visualizer } from '../../types/visualizer';
import { createGeometry } from '../../visual-engine/geometry/GeometryState';
import { BEHIND, createTerrain, PERIOD, TERRAIN, terrainAcross, terrainBand, terrainBound, terrainDepth, terrainHeight, terrainMeander, type TerrainValues } from '../../visual-engine/primitives/terrainLaw';
import { CONFIGURATIONS, FRONT_SPEED, strainOf, TerrainMotion } from '../../visual-engine/primitives/terrainMotion';
import { terrainQuality, type TerrainPrimitive } from '../../visual-engine/primitives/TerrainPrimitive';
import type { RecipeVisualizer } from '../../visual-engine/RecipeVisualizer';
import { createWorld, type WorldState } from '../../world/WorldState';
import { REST_VIEW, WorldView } from '../../world/WorldView';
import { findVisualizer, visualizers } from '../registry';
import tunnelPreset from '../tunnel/preset.json';
import { TunnelVisualizer } from '../tunnel/TunnelVisualizer';
import preset from './preset.json';

const P = preset.visual, GAINS = { motion: 1, expansion: 1, turbulence: 1 };
const rest = (set: Partial<TerrainValues> = {}): TerrainValues => ({ ...createTerrain(), cell: P.cell, relief: P.relief, rough: P.roughness, valley: P.valley, seedX: 7, seedY: 11, ...set });

/** The terrain's motion over a hand-set world, at any frame rate. `script` sets the world at each instant (its travel and angle included). */
function flight() {
  const world = createWorld(), view = new WorldView(), geometry = createGeometry(), motion = new TerrainMotion(P), events = new EventStream();
  world.time = 10;
  // The view has seen the world once: what it travels from now on is counted from here.
  view.update(world, GAINS);
  let rows = 0, last = 0;
  const run = (seconds: number, script?: (world: WorldState, t: number) => void, fps = 60, each?: () => void): void => {
    const from = world.time;
    for (let k = 1; k <= Math.round(seconds * fps); k++) {
      world.time = from + k / fps;
      script?.(world, world.time);
      view.update(world, GAINS);
      const v = motion.step(1 / fps, view, geometry, events, world.time), at = v.row + v.shift;
      // Rows covered, unwrapped: the position is kept within a period.
      rows += (at - last + PERIOD) % PERIOD; last = at;
      each?.();
    }
  };
  return { world, view, geometry, motion, events, run, get rows() { return rows; } };
}

describe('terrain law: the ground', () => {
  it('is rigid: a point of the landscape keeps its height however far the viewer has travelled, across the period too', () => {
    // The same lattice points seen from four places on the path (the mesh slides by whole cells, forwards and sideways).
    const from = [rest({ row: 10, shift: 0.3, col: 2, shiftX: 0.4 }), rest({ row: 13, shift: 0.7, col: 1, shiftX: 0.9 }), rest({ row: PERIOD - 4, shift: 0, col: -3, shiftX: 0.1 }), rest({ row: 2, shift: 0.5, col: 0, shiftX: 0 })];
    let checked = 0;
    const varied = new Set<number>();
    for (let r = 20; r < 60; r += 3) {
      for (let j = -20; j <= 20; j += 4) {
        const heights = from.map((t) => terrainHeight(t, j - t.col, ((r - t.row) % PERIOD + PERIOD) % PERIOD));
        for (const h of heights) expect(h).toBe(heights[0]);
        varied.add(Math.round(heights[0] * 100)); checked++;
      }
    }
    expect(checked).toBeGreaterThan(100); expect(varied.size).toBeGreaterThan(40);
    // And it is a landscape: a floor along the valley's centre, walls beside it.
    const t = from[0];
    const floor = terrainHeight(t, Math.round(terrainMeander(40 + t.row) / t.cell) - t.col, 40), wall = Math.max(...[-30, -24, 24, 30].map((i) => terrainHeight(t, i, 40)));
    expect(Math.abs(floor)).toBeLessThan(0.1 * P.relief + P.roughness); expect(wall).toBeGreaterThan(0.25 * P.relief);
  });

  it('every term the world adds is zero at rest, and each does one thing', () => {
    const base = rest({ row: 5 }), at = (t: TerrainValues, i: number, k: number): number => terrainHeight(t, i, k);
    // Pressure raises the relief: the walls go up, the floor stays where it is.
    const swollen = rest({ row: 5, relief: P.relief * 1.3 });
    expect(at(swollen, 28, 30) / at(base, 28, 30)).toBeGreaterThan(1.15);
    // Stored potential gathers the heights onto terraces: whole steps of the relief.
    const terraced = rest({ row: 5, terrace: 1, rough: 0 }), step = P.relief / terraced.stepsAfter;
    for (const i of [-30, -22, 18, 26, 31]) expect(Math.abs(at(terraced, i, 30) / step - Math.round(at(terraced, i, 30) / step))).toBeLessThan(1e-4);
    // Strain lifts whole plates: every point of a plate by the same amount, another plate by another.
    const lifted = rest({ row: 0, lift: 1 }), still = rest({ row: 0 }), shift = (i: number, k: number): number => at(lifted, i, k) - at(still, i, k);
    const plate = lifted.plateAfter, inside = [shift(0, 16), shift(3, 17), shift(7, 23), shift(5, 20)];
    for (const s of inside) expect(s).toBeCloseTo(inside[0], 5);
    expect(Math.abs(inside[0])).toBeLessThanOrEqual(1);
    const others = new Set([shift(plate, 16), shift(-plate, 16), shift(0, 16 + plate), shift(2 * plate, 16 + 2 * plate)].map((s) => Math.round(s * 1000)));
    expect(others.size).toBeGreaterThan(1);
    // A release is a crest where its front is, and nowhere else.
    const released = rest({ row: 5, release: 1, bulge: 3, front: 40 }), k40 = Math.round(40 / P.cell) + BEHIND;
    expect(at(released, 0, k40) - at(base, 0, k40)).toBeGreaterThan(2.5); expect(at(released, 0, k40 + 30) - at(base, 0, k40 + 30)).toBeLessThan(1e-3);
    expect(terrainBand(released, 40)).toBe(1);
    // Behind the front the ground has its new configuration, ahead of it the old one.
    const reorganised = rest({ row: 5, terrace: 1, rough: 0, front: 40, stepsAfter: 9, stepsBefore: 4 });
    const near = at(reorganised, 28, 20) / (P.relief / 9), far = at(reorganised, 28, 80) / (P.relief / 4);
    expect(Math.abs(near - Math.round(near))).toBeLessThan(1e-4); expect(Math.abs(far - Math.round(far))).toBeLessThan(1e-4);
    // The far end leans as one piece: every column of a row by the same distance, and nothing under the viewer.
    const leaning = rest({ lean: 1 });
    expect(terrainAcross(leaning, 5, 60) - terrainAcross(base, 5, 60)).toBeCloseTo(terrainAcross(leaning, -20, 60) - terrainAcross(base, -20, 60), 9);
    expect(terrainAcross(leaning, 5, 0)).toBe(terrainAcross(base, 5, 0)); expect(terrainDepth(base, BEHIND)).toBe(0);
  });

  it('the world\'s wave fronts cross it as rings: a low one lifts the ground where it is, a high one hardly', () => {
    const waves = new WaveField(), a = new Float32Array(MAX_WAVES * 4), b = new Float32Array(MAX_WAVES * 4), t = rest({ wave: 1 });
    waves.spawn(5, 1, 0, 1.6, 0.22, 1.4);
    packWaves(a, b, waves, 5.5);
    const radius = 1.6 * 0.5 * 14, k = Math.round((16 + radius) / P.cell) + BEHIND, lift = (i: number, row: number): number => terrainHeight(t, i, row, a, b) - terrainHeight(t, i, row);
    expect(lift(0, k)).toBeGreaterThan(0.2); expect(Math.abs(lift(0, k + 30))).toBeLessThan(1e-3); expect(Math.abs(lift(0, BEHIND))).toBeLessThan(1e-3);
    const high = new WaveField();
    high.spawn(5, 1, 1, 1.6, 0.22, 1.4);
    packWaves(a, b, high, 5.5);
    expect(lift(0, k)).toBeLessThan(0.1);
    // Without fronts (no clock) nothing is added.
    a.fill(0); b.fill(0);
    expect(lift(0, k)).toBe(0);
  });

  it('is finite and bounded for any values, broken ones included', () => {
    const a = new Float32Array(MAX_WAVES * 4), b = new Float32Array(MAX_WAVES * 4);
    for (let w = 0; w < MAX_WAVES; w++) { a.set([0.5, 0, 0.1, 0.4 + 0.2 * w], w * 4); b.set([2, 2.4, 0.2, w % 2 ? -1 : w / 7], w * 4); }
    const sets: TerrainValues[] = [
      rest(), rest({ terrace: 1, throat: 1, ridge: 1, crest: 1.5, lift: 1.1, release: 1, bulge: 3.2, front: 30, quake: 0.3, wave: 1.1, lean: 1, relief: P.relief * 1.32 }),
      rest({ row: PERIOD - 1, shift: 0.999, col: -9, shiftX: 0.999, relief: P.relief * 0.8, lift: 1.1, plateAfter: 16, plateBefore: 4, stepsAfter: 4, stepsBefore: 9, front: 0 }),
    ];
    for (const t of sets) {
      const bound = terrainBound(t);
      for (let k = 0; k <= 150; k += 7) for (let i = -36; i <= 36; i += 5) {
        const h = terrainHeight(t, i, k, a, b);
        expect(Number.isFinite(h)).toBe(true); expect(Math.abs(h)).toBeLessThanOrEqual(bound);
        expect(Number.isFinite(terrainAcross(t, i, terrainDepth(t, k)))).toBe(true);
      }
    }
  });
});

describe('terrain motion: the ground under the shared world', () => {
  it('travels the world\'s own distance, the same at any frame rate, continuous across the period, and stops when the world does', () => {
    const rows = [30, 60, 144].map((fps) => {
      const f = flight();
      // A world that stands still, then kicks (its travel as a jump of speed every half second makes it) for 12 s, then stands still again.
      const travelled = (t: number): number => {
        const s = Math.min(Math.max(t - 10.5, 0), 12), kicks = Math.floor(s / 0.5 + 1e-9);
        return s <= 0 ? 0 : 1.2 * s + 1.6 * 0.15 * (kicks * (1 - Math.exp(-0.5 / 0.15)) + 1 - Math.exp(-(s - kicks * 0.5) / 0.15));
      };
      let jerk = 0, speed = 0;
      f.run(12.5, (world, t) => { world.travel = travelled(t); }, fps, () => { jerk = Math.max(jerk, Math.abs(f.motion.speed - speed)); speed = f.motion.speed; });
      // A kick is a jump of the world's speed (2.8 × the stride from rest, 1.6 × after): the ground takes it as a surge, never in one frame.
      expect(jerk).toBeLessThan(2.8 * P.stride / 3);
      f.run(3.5, (world, t) => { world.travel = travelled(t); }, fps);
      expect(f.motion.speed).toBe(0);
      const still = f.motion.values.row + f.motion.values.shift;
      f.run(3, undefined, fps);
      expect(f.motion.values.row + f.motion.values.shift).toBe(still);
      expect(f.rows).toBeCloseTo(travelled(30) * P.stride / P.cell, 3);
      return f.rows;
    });
    expect(rows[0]).toBeCloseTo(rows[1], 3); expect(rows[2]).toBeCloseTo(rows[1], 3);
    // Hours of flight stay within one period of the landscape: nothing grows, and the viewer keeps following the valley.
    const f = flight();
    let most = 0;
    f.run(120, (world, t) => { world.travel = 6 * (t - 10); }, 30, () => {
      const v = f.motion.values;
      expect(v.row).toBeGreaterThanOrEqual(0); expect(v.row).toBeLessThan(PERIOD); expect(v.shift).toBeGreaterThanOrEqual(0); expect(v.shift).toBeLessThan(1);
      expect((v.col + v.shiftX) * P.cell).toBeCloseTo(terrainMeander(v.row + v.shift + BEHIND), 9);
      most = Math.max(most, v.row);
    });
    expect(f.rows).toBeGreaterThan(5 * PERIOD); expect(most).toBeGreaterThan(PERIOD - 40);
  });

  it('in a world at rest it is the landscape, still: nothing moves by itself, with or without a clock', () => {
    const f = flight();
    f.run(2);
    const v = f.motion.values, before = { ...v };
    expect([v.terrace, v.throat, v.lift, v.release, v.quake, v.ridge, v.lean]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(v.crest).toBe(1); expect(v.relief).toBe(P.relief); expect(f.motion.bank).toBe(-0);
    f.run(30);
    expect({ ...v }).toEqual(before);
    // Without a clock it is the same landscape where the flight left it.
    const motion = new TerrainMotion(P);
    for (let k = 0; k < 600; k++) motion.step(1 / 60, REST_VIEW, createGeometry());
    expect({ ...motion.values }).toEqual({ ...before, col: Math.floor(terrainMeander(BEHIND) / P.cell), shiftX: terrainMeander(BEHIND) / P.cell - Math.floor(terrainMeander(BEHIND) / P.cell) });
  });

  it('a build organises the ground progressively; steady music does not; a forecast that never comes true leaves nothing behind', () => {
    const f = flight();
    // What a steady groove keeps stored: the ground stays as it is.
    f.run(6, (world) => { world.potential = 0.2; world.turbulence = 0.2; });
    expect(f.motion.values.terrace).toBe(0); expect(f.motion.values.lift).toBe(0); expect(f.motion.aperture).toBe(0);
    // A build: the stored potential rises over eight seconds. Terraces and the throat follow it, never by a step.
    const terraces: number[] = [];
    f.run(8, (world, t) => { world.potential = 0.2 + 0.6 * (t - 16) / 8; world.turbulence = 0.2; }, 60, () => terraces.push(f.motion.values.terrace));
    expect(terraces.at(-1)).toBeGreaterThan(0.9); expect(f.motion.values.throat).toBeGreaterThan(0.8);
    for (let k = 1; k < terraces.length; k++) { expect(terraces[k]).toBeGreaterThanOrEqual(terraces[k - 1]); expect(terraces[k] - terraces[k - 1]).toBeLessThan(0.01); }
    expect(f.motion.values.lift).toBeGreaterThan(0);
    const configuration = [f.motion.values.plateAfter, f.motion.values.stepsAfter];
    // The drop never comes: what was stored leaks away. The ground goes back, over seconds, and is the landscape again.
    const back: number[] = [], lifts: number[] = [];
    f.run(40, (world, t) => { world.potential = 0.8 * Math.exp(-(t - 24) / 8); world.turbulence = 0.2 * Math.exp(-(t - 24) / 4); }, 60, () => { back.push(f.motion.values.terrace); lifts.push(f.motion.values.lift); });
    for (let k = 1; k < back.length; k++) { expect(back[k]).toBeLessThanOrEqual(back[k - 1]); expect(back[k - 1] - back[k]).toBeLessThan(0.01); expect(Math.abs(lifts[k] - lifts[k - 1])).toBeLessThan(0.03); }
    expect(back.at(-1)).toBe(0); expect(lifts.at(-1)).toBe(0); expect(f.motion.aperture).toBe(0);
    // Nothing irreversible happened: no front, no other configuration, nothing held.
    expect(f.motion.values.release).toBe(0); expect(f.motion.values.front).toBe(1e4);
    expect([f.motion.values.plateAfter, f.motion.values.stepsAfter]).toEqual(configuration); expect(configuration).toEqual([...CONFIGURATIONS[0]]);
  });

  it('a release is a front that runs down the valley at its own speed and leaves another ground behind it', () => {
    const f = flight();
    f.run(2, (world) => { world.potential = 0.7; });
    f.world.releaseTime = f.world.time; f.world.releaseStrength = 0.6; f.world.potential = 0.1;
    f.run(0.5);
    const v = f.motion.values;
    expect(v.front).toBeCloseTo(FRONT_SPEED * 0.5, 6); expect(v.release).toBeCloseTo(Math.exp(-0.5 / 1.6), 6);
    expect([v.plateBefore, v.stepsBefore]).toEqual([...CONFIGURATIONS[0]]); expect([v.plateAfter, v.stepsAfter]).not.toEqual([...CONFIGURATIONS[0]]);
    expect(v.lift).toBeGreaterThan(0);
    // It passes: the front leaves the valley, its pressure fades, and the new ground stays.
    f.run(20);
    expect(v.release).toBeLessThan(1e-4); expect(v.lift).toBeLessThan(1e-3); expect([v.plateAfter, v.stepsAfter]).not.toEqual([...CONFIGURATIONS[0]]);
    // Every plate size divides the period, so no plate is cut at the seam.
    for (const [plate] of CONFIGURATIONS) expect(PERIOD % plate).toBe(0);
  });

  it('plates lift when the world really strains, with hysteresis; an ordinary kick lifts nothing, an event that stands out does, once', () => {
    const f = flight(), strike = (significance: number): void => f.events.push('impact', f.world.time, 0.6, 0.9, 1, 0.4, 0, significance);
    f.run(1);
    // A strain that wavers below where the ground cracks: no plate moves.
    let most = 0;
    f.run(10, (world, t) => { world.potential = 0.4 + 0.1 * Math.sin(t * 9); world.turbulence = 0.1; }, 60, () => { most = Math.max(most, f.motion.values.lift); });
    expect(strainOf(0.5, 0.1)).toBeLessThan(0.3); expect(most).toBe(0);
    // Kicks of a steady beat, each an ordinary event: refused.
    f.run(4, (_world, t) => { if (Math.abs((t * 2) % 1) < 1 / 60) strike(0.4); });
    expect(f.motion.accents).toBe(0); expect(f.motion.refused).toBeGreaterThan(5); expect(f.motion.values.lift).toBe(0);
    // One that stands out far beyond the usual accents: the plates lift for an instant and settle.
    f.run(0.5, (world) => { world.potential = 0; world.turbulence = 0; });
    strike(0.95); f.run(1 / 60);
    expect(f.motion.accents).toBe(1); expect(f.motion.values.lift).toBeGreaterThan(0.3);
    strike(1); f.run(0.5);
    expect(f.motion.accents).toBe(1);
    f.run(8);
    expect(f.motion.values.lift).toBe(0);
    // It strains for real: the plates lift over most of a second, not in a frame, and stay lifted while the strain wavers.
    const lifts: number[] = [];
    f.run(2, (world) => { world.potential = 0.8; world.turbulence = 0.5; }, 60, () => lifts.push(f.motion.values.lift));
    expect(lifts[119]).toBeGreaterThan(0.5); expect(lifts[3]).toBeLessThan(0.15 * lifts[119]);
    for (let k = 1; k < lifts.length; k++) expect(lifts[k] - lifts[k - 1]).toBeLessThan(0.03);
    let least = Infinity;
    f.run(6, (world, t) => { world.potential = 0.55 + 0.1 * Math.sin(t * 8); world.turbulence = 0.15; }, 60, () => { least = Math.min(least, f.motion.aperture); });
    expect(least).toBe(1);
  });

  it('the registers: lows raise the relief and ring the finer octave, mids fold the crests, highs tremble, stereo leans, a turn banks', () => {
    const f = flight();
    f.run(1);
    f.run(3, (world) => { world.radius = 0.6; world.excitation = 0.8; world.shimmer = 0.5; world.bias = -0.8; world.spin = 2; f.geometry.edgeHardness = 0.9; });
    const v = f.motion.values;
    expect(v.relief).toBeCloseTo(P.relief * (1 + 0.35 * 0.6), 9);
    // The finer octave and the surface follow the groove over their own times (response.test.ts): held three seconds, they are there.
    expect(v.crest).toBeCloseTo(1.4, 2); expect(v.quake).toBeCloseTo(0.6 * P.roughness * 0.5, 3);
    expect(v.ridge).toBeGreaterThan(0.85); expect(v.lean).toBeLessThan(-0.75); expect(Math.abs(f.motion.bank)).toBeGreaterThan(0.05); expect(Math.abs(f.motion.bank)).toBeLessThanOrEqual(0.1);
    // The pressure is bounded both ways: the relief never collapses and never runs away.
    f.run(1, (world) => { world.radius = -50; });
    expect(v.relief).toBeCloseTo(P.relief * (1 - 0.35 * 0.6), 9);
    f.run(1, (world) => { world.radius = 50; });
    expect(v.relief).toBeCloseTo(P.relief * (1 + 0.35 * 0.9), 9);
  });

  it('is the same at 30, 60, 120 and 144 frames per second; finite for any world and any step; starts over with a new session', () => {
    const script = (world: WorldState, t: number): void => {
      world.travel = 2 * (t - 10) + 0.5 * Math.sin(t); world.angle = 0.4 * Math.sin(t * 0.7); world.spin = 0.28 * Math.cos(t * 0.7) * 3;
      world.potential = 0.45 + 0.4 * Math.sin(t * 0.5); world.turbulence = 0.3 + 0.25 * Math.sin(t * 0.9); world.radius = 0.3 * Math.sin(t * 2);
      world.bias = 0.5 * Math.sin(t * 0.3); world.excitation = 0.5 + 0.4 * Math.sin(t * 3); world.shimmer = 0.5 + 0.4 * Math.sin(t * 5);
      if (t >= 14 && world.releaseTime < 0) { world.releaseTime = 14; world.releaseStrength = 0.5; }
    };
    const at = [30, 60, 120, 144].map((fps) => { const f = flight(); f.run(12, script, fps); return { ...f.motion.values, bank: f.motion.bank, aperture: f.motion.aperture, rows: f.rows }; });
    for (const other of at) for (const key of Object.keys(at[1]) as (keyof typeof other)[]) {
      if (key === 'row' || key === 'shift' || key === 'col' || key === 'shiftX') continue;
      expect(Math.abs(other[key] - at[1][key])).toBeLessThanOrEqual(3e-3 * Math.max(1, Math.abs(at[1][key])));
    }
    // Any world, broken ones included, and any step: every value the law reads stays a number.
    const broken: Partial<WorldState>[] = [
      { potential: NaN, turbulence: Infinity, coherence: -Infinity, spin: NaN, releaseTime: NaN, releaseStrength: NaN, impulseStrength: -Infinity, excitation: NaN, radius: NaN, bias: NaN, shimmer: NaN, travel: NaN },
      { potential: 7, turbulence: -3, spin: 1e9, releaseStrength: 1e9, releaseTime: 10, excitation: 50, radius: 1e9, bias: -1e9, shimmer: 1e9, travel: 1e12 },
    ];
    for (const set of broken) for (const dt of [1 / 60, 0, -1, NaN, Infinity, 5]) {
      const world = { ...createWorld(), time: 20, ...set }, view = new WorldView(), motion = new TerrainMotion(P), geometry = { ...createGeometry(), edgeHardness: NaN, angularity: Infinity };
      for (let k = 0; k < 5; k++) { world.time += 0.016; view.update(world, GAINS); motion.step(dt, view, geometry, new EventStream(), world.time); }
      for (const value of [...Object.values(motion.values), motion.bank, motion.speed, motion.aperture, motion.accent]) expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(terrainHeight(motion.values, 3, 40))).toBeLessThanOrEqual(terrainBound(motion.values));
    }
    // Another session (the clock went back): what was being followed is let go at once; the ground travelled is kept.
    const f = flight();
    f.run(4, (world, t) => { world.travel = 3 * (t - 10); world.potential = 0.9; world.turbulence = 0.6; });
    expect(f.motion.aperture).toBeGreaterThan(0.9);
    const row = f.motion.values.row;
    f.world.time = 0.5; f.world.potential = 0; f.world.turbulence = 0; f.world.travel = 0;
    f.view.update(f.world, GAINS); f.motion.step(1 / 60, f.view, f.geometry, f.events, 0.5);
    expect(f.motion.aperture).toBe(0); expect(f.motion.values.terrace).toBe(0); expect(f.motion.values.lift).toBe(0); expect(f.motion.values.row).toBe(row);
    // The motion writes into the one object it owns.
    const values = f.motion.values;
    expect(f.motion.step(1 / 60, f.view, f.geometry)).toBe(values);
  });
});

describe('Generative Terrain: the scene', () => {
  const calls = { frames: vi.fn(), listeners: vi.fn() };
  beforeEach(() => {
    calls.frames.mockClear(); calls.listeners.mockClear();
    vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600, addEventListener: calls.listeners, requestAnimationFrame: calls.frames });
    vi.stubGlobal('requestAnimationFrame', calls.frames);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  /** A scene driven through a real Director over a hand-set world, as the engine drives it. */
  function rig<T extends Visualizer>(scene: T, quality = QUALITY_PROFILES.low) {
    const passes: Pass[] = [];
    scene.init({ renderer: { getPixelRatio: () => 1 } as WebGLRenderer, quality, width: 800, height: 600, addPass: (pass) => { passes.push(pass); } });
    scene.resize(800, 600);
    scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
    const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame, director = new VisualDirector();
    const experience = createSnapshot(newFrame()), world = experience.world, events = new EventStream();
    const clock = { time: 0, hits: { times: new Float64Array(8).fill(-Infinity), strengths: new Float64Array(8), count: 0, size: 8 } as never, hitScale: 1, experience, events };
    const update = (seconds = 1, live = true, fps = 60): void => {
      for (let k = 0; k < Math.round(seconds * fps); k++) {
        world.time += 1 / fps; world.travel += world.speed / fps; world.angle += world.spin / fps;
        clock.time = world.time;
        const modulation = director.update(response, DEFAULT_DIRECTION, 1 / fps, undefined, live ? experience : undefined);
        scene.update(audio, 1 / fps, world.time, response, modulation, live ? clock : undefined);
      }
    };
    return { scene, world, events, passes, update };
  }
  const definition = findVisualizer('terrain')!;
  const mount = (quality = QUALITY_PROFILES.low) => rig(definition.create(definition.preset) as RecipeVisualizer<typeof P>, quality);
  const ground = (r: ReturnType<typeof mount>): TerrainPrimitive => r.scene.world.primitive<TerrainPrimitive>('ground')!;
  const terrain = (r: ReturnType<typeof mount>): Float32Array => {
    let uniforms: ShaderMaterial['uniforms'] | undefined;
    r.scene.scene.traverse((object) => { if (object instanceof LineSegments) uniforms = (object.material as ShaderMaterial).uniforms; });
    return uniforms!.uTerrain.value as Float32Array;
  };

  it('is a scene of its own beside the tunnel: registered like the others, chosen by the user, never picked by the show on its own', () => {
    expect(definition.name).toBe('Generative Terrain'); expect(definition.id).toBe('terrain');
    expect(visualizers.map((v) => v.id)).toContain('terrain'); expect(new Set(visualizers.map((v) => v.id)).size).toBe(visualizers.length);
    expect(new Set(visualizers.map((v) => v.order)).size).toBe(visualizers.length);
    // Infinite Tunnel is still there, first, under its own name.
    expect(visualizers[0].id).toBe('tunnel'); expect(visualizers[0].name).toBe('Infinite Tunnel');
    // Experimental: not a fixture, so the free rig does not compose with it until it has been judged on real music.
    expect(FIXTURES.some((fixture) => fixture.id === 'terrain')).toBe(false);
  });

  it('two draw calls from one vertex buffer, no pass, no texture; fewer cells at a lower quality, the same extent', () => {
    const low = mount(QUALITY_PROFILES.low), high = mount(QUALITY_PROFILES.high);
    for (const r of [low, high]) {
      const drawn: (Mesh | LineSegments)[] = [];
      r.scene.scene.traverse((object) => { if (object instanceof Mesh || object instanceof LineSegments) drawn.push(object); });
      expect(drawn).toHaveLength(2); expect(r.passes).toHaveLength(0);
      expect(drawn[0].geometry.getAttribute('position')).toBe(drawn[1].geometry.getAttribute('position'));
      for (const object of drawn) for (const uniform of Object.values((object.material as ShaderMaterial).uniforms)) expect(uniform.value instanceof Texture).toBe(false);
      expect(r.scene.world.mounted).toHaveLength(1); expect(ground(r).vertices).toBe(drawn[0].geometry.getAttribute('position').count);
    }
    const a = terrainQuality(P, QUALITY_PROFILES.low), b = terrainQuality(P, QUALITY_PROFILES.high);
    expect(a.columns * a.rows).toBeLessThan(b.columns * b.rows);
    // No less ground than at full quality, and hardly more (cells are whole).
    for (const [low, high] of [[a.rows * a.cell, b.rows * b.cell], [a.columns * a.cell, b.columns * b.cell]]) { expect(low).toBeGreaterThanOrEqual(high - 1e-9); expect(low).toBeLessThan(1.06 * high); }
    expect(a.columns % 2).toBe(0);
    expect(ground(high).vertices).toBeLessThan(40000);
    low.scene.dispose(); high.scene.dispose();
  });

  it('follows the world: it flies with the world\'s travel, terraces under stored potential, and is still without a clock', () => {
    const r = mount(), u = terrain(r);
    r.update(1);
    const start = u[TERRAIN.row] + u[TERRAIN.shift];
    r.world.speed = 2; r.world.potential = 0.8;
    r.update(3);
    expect(u[TERRAIN.row] + u[TERRAIN.shift]).toBeGreaterThan(start + 20); expect(u[TERRAIN.terrace]).toBeGreaterThan(0.9); expect(u[TERRAIN.throat]).toBeGreaterThan(0.8);
    expect(ground(r).debug.speed).toBeGreaterThan(10);
    // Without a clock: the landscape where the flight left it, and nothing moving.
    r.update(1, false);
    const still = Array.from(u);
    expect(u[TERRAIN.terrace]).toBe(0);
    r.update(5, false);
    expect(Array.from(u)).toEqual(still);
    r.scene.dispose();
  });

  it('starts no loop, no timer and no listener of its own, and is seeded without Math.random', () => {
    const intervals = vi.spyOn(globalThis, 'setInterval'), timeouts = vi.spyOn(globalThis, 'setTimeout');
    const r = mount();
    r.world.speed = 2; r.world.potential = 0.6;
    r.update(2); r.update(1, false);
    r.scene.dispose();
    expect(intervals).not.toHaveBeenCalled(); expect(timeouts).not.toHaveBeenCalled();
    expect(calls.frames).not.toHaveBeenCalled(); expect(calls.listeners).not.toHaveBeenCalled();
    // Whatever Math.random returns (three.js uses it for its ids), the same seed is the same landscape, vertex for vertex.
    let n = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => 0.123);
    const first = mount();
    vi.spyOn(Math, 'random').mockImplementation(() => (n = (n * 7 + 0.31) % 1));
    const second = mount();
    for (const s of [first, second]) { s.world.speed = 2; s.world.potential = 0.6; s.update(2); }
    expect(Array.from(terrain(first))).toEqual(Array.from(terrain(second)));
    const heights = (s: typeof first): number[] => [-20, -7, 0, 9, 24].map((i) => terrainHeight(ground(s).motion.values, i, 40));
    expect(heights(first)).toEqual(heights(second));
    first.scene.dispose(); second.scene.dispose();
  });

  it('releases what it owns, and opening and closing it, or going between the tunnel and the terrain, leaves nothing behind', () => {
    const geometries = vi.spyOn(BufferGeometry.prototype, 'dispose'), materials = vi.spyOn(Material.prototype, 'dispose'), textures = vi.spyOn(Texture.prototype, 'dispose');
    const r = mount();
    r.update(0.5);
    r.scene.dispose();
    const terrainCost = [geometries.mock.calls.length, materials.mock.calls.length, textures.mock.calls.length];
    expect(terrainCost.slice(0, 2)).toEqual([2, 2]); expect(r.scene.scene.children).toHaveLength(0); expect(r.scene.world.mounted).toHaveLength(0);
    geometries.mockClear(); materials.mockClear(); textures.mockClear();
    const t = rig(new TunnelVisualizer(tunnelPreset));
    t.update(0.5); t.scene.dispose();
    const tunnelCost = [geometries.mock.calls.length, materials.mock.calls.length, textures.mock.calls.length];
    // Thirty times from one to the other, each over a live world: every mount releases exactly what one mount owns.
    geometries.mockClear(); materials.mockClear(); textures.mockClear();
    for (let k = 0; k < 30; k++) {
      const a = mount(); a.world.speed = 2; a.world.potential = 0.7; a.update(0.2); a.scene.dispose();
      expect(a.scene.scene.children).toHaveLength(0);
      const b = rig(new TunnelVisualizer(tunnelPreset)); b.world.speed = 2; b.update(0.2); b.scene.dispose();
      expect(b.scene.scene.children).toHaveLength(0);
    }
    expect([geometries.mock.calls.length, materials.mock.calls.length, textures.mock.calls.length]).toEqual(terrainCost.map((n, i) => 30 * (n + tunnelCost[i])));
  });
});
