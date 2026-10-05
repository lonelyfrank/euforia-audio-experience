import { springMatrix } from '../dynamics/Dynamics';
import type { AnalysisFrame } from '../audio/features/decode';
import type { ExperienceState } from '../experience/types';

export const MODES = 12;
export const WAVES = 8;
/** Rectangular membrane eigenmodes. Precomputed at module load, shared by scenes. */
export const MODE_SHAPES: readonly (readonly [number, number])[] = [
  [1, 1], [1, 2], [2, 1], [2, 2], [1, 3], [3, 1], [2, 3], [3, 2], [3, 3], [2, 4], [4, 2], [4, 4],
];
export interface PhysicsFrame {
  time: number;
  displacement: number;
  velocity: number;
  energy: number;
  damping: number;
  activeResonators: number;
  waveActivity: number;
  modes: Float32Array;
  /** Each wave: origin x/y (-1..1), time, impulse. Analytic propagation conserves event age. */
  waves: Float32Array;
}
export const createPhysicsFrame = (): PhysicsFrame => ({ time: 0, displacement: 0, velocity: 0, energy: 0,
  damping: 0.22, activeResonators: 0, waveActivity: 0, modes: new Float32Array(MODES), waves: new Float32Array(WAVES * 4) });

/** Exact damped modes driven by forces/velocity impulses, independent of rendering cadence. */
export class ResonantPhysics {
  readonly frame = createPhysicsFrame();
  private readonly x = new Float64Array(MODES);
  private readonly v = new Float64Array(MODES);
  private readonly matrices = new Float64Array(MODES * 4);
  private readonly omega = Float64Array.from(MODE_SHAPES, ([m, n]) => 2 * Math.PI * 0.32 * Math.sqrt(m * m + n * n));
  private step = 0;
  private lastEvent = 0;
  private nextWave = 0;

  update(a: AnalysisFrame, e: ExperienceState, dt: number): void {
    const f = this.frame;
    if (Math.abs(dt - this.step) > 1e-8) {
      this.step = dt;
      for (let i = 0; i < MODES; i++) springMatrix(this.omega[i], f.damping, dt, this.matrices, i * 4);
    }
    const impulse = e.eventId !== this.lastEvent ? e.eventStrength : 0;
    this.lastEvent = e.eventId;
    if (impulse > 0) {
      const at = this.nextWave++ % WAVES * 4;
      f.waves[at] = a.balance * 0.65;
      f.waves[at + 1] = ((e.eventId % 3) - 1) * 0.25;
      f.waves[at + 2] = e.eventTime;
      f.waves[at + 3] = impulse;
    }
    f.energy = f.activeResonators = 0;
    for (let i = 0; i < MODES; i++) {
      let excitation = 0;
      for (let b = i * 6; b < i * 6 + 6; b++) excitation = Math.max(excitation, a.pitchBins[b]);
      const omega = this.omega[i];
      // Harmonic force maintains deformation; percussion changes momentum.
      // The carrier excites each mode near its own natural frequency.
      const force = excitation * e.flow * (0.3 + 0.7 * a.phaseCoherence) * Math.sin(omega * a.time) * 0.9;
      const target = force / (omega * omega);
      const v = this.v[i] + impulse * (1 - i / (MODES * 1.2)) * 2;
      const x = this.x[i] - target, at = i * 4, m = this.matrices;
      this.x[i] = m[at] * x + m[at + 1] * v + target;
      this.v[i] = m[at + 2] * x + m[at + 3] * v;
      f.modes[i] = this.x[i];
      f.energy += 0.5 * (this.v[i] ** 2 + (omega * this.x[i]) ** 2);
      if (Math.abs(this.x[i]) + Math.abs(this.v[i]) > 0.002) f.activeResonators++;
    }
    f.displacement = this.x[0]; f.velocity = this.v[0]; f.time = a.time;
    f.waveActivity = 0;
    for (let i = 0; i < WAVES; i++) {
      const age = a.time - f.waves[i * 4 + 2];
      if (age >= 0) f.waveActivity += f.waves[i * 4 + 3] * Math.exp(-age * 1.3);
    }
  }

  reset(): void {
    this.x.fill(0); this.v.fill(0); this.frame.modes.fill(0); this.frame.waves.fill(0);
    this.lastEvent = this.nextWave = 0;
    this.frame.time = this.frame.displacement = this.frame.velocity = this.frame.energy = this.frame.activeResonators = this.frame.waveActivity = 0;
  }
}

/** Causal outgoing pulse, signed oscillation, amplitude spreading and damping. */
export function radialWave(distance: number, age: number, strength: number): number {
  if (age < 0 || distance > age * 1.4) return 0;
  const behind = age * 1.4 - distance;
  return strength * Math.sin(behind * 18) * Math.exp(-behind * 5 - age * 1.3) / Math.sqrt(1 + distance * 4);
}
