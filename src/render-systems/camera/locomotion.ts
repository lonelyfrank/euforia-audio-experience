import type { PerspectiveCamera } from 'three';
import { DampedOscillator } from '../../physics/primitives';
import { clamp, finite, follow, RateFollower } from '../../visualizers/shared/motion';
import type { WorldView } from '../../world/WorldView';

/*
 * How the observer of a world moves through it (docs/generative-worlds.md): five ways of being in a space, each a
 * reading of the shared world, combined per scene by a rig that smooths and bounds what they ask.
 *
 *   travel   through the space, forward motion dominant, banking into the world's turn      (Infinite Tunnel)
 *   glide    over a landscape, steady height, horizon and depth; the ground slides under it  (Generative Terrain)
 *   orbit    round a subject, at a distance and an angle the world sets                       (Fractured Expanse)
 *   hover    almost still, small shifts and reframes towards what grows                      (Monolith Desert)
 *   drift    slow, fluid paths whose turns follow coherence and turbulence                   (Resonant Forest)
 *
 * None of them has a time or a clock of its own and none reads the capture, the analysis or the cognition: every
 * quantity is the world's (WorldView: its travel, its turn, its pressure, its tension …) followed exactly over a frame,
 * or a sum of the world's own displacement (an orbit's angle is a share of the world's turn, a drift's path is a
 * function of the distance travelled). So a profile is the same at any frame rate, and when the world is at rest every
 * offset it asks for is zero and the observer settles where it is; nothing goes round because time passes.
 *
 * A profile adds, scaled by its weight, what it asks of the pose to the rest pose of the scene (an observer and a
 * target); the rig follows the sum with nearly critically damped bodies (exact steps: the same path at any frame rate,
 * an acceleration bounded by the bounded offsets), clamps the lens and the roll, and places the camera. The scene's
 * motion relative to the observer (what a ground or a sea slides by) is the distance a forward profile returns.
 */

export const LOCOMOTIONS = ['travel', 'glide', 'orbit', 'hover', 'drift'] as const;
export type Locomotion = typeof LOCOMOTIONS[number];

/** What a scene offers its observer to look at: a point (scene units) and how much it asks to be looked at (0..1). */
export interface MotionFocus {
  x: number;
  y: number;
  z: number;
  weight: number;
}

/** What every profile reads in a frame: the shared world, the heard time and the scene's subject. A stable object, written in place. */
export interface MotionInput {
  dt: number;
  view: Readonly<WorldView>;
  /** Audio time heard (s), and whether there is a clock: without one the world is at rest, and so is the observer. */
  time: number;
  timed: boolean;
  focus: MotionFocus;
}

/** A pose: where the observer is, what it looks at (scene units), how much its lens opens (degrees added to the scene's) and its roll (rad). */
export interface MotionPose {
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
  fov: number;
  roll: number;
}

export const createPose = (): MotionPose => ({ x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: -1, fov: 0, roll: 0 });
export const createInput = (view: Readonly<WorldView>): MotionInput => ({ dt: 0, view, time: 0, timed: false, focus: { x: 0, y: 0, z: 0, weight: 0 } });

/** One way of moving. `step` adds what it asks of the pose (× `weight`) to `out` and returns the distance it carries the scene this frame (units). */
export interface LocomotionProfile {
  readonly kind: Locomotion;
  step(input: Readonly<MotionInput>, weight: number, rest: Readonly<MotionPose>, out: MotionPose): number;
  /** Share of the forward motion this profile holds back at full weight (0: none). */
  readonly hold?: number;
  /** 0..1: how much of itself the moment asks for (a calm world for hover); absent: always all of it. */
  presence?(input: Readonly<MotionInput>): number;
  reset(): void;
}

const k = (h: number, tau: number): number => Math.exp(-h / tau);
const step = (dt: number): number => (dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.25) : 0);

// ---- the five profiles ----

/** Forward through the space: the world's travel × `stride`, followed over `tau` (a kick surges, it does not jerk); banks into the world's turn. */
export interface TravelParams { stride: number; tau: number; bank: number; widen: number }
export const TRAVEL: Readonly<TravelParams> = { stride: 1, tau: 0.2, bank: 0.12, widen: 6 };

export class Travel implements LocomotionProfile {
  readonly kind: Locomotion = 'travel';
  readonly params: TravelParams;
  private readonly rate = new RateFollower();
  private spin = 0;
  private fresh = true;

