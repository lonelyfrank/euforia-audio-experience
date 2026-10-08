import { Rng, seedOf } from '../../show/rng';
import { canJoin, canSpan, compatibility, JOINT_RANGE, JOINT_REST, makeBond, remembered, stepBonds, stepMemory, type BondEvents } from './BondSystem';
import type { Population } from './StructuralIdentity';
import { readLifecycle, stabilityOf, stepCohesion, stepRegime, stepRoles } from './StructuralLifecycle';
import { StructuralState } from './StructuralState';
import {
  createTuning, DEFAULT_STRUCTURE, finite, JOINT, LIFECYCLE, MAX_JOINTS, MEMORY_SLOTS, ROLE, ROLE_COUNT, SPAN, unit,
  type StructuralConfig, type StructuralEnvironment,
} from './StructuralTypes';

/*
 * The structural system: elements, their bonds and one fixed-step simulation.
 *
 *   acceleration = drag · (flow − velocity) · coupling / mass      the medium: flow, pressure, potential, vortices
 *                + fronts / mass                                   the world's events passing through
 *                + potential                                       the world's pressure, and the pull that keeps its body one
 *                + bonds + braces                                  structural constraints
 *                + memory                                          the pull back to a lost partner
 *
 * The medium decides where an element goes; its resonance decides how it
 * answers where it is (its swing, its light, the load on its bonds): the
 * sound never writes a position. The step is fixed and counted on the clock
 * it is given (the heard audio time), so what forms and what breaks does not
 * depend on the frame rate; neighbourhoods are found in a spatial grid of
 * bounded cells, so nothing is ever compared with everything.
 *
 * CPU side by design: the bookkeeping of a sparse, changing topology for a
 * bounded number of elements. Every array is allocated once.
 */

/** Steps simulated per call at most: a stall is skipped, not caught up. */
const MAX_STEPS = 8;
/**
 * Cadences, in steps of the simulation's own clock (never in frames): the medium is sampled every other step, an
 * element visits its neighbourhood (regimes, cohesion, roles, bond formation) every sixth, the loops are counted every twelfth.
 */
const MEDIUM_EVERY = 2;
const NEIGHBOUR_EVERY = 6;
const BOOK_EVERY = 12;
/** The spatial grid: buckets (a power of two), elements kept per bucket, and neighbours one element takes into account. */
const CELLS = 2048;
const CELL_CAP = 8;
const NEAR_MAX = 20;
/** A bond is made when the two elements suit each other at least this much; a remembered partner counts for more. */
const FORMS_AT = 0.2;
const MEMORY_GAIN = 1.5;
const LOYALTY = 1.6;
/** What making a bond takes out of an element's cohesion: the next one has to settle again, so structures grow step by step. */
const BOND_COST = 0.6;
/** A wire is made between elements from this share of its length apart to that one. */
const SPAN_NEAR = 0.5;
const SPAN_FAR = 1.35;
/** Force with which settled, compatible neighbours draw together (per unit mass, units/s²). */
const GATHER = 0.5;
/** How long a fracture stays in an element (s), and the harmonics of a wire on the frequency axis (one octave is a tenth of it). */
const SHOCK_TAU = 2.5;
const OCTAVE = 0.1;
/** Bounds no state passes, whatever the environment. */
const V_MAX = 12;
const R_MAX = 8;
/** Pitch difference at which two neighbours no longer count as resonating alike. */
const AGREE = 0.15;
/** Below this speed an element has no direction of its own (units/s). */
const STILL = 0.02;

export interface StructuralStats {
  elements: number;
  /** Shares of the elements with no bond / with at least one. */
  free: number;
  structured: number;
  /** Elements whose leading role is node / fragment. */
  nodes: number;
  fragments: number;
  bonds: number;
  spans: number;
  joints: number;
  /** Closed polygons. */
  loops: number;
  /** Means over the elements (stress over the bonds). */
  order: number;
  temperature: number;
  stress: number;
  excitation: number;
  bondStrength: number;
  kinetic: number;
  /** Bonds made and broken since the last reset. */
  formed: number;
  fractures: number;
  /** Steps of the last call, states repaired (non-finite) since the last reset. */
  steps: number;
  repairs: number;
  /** CPU time per frame, smoothed (ms): the whole simulation, and its bookkeeping part (grid, neighbourhoods, loops). Only while `profile` is on. */
  stepMs: number;
  bookMs: number;
}

