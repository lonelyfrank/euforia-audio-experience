import { REST_WORLD, MAX_SPEED, MAX_SPIN, type WorldState } from './WorldState';

/** How strongly the current mood lets a scene express each kind of motion (Character multipliers, ~0.3–2). */
export interface WorldGains {
  motion: number;
  expansion: number;
  turbulence: number;
}

/**
 * One layer's view of the shared world: the scene-physics adapter. Every
 * layer observes the same WorldState; what differs is only its interpretation.
 * Gains act on velocities, never on positions: `travel` and `turn` integrate
 * the world's own displacement since the previous frame, so a mood change or a
 * newly mounted scene continues the motion instead of jumping. A scene mounted
 * during a crossfade therefore inherits the world's momentum, pressure and
 * excitation at once. Allocation-free; read-only for scenes.
 */
export class WorldView {
  /** The presented world (REST_WORLD when the clock is not synchronized: nothing moves on its own). */
  world: Readonly<WorldState> = REST_WORLD;
  /** Accumulated forward travel and rotation of this layer (world units × motion gain). */
  travel = 0;
  turn = 0;
  /** Travel and rotation this frame (≥ 0 travel; signed turn). */
  dTravel = 0;
  dTurn = 0;
  /** Current velocities, normalized: speed 0..1, spin −1..1 (× motion gain). */
  speed = 0;
  spin = 0;
  /** Radial pressure (signed: + expanded, − drawn in), × expansion gain. */
  pressure = 0;
  /** Radial velocity of the world (units/s; + outwards), × expansion gain. */
  surge = 0;
  /** Lateral force origin −1 (left) … 1 (right). */
  lateral = 0;
  /** 0..1 fields. */
  disorder = 0;
  coherence = 1;
  excitation = 0;
  shimmer = 0;
  tension = 0;
  light = 0;
  openness = 0;
  /** Seconds since the last release / impulse (Infinity before any), and their strengths. */
  releaseAge = Infinity;
  releaseStrength = 0;
  impulseAge = Infinity;
  impulseStrength = 0;
  private lastTime = NaN;
  private lastTravel = 0;
  private lastAngle = 0;

  update(world: Readonly<WorldState> | undefined, gains: WorldGains): void {
    const w = world ?? REST_WORLD;
    this.world = w;
    // A new session (or no clock) restarts the deltas: never a jump from another world's positions.
    const fresh = !world || !(w.time >= this.lastTime - 1e-9) || w.time - this.lastTime > 1;
    this.dTravel = fresh ? 0 : Math.max(0, w.travel - this.lastTravel) * gains.motion;
    this.dTurn = fresh ? 0 : (w.angle - this.lastAngle) * gains.motion;
    this.travel += this.dTravel;
    this.turn += this.dTurn;
    this.lastTravel = w.travel;
    this.lastAngle = w.angle;
    this.lastTime = world ? w.time : NaN;
    this.speed = Math.min(1, (w.speed / MAX_SPEED) * gains.motion);
    this.spin = Math.max(-1, Math.min(1, (w.spin / MAX_SPIN) * gains.motion));
    this.pressure = w.radius * gains.expansion;
    this.surge = w.radialVelocity * gains.expansion;
    this.lateral = w.bias;
    this.disorder = Math.min(1, w.turbulence * gains.turbulence);
    this.coherence = w.coherence;
    this.excitation = w.excitation;
    this.shimmer = w.shimmer;
    this.tension = w.potential;
    this.light = w.illumination;
    this.openness = w.openness;
    this.releaseAge = w.time - w.releaseTime;
    this.releaseStrength = w.releaseStrength;
    this.impulseAge = w.time - w.impulseTime;
    this.impulseStrength = w.impulseStrength;
  }
}

/** A shared view at rest, for scenes updated without a Director (tests, hosts without the rig). */
export const REST_VIEW: Readonly<WorldView> = new WorldView();
