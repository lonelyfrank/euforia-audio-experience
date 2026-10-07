import { substeps } from './matterLaw';
import { matterLayout } from './MatterSeeds';
import { tracerLaw, tracerStep } from './tracerLaw';
import { seedTracers, type TracerSeeds } from './TracerSeeds';
import type { SharedField } from './TracerSimulation';

/** What a cloud of tracers looks like as a whole (means over the tracers). */
export interface TracerMeasure {
  /** Mean distance from the centre of the field and its standard deviation. */
  radius: number;
  spread: number;
  /** Mean speed (units/s) and mean kinetic energy (½ v²). */
  speed: number;
  kinetic: number;
  /** Mean radial velocity (+ outwards) and mean angular velocity about the axis (rad/s, signed). */
  outward: number;
  circulation: number;
  /** Mean distance to the nearest shell of the body (× the matter's radius): small = gathered in sheets. */
  offShell: number;
  /** Mean energy left by the fronts. */
  energy: number;
}

/**
 * The tracers simulated on the CPU with the reference laws: the same seeds,
 * the same shared field arrays and the same stepping as `TracerSimulation`,
 * for a small number of tracers. It is what the tests exercise; `measure`
 * turns it into numbers about the cloud. Deterministic, allocation-free after
 * construction.
 */
export class TracerProbe {
  readonly seeds: TracerSeeds;
  position: Float32Array;
  velocity: Float32Array;
  private nextPosition: Float32Array;
  private nextVelocity: Float32Array;
  private readonly measured: TracerMeasure = { radius: 0, spread: 0, speed: 0, kinetic: 0, outward: 0, circulation: 0, offShell: 0, energy: 0 };
  private pendingReset = true;

  constructor(count: number, seed: number, private readonly shared: SharedField, private readonly detail = false) {
    this.seeds = seedTracers(matterLayout(count), seed);
    const n = this.seeds.layout.count * 4;
    this.position = new Float32Array(n); this.velocity = new Float32Array(n);
    this.nextPosition = new Float32Array(n); this.nextVelocity = new Float32Array(n);
  }

  get count(): number {
    return this.seeds.layout.count;
  }

  /** Advances by `dt` seconds in the field as the shared arrays describe it now. */
  step(dt: number): void {
    const steps = substeps(dt) || (this.pendingReset ? 1 : 0);
    if (steps === 0) return;
    const h = Math.min(dt, 0.1) / steps;
    const { home, trait } = this.seeds, { uField, uWaveA, uWaveB, topology } = this.shared;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < this.count; i++) {
        const at = i * 4;
        const law = tracerLaw(this.position[at], this.position[at + 1], this.position[at + 2], home[at + 3], trait[at], uField, topology, uWaveA, uWaveB, this.detail);
        tracerStep(i, this.position, this.velocity, this.nextPosition, this.nextVelocity, home, trait, law, uField, h, this.pendingReset);
      }
      this.pendingReset = false;
      let swap = this.position; this.position = this.nextPosition; this.nextPosition = swap;
      swap = this.velocity; this.velocity = this.nextVelocity; this.nextVelocity = swap;
    }
  }

  /** The cloud about the centre `lateral`, for a body of radius `radius` (both as the packed fields hold them). Reused object. */
  measure(lateral = 0, radius = 1): TracerMeasure {
    const p = this.position, v = this.velocity, n = this.count, m = this.measured;
    let sum = 0, squares = 0, speed = 0, kinetic = 0, outward = 0, circulation = 0, off = 0, energy = 0;
    for (let i = 0; i < n; i++) {
      const at = i * 4, x = p[at] - lateral, y = p[at + 1], z = p[at + 2];
      const r = Math.max(Math.hypot(x, y, z), 1e-6), rho2 = Math.max(x * x + y * y, 1e-6);
      const v2 = v[at] * v[at] + v[at + 1] * v[at + 1] + v[at + 2] * v[at + 2];
      sum += r; squares += r * r; speed += Math.sqrt(v2); kinetic += 0.5 * v2;
      outward += (x * v[at] + y * v[at + 1] + z * v[at + 2]) / r;
      circulation += (x * v[at + 1] - y * v[at]) / rho2;
      const shell = (r / radius - 0.55) / 0.3;
      off += Math.abs(shell - Math.round(Math.min(2, Math.max(0, shell)))) * 0.3;
      energy += p[at + 3];
    }
    m.radius = sum / n; m.spread = Math.sqrt(Math.max(0, squares / n - m.radius * m.radius));
    m.speed = speed / n; m.kinetic = kinetic / n; m.outward = outward / n; m.circulation = circulation / n; m.offShell = off / n; m.energy = energy / n;
    return m;
  }

  /** The tracers re-form at their seeds on the next step. */
  reset(): void {
    this.pendingReset = true;
  }
}