export interface PolygonOptions {
  x?: number;
  y?: number;
  z?: number;
  /** Rotation in its plane (rad). */
  turn?: number;
  /** Made whole at once (a test fixture, a world that starts with it) instead of left to form. */
  bonded?: boolean;
  /** Its matter: one narrow population, so its wires resonate together. */
  population?: Population;
}

const flowOut = new Float64Array(3);
const pushOut = new Float64Array(3);

export class StructuralSystem {
  readonly config: StructuralConfig;
  readonly state: StructuralState;
  /** Development overrides; the product leaves them as created. */
  readonly tuning = createTuning();
  readonly stats: StructuralStats = {
    elements: 0, free: 1, structured: 0, nodes: 0, fragments: 0, bonds: 0, spans: 0, joints: 0, loops: 0, order: 0, temperature: 0, stress: 0,
    excitation: 0, bondStrength: 0, kinetic: 0, formed: 0, fractures: 0, steps: 0, repairs: 0, stepMs: 0, bookMs: 0,
  };
  /** The clock the simulation has reached, and how far the last call's time is past it (s): what is presented is extrapolated by it. */
  time = NaN;
  alpha = 0;
  /** Measure CPU time (development). */
  profile = false;
  private readonly acc: Float64Array;
  /** The medium at each element as last sampled: its velocity, the fronts' acceleration, and the drag's decay and gain over a step. */
  private readonly flow: Float32Array;
  private readonly push: Float32Array;
  private readonly decay: Float32Array;
  private readonly gain: Float32Array;
  private readonly cells = new Int32Array(CELLS * CELL_CAP);
  private readonly cellCount = new Uint8Array(CELLS);
  private readonly mark: Int32Array;
  /** The neighbour each settled element drifts towards (−1: none), as found at its last visit. */
  private readonly mate: Int32Array;
  private tick = 0;
  private stepIndex = 0;
  private structures = 0;
  private readonly events: BondEvents = { broken: 0, fractures: 0 };
  private bookTime = 0;

  constructor(config: Partial<StructuralConfig> = {}) {
    const c = this.config = { ...DEFAULT_STRUCTURE, ...config };
    c.capacity = Math.max(2, Math.floor(finite(c.capacity, DEFAULT_STRUCTURE.capacity)));
    c.step = Math.min(1 / 30, Math.max(1 / 480, finite(c.step, DEFAULT_STRUCTURE.step)));
    c.maxJoints = Math.min(MAX_JOINTS, Math.max(1, Math.floor(c.maxJoints)));
    c.maxSides = Math.min(12, Math.max(3, Math.floor(c.maxSides)));
    c.neighbourhood = Math.max(0.05, c.neighbourhood);
    this.state = new StructuralState(c);
    this.acc = new Float64Array(c.capacity * 3);
    this.flow = new Float32Array(c.capacity * 3); this.push = new Float32Array(c.capacity * 3);
    this.decay = new Float32Array(c.capacity); this.gain = new Float32Array(c.capacity);
    this.mark = new Int32Array(c.capacity).fill(-1);
    this.mate = new Int32Array(c.capacity).fill(-1);
  }

  /**
   * Adds free matter of one population, scattered through a shell of the
   * world (between two radii, flattened towards its plane by `flat`). The
   * same seed scatters it the same way. Returns how many elements fitted.
   */
  addPopulation(count: number, population: Readonly<Population>, inner: number, outer: number, flat = 0.5): number {
    const s = this.state, rng = new Rng(seedOf(this.config.seed, population.id, 0x73747275));
    let added = 0;
    for (let k = 0; k < count; k++) {
      const z = 2 * rng.next() - 1, angle = 2 * Math.PI * rng.next(), ring = Math.sqrt(1 - z * z);
      // Uniform in the volume of the shell.
      const r = Math.cbrt(inner * inner * inner + (outer * outer * outer - inner * inner * inner) * rng.next());
      if (s.add(this.config.seed, population, ring * Math.cos(angle) * r, ring * Math.sin(angle) * r, z * r * (1 - flat), this.config.reach) < 0) break;
      added++;
    }
    return added;
  }

