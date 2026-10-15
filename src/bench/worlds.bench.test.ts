import { expect, it } from 'vitest';
import { createCues } from '../experience/MusicalCues';
import { CameraRig, createInput, Drift, Glide, Hover, Orbit } from '../render-systems/camera/locomotion';
import { createGeometry } from '../visual-engine/geometry/GeometryState';
import { createShape, growTree } from '../visual-engine/primitives/forestLaw';
import { ForestField } from '../visual-engine/primitives/forestGrowth';
import { OceanMotion, type OceanParams } from '../visual-engine/primitives/oceanMotion';
import { populationElements, type SolidPopulation } from '../visual-engine/primitives/SolidPrimitive';
import { TerrainMotion, type TerrainParams } from '../visual-engine/primitives/terrainMotion';
import { StructuralSystem } from '../visual-engine/structural/StructuralDynamics';
import { createStillEnvironment, type StructuralEnvironment } from '../visual-engine/structural/StructuralTypes';
import { DEFAULT_SOLID_BUDGET, solidProfile } from '../visual-engine/structural/SolidTypes';
import expanse from '../visualizers/fractured-expanse/preset.json';
import ocean from '../visualizers/pulse-ocean/preset.json';
import forest from '../visualizers/resonant-forest/preset.json';
import { createWorld } from '../world/WorldState';
import { WorldView } from '../world/WorldView';

/**
 * Synthetic CPU cost of what the generative worlds added (docs/generative-worlds.md): a camera rig per frame for each
 * world's profiles, the sea's reading of the world per frame, the forest's life per frame with its pool full and the
 * growing of one tree, and Fractured Expanse's seven bodies per frame (the structural engine's own step). No audio
 * path and no GPU: order of magnitude on the machine it runs on, with the tail beside the median. Kept short.
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

it('measures the camera rigs, the sea, the forest and the expanse\'s bodies (synthetic CPU, not live overhead)', { timeout: 180000 }, async () => {
  const world = createWorld(), view = new WorldView(), geometry = createGeometry(), gains = { motion: 1, expansion: 1, turbulence: 1 };
  let clock = 0;
  const live = (k: number): void => {
    clock += 1 / 60;
    world.time = clock; world.speed = 2 + Math.sin(clock); world.travel += world.speed / 60; world.spin = 0.6 * Math.sin(clock * 0.3); world.angle += world.spin / 60;
    world.radius = 0.3 * Math.sin(clock * 6); world.potential = 0.5 + 0.4 * Math.sin(clock * 0.7); world.turbulence = 0.4 + 0.3 * Math.sin(clock * 1.3);
    world.excitation = 0.6 + 0.3 * Math.sin(clock * 12); world.shimmer = 0.5 + 0.4 * Math.sin(clock * 50); world.openness = 0.6; world.bias = Math.sin(clock * 0.2);
    if (k % 600 === 0) { world.releaseTime = clock; world.releaseStrength = 0.6; }
    view.update(world, gains);
  };
  const input = createInput(view);
  input.dt = 1 / 60; input.timed = true; input.focus.weight = 0.5; input.focus.z = -40;
  const rig = (entries: ConstructorParameters<typeof CameraRig>[0]) => { const r = new CameraRig(entries, { tz: -50 }); return (k: number) => { live(k); input.time = clock; r.step(input); }; };
  const glideHover = measure(30000, 100, rig([{ profile: new Glide(), weight: 1 }, { profile: new Hover(), weight: 1 }]));
  const orbit = measure(30000, 100, rig([{ profile: new Orbit(), weight: 1 }]));
  const glideDrift = measure(30000, 100, rig([{ profile: new Glide({ ride: 0.35 }), weight: 1 }, { profile: new Drift(), weight: 1 }]));

  const sea = new OceanMotion(ocean.visual as unknown as OceanParams);
  const oceanFrame = measure(30000, 100, (k) => { live(k); sea.step(1 / 60, view, geometry, 0.1); });

  // The forest: its pool kept full (dense, fast-growing, short-lived), releases now and then.
  const P = forest.visual as unknown as TerrainParams, motion = new TerrainMotion(P), cues = createCues();
  cues.silent = false; cues.live = true; cues.phase = 'groove'; cues.groove = 0.8; cues.stability = 0.9; cues.repetition = 0.7;
  const field = new ForestField({ ...forest.visual.forest, density: 1, rate: 4, growing: 40, span: 20 }, 3);
  let peak = 0;
  const forestFrame = measure(20000, 20, (k) => {
    live(k);
    const v = motion.step(1 / 60, view, geometry);
    if (k % 300 === 0) { const seq = ++cues.seq; Object.assign(cues.cues[seq % 16], { seq, kind: 'release', status: 'confirmed', time: clock, expected: 0, strength: 0.9, confidence: 1, ref: 0 }); }
    field.step(1 / 60, v, view, geometry, v.row + v.shift, P.rows, P.columns, cues, clock);
    peak = Math.max(peak, field.live());
  });
  const shape = createShape();
  const treeGrowth = measure(20000, 100, (k) => { growTree(k, { branching: (k % 3) / 2, spread: 0.7, upright: 0.25, height: 10, foliage: 0.75 }, shape); });

  // Fractured Expanse's population: seven bodies, rigid, the engine's own step per frame.
  const population = expanse.visual as unknown as SolidPopulation;
  const system = new StructuralSystem({ capacity: populationElements(population), seed: 20261016, solids: { ...DEFAULT_SOLID_BUDGET, ...expanse.visual.budget, bodies: population.bodies.length } });
  Object.assign(system.solids!.tuning, solidProfile('rigid'));
  for (const b of population.bodies) system.seedSolid(b.kind, b.radius, { x: b.x, y: b.y, z: b.z, turn: b.turn, tilt: b.tilt });
  const env: StructuralEnvironment = { ...createStillEnvironment(), coherence: 0.9, harmony: 0.7, energy: 0.7, turbulence: 0.05 };
  let simulated = 0;
  const expanseFrame = measure(3000, 10, () => { simulated += 1 / 60; system.advance(simulated, env); });

  const rows = { rigGlideHover: glideHover, rigOrbit: orbit, rigGlideDrift: glideDrift, oceanFrame, forestFullPool: forestFrame, growTree: treeGrowth, expanseBodies7: expanseFrame };
  console.log('worlds bench:\n' + Object.entries(rows).map(([name, cost]) => `  ${name.padEnd(18)} ${show(cost)}`).join('\n'));
  expect(peak).toBeGreaterThan(20);
  // Microseconds for the rigs, the sea and the forest; the bodies a fraction of a frame.
  expect(glideHover.p95).toBeLessThan(0.05); expect(orbit.p95).toBeLessThan(0.05); expect(glideDrift.p95).toBeLessThan(0.05);
  expect(oceanFrame.p95).toBeLessThan(0.05); expect(forestFrame.p95).toBeLessThan(0.3); expect(treeGrowth.p95).toBeLessThan(0.1);
  expect(expanseFrame.p95).toBeLessThan(3);
  const path = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env.EUFORIA_WORLDS_BENCH_REPORT;
  if (path) {
    const fs = await import(/* @vite-ignore */ 'node:fs/promises' as string);
    await fs.writeFile(path, JSON.stringify({ method: 'ms per call, timed in groups after a warm-up of the same length; no GPU, no audio path, machine not isolated', rows, peak }, null, 2));
  }
});