  constructor(params: Partial<TravelParams> = {}) { this.params = { ...TRAVEL, ...params }; }

  step(input: Readonly<MotionInput>, weight: number, _rest: Readonly<MotionPose>, out: MotionPose): number {
    const h = step(input.dt), view = input.view, p = this.params;
    const rate = h > 0 ? finite(view.dTravel) * p.stride / h : 0, spin = clamp(finite(view.spin), -1, 1);
    if (this.fresh) { this.rate.rate = rate; this.spin = spin; this.fresh = false; }
    const distance = Math.max(0, this.rate.step(h, rate, p.tau));
    this.spin = follow(this.spin, spin, k(h, 0.5));
    out.roll += weight * -p.bank * this.spin;
    out.fov += weight * p.widen * clamp(finite(view.speed), 0, 1);
    return weight * distance;
  }

  reset(): void { this.rate.reset(); this.spin = 0; this.fresh = true; }
}

/**
 * Over a landscape: the travel followed more softly (`tau`), a steady height that lifts a little with the world's
 * pressure and the lens opening with speed (depth), a slight bank. The horizon stays where it is.
 */
export interface GlideParams { stride: number; tau: number; lift: number; bank: number; widen: number }
export const GLIDE: Readonly<GlideParams> = { stride: 1, tau: 0.6, lift: 0.5, bank: 0.05, widen: 4 };

export class Glide implements LocomotionProfile {
  readonly kind: Locomotion = 'glide';
  readonly params: GlideParams;
  private readonly rate = new RateFollower();
  private pressure = 0;
  private spin = 0;
  private speed = 0;
  private fresh = true;

  constructor(params: Partial<GlideParams> = {}) { this.params = { ...GLIDE, ...params }; }

  step(input: Readonly<MotionInput>, weight: number, _rest: Readonly<MotionPose>, out: MotionPose): number {
    const h = step(input.dt), view = input.view, p = this.params;
    const rate = h > 0 ? finite(view.dTravel) * p.stride / h : 0, pressure = clamp(finite(view.pressure), -0.6, 0.9);
    const spin = clamp(finite(view.spin), -1, 1), speed = clamp(finite(view.speed), 0, 1);
    if (this.fresh) { this.rate.rate = rate; this.pressure = pressure; this.spin = spin; this.speed = speed; this.fresh = false; }
    const distance = Math.max(0, this.rate.step(h, rate, p.tau));
    this.pressure = follow(this.pressure, pressure, k(h, 1.2));
    this.spin = follow(this.spin, spin, k(h, 0.8));
    this.speed = follow(this.speed, speed, k(h, 1));
    out.y += weight * p.lift * this.pressure;
    out.ty += weight * p.lift * this.pressure;
    out.roll += weight * -p.bank * this.spin;
    out.fov += weight * p.widen * this.speed;
    return weight * distance;
  }

  reset(): void { this.rate.reset(); this.pressure = this.spin = this.speed = 0; this.fresh = true; }
}

/**
 * Round a subject. The angle is a share of the world's own turn (`share`, rad per rad) and of its travel (`carry`, rad
 * per unit): the observer goes round when the world turns or moves on, and stands where it is when the world does.
 * Elevation rises as the world opens; the distance breathes with its pressure and draws in with what it holds
 * (`breathe`, `tense`, within 0.7 … 1.5 of the rest distance). The target leans towards the scene's subject (`focus`).
 */
export interface OrbitParams { share: number; carry: number; elevation: number; breathe: number; tense: number; focus: number }
export const ORBIT: Readonly<OrbitParams> = { share: 0.2, carry: 0.015, elevation: 0.3, breathe: 0.25, tense: 0.15, focus: 1 };

export class Orbit implements LocomotionProfile {
  readonly kind: Locomotion = 'orbit';
  readonly params: OrbitParams;
  /** Angle the world has carried the observer round (rad, kept within a turn), elevation and distance factor as followed. */
  azimuth = 0;
  elevation = 0;
  distance = 1;
  private fresh = true;

  constructor(params: Partial<OrbitParams> = {}) { this.params = { ...ORBIT, ...params }; }

