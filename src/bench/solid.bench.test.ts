import { expect, it } from 'vitest';
import type { WebGLRenderer } from 'three';
import { QUALITY_PROFILES } from '../renderer/quality';
import { TOPOLOGY_VALUES } from '../render-systems/fields/vectorField';
import type { VoiceCycles } from '../visual-engine/geometry/VoiceCycles';
import type { PrimitiveContext } from '../visual-engine/Primitive';
import { SOLID_DRAW_CALLS, SOLID_LAB_BUDGET, SOLID_LAB_ELEMENTS, SolidPrimitive } from '../visual-engine/primitives/SolidPrimitive';
import { createResonanceFrame } from '../physics/MultiscaleResonance';
import { ResonanceField } from '../visual-engine/structural/ResonanceField';
import { INTACT, SOLID_KINDS, solidProfile, type SolidKind, type SolidProfile } from '../visual-engine/structural/SolidTypes';
import { StructuralSystem } from '../visual-engine/structural/StructuralDynamics';
import { createStillEnvironment, type StructuralEnvironment } from '../visual-engine/structural/StructuralTypes';

/**
 * Synthetic CPU cost of the solid bodies, split by what is paid: the fixed step with its constraints, the topology
 * update of a fracture or a recomposition, the creation of a body, and the fill of the GPU buffers. No GPU, no audio
 * path: order of magnitude on the machine it runs on (which may be throttled), with the tail and the peak beside the
 * median because a frame is lost to the worst step, not to the average one.
 */

interface Cost { n: number; p50: number; p95: number; p99: number; max: number }
const summary = (samples: number[]): Cost => {
  const sorted = [...samples].sort((a, b) => a - b), at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] ?? 0 };
};
const show = (c: Cost): string => `p50 ${(c.p50 * 1000).toFixed(1)} · p95 ${(c.p95 * 1000).toFixed(1)} · p99 ${(c.p99 * 1000).toFixed(1)} · max ${(c.max * 1000).toFixed(1)} µs (${c.n})`;
const timed = (samples: number[], work: () => void): void => { const start = performance.now(); work(); samples.push(performance.now() - start); };
const hold: StructuralEnvironment['hold'] = (x, y, z, home, out) => {
  const r = Math.max(Math.hypot(x, y, z), 1e-4), k = -3 * (r - (0.3 + 0.95 * home)) / r;
  out[0] = x * k; out[1] = y * k; out[2] = z * k;
};

/** A living, sounding world: what a body pays every step while music plays. */
function world() {
  const frame = createResonanceFrame(), field = new ResonanceField();
  const env: StructuralEnvironment = { ...createStillEnvironment(), coherence: 0.9, harmony: 0.7, energy: 0.7, turbulence: 0.03, resonance: field, hold };
  let time = 0;
  const tick = (dt: number): void => {
    time += dt;
    for (let k = 0; k < frame.meso.length; k++) { frame.mesoLevel[k] = 0.5; frame.meso[k] = 0.5 * Math.sin(2 * Math.PI * (1 + 0.15 * k) * time); }
    for (let k = 0; k < frame.macro.length; k++) frame.macro[k] = 0.5 * Math.sin(2 * Math.PI * (0.3 + 0.1 * k) * time + k);
    // The lows as the calibration would hand them over: a kick every half second.
    env.pulse = Math.exp(-(time % 0.5) / 0.11);
    field.update(frame);
  };
  return { env, tick };
}