  /**
   * Seeds the matter of a regular polygon: `sides` wires (two elements each)
   * laid out where its sides would be, in the plane z = const, each end
   * remembering the end it belongs with. Left unbonded they are loose matter
   * that tends to this figure and forms it when the world lets it; `bonded`
   * makes it whole at once. Returns the index of its first element, or −1
   * when the pool has no room for it.
   */
  seedPolygon(sides: number, radius: number, options: PolygonOptions = {}): number {
    const s = this.state, n = Math.min(this.config.maxSides, Math.max(3, Math.round(finite(sides, 4))));
    if (s.count + 2 * n > s.capacity) return -1;
    const { x = 0, y = 0, z = 0, turn = 0, bonded = false } = options;
    const population = options.population ?? { id: 200 + this.structures, centre: 0.42, spread: 0.03 };
    const first = s.count, kin = this.structures++, side = 2 * radius * Math.sin(Math.PI / n), inset = 0.5 * JOINT_REST / Math.max(side, 1e-6);
    for (let k = 0; k < n; k++) {
      const a = turn + 2 * Math.PI * k / n, b = turn + 2 * Math.PI * (k + 1) / n;
      const ax = x + radius * Math.cos(a), ay = y + radius * Math.sin(a), bx = x + radius * Math.cos(b), by = y + radius * Math.sin(b);
      for (let end = 0; end < 2; end++) {
        const t = end === 0 ? inset : 1 - inset, e = s.add(this.config.seed, population, ax + (bx - ax) * t, ay + (by - ay) * t, z, this.config.reach);
        s.sides[e] = n; s.reach[e] = side - JOINT_REST; s.kin[e] = kin;
      }
    }
    for (let k = 0; k < n; k++) {
      const e0 = first + 2 * k, e1 = e0 + 1, next = first + 2 * ((k + 1) % n);
      this.remember(e0, e1, SPAN, side - JOINT_REST); this.remember(e1, e0, SPAN, side - JOINT_REST);
      this.remember(e1, next, JOINT, JOINT_REST); this.remember(next, e1, JOINT, JOINT_REST);
    }
    if (bonded) {
      for (let k = 0; k < n; k++) {
        const e0 = first + 2 * k, e1 = e0 + 1, next = first + 2 * ((k + 1) % n);
        makeBond(s, e0, e1, true, side - JOINT_REST);
        makeBond(s, e1, next, false, JOINT_REST);
      }
      for (let e = first; e < first + 2 * n; e++) { s.cohesion[e] = 1; s.order[e] = 0.8; }
      this.book();
    }
    return first;
  }

  /**
   * Advances the simulation to `now` (s) in fixed steps: the heard audio time
   * when there is one. The first call, or a clock that went back (another
   * session), only sets the clock. Returns the steps taken.
   */
  advance(now: number, env: Readonly<StructuralEnvironment>): number {
    if (!Number.isFinite(now)) return 0;
    const h = this.config.step;
    if (Number.isNaN(this.time) || now < this.time - 1) { this.time = now; this.alpha = 0; this.stats.steps = 0; return 0; }
    if (now - this.time > MAX_STEPS * h) this.time = now - MAX_STEPS * h;
    const steps = Math.max(0, Math.floor((now - this.time) / h + 1e-9));
    const started = this.profile ? performance.now() : 0;
    this.bookTime = 0;
    for (let k = 0; k < steps; k++) { this.step(env); this.time += h; }
    this.alpha = Math.max(0, now - this.time);
    this.ring(env);
    this.stats.steps = steps;
    if (this.profile) {
      this.stats.stepMs += (performance.now() - started - this.stats.stepMs) * 0.05;
      this.stats.bookMs += (this.bookTime - this.stats.bookMs) * 0.05;
    }
    return steps;
  }

