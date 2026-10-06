/*
 * The persistent physical condition of Halo's visual universe. It belongs to
 * no scene: the WorldEngine advances it on the audio clock, every scene reads
 * it and interprets it in its own geometry. Changing scene never resets it;
 * only a new audio session does.
 *
 * Four bodies (second-order: position, velocity, momentum) and seven fields
 * (first-order: they relax towards what the music asks, each at its own time
 * scale). Units are visual, not SI; ranges are documented per field and hold
 * by construction (saturating inputs and soft velocity limits).
 * See docs/world-engine.md.
 */

/** Radial body: ~0.55 Hz, ζ 0.5 (one soft overshoot). */
export const RADIAL_OMEGA = 2 * Math.PI * 0.55;
export const RADIAL_ZETA = 0.5;
/** Lateral body: ~0.3 Hz, ζ 0.8 (moves towards the sound, barely overshoots). */
export const BIAS_OMEGA = 2 * Math.PI * 0.3;
export const BIAS_ZETA = 0.8;
/** Base drags (1/s): rotation coasts ~1.7 s, travel ~0.9 s. */
export const SPIN_DRAG = 0.6;
export const TRAVEL_DRAG = 1.1;
/** Soft velocity limits (bounded motion under any input). */
export const MAX_RADIAL_VELOCITY = 2.5;
export const MAX_SPIN = 3;
export const MAX_SPEED = 6;
export const MAX_BIAS_VELOCITY = 2;
/** Field time constants (s). */
export const EXCITATION_TAU = 0.45;
export const SHIMMER_TAU = 0.18;
export const TURBULENCE_RISE = 0.4;
export const TURBULENCE_SETTLE = 2;
export const COHERENCE_TAU = 1.5;
export const POTENTIAL_LEAK = 8;
export const ILLUMINATION_RISE = 0.15;
export const ILLUMINATION_FADE = 1.4;
export const OPENNESS_TAU = 4;

/** Forces held over the next step: the world's inputs at its last update (what extrapolation integrates). */
export interface WorldForces {
  /** Equilibrium of the radial body (pressure − tension), dimensionless. */
  radialRest: number;
  /** Torque on the rotation (rad/s² per unit inertia). */
  torque: number;
  /** Rotational drag (1/s). */
  spinDrag: number;
  /** Forward thrust (units/s²) and its drag (1/s). */
  thrust: number;
  travelDrag: number;
  /** Equilibrium of the lateral body: where the sound sits in the stereo image (−1 left … 1 right). */
  biasRest: number;
  /** Excitation input rates (1/s) of the broad and fine wave fields. */
  excitationRate: number;
  shimmerRate: number;
  /** Targets of the relaxing fields. */
  turbulenceTarget: number;
  coherenceTarget: number;
  illuminationTarget: number;
  opennessTarget: number;
  /** Charge rate (1/s) of the stored potential (prediction weighted by its confidence). */
  charge: number;
}

export interface WorldState {
  /** Audio time (s) the state refers to (capture clock; presented at the heard time). */
  time: number;
  /** Radial body: expansion (+) / contraction (−) about the silent rest 0; typically −0.5 … 0.8. */
  radius: number;
  radialVelocity: number;
  /** Rotation: accumulated angle (rad, unbounded) and angular velocity (rad/s, |spin| < 3). */
  angle: number;
  spin: number;
  /** Forward travel: distance (units, unbounded) and speed (units/s, 0 … 6). One unit ≈ one beat's stride at full motion. */
  travel: number;
  speed: number;
  /** Lateral body: where the world's force comes from (−1 left … 1 right); 0 for mono. */
  bias: number;
  biasVelocity: number;
  /** 0..1 broad wave/surface excitation (fast: ~0.45 s decay). */
  excitation: number;
  /** 0..1 fine-scale excitation from high-frequency transients (~0.18 s). */
  shimmer: number;
  /** 0..1 spatial disorder (roughness, chaos, fragmentation): rises in ~0.4 s, settles in ~2 s. Independent of loudness. */
  turbulence: number;
  /** 0..1 structural coupling (harmonicity, phase and inter-channel coherence); regained in silence. */
  coherence: number;
  /** 0..1 stored potential: prepared by confident predictions, released by an actual drop, otherwise leaks (~8 s). */
  potential: number;
  /** 0..1 continuous light level of the world (not flashes: those pass the shared FlashGuard). */
  illumination: number;
  /** 0..1 slow spatial openness (~4 s). */
  openness: number;
  /** Energy bookkeeping (approximate, visual): kinetic, elastic (springs), stored potential, waves, total. */
  kinetic: number;
  elastic: number;
  stored: number;
  wave: number;
  energy: number;
  /** Audio time and strength of the last release of stored potential (-Infinity / 0 before any). */
  releaseTime: number;
  releaseStrength: number;
  /** Audio time and strength of the last impulse delivered to the bodies. */
  impulseTime: number;
  impulseStrength: number;
  forces: WorldForces;
}

export const createForces = (): WorldForces => ({
  radialRest: 0, torque: 0, spinDrag: SPIN_DRAG, thrust: 0, travelDrag: TRAVEL_DRAG, biasRest: 0,
  excitationRate: 0, shimmerRate: 0, turbulenceTarget: 0, coherenceTarget: 1, illuminationTarget: 0, opennessTarget: 0, charge: 0,
});

export const createWorld = (): WorldState => ({
  time: 0, radius: 0, radialVelocity: 0, angle: 0, spin: 0, travel: 0, speed: 0, bias: 0, biasVelocity: 0,
  excitation: 0, shimmer: 0, turbulence: 0, coherence: 1, potential: 0, illumination: 0, openness: 0,
  kinetic: 0, elastic: 0, stored: 0, wave: 0, energy: 0,
  releaseTime: -Infinity, releaseStrength: 0, impulseTime: -Infinity, impulseStrength: 0, forces: createForces(),
});

/** A world at rest, for scenes without a synchronized clock: nothing moves on its own. */
export const REST_WORLD: Readonly<WorldState> = Object.freeze({ ...createWorld(), forces: Object.freeze(createForces()) });

export function copyWorld(to: WorldState, from: WorldState): void {
  const forces = to.forces;
  Object.assign(to, from);
  to.forces = forces;
  Object.assign(forces, from.forces);
}
