import type { ResonanceField } from './ResonanceField';

/*
 * Structural dynamics: the physical lifecycle of what a world is built from.
 * Particles, the ends of a wire, the corners of a polygon and the fragments
 * of a broken one are the same thing here: an element with a stable physical
 * identity, a dynamic state, and bonds to other elements. A structure is not
 * an object that is created and destroyed: it is what a set of bonds holds
 * together for as long as they hold.
 *
 *   audio → excitation → environment → matter / structure → topology → rendering
 *
 * The environment decides where an element goes (macro motion); its own
 * resonance decides how it answers locally (micro response). Order and
 * temperature are continuous regimes, roles are weights, and a fracture
 * changes the topology, never the number of elements.
 */

/** What an element is being, as weights that sum to one. They emerge from its local conditions; none is assigned. */
export const ROLES = ['free', 'node', 'edge', 'surface', 'anchor', 'fragment', 'tracer'] as const;
export type Role = typeof ROLES[number];
export const ROLE = Object.fromEntries(ROLES.map((role, i) => [role, i])) as { readonly [K in Role]: number };
export const ROLE_COUNT = ROLES.length;

/** A reading of the continuous state for the development tools (excitation, cohesion, stress, damage … decide; this only names). */
export const LIFECYCLES = ['dormant', 'excited', 'cohering', 'bound', 'stressed', 'fractured', 'free', 'reforming'] as const;
export type Lifecycle = typeof LIFECYCLES[number];
export const LIFECYCLE = Object.fromEntries(LIFECYCLES.map((state, i) => [state, i])) as { readonly [K in Lifecycle]: number };

/**
 * Bonds an element can hold: one span (a wire: a bond with a length) and up to
 * MAX_JOINTS joints (a weld: a bond of almost no length to the end of another wire).
 */
export const MAX_JOINTS = 3;
export const MAX_BONDS = 1 + MAX_JOINTS;
/** What an element remembers of its last structure: its span partner and its joint partner. */
export const MEMORY_SLOTS = 2;
export const SPAN = 0;
export const JOINT = 1;

export interface StructuralConfig {
  /** Elements the pools hold: nothing grows past it. */
  capacity: number;
  /** The same seed is the same matter. */
  seed: number;
  /** Fixed simulation step (s): topology never depends on the frame rate. */
  step: number;
  /** Joints one element may hold: 1 makes chains and polygons, more makes networks (≤ MAX_JOINTS). */
  maxJoints: number;
  /** Wires a chain may grow to, and so the largest polygon. */
  maxSides: number;
  /** Length of a wire of middle matter (units); low matter spans further, fine matter less. */
  reach: number;
  /** How far an element sees its neighbours (units): the cell of the spatial grid. */
  neighbourhood: number;
}

export const DEFAULT_STRUCTURE: Readonly<StructuralConfig> = { capacity: 256, seed: 1, step: 1 / 120, maxJoints: 1, maxSides: 6, reach: 0.42, neighbourhood: 0.5 };

/**
 * Development overrides (the Structures panel of the engine cockpit). `null`
 * leaves the world's own value; the factors are 1 in the product. Never
 * persisted, never read from user settings.
 */
export interface StructuralTuning {
  coherence: number | null;
  temperature: number | null;
  /** × the stress a bond bears before it breaks. */
  fractureThreshold: number;
  /** × the strength bonds are made with. */
  bondStrength: number;
  /** × how much of its resonance an element takes (micro response). */
  resonanceCoupling: number;
  /** × how much of the environment's flow and fronts an element takes (macro motion). */
  environmentCoupling: number;
}

export const createTuning = (): StructuralTuning => ({ coherence: null, temperature: null, fractureThreshold: 1, bondStrength: 1, resonanceCoupling: 1, environmentCoupling: 1 });

/**
 * The shared environment as structural elements sample it. Not a world of
 * their own: a world's primitive fills it from the frame every primitive
 * reads (the same vector field the tracers follow, the same fronts that push
 * the matter). All levels 0..1.
 */
export interface StructuralEnvironment {
  /** The world holds together / how ordered and repeating the sound is / how disturbed the world is. */
  coherence: number;
  harmony: number;
  turbulence: number;
  /** Stored potential: what draws structures taut before a release. */
  tension: number;
  /** How alive the world is: 0 in silence, where nothing new may form or be set in motion. */
  energy: number;
  /** How far the last release still holds structures open. */
  release: number;
  /** Drag of the medium (1/s): the rate the flows act through. */
  drag: number;
  /** The multiscale resonance as elements look it up; null when nothing can ring (no synchronized clock). */
  resonance: ResonanceField | null;
  /** Velocity of the medium at a point (units/s): flow, pressure, potential, vortices, turbulence. Writes out[0..2]. */
  flow(x: number, y: number, z: number, out: Float64Array): void;
  /** Acceleration the wave fronts passing through a point give matter of this frequency affinity (units/s²). Writes out[0..2]. */
  push(x: number, y: number, z: number, affinity: number, out: Float64Array): void;
  /**
   * Acceleration of the world's potential on matter whose home is the layer `home` (0..1) of its body: the pressure
   * that opens the body and the pull that keeps it one (units/s²). Writes out[0..2].
   */
  hold(x: number, y: number, z: number, home: number, out: Float64Array): void;
}

/** An environment in which nothing happens: silence, a still medium. */
export const createStillEnvironment = (): StructuralEnvironment => ({
  coherence: 1, harmony: 0, turbulence: 0, tension: 0, energy: 0, release: 0, drag: 2, resonance: null,
  flow: (_x, _y, _z, out) => { out[0] = out[1] = out[2] = 0; },
  push: (_x, _y, _z, _affinity, out) => { out[0] = out[1] = out[2] = 0; },
  hold: (_x, _y, _z, _home, out) => { out[0] = out[1] = out[2] = 0; },
});

export const unit = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
/** A finite number, or the fallback: what reaches the simulation is never NaN or infinite. */
export const finite = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback);
