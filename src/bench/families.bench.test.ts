import { expect, it } from 'vitest';
import { createAnticipation } from '../experience/Anticipation';
import { createCognition } from '../experience/cognition/types';
import { EventStream } from '../experience/EventStream';
import { createCues, MusicalCues } from '../experience/MusicalCues';
import { createGeometry } from '../visual-engine/geometry/GeometryState';
import { MIXED_POPULATION } from '../visual-engine/primitives/solidSlot';
import { populationElements } from '../visual-engine/primitives/SolidPrimitive';
import { EmergenceField } from '../visual-engine/primitives/terrainEmergence';
import { LEGACY_RESPONSE, TerrainMotion, type TerrainParams } from '../visual-engine/primitives/terrainMotion';
import { StructuralSystem } from '../visual-engine/structural/StructuralDynamics';
import { createStillEnvironment, type StructuralEnvironment } from '../visual-engine/structural/StructuralTypes';
import { DEFAULT_SOLID_BUDGET, solidProfile } from '../visual-engine/structural/SolidTypes';
import terrain from '../visualizers/terrain/preset.json';
import { createWorld } from '../world/WorldState';
import { WorldView } from '../world/WorldView';

/**
 * Synthetic CPU cost of what the scene families added (docs/scene-families.md): the musical cues per analysis hop,
 * the terrain's motion per frame with the three scales against the legacy response, the emergence field per frame
 * with a full pool, and a Particles scene's population of solids per frame (the structural engine's own step). No
 * audio path and no GPU: order of magnitude on the machine it runs on, with the tail beside the median. Kept short:
 * the suite runs its files in parallel, and a long benchmark beside another one would be measuring the other.
 */

interface Cost { n: number; p50: number; p95: number; p99: number; max: number }
const summary = (samples: Float64Array): Cost => {
  const sorted = Float64Array.from(samples).sort(), at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] ?? 0 };
};
const show = (c: Cost): string => `p50 ${(c.p50 * 1000).toFixed(2)} · p95 ${(c.p95 * 1000).toFixed(2)} · p99 ${(c.p99 * 1000).toFixed(2)} · max ${(c.max * 1000).toFixed(1)} µs (${c.n})`;
function measure(calls: number, group: number, work: (k: number) => void): Cost {
  const samples = new Float64Array(calls / group);
  for (let k = 0; k < calls; k++) work(k);
  for (let s = 0; s < samples.length; s++) {
    const start = performance.now();
    for (let k = 0; k < group; k++) work(s * group + k);
    samples[s] = (performance.now() - start) / group;
  }
  return summary(samples);
}

