import type { PerspectiveCamera } from 'three';
import { DampedOscillator } from '../../physics/primitives';
import type { WorldView } from '../../world/WorldView';

/** Largest angles the observer leans to (rad) and how far its aim follows the world sideways (units). */
const MAX_AZIMUTH = 0.55;
const MAX_ELEVATION = 0.22;
const MAX_AIM = 0.35;
/** Share of the world's own rotation that carries the observer round it (rad per rad). */
const ORBIT = 0.12;
/** How far the field of view opens with the world and narrows with its stored potential (degrees). */
const FOV_OPEN = 9;
const FOV_TENSE = 5;

/**
 * The observer of a world: a camera with inertia of its own, and a part of the
 * world it looks at. The world moves, the observer follows it; a beat never
 * moves the camera. It is carried round the matter by a share of the world's
 * own rotation (so what the sound builds is seen from all sides, and stands
 * still when the world does), and five soft, nearly critically damped bodies
 * (exact steps: the same path at any frame rate) do the rest:
 *   - azimuth leans towards the way the world turns and where its force comes from;
 *   - elevation rises a little as the world opens;
 *   - distance keeps the matter framed as its pressure changes, with a lag
 *     (so an expansion is seen, then followed);
 *   - the aim looks slightly ahead of the world's lateral motion;
 *   - the field of view opens as the world opens and narrows as it stores
 *     potential (tension draws the observer in, a release lets it out).
 * At rest (a silent world) every target is neutral and the observer settles.
 */
export class Observer {
  private readonly azimuth = new DampedOscillator(2 * Math.PI * 0.12, 0.9);
  private readonly elevation = new DampedOscillator(2 * Math.PI * 0.1, 1);
  private readonly distance = new DampedOscillator(2 * Math.PI * 0.22, 0.85, 1);
  private readonly aim = new DampedOscillator(2 * Math.PI * 0.18, 0.9);
  private readonly fov = new DampedOscillator(2 * Math.PI * 0.14, 1);
  /** Angle the world's rotation has carried the observer round the axis (rad, kept within one turn). */
  private orbit = 0;

  /**
   * `amount` 0..1: how much camera motion the Director allows (angles and
   * aim). `depth` 0..1 is its slow depth channel. Framing by distance always
   * follows the world.
   */
  step(dt: number, view: Readonly<WorldView>, amount: number, depth: number): void {
    const h = Math.min(Math.max(dt, 0), 0.1);
    const a = clamp(amount, 0, 1);
    this.azimuth.step(h, clamp(a * (0.7 * view.spin + 0.3 * view.lateral), -1, 1) * MAX_AZIMUTH);
    this.elevation.step(h, a * clamp(view.openness - 0.3, -1, 1) * MAX_ELEVATION);
    // An expansion under way is followed before it has arrived (the world's radial velocity).
    this.distance.step(h, clamp(1 + 0.3 * view.pressure + 0.05 * view.surge - 0.1 * view.tension - 0.16 * (clamp(depth, 0, 1) - 0.5), 0.7, 1.5));
    // Look-ahead: where the lateral body is going, not only where it is.
    this.aim.step(h, clamp(a * (view.lateral + 0.25 * view.world.biasVelocity), -1, 1) * MAX_AIM);
    this.fov.step(h, a * (FOV_OPEN * clamp(view.openness, 0, 1) - FOV_TENSE * clamp(view.tension, 0, 1)));
    // The layer's own share of the world's turn since the previous frame: a sum of angles, whatever the frame rate.
    if (Number.isFinite(view.dTurn)) this.orbit = (this.orbit + ORBIT * a * view.dTurn) % (2 * Math.PI);
  }

  /**
   * Places `camera` on its orbit at `distance` × the observer's own factor; with `fov` (the scene's own field of
   * view, degrees) the observer's opening is applied to it. Must not allocate.
   */
  apply(camera: PerspectiveCamera, distance: number, fov?: number): void {
    const d = distance * this.distance.x, az = this.azimuth.x + this.orbit, el = this.elevation.x;
    camera.position.set(this.aim.x + d * Math.sin(az) * Math.cos(el), d * Math.sin(el), d * Math.cos(az) * Math.cos(el));
    camera.lookAt(this.aim.x, 0, 0);
    if (fov !== undefined && Math.abs(camera.fov - (fov + this.fov.x)) > 1e-3) {
      camera.fov = fov + this.fov.x;
      camera.updateProjectionMatrix();
    }
  }

  /** Angular and radial speed of the observer (rad/s, 1/s): diagnostics and tests. */
  get motion(): number {
    return Math.abs(this.azimuth.v) + Math.abs(this.elevation.v) + Math.abs(this.distance.v) + Math.abs(this.aim.v);
  }

  get state(): readonly [azimuth: number, elevation: number, distance: number, aim: number, orbit: number, fov: number] {
    return [this.azimuth.x, this.elevation.x, this.distance.x, this.aim.x, this.orbit, this.fov.x];
  }

  reset(): void {
    this.azimuth.reset(); this.elevation.reset(); this.distance.reset(1); this.aim.reset(); this.fov.reset();
    this.orbit = 0;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x > hi ? hi : x > lo ? x : lo;
}