  step(input: Readonly<MotionInput>, weight: number, rest: Readonly<MotionPose>, out: MotionPose): number {
    const h = step(input.dt), view = input.view, p = this.params, f = input.focus;
    const elevation = p.elevation * clamp(finite(view.openness) - 0.3, -0.5, 1);
    const distance = clamp(1 + p.breathe * clamp(finite(view.pressure), -0.6, 0.9) - p.tense * clamp(finite(view.tension), 0, 1), 0.7, 1.5);
    if (this.fresh) { this.elevation = elevation; this.distance = distance; this.fresh = false; }
    // A sum of the world's own angles and distance: the same at any frame rate, still when the world is.
    this.azimuth = (this.azimuth + p.share * finite(view.dTurn) + p.carry * finite(view.dTravel)) % (2 * Math.PI);
    this.elevation = follow(this.elevation, elevation, k(h, 2));
    this.distance = follow(this.distance, distance, k(h, 1.5));
    // Where it looks: the rest target, leaning towards the subject as far as the subject asks.
    const lean = weight * p.focus * clamp(finite(f.weight), 0, 1);
    const tx = lean * (f.x - rest.tx), ty = lean * (f.y - rest.ty), tz = lean * (f.z - rest.tz);
    out.tx += tx; out.ty += ty; out.tz += tz;
    // Where it stands: the rest offset from the target, turned about the vertical and raised, at the distance followed.
    const ox = rest.x - rest.tx, oy = rest.y - rest.ty, oz = rest.z - rest.tz;
    const c = Math.cos(this.azimuth), s = Math.sin(this.azimuth), ce = Math.cos(this.elevation), se = Math.sin(this.elevation);
    const rx = ox * c + oz * s, rz = -ox * s + oz * c, flat = Math.hypot(rx, rz);
    const d = this.distance, x = rx * ce * d, y = oy * d + flat * se * d, z = rz * ce * d;
    out.x += tx + weight * (x - ox); out.y += ty + weight * (y - oy); out.z += tz + weight * (z - oz);
    return 0;
  }

  reset(): void { this.elevation = 0; this.distance = 1; this.fresh = true; }
}

/**
 * Almost still: the observer rises a little as the world opens and towards what grows (the subject's weight), shifts
 * towards where the sound is, and turns its aim to the subject (`reframe`, as a turn of the head: the observer stays);
 * the lens draws in with tension. Its presence is the world's calm: with the world moving fast it gives way to
 * whatever travels, and while it is there it holds back that travel by `hold`.
 */
export interface HoverParams { lift: number; rise: number; sway: number; reframe: number; tense: number; hold: number; calm: number }
export const HOVER: Readonly<HoverParams> = { lift: 0.6, rise: 0.8, sway: 0.6, reframe: 0.35, tense: 4, hold: 0.45, calm: 0.45 };

export class Hover implements LocomotionProfile {
  readonly kind: Locomotion = 'hover';
  readonly params: HoverParams;
  readonly hold: number;
  private openness = 0;
  private lateral = 0;
  private tension = 0;
  private speed = 0;
  private fresh = true;

  constructor(params: Partial<HoverParams> = {}) { this.params = { ...HOVER, ...params }; this.hold = this.params.hold; }

  /** The world's calm: how far its speed (followed over 1.5 s) is below `calm`. */
  presence(input: Readonly<MotionInput>): number {
    const h = step(input.dt), speed = clamp(finite(input.view.speed), 0, 1);
    if (this.fresh) this.speed = speed;
    this.speed = follow(this.speed, speed, k(h, 1.5));
    return 1 - clamp(this.speed / Math.max(1e-3, this.params.calm), 0, 1);
  }

  step(input: Readonly<MotionInput>, weight: number, rest: Readonly<MotionPose>, out: MotionPose): number {
    const h = step(input.dt), view = input.view, p = this.params, f = input.focus;
    const openness = clamp(finite(view.openness), 0, 1), lateral = clamp(finite(view.lateral), -1, 1), tension = clamp(finite(view.tension), 0, 1);
    if (this.fresh) { this.openness = openness; this.lateral = lateral; this.tension = tension; this.fresh = false; }
    this.openness = follow(this.openness, openness, k(h, 2.5));
    this.lateral = follow(this.lateral, lateral, k(h, 2));
    this.tension = follow(this.tension, tension, k(h, 1.2));
    const subject = clamp(finite(f.weight), 0, 1);
    const up = p.lift * this.openness + p.rise * subject, aside = p.sway * this.lateral;
    out.x += weight * aside; out.y += weight * up;
    // The aim turns towards the subject; the target keeps the observer's own shift so the view does not tilt by it.
    const turn = weight * p.reframe * subject;
    out.tx += weight * aside + turn * (f.x - rest.tx); out.ty += weight * up + turn * (f.y - rest.ty); out.tz += turn * (f.z - rest.tz);
    out.fov -= weight * p.tense * this.tension;
    return 0;
  }