  /** One fixed step. */
  step(env: Readonly<StructuralEnvironment>): void {
    const s = this.state, h = this.config.step, acc = this.acc, p = s.position, v = s.velocity, U = this.flow, tuning = this.tuning;
    const resonance = env.resonance, hear = Math.max(0, finite(tuning.resonanceCoupling, 1)), carry = Math.max(0, finite(tuning.environmentCoupling, 1));
    const drag = Math.min(20, Math.max(0.2, finite(env.drag, 2)));
    // Micro response: what each element takes of the sound, by its own resonance.
    for (let i = 0; i < s.count; i++) {
      if (resonance?.live) {
        const r = resonance.at(s.f0[i], s.q[i]);
        s.vibration[i] = r[0] * hear; s.excitation[i] = unit(r[1] * hear); s.micro[i] = unit(r[2] * hear);
      } else s.vibration[i] = s.excitation[i] = s.micro[i] = 0;
    }
    acc.fill(0, 0, s.count * 3);
    stepBonds(s, acc, env, tuning, h, this.events);
    stepMemory(s, acc, env, this.config, h);
    this.gather(env);
    // Macro motion: the medium carries each element as far as its matter lets it.
    const push = this.push, decay = this.decay, gains = this.gain, alive = unit(3 * env.energy);
    if (this.stepIndex % MEDIUM_EVERY === 0) {
      for (let i = 0; i < s.count; i++) {
        const at = i * 3, mass = s.mass[i];
        env.flow(p[at], p[at + 1], p[at + 2], flowOut);
        env.push(p[at], p[at + 1], p[at + 2], s.f0[i], pushOut);
        U[at] = finite(flowOut[0]) * carry; U[at + 1] = finite(flowOut[1]) * carry; U[at + 2] = finite(flowOut[2]) * carry;
        push[at] = finite(pushOut[0]) * carry / mass; push[at + 1] = finite(pushOut[1]) * carry / mass; push[at + 2] = finite(pushOut[2]) * carry / mass;
        // The world's potential holds matter in its body only while the world is alive: silence leaves everything where it is.
        if (alive > 0) {
          env.hold(p[at], p[at + 1], p[at + 2], s.home[i], pushOut);
          push[at] += finite(pushOut[0]) * carry * alive; push[at + 1] += finite(pushOut[1]) * carry * alive; push[at + 2] += finite(pushOut[2]) * carry * alive;
        }
        const rate = s.coupling[i] * drag / mass;
        decay[i] = Math.exp(-rate * h); gains[i] = (1 - decay[i]) / rate;
      }
    }
    const shockDecay = Math.exp(-h / SHOCK_TAU);
    for (let i = 0; i < s.count; i++) {
      const at = i * 3, ux = U[at], uy = U[at + 1], uz = U[at + 2], k = decay[i], gain = gains[i];
      const ax = acc[at] + push[at], ay = acc[at + 1] + push[at + 1], az = acc[at + 2] + push[at + 2];
      // The exact answer to the drag over the step, for a flow and a force held through it.
      let vx = ux + (v[at] - ux) * k + ax * gain, vy = uy + (v[at + 1] - uy) * k + ay * gain, vz = uz + (v[at + 2] - uz) * k + az * gain;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (speed > V_MAX) { vx *= V_MAX / speed; vy *= V_MAX / speed; vz *= V_MAX / speed; }
      let x = p[at] + vx * h, y = p[at + 1] + vy * h, z = p[at + 2] + vz * h;
      const r = Math.sqrt(x * x + y * y + z * z);
      if (r > R_MAX) { x *= R_MAX / r; y *= R_MAX / r; z *= R_MAX / r; }
      if (!(Number.isFinite(x + y + z + vx + vy + vz))) {
        // Never propagate a broken state: the element stays where it last was, at rest.
        x = finite(p[at]); y = finite(p[at + 1]); z = finite(p[at + 2]); vx = vy = vz = 0;
        this.stats.repairs++;
      }
      p[at] = x; p[at + 1] = y; p[at + 2] = z; v[at] = vx; v[at + 1] = vy; v[at + 2] = vz;
      s.shock[i] *= shockDecay;
      s.age[i] += h;
      s.energy[i] = 0.5 * s.mass[i] * (vx * vx + vy * vy + vz * vz) + 0.5 * s.excitation[i] * s.excitation[i];
    }
    this.stats.fractures = this.events.fractures;
    this.stepIndex++;
    const started = this.profile ? performance.now() : 0;
    // One sixth of the elements look round them at each step: the same cadence for each, no step heavier than another.
    this.neighbourhoods(env, h * NEIGHBOUR_EVERY, this.stepIndex % NEIGHBOUR_EVERY);
    if (this.stepIndex % BOOK_EVERY === 0) this.book();
    if (this.profile) this.bookTime += performance.now() - started;
  }

