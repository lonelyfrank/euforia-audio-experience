import { WebGLRenderer } from 'three';
import { FIELD_VALUES, packFields, packWaves, PHASE_PERIOD } from '../fields/fieldLaw';
import { createFields } from '../fields/SpatialFields';
import { EDDIES, TOPOLOGY, TOPOLOGY_VALUES } from '../fields/vectorField';
import { MAX_WAVES, WaveField } from '../waves/WaveField';
import { matterLayout } from './MatterSeeds';
import { TracerProbe } from './TracerProbe';
import { TracerSimulation } from './TracerSimulation';

/** What the parity check found: distances (units) between the GPU's and the CPU reference's positions of the same tracers. */
export interface TracerParityReport {
  tracers: number;
  steps: number;
  fullFloat: boolean;
  rms: number;
  seed: number;
  tolerance: number | null;
  outcome: 'pass' | 'fail' | 'unvalidated-half-float';
  initial: string;
  mean: number;
  max: number;
  /** Tracers whose state is not finite on either side, and how far the tracers moved in all (so a still field cannot pass). */
  invalid: number;
  travelled: number;
}

/**
 * The GPU ↔ CPU parity check of the Field scene's laws (the vector field, the
 * tracer law and the tracer step): the same seeds, packed fields, topology,
 * fronts and steps through `TracerSimulation` on a real WebGL2 context and
 * through `TracerProbe`, then the positions compared tracer by tracer. The
 * laws are written twice (GLSL and TypeScript): run this after changing
 * either text. A development tool, not part of the app: from a page served by
 * Vite,
 *
 *   (await import('/src/render-systems/particles/tracerParity.ts')).runTracerParity()
 *
 * Every flow is on, the shells hold, three eddies are awake and a fourth is
 * waking, two fronts travel, the structure turns, the step length varies and
 * some tracers re-form. A turbulent path amplifies rounding, so the run is
 * short; expect a mean around 1e-5 units and a maximum below 1e-3 with
 * full-float targets.
 */
export function runTracerParity(count = 1024, steps = 120, detail = true): TracerParityReport {
  const renderer = new WebGLRenderer({ canvas: document.createElement('canvas') });
  const shared = { uField: new Float32Array(FIELD_VALUES), uWaveA: new Float32Array(MAX_WAVES * 4), uWaveB: new Float32Array(MAX_WAVES * 4), topology: new Float32Array(TOPOLOGY_VALUES) };
  const probe = new TracerProbe(count, 20261008, shared, detail);
  const simulation = new TracerSimulation(renderer, probe.seeds, detail, shared);
  try {
    if (simulation.seeds.layout.count !== matterLayout(count).count) throw new Error('tracer parity: layouts differ');
    const fields = createFields(), waves = new WaveField();
    Object.assign(fields, {
      radius: 1.15, gather: 0.5, surge: 0.3, vortex: 0.8, flatten: 0.2, advection: 0.5, lateral: 0.2, drift: 0.1,
      turbulence: 0.5, turbulenceScale: 2.1, shimmer: 0.2, drag: 2.2, lifetimeRate: 0.3, phaseRate: 0.5, turn: 3,
    });
    waves.update(0, undefined);
    waves.spawn(0.2, 0.9, 0.2, 1.7, 0.2, 1.2, 0.1, 0, 0);
    waves.spawn(0.7, 0.7, -1, 1.1, 0.45, 0.7, -0.2, 0.1, 0.05);

    const n = probe.count, start = new Float32Array(n * 4), gpu = new Float32Array(n * 4);
    const lengths = [1 / 60, 1 / 30, 1 / 144, 1 / 60, 1 / 50];
    let now = 0, phase = 0;
    for (let step = 0; step < steps; step++) {
      const dt = lengths[step % lengths.length];
      now += dt;
      fields.turn += 0.4 * dt;
      phase = (phase + fields.phaseRate * dt) % PHASE_PERIOD;
      packFields(shared.uField, fields, phase);
      packWaves(shared.uWaveA, shared.uWaveB, waves, now);
      shared.topology[TOPOLOGY.eddy] = 0.9; shared.topology[TOPOLOGY.eddies] = Math.min(EDDIES, 3 + step / steps); shared.topology[TOPOLOGY.well] = 1.6;
      probe.step(dt);
      simulation.step(dt);
      if (step === 0) start.set(probe.position);
    }
    simulation.read(gpu);
    const cpu = probe.position;
    let squares = 0, sum = 0, max = 0, valid = 0, invalid = 0, travelled = 0;
    for (let i = 0; i < n; i++) {
      const at = i * 4;
      const error = Math.hypot(gpu[at] - cpu[at], gpu[at + 1] - cpu[at + 1], gpu[at + 2] - cpu[at + 2]);
      if (!Number.isFinite(error)) { invalid++; continue; }
      travelled += Math.hypot(cpu[at] - start[at], cpu[at + 1] - start[at + 1], cpu[at + 2] - start[at + 2]);
      sum += error; squares += error * error; valid++;
      if (error > max) max = error;
    }
    const report: TracerParityReport = { tracers: n, steps, fullFloat: simulation.fullFloat, rms: Math.sqrt(squares / Math.max(1, valid)), seed: 20261008, tolerance: simulation.fullFloat ? 1e-3 : null, outcome: !simulation.fullFloat ? 'unvalidated-half-float' : invalid || max >= 1e-3 ? 'fail' : 'pass', initial: 'seeded tracers; shared fields; two fronts; variable dt; see tracerParity.ts', mean: valid ? sum / valid : 0, max, invalid, travelled: travelled / n };
    return report;
  } finally { simulation.dispose(); renderer.dispose(); }
}
