import type { AudioEvent, EventCursor, EventStream } from '../../experience/EventStream';
import { unit } from '../../experience/types';
import { REST_WORLD } from '../../world/WorldState';
import type { WorldView } from '../../world/WorldView';
import { architecture, createTopology, crackOf, type TunnelTopology } from './topology';

/*
 * The tunnel's motion coordinator: Balanced.
 *
 * Every transformation of the tunnel answers the world by itself, and each is
 * right by itself. Together, at full strength, they stop being readable: the
 * wall twists, bends, opens, turns and breathes at once. This does not remove
 * any of them and simulates nothing of its own: it takes the targets the scene
 * has just computed from the world (the same ones it would show) and decides
 * how much of each is shown now, in three layers.
 *
 *   A  primary     travel, turn, the camera's depth          continuous: followed, never held back by B or C
 *   B  secondary   lows → pulse and pressure (untouched)      one register, one kind of motion; slow where a
 *                  mids → torsion, bend, the section's form   change of form would read as flicker
 *                  highs → surface detail and light (untouched)
 *   C  events      the wall opening, panels, rings, facets    only when the world really strains or an event
 *                                                             stands out; one at a time, with hysteresis
 *
 * The motion budget is not a sum held constant: while C is using the picture
 * (`occupancy`), the invasive parts of B (torsion, bend, the section's depth,
 * the oval, the waveguide) give way progressively; the lows keep their whole
 * response, and the travel is never touched.
 *
 * State: a few followers and one gate, all exact for an input held through a
 * frame (so the same at any frame rate), all at rest when the world is. The
 * accents of C are ages of dated events, read with a cursor. `balance` 0 is the
 * tunnel as it was: the scene then does not come here at all.
 */

/** The targets of one frame, as the scene computes them from the world and as they are shown. One reused object each. */
export interface TunnelMotion {
  /** Forward travel and turn of the world in this frame (world units, rad). */
  advance: number;
  turn: number;
  /** Radius of the wall (units) and field of view (degrees). */
  radius: number;
  fov: number;
  /** Lows: depth and lobes of the section, height of the rings sent down the tunnel. */
  shape: number;
  lobes: number;
  ring: number;
  /** Mids: the lead's ring lines (depth, cycles), torsion, bend, lean, the oval squeeze. */
  wobble: number;
  cycles: number;
  twist: number;
  bend: number;
  lateral: number;
  oval: number;
  /** The shared modal field in the wall. */
  waveguide: number;
  /** Highs and light: the fine grid, the corrugation, the sparks, the wall's own light. */
  detail: number;
  ripple: number;
  sparks: number;
  light: number;
}

export const createMotion = (): TunnelMotion => ({
  advance: 0, turn: 0, radius: 0, fov: 0, shape: 0, lobes: 0, ring: 0, wobble: 0, cycles: 0, twist: 0, bend: 0, lateral: 0, oval: 0, waveguide: 0,
  detail: 0, ripple: 0, sparks: 0, light: 0,
});

/** A: the travel's speed and the turn follow the world over these times (s): a kick surges the tunnel, it does not jerk it. */
const TRAVEL_TAU = 0.2;
const TURN_TAU = 0.3;
const FOV_TAU = 0.6;
/** B: how fast each part of the form follows (s). What changes the number of things on the wall is slow. */
const SHAPE_TAU = 0.2;
const COUNT_TAU = 1.2;
const TWIST_TAU = 0.6;
const BEND_TAU = 0.8;
const LEAN_TAU = 0.4;
/** The most torsion shown (turns per unit of depth) and the range of the radius (× the radius of the corridor at rest). */
const TWIST_MAX = 0.028;
const RADIUS = [0.7, 1.4];
/** C: what the wall reads of the world follows over these times (s). */
const TENSION_TAU = 0.3;
const DISORDER_TAU = 0.5;
const SPIN_TAU = 0.5;
/** Below this spin the rings turn against each other less and less, instead of flipping with its sign. */
const SPIN_SOFT = 0.12;
/** The wall opens once its crack drive passes OPEN and closes again only below CLOSE; it takes this long to open and to close (s). */
const OPEN = 0.3;
const CLOSE = 0.12;
const OPEN_TIME = 0.6;
const CLOSE_TIME = 1.4;
/** An impact holds the rings apart only if it stands out this far, and not sooner than this after the last one (s); it lasts this long (s). */
const ACCENT_AT = 0.7;
const ACCENT_EVERY = 2;
const ACCENT_TIME = 0.5;
/** How much of each invasive part of B gives way while C fills the picture. */
const YIELD = { twist: 0.6, bend: 0.5, shape: 0.35, oval: 0.5, waveguide: 0.4, roll: 0.5 };

/** Closer than this to what it follows, a follower is there: what the world has stopped asking for stops, it does not fade for ever. */
const ARRIVED = 1e-5;
const follow = (y: number, x: number, k: number): number => (Math.abs(y - x) < ARRIVED ? x : x + (y - x) * k);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const finite = (x: number): number => (Number.isFinite(x) ? x : 0);

