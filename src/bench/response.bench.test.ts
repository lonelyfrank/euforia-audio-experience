import { expect, it } from 'vitest';
import { newFrame } from '../audio/features/decode';
import { AdaptiveMusicCalibration } from '../experience/AdaptiveCalibration';
import { createMotion, TunnelMotionCoordinator } from '../visualizers/tunnel/motion';
import { createTopology, tunnelTopology } from '../visualizers/tunnel/topology';
import { createWorld } from '../world/WorldState';
import { WorldView } from '../world/WorldView';

/**
 * Synthetic CPU cost of what calibrates and coordinates the response: the adaptive calibration per analysis hop and
 * per rated attack, and the tunnel's motion coordinator per frame (with the architecture law it evaluates). No audio
 * path and no GPU: order of magnitude on the machine it runs on, with the tail beside the median.
 */

interface Cost { n: number; p50: number; p95: number; p99: number; max: number }
const summary = (samples: Float64Array): Cost => {
  const sorted = Float64Array.from(samples).sort(), at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] ?? 0 };
};
const show = (c: Cost): string => `p50 ${(c.p50 * 1000).toFixed(2)} · p95 ${(c.p95 * 1000).toFixed(2)} · p99 ${(c.p99 * 1000).toFixed(2)} · max ${(c.max * 1000).toFixed(1)} µs (${c.n})`;
/** Calls timed in groups of `group`, so that the clock's own resolution does not drown a call of a fraction of a microsecond. */
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

it('measures the adaptive calibration and the tunnel\'s motion coordinator (synthetic CPU, not live overhead)', { timeout: 120000 }, async () => {
  // ---- calibration: one hop of a track that swings, with a kick in the lows ----
  const calibration = new AdaptiveMusicCalibration(), a = newFrame();
  a.presence = a.sounding = a.energyConfidence = 1; a.noiseFloorDb = -70; a.onsetDensity = 4; a.percussiveShare = 0.4;
  let time = 0;
  const hop = (): void => {
    time += 256 / 48000;
    a.time = time; a.loudnessMomentary = -20 + 5 * Math.sin(time * 1.5);
    a.loudnessQuantiles[0] = -27; a.loudnessQuantiles[1] = -20; a.loudnessQuantiles[2] = -16; a.loudnessQuantiles[3] = -15;
    for (let b = 0; b < 8; b++) { a.bandLevel[b] = 0.7; a.bandRel[b] = 0.5 + 0.4 * Math.sin(time * 9 + b); }
    calibration.update(a, 256 / 48000);
  };
  const perHop = measure(200000, 100, hop), perAttack = measure(100000, 100, (k) => calibration.rate(0.15 + 0.1 * ((k * 7) % 5) / 5));

  // ---- coordinator: one frame of a world that strains, with the architecture law the scene evaluates anyway ----
  const world = createWorld(), view = new WorldView(), coordinator = new TunnelMotionCoordinator(4), raw = createMotion(), topology = createTopology();
  const gains = { motion: 1, expansion: 1, turbulence: 1 };
  let clock = 0;
  const frame = (balanced: boolean) => (k: number): void => {
    clock += 1 / 60;
    world.time = clock; world.travel += 2 / 60; world.angle += 0.5 / 60;
    world.potential = 0.5 + 0.4 * Math.sin(clock * 0.7); world.turbulence = 0.4 + 0.3 * Math.sin(clock * 1.3); world.spin = 1.5 * Math.sin(clock * 0.9);
    if (k % 30 === 0) { world.impulseTime = clock; world.impulseStrength = 0.8; }
    view.update(world, gains);
    raw.advance = view.dTravel; raw.turn = view.dTurn; raw.radius = 4.2; raw.fov = 75; raw.twist = view.spin * 0.03; raw.bend = 3 * (0.1 + 1.4 * view.disorder);
    raw.shape = 0.2; raw.lobes = 5; raw.cycles = 3; raw.oval = 0.1; raw.waveguide = 0.25; raw.wobble = 0.3; raw.ring = 0.1; raw.lateral = view.lateral;
    tunnelTopology(topology, view);
    if (balanced) coordinator.step(1 / 60, view, raw, topology, 1);
  };
  const asItWas = measure(200000, 100, frame(false)), balanced = measure(200000, 100, frame(true));

  const rows = { calibrationPerHop: perHop, calibrationPerAttack: perAttack, tunnelTargetsAndArchitecture: asItWas, tunnelBalanced: balanced };
  console.log('response bench:\n' + Object.entries(rows).map(([name, cost]) => `  ${name.padEnd(30)} ${show(cost)}`).join('\n'));
  // Far inside an analysis hop (5.3 ms) and a frame: a few microseconds at the worst percentile on any machine that runs the app.
  expect(perHop.p95).toBeLessThan(0.05); expect(perAttack.p95).toBeLessThan(0.05); expect(balanced.p95).toBeLessThan(0.05);
  // What the coordinator adds to a frame is what it costs over the targets it is given.
  expect(balanced.p50 - asItWas.p50).toBeLessThan(0.01);
  const path = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env.EUFORIA_RESPONSE_BENCH_REPORT;
  if (path) {
    const fs = await import(/* @vite-ignore */ 'node:fs/promises' as string);
    await fs.writeFile(path, JSON.stringify({ method: 'ms per call, timed in groups of 100 after a warm-up of the same length; no GPU, no audio path, machine not isolated', rows }, null, 2));
  }
});
