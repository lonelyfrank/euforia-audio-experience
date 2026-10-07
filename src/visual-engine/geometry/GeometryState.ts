import { createMaterial, type VisualMaterial } from '../../render-systems/materials/VisualMaterial';

/**
 * What the sound and the world ask of geometry, right now: the one contract
 * between interpretation (SoundMorphology, ExperienceEngine, WorldState) and
 * everything that is drawn. A primitive never reads bands, beats or spectra:
 * it reads these traits, so a filament, a surface and a cloud of particles
 * answer the same sound in the same way.
 *
 * It extends the VisualMaterial (what kind of matter could stand for the
 * sound) with what a shape needs beyond a material: how its lines run, how it
 * is ordered and connected, how it moves, how far it reaches. Continuous
 * traits only, 0..1 unless noted; no classes, no tables from sounds to shapes.
 * The perceptual reason of every trait is in docs/visual-grammar.md.
 *
 * At rest (silence, a still world) every trait is 0 except `coherence`, and
 * the `rigidity` that follows from it: a world nothing disturbs is whole.
 */
export interface GeometryState extends VisualMaterial {
  /** Lines run round and unbroken: a clear, smooth repeating cycle. */
  curvature: number;
  /** Corners: the cycle itself jumps (a ramp falling back, a square), or the sound is bright, stacked and sudden. */
  edgeHardness: number;
  /** Flat stretches between jumps (a square wave): terraces, segments, sample-and-hold. */
  stepping: number;
  /** −1..1: which way the cycle leans (+ it falls faster than it rises): the direction edges point. */
  skew: number;
  /** A voice with a clean shape of its own is there to be drawn. */
  tonalShape: number;
  /** The shape does not repeat: noise, and the ripple of a busy cycle. */
  noiseShape: number;

  /** The world holds together (1 at rest) / is disturbed. */
  coherence: number;
  disorder: number;

  /** How much of the spectrum and of time is occupied. */
  density: number;
  /** Structures fork: several partials that belong together but are not one cycle. */
  branching: number;
  /** How much structure the picture may carry at once: the planner's entropy, less its fatigue. */
  topologyComplexity: number;

  /** A struck structure rings on / motion dies in it / it is drawn taut by stored potential. */
  elasticity: number;
  viscosity: number;
  tension: number;

  /** 0 = fine, short waves (bright sound) … 1 = long, broad ones (low sound). */
  waveScale: number;
  /** How fast waves and ripples run: the world's travel and the music's motion. */
  waveVelocity: number;

  /** Weight of an element: low, heavy sound makes large, slow matter. */
  particleMass: number;
  /** How loosely matter fills its volume: an open, wide sound. */
  particleSpread: number;

  /** How far two points may be apart and still be joined. */
  connectionRadius: number;
  /** How long a trace stays: steady, coherent sound leaves long ones. */
  trailPersistence: number;

  /** How far sustained sound presses a surface out of its plane, and how rough it leaves it. */
  surfaceDisplacement: number;
  surfaceRoughness: number;

  /** Extent of the world along the view, and across it (stereo width). */
  spatialDepth: number;
  stereoSpread: number;
  /** −1 (left) … 1 (right): where the world's forces come from. */
  lateralBias: number;

  /** The world's last impact, still ringing (seconds, not frames). */
  impulse: number;
  /** How far the last release still holds structures open. */
  fracture: number;
  /** How alive the world is: its light and excitation. What structures cool down with. */
  energy: number;
}

export const createGeometry = (): GeometryState => ({
  ...createMaterial(),
  curvature: 0, edgeHardness: 0, stepping: 0, skew: 0, tonalShape: 0, noiseShape: 0,
  coherence: 1, disorder: 0,
  density: 0, branching: 0, topologyComplexity: 0,
  elasticity: 0, viscosity: 0, tension: 0,
  waveScale: 0, waveVelocity: 0,
  particleMass: 0, particleSpread: 0,
  connectionRadius: 0, trailPersistence: 0,
  surfaceDisplacement: 0, surfaceRoughness: 0,
  spatialDepth: 0, stereoSpread: 0, lateralBias: 0,
  impulse: 0, fracture: 0, energy: 0,
});

export const GEOMETRY_KEYS = Object.keys(createGeometry()) as (keyof GeometryState)[];
/** The traits that are signed (−1..1); every other one is 0..1. */
export const SIGNED_TRAITS: readonly (keyof GeometryState)[] = ['skew', 'lateralBias'];