/**
 * Development switch: `balance` set replaces the preset's (0: the tunnel as it was, 1: balanced), to compare the two
 * on the same sound. Read in development builds only; nothing in the product sets it and nothing of it is persisted.
 */
export const tunnelLab: { balance: number | null } = { balance: null };

export class TunnelMotionCoordinator {
  /** What is shown this frame. */
  readonly motion = createMotion();
  readonly topology = createTopology();
  /** The balanced targets as they are being followed: what `motion` is, wholly or in part. */
  private readonly held = createMotion();
  /** How far C is using the picture now (0..1), how far the wall is allowed to open (0..1), and the accent held (0..1). */
  occupancy = 0;
  aperture = 0;
  accent = 0;
  /** What is left of the camera's roll while C fills the picture (× the roll the scene computes; 1: all of it). */
  rollShare = 1;
  /** Accents taken and refused (below the bar, or too soon) since the last reset: the tools read them. */
  accents = 0;
  refused = 0;
  private fresh = true;
  private open = false;
  /** The occupancy of the frame before. */
  private occupied = 0;
  private speed = 0;
  private turnRate = 0;
  private tension = 0;
  private disorder = 0;
  private spin = 0;
  private accentTime = -Infinity;
  private accentLevel = 0;
  private lastTime = -Infinity;
  private readonly cursor: EventCursor = { time: -Infinity, seq: 0 };
  private heard = 0;
  /** `radius`: that of the corridor at rest (units), which the range of the wall's radius is a share of. */
  constructor(private readonly radius: number) {}

  private readonly visit = (event: AudioEvent): void => {
    if (event.type !== 'impact' && event.type !== 'drop') return;
    const weight = unit(finite(event.significance));
    // One accent at a time: an event that does not stand out, or comes too soon after one that did, opens nothing.
    if (weight < ACCENT_AT || event.audioTime - this.accentTime < ACCENT_EVERY || !Number.isFinite(event.audioTime)) { this.refused++; return; }
    this.accentTime = event.audioTime; this.accentLevel = unit(0.5 + 0.5 * (weight - ACCENT_AT) / (1 - ACCENT_AT)); this.accents++;
  };

  /**
   * One frame. `raw`: the targets the scene computed from the world, untouched (they are the tunnel as it was);
   * `balance` 0..1: how far they are coordinated. `events`: the session's dated events with the audio time heard
   * (`now`), or none without a clock. Returns `motion`; `topology` is filled beside it. Must not allocate.
   */
  step(dt: number, view: Readonly<WorldView>, raw: Readonly<TunnelMotion>, rawTopology: Readonly<TunnelTopology>, balance: number, events?: EventStream, now = 0): TunnelMotion {
    const m = this.held, t = this.topology, b = unit(finite(balance)), h = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.25) : 0;
    const world = view.world;
    // No clock, or another session: nothing of the last frames holds. The next live frame starts from the world as it is.
    if (world === REST_WORLD || world.time < this.lastTime - 1) this.reset();
    this.lastTime = world === REST_WORLD ? -Infinity : world.time;
    if (events && world !== REST_WORLD) {
      // A scene mounted into a running session starts from now: what was heard before it was there opens nothing in it.
      if (this.cursor.epoch === undefined) { this.cursor.time = now; this.cursor.seq = events.seq; this.cursor.epoch = events.epoch; }
      this.heard = now;
      events.forEachHeard(this.cursor, now, this.visit);
    }
    const tension = unit(finite(view.tension)), disorder = unit(finite(view.disorder)), spin = clamp(finite(view.spin), -1, 1);
    const speed = h > 0 ? raw.advance / h : 0, turnRate = h > 0 ? raw.turn / h : 0;
    if (this.fresh) {
      // The first frame takes the world's momentum and the targets as they are: a scene that is mounted does not fade its motion in.
      Object.assign(m, raw);
      this.speed = speed; this.turnRate = turnRate; this.tension = tension; this.disorder = disorder; this.spin = spin;
      this.open = crackOf(tension, disorder) > OPEN; this.aperture = this.open ? 1 : 0;
      this.occupied = this.occupancy = unit(0.9 * Math.max(rawTopology.gapAxial / 0.36, rawTopology.gapAngular / 0.28, rawTopology.lift / 0.2) * this.aperture + 0.5 * rawTopology.release);
      this.fresh = false;
    }

    // ---- A: primary motion. The exact answer of a follower to a speed held through the frame, and its integral. ----
    const travel = Math.exp(-h / TRAVEL_TAU), turning = Math.exp(-h / TURN_TAU);
    m.advance = Math.max(0, speed * h + (this.speed - speed) * TRAVEL_TAU * (1 - travel));
    this.speed = follow(this.speed, speed, travel);
    m.turn = turnRate * h + (this.turnRate - turnRate) * TURN_TAU * (1 - turning);
    this.turnRate = follow(this.turnRate, turnRate, turning);
    m.fov = follow(m.fov, raw.fov, Math.exp(-h / FOV_TAU));