  /**
   * A blow at a point (development and tests): velocity given to the matter
   * round it, falling with distance. An impulse, never a displacement.
   */
  strike(x: number, y: number, z: number, strength: number, radius = 1): void {
    const s = this.state, p = s.position, v = s.velocity;
    for (let i = 0; i < s.count; i++) {
      const dx = p[i * 3] - x, dy = p[i * 3 + 1] - y, dz = p[i * 3 + 2] - z, d = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-4);
      const k = strength * Math.exp(-(d / radius) * (d / radius)) / (d * s.mass[i]);
      v[i * 3] += dx * k; v[i * 3 + 1] += dy * k; v[i * 3 + 2] += dz * k;
    }
  }

  /** A new audio session: the matter stays where it is and as it is; only the clock is forgotten. */
  reset(): void {
    this.time = NaN; this.alpha = 0;
  }

  /** Removes all matter and all bonds (the pools stay). */
  clear(): void {
    this.state.clear();
    this.mate.fill(-1);
    this.structures = 0; this.stepIndex = 0; this.events.fractures = 0;
    this.stats.formed = this.stats.fractures = this.stats.repairs = 0;
    this.book();
  }

  /**
   * Neighbourhood force: settled, compatible matter draws together. An element
   * drifts towards the neighbour it could bond with, the more so the more
   * ordered and the colder it is, and only in a living world: this is what
   * lets wires find each other's ends and chains close.
   */
  private gather(env: Readonly<StructuralEnvironment>): void {
    const alive = unit(3 * env.energy);
    if (alive <= 0) return;
    const s = this.state, p = s.position, acc = this.acc, mate = this.mate, most = this.config.maxJoints;
    for (let i = 0; i < s.count; i++) {
      const j = mate[i];
      if (j < 0) continue;
      // What was found at the last visit may have bonded elsewhere since.
      if (s.span[i] < 0 ? s.span[j] >= 0 : s.span[j] < 0 || s.joints[i] >= most || s.joints[j] >= most) { mate[i] = -1; continue; }
      const dx = p[j * 3] - p[i * 3], dy = p[j * 3 + 1] - p[i * 3 + 1], dz = p[j * 3 + 2] - p[i * 3 + 2], d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(d > JOINT_REST)) continue;
      const f = GATHER * alive * s.order[i] * (1 - s.temperature[i]) * Math.min(1, d / JOINT_RANGE) / d;
      acc[i * 3] += dx * f / s.mass[i]; acc[i * 3 + 1] += dy * f / s.mass[i]; acc[i * 3 + 2] += dz * f / s.mass[i];
      acc[j * 3] -= dx * f / s.mass[j]; acc[j * 3 + 1] -= dy * f / s.mass[j]; acc[j * 3 + 2] -= dz * f / s.mass[j];
    }
  }

  private remember(i: number, j: number, slot: number, rest: number): void {
    const s = this.state, at = i * MEMORY_SLOTS + slot;
    s.memPartner[at] = j; s.memRest[at] = rest; s.memStrength[at] = 1;
  }

  /** The string modes of every wire, from the resonance at its pitch and its first harmonics: what a frame shows of it. */
  private ring(env: Readonly<StructuralEnvironment>): void {
    const s = this.state, resonance = env.resonance, hear = Math.max(0, finite(this.tuning.resonanceCoupling, 1));
    for (let at = 0; at < s.bondCapacity; at++) {
      if (!s.bondAlive[at] || !s.bondSpan[at]) continue;
      const a = s.bondA[at], b = s.bondB[at], m = at * 3;
      if (!resonance?.live) { s.bondModes[m] = s.bondModes[m + 1] = s.bondModes[m + 2] = 0; continue; }
      const dx = s.position[b * 3] - s.position[a * 3], dy = s.position[b * 3 + 1] - s.position[a * 3 + 1], dz = s.position[b * 3 + 2] - s.position[a * 3 + 2];
      const rest = Math.max(s.bondRest[at], 0.05), stretch = (Math.sqrt(dx * dx + dy * dy + dz * dz) - rest) / rest;
      // A wire drawn taut sounds higher: its pitch follows its strain.
      const pitch = 0.5 * (s.f0[a] + s.f0[b]) + 0.08 * Math.max(-0.5, Math.min(0.5, stretch)), q = 0.5 * (s.q[a] + s.q[b]), k = s.bondCoupling[at] * hear;
      s.bondModes[m] = resonance.at(pitch, q)[0] * k;
      s.bondModes[m + 1] = resonance.at(pitch + OCTAVE, q)[0] * k * 0.6;
      s.bondModes[m + 2] = resonance.at(pitch + 1.585 * OCTAVE, q)[0] * k * 0.4;
    }
  }

  private bucket(cx: number, cy: number, cz: number): number {
    return ((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) >>> 0) & (CELLS - 1);
  }

  /**
   * Every element looks at what is near it (a bounded number of neighbours in
   * the grid, and the partners it remembers): its order and temperature
   * follow, its cohesion settles, its roles shift, and it bonds with the most
   * compatible neighbour if both have settled.
   */
  private neighbourhoods(env: Readonly<StructuralEnvironment>, dt: number, phase: number): void {
    const s = this.state, p = s.position, v = s.velocity, U = this.flow, config = this.config;
    const R = config.neighbourhood, inv = 1 / R, cells = this.cells, counts = this.cellCount, most = config.maxJoints;
    counts.fill(0);
    for (let i = 0; i < s.count; i++) {
      const b = this.bucket(Math.floor(p[i * 3] * inv), Math.floor(p[i * 3 + 1] * inv), Math.floor(p[i * 3 + 2] * inv));
      // A full bucket takes no more (lowest numbers first): the neighbourhood is bounded by construction.
      if (counts[b] < CELL_CAP) cells[b * CELL_CAP + counts[b]++] = i;
    }
    for (let i = phase; i < s.count; i += NEIGHBOUR_EVERY) {
      const at = i * 3, x = p[at], y = p[at + 1], z = p[at + 2], vx = v[at], vy = v[at + 1], vz = v[at + 2];
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz), moving = speed > STILL;
      let near = 0, spread = 0, agree = 0, hx = moving ? vx / speed : 0, hy = moving ? vy / speed : 0, hz = moving ? vz / speed : 0, headed = moving ? 1 : 0;
      const seeking = s.cohesion[i] >= 1, spans = s.span[i] < 0, wire = s.spanPartner(i), room = s.joints[i] < most;
      let best = -1, bestScore = FORMS_AT, bestDistance = 0, mate = -1, mateDistance = Infinity;
      if (++this.tick > 0x7ffffff0) { this.tick = 1; this.mark.fill(-1); }
      const tick = this.tick, cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
      for (let c = 0; c < 27 && near < NEAR_MAX; c++) {
        const b = this.bucket(cx + (c % 3) - 1, cy + (Math.floor(c / 3) % 3) - 1, cz + Math.floor(c / 9) - 1);
        for (let k = 0; k < counts[b] && near < NEAR_MAX; k++) {
          const j = cells[b * CELL_CAP + k];
          // Two cells may share a bucket: an element is seen once.
          if (j === i || this.mark[j] === tick) continue;
          this.mark[j] = tick;
          const dx = p[j * 3] - x, dy = p[j * 3 + 1] - y, dz = p[j * 3 + 2] - z, d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > R * R) continue;
          const wx = v[j * 3], wy = v[j * 3 + 1], wz = v[j * 3 + 2], other = Math.sqrt(wx * wx + wy * wy + wz * wz);
          near++;
          spread += (wx - vx) * (wx - vx) + (wy - vy) * (wy - vy) + (wz - vz) * (wz - vz);
          if (other > STILL) { hx += wx / other; hy += wy / other; hz += wz / other; headed++; }
          const pitch = (s.f0[j] - s.f0[i]) / AGREE;
          agree += (1 - Math.abs(s.excitation[i] - s.excitation[j])) / (1 + pitch * pitch);
          if (!seeking) continue;
          // The nearest matter it could bond with, once both are near and settled enough: what it drifts towards.
          if (d2 < mateDistance && s.cohesion[j] >= 0.5 && Math.abs(pitch) < 1 && (spans ? s.span[j] < 0 : room && j !== wire && s.span[j] >= 0 && s.joints[j] < most)) {
            mate = j; mateDistance = d2;
          }
          if (s.cohesion[j] < 1) continue;
          const d = Math.sqrt(d2);
          const score = spans ? this.spanScore(i, j, d, 0.5 * (s.reach[i] + s.reach[j])) : this.jointScore(i, j, d);
          if (score > bestScore) { bestScore = score; best = j; bestDistance = d; }
        }
      }
      // What it remembers it looks for directly, also beyond its neighbourhood.
      if (seeking) {
        const j = s.memPartner[i * MEMORY_SLOTS + (spans ? SPAN : JOINT)];
        if (j >= 0 && s.cohesion[j] >= 1) {
          const dx = p[j * 3] - x, dy = p[j * 3 + 1] - y, dz = p[j * 3 + 2] - z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const score = spans ? this.spanScore(i, j, d, s.memRest[i * MEMORY_SLOTS + SPAN]) : this.jointScore(i, j, d);
          if (score > bestScore) { best = j; bestDistance = d; }
        }
      }
      s.density[i] = near / (near + 3);
      // Elements that are still agree in direction; moving ones as far as they head the same way.
      s.alignment[i] = headed > 1 ? Math.sqrt(hx * hx + hy * hy + hz * hz) / headed : 1;
      s.agreement[i] = near > 0 ? agree / near : 0.5;
      const ux = vx - U[at], uy = vy - U[at + 1], uz = vz - U[at + 2], peculiar = Math.sqrt(ux * ux + uy * uy + uz * uz), stability = stabilityOf(peculiar);
      stepRegime(s, i, env, this.tuning, dt, peculiar, near > 0 ? Math.sqrt(spread / near) : 0);
      stepCohesion(s, i, env, dt, stability);
      stepRoles(s, i, dt, stability, speed);
      s.lifecycle[i] = readLifecycle(s, i, speed);
      if (best >= 0 && makeBond(s, i, best, spans, bestDistance) >= 0) {
        s.cohesion[i] = Math.max(0, s.cohesion[i] - BOND_COST); s.cohesion[best] = Math.max(0, s.cohesion[best] - BOND_COST);
        this.stats.formed++;
        mate = -1;
      }
      this.mate[i] = mate >= 0 && (spans || canJoin(s, i, mate, config)) ? mate : -1;
    }
  }

  /**
   * What `i` and `j` still owe the partners they lost: an element that remembers another in this slot does not take
   * a stranger while the memory is strong, so a broken structure tends to find itself again before it becomes
   * something else. It fades with the memory.
   */
  private loyalty(i: number, j: number, slot: number): number {
    const s = this.state, a = i * MEMORY_SLOTS + slot, b = j * MEMORY_SLOTS + slot;
    return LOYALTY * ((s.memPartner[a] >= 0 && s.memPartner[a] !== j ? s.memStrength[a] : 0) + (s.memPartner[b] >= 0 && s.memPartner[b] !== i ? s.memStrength[b] : 0));
  }

  /** How well `i` and `j` suit a wire of this ideal length at this distance (0: they cannot have one). */
  private spanScore(i: number, j: number, distance: number, ideal: number): number {
    const s = this.state;
    if (!canSpan(s, i, j) || !(ideal > 0) || distance < SPAN_NEAR * ideal || distance > SPAN_FAR * ideal) return 0;
    const memory = Math.max(remembered(s, i, j, SPAN), remembered(s, j, i, SPAN));
    return compatibility(s, i, j, distance, ideal, 0.5 * ideal) * (1 + MEMORY_GAIN * memory) - this.loyalty(i, j, SPAN);
  }

  /** How well the wire ends `i` and `j` suit a joint at this distance (0: they cannot have one). */
  private jointScore(i: number, j: number, distance: number): number {
    const s = this.state;
    if (distance > 2 * JOINT_RANGE || s.span[i] < 0 || s.span[j] < 0) return 0;
    const memory = Math.max(remembered(s, i, j, JOINT), remembered(s, j, i, JOINT));
    // Ends that belonged together find each other from a little further.
    const range = JOINT_RANGE * (1 + memory);
    if (distance > range) return 0;
    const score = compatibility(s, i, j, distance, JOINT_REST, range) * (1 + MEMORY_GAIN * memory) - this.loyalty(i, j, JOINT);
    return score > FORMS_AT && canJoin(s, i, j, this.config) ? score : 0;
  }

  /** Sparse bookkeeping: which wires close into polygons, how flat each is, and the summary the tools read. */
  private book(): void {
    const s = this.state, p = s.position, limit = s.maxSides, stats = this.stats;
    s.loops = 0;
    for (let i = 0; i < s.count; i++) { s.loop[i] = 0; s.loopOf[i] = -1; }
    for (let i = 0; i < s.count && s.loops < s.loopCapacity; i++) {
      if (s.span[i] < 0 || s.joints[i] === 0 || s.loopOf[i] >= 0) continue;
      const at = s.loops * limit;
      let e = i, corners = 0, closed = false;
      while (corners < limit) {
        s.loopCorners[at + corners++] = e;
        const far = s.spanPartner(e);
        let through = -1;
        for (let k = 0; k < MAX_JOINTS && through < 0; k++) through = s.joint[far * MAX_JOINTS + k];
        if (through < 0) break;
        e = s.other(through, far);
        if (s.span[e] < 0) break;
        if (e === i) { closed = corners >= 3; break; }
      }
      if (!closed) continue;
      const L = s.loops++;
      s.loopSize[L] = corners;
      let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0, surface = 0;
      for (let k = 0; k < corners; k++) {
        const a = s.loopCorners[at + k], b = s.loopCorners[at + (k + 1) % corners], far = s.spanPartner(a);
        s.loop[a] = s.loop[far] = corners; s.loopOf[a] = s.loopOf[far] = L;
        cx += p[a * 3]; cy += p[a * 3 + 1]; cz += p[a * 3 + 2];
        // Newell's sum: the normal of the best plane through the corners.
        nx += (p[a * 3 + 1] - p[b * 3 + 1]) * (p[a * 3 + 2] + p[b * 3 + 2]);
        ny += (p[a * 3 + 2] - p[b * 3 + 2]) * (p[a * 3] + p[b * 3]);
        nz += (p[a * 3] - p[b * 3]) * (p[a * 3 + 1] + p[b * 3 + 1]);
        surface += s.roles[a * ROLE_COUNT + ROLE.surface];
      }
      cx /= corners; cy /= corners; cz /= corners;
      const length = Math.max(Math.sqrt(nx * nx + ny * ny + nz * nz), 1e-9);
      let off = 0, size = 0;
      for (let k = 0; k < corners; k++) {
        const a = s.loopCorners[at + k], dx = p[a * 3] - cx, dy = p[a * 3 + 1] - cy, dz = p[a * 3 + 2] - cz;
        const out = (dx * nx + dy * ny + dz * nz) / length;
        off += out * out; size += dx * dx + dy * dy + dz * dz;
      }
      s.loopPlanarity[L] = 1 - unit(3 * Math.sqrt(off / Math.max(size, 1e-9)));
      s.loopSurface[L] = surface / corners;
    }

    let free = 0, nodes = 0, fragments = 0, order = 0, temperature = 0, excitation = 0, kinetic = 0;
    for (let i = 0; i < s.count; i++) {
      if (s.span[i] < 0 && s.joints[i] === 0) free++;
      if (s.role[i] === ROLE.node) nodes++;
      if (s.role[i] === ROLE.fragment || s.lifecycle[i] === LIFECYCLE.fractured) fragments++;
      order += s.order[i]; temperature += s.temperature[i]; excitation += s.excitation[i];
      kinetic += 0.5 * s.mass[i] * (s.velocity[i * 3] ** 2 + s.velocity[i * 3 + 1] ** 2 + s.velocity[i * 3 + 2] ** 2);
    }
    let spans = 0, stress = 0, strength = 0;
    for (let b = 0; b < s.bondCapacity; b++) {
      if (!s.bondAlive[b]) continue;
      spans += s.bondSpan[b]; stress += s.bondStress[b]; strength += s.bondStrength[b] * (1 - 0.5 * s.bondDamage[b]);
    }
    const n = Math.max(1, s.count), bonds = Math.max(1, s.bonds);
    stats.elements = s.count; stats.free = s.count ? free / n : 1; stats.structured = s.count ? 1 - free / n : 0;
    stats.nodes = nodes; stats.fragments = fragments; stats.bonds = s.bonds; stats.spans = spans; stats.joints = s.bonds - spans; stats.loops = s.loops;
    stats.order = order / n; stats.temperature = temperature / n; stats.excitation = excitation / n; stats.kinetic = kinetic;
    stats.stress = s.bonds ? stress / bonds : 0; stats.bondStrength = s.bonds ? strength / bonds : 0;
  }
}
