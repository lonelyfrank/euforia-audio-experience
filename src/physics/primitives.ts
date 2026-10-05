import { springMatrix } from '../dynamics/Dynamics';

/*
 * Reusable physical primitives for scenes. Each step is the exact solution
 * for a force held constant over the step, so the result does not depend on
 * how the time is cut (30, 60 or 144 fps give the same trajectory for the same
 * forces); impulses change velocity, never position. Deterministic and
 * allocation-free. Scenes feed them forces from the semantic layer (intents,
 * experience state) and advance them on the heard audio clock.
 */

/** Unit mass on a spring with damping, about a rest position that forces displace. */
export class DampedOscillator {
  x: number;
  v = 0;
  private readonly m = new Float64Array(4);
  private h = -1;

  constructor(readonly omega: number, readonly zeta: number, rest = 0) {
    this.x = rest;
  }

  /** Advances `h` s; `force` (per unit mass) shifts the equilibrium by force / ω². */
  step(h: number, rest: number, force = 0): void {
    if (!(h > 0)) return;
    if (h !== this.h) {
      springMatrix(this.omega, this.zeta, h, this.m);
      this.h = h;
    }
    const m = this.m;
    const eq = rest + force / (this.omega * this.omega);
    const dx = this.x - eq;
    this.x = eq + m[0] * dx + m[1] * this.v;
    this.v = m[2] * dx + m[3] * this.v;
  }

  impulse(dv: number): void {
    this.v += dv;
  }

  /** Kinetic + potential energy about `rest`. */
  energy(rest: number): number {
    const dx = this.x - rest;
    return 0.5 * this.v * this.v + 0.5 * this.omega * this.omega * dx * dx;
  }

  reset(rest = 0): void {
    this.x = rest;
    this.v = 0;
  }
}

/** Unit mass with linear drag: v' = force − drag·v. Position integrates exactly too. */
export class Momentum {
  position = 0;
  velocity = 0;

  constructor(readonly drag: number) {}

  step(h: number, force: number): void {
    if (!(h > 0)) return;
    const k = Math.exp(-this.drag * h);
    const terminal = force / this.drag;
    const v0 = this.velocity - terminal;
    this.position += terminal * h + (v0 * (1 - k)) / this.drag;
    this.velocity = terminal + v0 * k;
  }

  impulse(dv: number): void {
    this.velocity += dv;
  }

  reset(): void {
    this.position = this.velocity = 0;
  }
}

/** Attack/release follower of a target, on the time it is given. */
export class Envelope {
  value = 0;

  constructor(readonly attack: number, readonly release: number) {}

  step(h: number, target: number): void {
    if (!(h > 0)) return;
    const tau = target > this.value ? this.attack : this.release;
    this.value = target + (this.value - target) * Math.exp(-h / tau);
  }

  reset(): void {
    this.value = 0;
  }
}