it('measures the musical cues, the terrain\'s three scales, the emergence field and a population of solids (synthetic CPU, not live overhead)', { timeout: 180000 }, async () => {
  // ---- cues: one hop, with an impact every few hops and a release prediction that comes and goes ----
  const cues = new MusicalCues(), events = new EventStream(), cognition = createCognition(), anticipation = createAnticipation();
  cognition.understanding.silence = 'none'; cognition.understanding.state = 'stableGroove';
  let time = 0;
  const cuesPerHop = measure(50000, 100, (k) => {
    time += 256 / 48000;
    if (k % 40 === 0) events.push('impact', time, 0.5, 0.9, 1, 0.3, 0, k % 400 === 0 ? 0.9 : 0.3);
    const p = cognition.predictions[0];
    if (k % 3000 === 0) Object.assign(p, { id: k + 1, kind: 'release', confidence: 0.6, time: time + 3, created: time });
    if (k % 3000 === 1500) p.id = 0;
    cues.hop(time, events, cognition, anticipation);
  });

  // ---- the terrain: one frame of a straining world, the three scales against the legacy response ----
  const world = createWorld(), view = new WorldView(), geometry = createGeometry(), gains = { motion: 1, expansion: 1, turbulence: 1 };
  let clock = 0;
  const strain = (k: number): void => {
    clock += 1 / 60;
    world.time = clock; world.travel += 2 / 60; world.angle += 0.5 / 60;
    world.potential = 0.5 + 0.4 * Math.sin(clock * 0.7); world.turbulence = 0.4 + 0.3 * Math.sin(clock * 1.3); world.excitation = 0.6 + 0.3 * Math.sin(clock * 12);
    world.shimmer = 0.5 + 0.4 * Math.sin(clock * 50);
    if (k % 600 === 0) { world.releaseTime = clock; world.releaseStrength = 0.6; }
    view.update(world, gains);
  };
  const P = terrain.visual as unknown as TerrainParams;
  const legacy = new TerrainMotion({ ...P, response: LEGACY_RESPONSE }), scales = new TerrainMotion(P);
  const legacyFrame = measure(50000, 100, (k) => { strain(k); legacy.step(1 / 60, view, geometry); });
  const scalesFrame = measure(50000, 100, (k) => { strain(k); scales.step(1 / 60, view, geometry); });

  // ---- the emergence: one frame with the pool full and every phase in it (dense, organised, releases now and then) ----
  const field = new EmergenceField({ ...terrain.visual.emergence, capacity: 64, emerging: 16, density: 1, rate: 4 }, 7), frame = createCues();
  frame.silent = false; frame.live = true; frame.phase = 'rising';
  const motion = new TerrainMotion(P);
  let peak = 0;
  const emergenceFrame = measure(20000, 20, (k) => {
    strain(k);
    const v = motion.step(1 / 60, view, geometry);
    if (k % 300 === 0) { const seq = ++frame.seq; Object.assign(frame.cues[seq % 16], { seq, kind: 'release', status: 'confirmed', time: clock, expected: 0, strength: 0.9, confidence: 1, ref: 0 }); }
    field.step(1 / 60, v, view, v.row + v.shift, P.rows, P.columns, motion.ring, motion.tension, frame, clock);
    peak = Math.max(peak, field.count);
  });

  // ---- a population of solids: what a Particles scene steps per frame (three bodies, rigid, the engine's own step) ----
  const system = new StructuralSystem({ capacity: populationElements(MIXED_POPULATION), seed: 20261007, solids: { ...DEFAULT_SOLID_BUDGET, bodies: 3 } });
  Object.assign(system.solids!.tuning, solidProfile('rigid'));
  for (const b of MIXED_POPULATION.bodies) system.seedSolid(b.kind, b.radius, { x: b.x, y: b.y, z: b.z, turn: b.turn, tilt: b.tilt });
  const env: StructuralEnvironment = { ...createStillEnvironment(), coherence: 0.9, harmony: 0.7, energy: 0.7, turbulence: 0.05 };
  let simulated = 0;
  const solidsFrame = measure(3000, 10, () => { simulated += 1 / 60; system.advance(simulated, env); });

  const rows = { cuesPerHop, terrainLegacy: legacyFrame, terrainScales: scalesFrame, emergenceFullPool: emergenceFrame, particleSolids3: solidsFrame };
  console.log('families bench:\n' + Object.entries(rows).map(([name, cost]) => `  ${name.padEnd(22)} ${show(cost)}`).join('\n'));
  expect(peak).toBeGreaterThan(20);
  // Far inside an analysis hop (5.3 ms) and a frame: microseconds; the solids a fraction of a millisecond.
  expect(cuesPerHop.p95).toBeLessThan(0.05); expect(scalesFrame.p95).toBeLessThan(0.05); expect(emergenceFrame.p95).toBeLessThan(0.3);
  expect(solidsFrame.p95).toBeLessThan(1.5);
  // The three scales are two followers more: what they add to a frame is noise beside a frame.
  expect(scalesFrame.p50 - legacyFrame.p50).toBeLessThan(0.01);
  const path = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env.EUFORIA_FAMILIES_BENCH_REPORT;
  if (path) {
    const fs = await import(/* @vite-ignore */ 'node:fs/promises' as string);
    await fs.writeFile(path, JSON.stringify({ method: 'ms per call, timed in groups after a warm-up of the same length; no GPU, no audio path, machine not isolated', rows, peak }, null, 2));
  }
});
