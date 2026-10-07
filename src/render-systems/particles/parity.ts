import { WebGLRenderer } from 'three';
import { AudioAnalyzer } from '../../audio/analysis/AudioAnalyzer';
import { newFrame } from '../../audio/features/decode';
import { VisualResponse } from '../../audio/visual-response/VisualResponse';
import { createFields } from '../fields/SpatialFields';
import { MatterForms } from '../forms/MatterForms';
import { WaveField } from '../waves/WaveField';
import { MatterProbe } from './MatterProbe';
import { STRAND } from './MatterSeeds';
import { MatterSimulation } from './MatterSimulation';

/** What the parity check found: distances (units) between the GPU's and the CPU reference's positions of the same elements. */
export interface ParityReport {
  elements: number;
  steps: number;
  fullFloat: boolean;
  /** Over all elements, and over those the wave form, the harmonic network and no form holds. */
  mean: number;
  max: number;
  wave: { elements: number; mean: number; max: number };
  harmonic: { elements: number; mean: number; max: number };
  free: { elements: number; mean: number; max: number };
  /** Elements whose state is not finite on either side, and how far the matter moved in all (so a still body cannot pass). */
  invalid: number;
  travelled: number;
}

/**
 * The GPU ↔ CPU parity check of the matter laws (field law, form law, matter
 * step): the same seeds, fields, forms, fronts and steps through
 * `MatterSimulation` on a real WebGL2 context and through `MatterProbe`, then
 * the positions compared element by element. The laws are written twice (GLSL
 * and TypeScript): run this after changing either text. A development tool,
 * not part of the app: from a page served by Vite,
 *
 *   (await import('/src/render-systems/particles/parity.ts')).runParity()
 *
 * Every field is on, both forms claim matter (with a moving signal history and
 * a network that reconfigures), two fronts travel, the step length varies and
 * some elements re-form. Expect a mean around 1e-5 units and a maximum below
 * 1e-3 with full-float targets (see docs/matter-engine.md).
 */
export function runParity(count = 1024, steps = 240, detail = true): ParityReport {
  const renderer = new WebGLRenderer({ canvas: document.createElement('canvas') });
  const forms = new MatterForms();
  const probe = new MatterProbe(count, 20261007, detail, forms);
  const simulation = new MatterSimulation(renderer, probe.seeds, detail, forms);
  const fields = createFields(), waves = new WaveField();
  Object.assign(fields, {
    radius: 1.15, stiffness: 9, gather: 0.4, surge: 0.3, vortex: 0.8, flatten: 0.35, advection: 0.5, lateral: 0.2, drift: 0.1,
    turbulence: 0.5, turbulenceScale: 2.1, shimmer: 0.2, cohesion: 6, order: 2.6, winding: 1.2, bond: 18, clumping: 2, clumpScale: 5,
    drag: 2.2, lifetimeRate: 0.25, phaseRate: 0.5, turn: 3, form: 34,
  });
  // The forms' sources: a sawtooth and a sine as the two voices, and a harmonic tone that turns into a chord half way.
  const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame, music = response.music;
  for (let i = 0; i < music.leadLine.length; i++) {
    music.leadLine[i] = 2 * i / music.leadLine.length - 1;
    music.bassLine[i] = Math.sin(2 * Math.PI * i / music.bassLine.length);
  }
  music.leadVoice = 0.9; music.bassVoice = 0.8; music.leadPitch = 330; music.bassPitch = 82;
  response.audible = response.presence = 1;
  const tone = newFrame(), chord = newFrame();
  [110, 220, 330, 440, 550, 660].forEach((hz, i) => { tone.partialHz[i] = hz; tone.partialLevel[i] = 0.9 / (i + 1); tone.partialPan[i] = (i % 3 - 1) * 0.5; });
  [220, 261.63, 329.63, 440].forEach((hz, i) => { chord.partialHz[i] = hz; chord.partialLevel[i] = 0.9 - 0.1 * i; });
  Object.assign(forms.state, { wave: 0.42, harmonic: 0.4, closure: 0.8, amplitude: 0.3, ribbon: 1.5, depth: 1.2, ring: 1, scale: 1, fracture: 0.1 });
  waves.update(0, undefined);
  waves.spawn(0.2, 0.9, 0.2, 1.7, 0.2, 1.2, 0.1, 0, 0);
  waves.spawn(1.1, 0.7, -1, 1.1, 0.45, 0.7, -0.2, 0.1, 0.05);

  const n = probe.count, start = new Float32Array(n * 4), gpu = new Float32Array(n * 4);
  const lengths = [1 / 60, 1 / 30, 1 / 144, 1 / 60, 1 / 50];
  let now = 0;
  for (let step = 0; step < steps; step++) {
    const dt = lengths[step % lengths.length];
    now += dt;
    forms.signal.update(dt, 9, audio, response);
    forms.harmonic.update(dt, step < steps / 2 ? tone : chord, 0.9);
    fields.turn += 0.4 * dt;
    forms.state.fracture = step > steps * 0.6 && step < steps * 0.7 ? 0.8 : 0.1;
    probe.step(fields, waves, now, dt);
    simulation.step(fields, waves, now, dt);
    if (step === 0) start.set(probe.position);
  }
  simulation.read(gpu);
  const cpu = probe.position, key = probe.seeds.form;
  const groups = { wave: group(), harmonic: group(), free: group() }, all = group();
  let invalid = 0, travelled = 0;
  for (let i = 0; i < n; i++) {
    const at = i * 4;
    const error = Math.hypot(gpu[at] - cpu[at], gpu[at + 1] - cpu[at + 1], gpu[at + 2] - cpu[at + 2]);
    if (!Number.isFinite(error)) { invalid++; continue; }
    travelled += Math.hypot(cpu[at] - start[at], cpu[at + 1] - start[at + 1], cpu[at + 2] - start[at + 2]);
    const k = key[(i - i % STRAND) * 4 + 1];
    add(all, error);
    add(k < forms.state.wave ? groups.wave : k > 1 - forms.state.harmonic ? groups.harmonic : groups.free, error);
  }
  const report: ParityReport = {
    elements: n, steps, fullFloat: simulation.fullFloat, mean: mean(all), max: all.max,
    wave: summary(groups.wave), harmonic: summary(groups.harmonic), free: summary(groups.free), invalid, travelled: travelled / n,
  };
  simulation.dispose();
  renderer.dispose();
  return report;
}

interface Group { elements: number; sum: number; max: number }
const group = (): Group => ({ elements: 0, sum: 0, max: 0 });
const add = (g: Group, error: number): void => { g.elements++; g.sum += error; if (error > g.max) g.max = error; };
const mean = (g: Group): number => (g.elements ? g.sum / g.elements : 0);
const summary = (g: Group) => ({ elements: g.elements, mean: mean(g), max: g.max });