    // ---- C: special events. What the wall reads of the world, the gate that lets it open, the accent of an event that stands out. ----
    this.tension = follow(this.tension, tension, Math.exp(-h / TENSION_TAU));
    this.disorder = follow(this.disorder, disorder, Math.exp(-h / DISORDER_TAU));
    this.spin = follow(this.spin, spin, Math.exp(-h / SPIN_TAU));
    const drive = crackOf(this.tension, this.disorder);
    if (drive > OPEN) this.open = true; else if (drive < CLOSE) this.open = false;
    this.aperture = this.open ? Math.min(1, this.aperture + h / OPEN_TIME) : Math.max(0, this.aperture - h / CLOSE_TIME);
    const release = rawTopology.release, age = this.heard - this.accentTime;
    // While a release is passing it is the event: an accent beside it would be a second one.
    this.accent = age >= 0 && Number.isFinite(age) ? this.accentLevel * Math.exp(-age / ACCENT_TIME) * (1 - unit(2 * release)) : 0;
    const magnitude = Math.abs(this.spin);
    architecture(t, this.tension, this.disorder, magnitude, this.spin / (magnitude + SPIN_SOFT), this.accent, view, this.aperture);
    this.occupancy = unit(0.9 * Math.max(t.gapAxial / 0.36, t.gapAngular / 0.28, t.lift / 0.2) + 0.5 * release);

    // ---- B: the secondary response. Lows and highs pass; the mids and the form follow, and give way to C. ----
    // What follows gives way by the occupancy of the middle of the frame: the picture is then the same at any frame rate.
    const room = 0.5 * (this.occupied + this.occupancy), count = Math.exp(-h / COUNT_TAU), form = Math.exp(-h / SHAPE_TAU);
    this.occupied = this.occupancy;
    m.radius = clamp(raw.radius, RADIUS[0] * this.radius, RADIUS[1] * this.radius);
    m.ring = raw.ring;
    m.shape = follow(m.shape, raw.shape * (1 - YIELD.shape * room), form);
    m.lobes = follow(m.lobes, raw.lobes, count);
    m.wobble = follow(m.wobble, raw.wobble, form);
    m.cycles = follow(m.cycles, raw.cycles, count);
    m.twist = follow(m.twist, clamp(raw.twist, -TWIST_MAX, TWIST_MAX) * (1 - YIELD.twist * room), Math.exp(-h / TWIST_TAU));
    m.bend = follow(m.bend, raw.bend * (1 - YIELD.bend * room), Math.exp(-h / BEND_TAU));
    m.lateral = follow(m.lateral, raw.lateral, Math.exp(-h / LEAN_TAU));
    m.oval = follow(m.oval, raw.oval * (1 - YIELD.oval * room), form);
    m.waveguide = raw.waveguide * (1 - YIELD.waveguide * this.occupancy);
    this.rollShare = 1 - YIELD.roll * this.occupancy * b;
    m.detail = raw.detail; m.ripple = raw.ripple; m.sparks = raw.sparks; m.light = raw.light;

    // What is shown: the balanced tunnel, or part of the way to it from the tunnel as it was.
    const shown = this.motion;
    for (const key of MOTION_KEYS) {
      if (!Number.isFinite(m[key])) m[key] = REST_MOTION[key];
      const value = b < 1 ? raw[key] + (m[key] - raw[key]) * b : m[key];
      shown[key] = Number.isFinite(value) ? value : REST_MOTION[key];
    }
    if (b < 1) for (const key of TOPOLOGY_KEYS) t[key] = rawTopology[key] + (t[key] - rawTopology[key]) * b;
    return shown;
  }

  /** Nothing of the last frames holds: the next one starts from the world as it is. */
  reset(): void {
    Object.assign(this.motion, REST_MOTION); Object.assign(this.held, REST_MOTION); Object.assign(this.topology, REST_TOPOLOGY);
    this.fresh = true; this.open = false;
    this.speed = this.turnRate = this.tension = this.disorder = this.spin = this.occupancy = this.occupied = this.aperture = this.accent = this.accentLevel = 0;
    this.rollShare = 1;
    this.accentTime = this.lastTime = -Infinity;
    this.accents = this.refused = 0;
  }
}

const REST_MOTION = createMotion();
const REST_TOPOLOGY = createTopology();
const MOTION_KEYS = Object.keys(REST_MOTION) as (keyof TunnelMotion)[];
/** The front and the strength of a release are the world's own facts: every other part of the architecture is coordinated. */
const TOPOLOGY_KEYS = (Object.keys(REST_TOPOLOGY) as (keyof TunnelTopology)[]).filter((key) => key !== 'front' && key !== 'release');