it('measures the solid bodies: step, topology, creation and buffers apart (synthetic CPU, not live overhead)', { timeout: 120000 }, async () => {
  const rows: Record<string, unknown>[] = [];
  const bench = (label: string, bodies: [SolidKind, number][], profile: SolidProfile = 'legacy'): void => {
    const system = new StructuralSystem({ capacity: SOLID_LAB_ELEMENTS, seed: 5, solids: SOLID_LAB_BUDGET }), solids = system.solids!, { env, tick } = world(), h = system.config.step;
    // The material: the body as it was (links alone, breaking under load), or the rigid one (its shape held, breaking on events).
    Object.assign(solids.tuning, solidProfile(profile)); solids.gate.tuning.mode = profile === 'legacy' ? 'load' : 'events';
    const seed = (): void => { system.clear(); bodies.forEach(([kind, x]) => system.seedSolid(kind, 0.5, { x })); };
    const create: number[] = [], step: number[] = [], fracture: number[] = [], recompose: number[] = [], book: number[] = [], empty: number[] = [];
    for (let k = 0; k < 60; k++) timed(create, seed);
    expect(solids.state.bodies).toBe(bodies.length);
    // The same system with no body in it: what the structural step costs by itself.
    system.clear();
    for (let k = 0; k < 600; k++) { tick(h); timed(empty, () => system.step(env)); }
    seed();
    for (let k = 0; k < 2400; k++) { tick(h); if (k >= 240) timed(step, () => system.step(env)); else system.step(env); }
    const whole = solids.stats.fractures;
    // A fracture experiment and what follows: the steps in which links give way, and those in which they form again.
    for (let b = 0; b < solids.state.bodies; b++) {
      const c = solids.centroid(b), first = solids.state.bodyFirst[b] * 3, p = system.state.position;
      system.strike(c[0] + (p[first] - c[0]) * 0.5, c[1] + (p[first + 1] - c[1]) * 0.5, c[2] + (p[first + 2] - c[2]) * 0.5, 11, 0.5);
    }
    // A body that breaks on events only is broken as an event breaks it.
    if (profile !== 'legacy') solids.gate.force(1);
    for (let k = 0; k < 240; k++) { tick(h); timed(fracture, () => system.step(env)); }
    const broken = solids.stats.fractures - whole;
    for (let k = 0; k < 3600; k++) { tick(h); timed(recompose, () => system.step(env)); }
    // The topology update alone: one link broken, everything read off the links again.
    for (let k = 0; k < 400; k++) {
      let link = -1;
      for (let l = 0; l < solids.state.links && link < 0; l++) if (solids.state.linkState[(l + k) % solids.state.links] === INTACT) link = (l + k) % solids.state.links;
      if (link < 0) break;
      solids.state.sever(link);
      timed(book, () => solids.state.book());
      solids.state.restore(link, solids.state.linkRest0[link], 0); solids.state.book();
    }
    const costs = { create: summary(create), structuralStepAlone: summary(empty), step: summary(step), fractureSteps: summary(fracture), recompositionSteps: summary(recompose), topologyUpdate: summary(book) };
    rows.push({ label, profile, elements: system.state.count, links: solids.state.links, triangles: solids.state.faces, cells: solids.state.cells, iterations: solids.budget.iterations, broken, reformed: solids.stats.reforms, ...costs });
    console.log(`solid ${label}: ${system.state.count} el · ${solids.state.links} links · ${solids.state.cells} cells · broke ${broken}, reformed ${solids.stats.reforms}\n`
      + Object.entries(costs).map(([name, cost]) => `  ${name.padEnd(20)} ${show(cost)}`).join('\n'));
    // Bounded whatever happened: no state repaired, no pool grown, and a step far inside a frame even at its worst percentile.
    expect(solids.stats.repairs).toBe(0); expect(system.state.count).toBeLessThanOrEqual(SOLID_LAB_ELEMENTS);
    expect(costs.step.p95).toBeLessThan(2); expect(costs.fractureSteps.p95).toBeLessThan(2); expect(costs.topologyUpdate.p95).toBeLessThan(1);
  };
  const full: [SolidKind, number][] = [['icosahedron', -1.8], ['icosahedron', -0.6], ['icosahedron', 0.6], ['icosahedron', 1.8]];
  for (const kind of SOLID_KINDS) bench(kind, [[kind, 0]]);
  // The whole budget: four bodies of the largest kind.
  bench('4 × icosahedron (budget full)', full);
  // The same bodies of the rigid material: the shape fit of every piece is paid in the same step.
  for (const kind of SOLID_KINDS) bench(`${kind} · rigid`, [[kind, 0]], 'rigid');
  bench('4 × icosahedron · rigid (budget full)', full, 'rigid');

  // The buffers: what a frame writes for the GPU, from the same state.
  const context: PrimitiveContext = {
    renderer: {} as WebGLRenderer, quality: QUALITY_PROFILES.high, seed: 5, uField: new Float32Array(32), uWaveA: new Float32Array(64), uWaveB: new Float32Array(64), voices: undefined as unknown as VoiceCycles,
  };
  for (const [solid, kind] of SOLID_KINDS.map((kind, k) => [k, kind] as const)) {
    const primitive = new SolidPrimitive(context, { solid, solidRadius: 0.6, pointSize: 3 }, new Float32Array(TOPOLOGY_VALUES));
    const draw = (primitive as unknown as { draw(view: string, light: number, flash: number, lean: number, fill: number): void }).draw.bind(primitive), buffers: number[] = [];
    for (let k = 0; k < 1200; k++) { const start = performance.now(); draw('all', 0.8, 0.1, 0, 0.6); if (k >= 200) buffers.push(performance.now() - start); }
    const cost = summary(buffers);
    rows.push({ label: `${kind} buffers`, drawCalls: SOLID_DRAW_CALLS, ...primitive.drawn, vertexCapacity: primitive.vertices, buffers: cost });
    console.log(`solid ${kind} buffers: ${SOLID_DRAW_CALLS} draw calls · ${primitive.drawn.points} points · ${primitive.drawn.lines} segments · ${primitive.drawn.triangles} triangles · ${show(cost)}`);
    expect(cost.p95).toBeLessThan(1);
    primitive.dispose();
  }
  const path = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env.EUFORIA_SOLID_BENCH_REPORT;
  if (path) {
    const fs = await import(/* @vite-ignore */ 'node:fs/promises' as string);
    await fs.writeFile(path, JSON.stringify({
      method: 'fixed 1/120 s steps in a living, sounding synthetic world; ms per call; warm-up excluded for the steady step; no GPU, no audio path, machine not isolated',
      budget: SOLID_LAB_BUDGET, elements: SOLID_LAB_ELEMENTS, rows,
    }, null, 2));
  }
});