  reset(): void { this.openness = this.lateral = this.tension = this.speed = 0; this.fresh = true; }
}

/**
 * Slow, fluid paths: the observer wanders across its corridor along a path that is a function of the distance
 * travelled (`wavelength` units of travel a bend; no travel, no bend), wider with the world's turbulence and simpler
 * with its coherence; it looks ahead along the path (`yaw`) and leans into its bends. Never beyond `corridor`.
 */
export interface DriftParams { amplitude: number; wavelength: number; stride: number; turbulence: number; yaw: number; bank: number; corridor: number }
export const DRIFT: Readonly<DriftParams> = { amplitude: 1.2, wavelength: 60, stride: 1, turbulence: 0.6, yaw: 8, bank: 0.04, corridor: 2 };

export class Drift implements LocomotionProfile {
  readonly kind: Locomotion = 'drift';
  readonly params: DriftParams;
  /** Where along its path the observer is (units of travel), and how wide and how simple the path is now. */
  path = 0;
  width = 1;
  order = 1;
  /** How much the observer is moving along its path (0..1): it leans into a bend only while it goes round it. */
  moving = 0;
  private fresh = true;

  constructor(params: Partial<DriftParams> = {}) { this.params = { ...DRIFT, ...params }; }

  /** The path's offset across the corridor at `s` (units), before the corridor's bound; and its slope (units per unit). */
  offset(s: number): number {
    const p = this.params, w = (2 * Math.PI) / Math.max(1, p.wavelength);
    return p.amplitude * this.width * (Math.sin(w * s) + 0.35 * (1 - this.order) * Math.sin(2.7 * w * s + 1));
  }

  step(input: Readonly<MotionInput>, weight: number, _rest: Readonly<MotionPose>, out: MotionPose): number {
    const h = step(input.dt), view = input.view, p = this.params;
    const width = 1 + p.turbulence * clamp(finite(view.disorder), 0, 1), order = clamp(finite(view.coherence), 0, 1);
    const moving = clamp(4 * finite(view.speed), 0, 1);
    if (this.fresh) { this.width = width; this.order = order; this.moving = moving; this.fresh = false; }
    this.width = follow(this.width, width, k(h, 3));
    this.order = follow(this.order, order, k(h, 3));
    this.moving = follow(this.moving, moving, k(h, 1));
    this.path += Math.max(0, finite(view.dTravel)) * p.stride;
    if (this.path > 1e6) this.path -= 1e6 - (1e6 % Math.max(1, p.wavelength));
    const x = clamp(this.offset(this.path), -p.corridor, p.corridor);
    const ahead = clamp(this.offset(this.path + p.yaw), -p.corridor, p.corridor);
    out.x += weight * x; out.tx += weight * ahead;
    out.roll += weight * -p.bank * (ahead - x) * this.moving;
    return 0;
  }

  reset(): void { this.width = this.order = 1; this.moving = 0; this.fresh = true; }
}

// ---- the rig ----

/** How the rig follows and bounds the pose: frequencies (Hz) of the observer, the target and the lens; the most it lets them go from rest. */
export interface RigLimits {
  /** Natural frequencies of the bodies that follow the observer, the target and the lens (Hz): lower is calmer. */
  position: number;
  target: number;
  lens: number;
  /** The most the observer and the target may be from their rest (units, per axis): what bounds the acceleration. */
  reach: number;
  /** Bounds of the lens (degrees added to the scene's) and of the roll (rad). */
  fov: readonly [number, number];
  roll: number;
}
export const RIG_LIMITS: Readonly<RigLimits> = { position: 0.25, target: 0.3, lens: 0.2, reach: 6, fov: [-8, 10], roll: 0.12 };

/** A profile of a rig, and its weight (multiplied by the profile's own presence, when it has one). */
export interface RigEntry { profile: LocomotionProfile; weight: number }

/**
 * The observer of one world: its profiles summed on the rest pose, followed and bounded. Allocation-free per frame.
 * After `step`, `advance` is the distance the scene moves past the observer this frame (units) and `speed` that rate.
 */
export class CameraRig {
  readonly rest: MotionPose;
  readonly limits: RigLimits;
  /** The pose the profiles ask for this frame, and the pose shown (followed). */
  readonly target = createPose();
  readonly pose = createPose();
  advance = 0;
  speed = 0;
  /** Weight of each entry this frame (its weight × its presence). */
  readonly weights: Float32Array;
  private readonly bodies: DampedOscillator[];
  private fresh = true;
  private lastFov = NaN;

