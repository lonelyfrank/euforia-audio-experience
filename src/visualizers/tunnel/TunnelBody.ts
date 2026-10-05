import type { HitLog } from '../../dynamics/HitLog';
import { DampedOscillator, Momentum } from '../../physics/primitives';

/** Forces the semantic layer applies to the tunnel this frame. */
export interface TunnelForces {
  /** Equilibrium radius factor: how open/full the sound is (1 = the preset radius). */
  rest: number;
  /** Push on the wall (per unit mass): expand − contract intents. Shifts the equilibrium by expand / ω². */
  expand: number;
  /** Forward speed the music's motion asks for (travel units/s), and extra thrust from accelerate − decelerate. */
  speed: number;
  pace: number;
  /** Velocity a hit adds to the forward travel (units/s per unit strength). */
  surge: number;
  /** Roll rate asked for (rad/s). */
  roll: number;
}

/** Wall: ~0.8 Hz, ζ 0.45 (one soft overshoot, then settles). */
const WALL_OMEGA = 2 * Math.PI * 0.8;
const WALL_ZETA = 0.45;
/** Outward wall velocity per unit hit strength: a kick breathes the tunnel open, the spring brings it back. */
const WALL_KICK = 0.6;
/** Drag (1/s): ~0.4 s to reach the asked speed, ~0.8 s to settle a roll. */
const TRAVEL_DRAG = 2.5;
const ROLL_DRAG = 1.2;
/** Longer jumps of the heard clock (stall, seek-like gap) restart the body at rest. */
const MAX_GAP = 1;

/**
 * The tunnel as a body instead of a set of target positions: the wall is a
 * damped spring pushed by the music's openness and the expand/contract
 * intents and kicked by hits; travel and roll have momentum with drag. It is
 * integrated on the heard audio clock with hits applied at their own audio
 * time, so the trajectory is the same at any frame rate.
 */
export class TunnelBody {
  readonly wall = new DampedOscillator(WALL_OMEGA, WALL_ZETA, 1);
  readonly travel = new Momentum(TRAVEL_DRAG);
  readonly roll = new Momentum(ROLL_DRAG);
  private time = NaN;
  private lastHit = -Infinity;

  advance(time: number, f: TunnelForces, hits: HitLog, hitScale: number): void {
    if (!Number.isFinite(this.time) || time < this.time - 1e-9 || time - this.time > MAX_GAP) {
      this.reset(f.rest);
      this.time = this.lastHit = time;
      return;
    }
    let at = this.time;
    for (let next = nextHit(hits, this.lastHit, time); next >= 0; next = nextHit(hits, this.lastHit, time)) {
      const t = hits.times[next];
      // A hit logged after the frame that should have shown it is applied now (late, not lost).
      if (t > at) {
        this.integrate(t - at, f);
        at = t;
      }
      const strength = hits.strengths[next] * hitScale;
      this.wall.impulse(strength * WALL_KICK);
      this.travel.impulse(strength * f.surge);
      this.lastHit = t;
    }
    this.integrate(time - at, f);
    this.time = time;
  }

  reset(rest = 1): void {
    this.wall.reset(rest);
    this.travel.reset();
    this.roll.reset();
    this.time = NaN;
  }

  private integrate(h: number, f: TunnelForces): void {
    this.wall.step(h, f.rest, f.expand);
    this.travel.step(h, f.speed * TRAVEL_DRAG + f.pace);
    this.roll.step(h, f.roll * ROLL_DRAG);
  }
}

/** The earliest logged hit after `after` and at or before `until`, or -1. */
function nextHit(hits: HitLog, after: number, until: number): number {
  let best = -1;
  for (let i = 0; i < hits.size; i++) {
    const t = hits.times[i];
    if (t > after && t <= until && (best < 0 || t < hits.times[best])) best = i;
  }
  return best;
}