  constructor(readonly entries: readonly RigEntry[], rest: Partial<MotionPose> = {}, limits: Partial<RigLimits> = {}) {
    this.rest = { ...createPose(), ...rest };
    this.limits = { ...RIG_LIMITS, ...limits };
    this.weights = new Float32Array(entries.length);
    const l = this.limits, body = (hz: number, x: number): DampedOscillator => new DampedOscillator(2 * Math.PI * hz, 1, x);
    const r = this.rest;
    this.bodies = [body(l.position, r.x), body(l.position, r.y), body(l.position, r.z), body(l.target, r.tx), body(l.target, r.ty), body(l.target, r.tz), body(l.lens, 0), body(l.lens, 0)];
    Object.assign(this.pose, r);
  }

  get locomotion(): Locomotion[] { return this.entries.map((e) => e.profile.kind); }

  /** One frame: every profile on the same input, the sum bounded and followed. Must not allocate. */
  step(input: Readonly<MotionInput>): void {
    const h = step(input.dt), r = this.rest, l = this.limits, t = this.target;
    Object.assign(t, r); t.fov = 0; t.roll = 0;
    let hold = 1, advance = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const { profile, weight } = this.entries[i];
      const w = weight * (profile.presence ? clamp(profile.presence(input), 0, 1) : 1);
      this.weights[i] = w;
      advance += profile.step(input, w, r, t);
      if (profile.hold) hold *= 1 - clamp(profile.hold * w, 0, 1);
    }
    // Bounded: the observer and its target stay within reach of their rest, the lens and the roll within theirs.
    t.x = clamp(finite(t.x), r.x - l.reach, r.x + l.reach); t.y = clamp(finite(t.y), r.y - l.reach, r.y + l.reach); t.z = clamp(finite(t.z), r.z - l.reach, r.z + l.reach);
    t.tx = clamp(finite(t.tx), r.tx - l.reach, r.tx + l.reach); t.ty = clamp(finite(t.ty), r.ty - l.reach, r.ty + l.reach); t.tz = clamp(finite(t.tz), r.tz - l.reach, r.tz + l.reach);
    t.fov = clamp(finite(t.fov), l.fov[0], l.fov[1]); t.roll = clamp(finite(t.roll), -l.roll, l.roll);
    this.advance = finite(advance) * hold;
    this.speed = h > 0 ? this.advance / h : 0;
    const b = this.bodies, p = this.pose;
    if (this.fresh) {
      // The first frame takes the pose as it is asked: a world that is mounted does not fly its observer in.
      b[0].reset(t.x); b[1].reset(t.y); b[2].reset(t.z); b[3].reset(t.tx); b[4].reset(t.ty); b[5].reset(t.tz); b[6].reset(t.fov); b[7].reset(t.roll);
      this.fresh = false;
    } else {
      b[0].step(h, t.x); b[1].step(h, t.y); b[2].step(h, t.z); b[3].step(h, t.tx); b[4].step(h, t.ty); b[5].step(h, t.tz); b[6].step(h, t.fov); b[7].step(h, t.roll);
    }
    p.x = b[0].x; p.y = b[1].x; p.z = b[2].x; p.tx = b[3].x; p.ty = b[4].x; p.tz = b[5].x; p.fov = b[6].x; p.roll = b[7].x;
  }

  /** Speed of the observer (units/s) and of its aim: the tools read them. */
  get motion(): number {
    const b = this.bodies;
    return Math.hypot(b[0].v, b[1].v, b[2].v);
  }

  /** Places `camera` at the pose; `fov` is the scene's own field of view (degrees). Must not allocate. */
  apply(camera: PerspectiveCamera, fov: number): void {
    const p = this.pose;
    camera.position.set(p.x, p.y, p.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(p.tx, p.ty, p.tz);
    if (p.roll !== 0) camera.rotateZ(p.roll);
    const lens = fov + p.fov;
    if (lens !== this.lastFov) { camera.fov = lens; camera.updateProjectionMatrix(); this.lastFov = lens; }
  }

  /** The next frame takes the pose as it is asked, and every profile starts from the world as it is. */
  reset(): void {
    this.fresh = true; this.lastFov = NaN;
    for (const e of this.entries) e.profile.reset();
  }
}
