import { unit } from '../../experience/types';
import { forEachCue, type Cue } from '../../experience/MusicalCues';
import { CameraRig, Orbit, type OrbitParams, type RigLimits } from '../../render-systems/camera/locomotion';
import { TOPOLOGY_VALUES } from '../../render-systems/fields/vectorField';
import { ConstellationPrimitive } from '../../visual-engine/primitives/ConstellationPrimitive';
import { FieldTracerPrimitive, tracerQuality, type TracerParams } from '../../visual-engine/primitives/FieldTracerPrimitive';
import { ShockwavePrimitive } from '../../visual-engine/primitives/ShockwavePrimitive';
import { SolidPrimitive, type SolidPlacement, type SolidPopulation } from '../../visual-engine/primitives/SolidPrimitive';
import type { RecipeBuilder } from '../../visual-engine/RecipeVisualizer';
import { RigCamera } from '../../visual-engine/RigCamera';
import { DEFAULT_SOLID_BUDGET, type SolidBudget, type SolidProfile } from '../../visual-engine/structural/SolidTypes';
import { follow } from '../shared/motion';

export interface FracturedExpanseParams {
  seed: number;
  /** The bodies suspended in the expanse, where they are seeded (world units), and how they live. */
  bodies: SolidPlacement[];
  start: SolidPopulation['start'];
  fracture: SolidPopulation['fracture'];
  profile: SolidProfile;
  /** Size of a vertex of a body (device-independent pixels at the rest distance). */
  pointSize: number;
  /** The pools of the bodies (links, faces, cells), beside their count. */
  budget?: Partial<SolidBudget>;
  /** The dust the field carries round them. */
  dust: TracerParams;
  /** How far apart two pieces of different bodies may be and still be joined (units). */
  reach: number;
  camera?: { orbit?: Partial<OrbitParams>; limits?: Partial<RigLimits>; distance?: number; height?: number };
}

export const BODIES_SLOT = 'bodies';
/** How long the eye stays on a body that broke (s of audio), and how long it takes to go to it and to leave it (s). */
const WATCH = 6;
const EYE_TAU = 0.9;
/** At rest the eye rests on the centre of what is there at this weight; on a body that broke at full weight. */
const AT_REST = 0.45;

/**
 * Fractured Expanse: a deep space of suspended bodies (docs/generative-worlds.md). The bodies are the structural
 * engine's own (one solver: SolidSystem, rigid material, the fracture gate), several of them in clusters, in the same
 * fields and fronts every world shares; the camera goes round them.
 *
 *   bodies          SolidPrimitive with a population: free matter that aggregates and seals, holds its shape, rings by
 *                   its natural frequency (the world's resonance), breaks only on a release heard, and forms again where
 *                   the physics lets it (link memory: the history of a fracture is kept for minutes)
 *   dust            FieldTracerPrimitive: the field made visible round them, almost nothing at rest
 *   constellation   ConstellationPrimitive: pieces that were one body, and neighbours lit by the highs
 *   fronts          ShockwavePrimitive: the world's dated fronts
 *   observer        Orbit: round the expanse by a share of the world's own turn, nearer as it holds tension, its eye
 *                   moving to a body that broke and coming back to the whole
 *
 * Lows press and carry the bodies (the field's pressure and drift), mids make them ring (resonance by natural frequency,
 * a uniform pulse ≤ PULSE_LIMIT), highs light the connections, a release heard breaks the most loaded; a breakdown lets
 * the field calm and the pieces find each other again.
 */
export const fracturedExpanseRecipe: RecipeBuilder<FracturedExpanseParams> = (p, quality) => {
  const topology = new Float32Array(TOPOLOGY_VALUES), dust = tracerQuality(p.dust, quality), c = p.camera ?? {};
  const population: SolidPopulation = { bodies: p.bodies, start: p.start, fracture: p.fracture, profile: p.profile };
  const budget: SolidBudget = { ...DEFAULT_SOLID_BUDGET, links: 360, faces: 240, cells: 56, frameMs: 1, ...p.budget, bodies: p.bodies.length };
  let bodies: SolidPrimitive | null = null;
  const rest = { x: 0, y: c.height ?? 0.9, z: c.distance ?? 5.2, tx: 0, ty: 0, tz: 0 };
  // An orbit goes round: the reach is the orbit's own diameter, and more (its distance breathes up to half again).
  const rig = new CameraRig([{ profile: new Orbit(c.orbit), weight: 1 }], rest, { reach: 3 * rest.z, ...c.limits });

  // The eye: the centre of what is there, or a body that broke, for a while after the release that broke it.
  let watched = -1, watchedAt = -Infinity, cursor = -1, eye = AT_REST, lastPieces = new Int32Array(0);
  const take = (cue: Readonly<Cue>): void => { if (cue.kind === 'release' && cue.status === 'confirmed') watchedAt = cue.time; };
  const camera = new RigCamera(rig, (frame, focus) => {
    if (!bodies) return;
    const solids = bodies.system.solids!, state = solids.state, h = frame.dt > 0 ? Math.min(frame.dt, 0.25) : 0;
    const cues = frame.timed ? frame.snapshot?.cues : undefined;
    if (cues) cursor = cursor < 0 ? cues.seq : forEachCue(cues, cursor, take);
    if (lastPieces.length !== state.bodies) lastPieces = Int32Array.from(state.bodyPieces.subarray(0, state.bodies));
    // A body that came apart since the last frame, after a release heard: that is where the eye goes.
    for (let b = 0; b < state.bodies; b++) {
      if (state.bodyPieces[b] > lastPieces[b] && frame.time - watchedAt < WATCH) watched = b;
      lastPieces[b] = state.bodyPieces[b];
    }
    if (watched >= 0 && frame.time - watchedAt >= WATCH) watched = -1;
    let x = 0, y = 0, z = 0;
    if (watched >= 0) { const o = solids.centroid(watched); x = o[0]; y = o[1]; z = o[2]; }
    else {
      for (let b = 0; b < state.bodies; b++) { const o = solids.centroid(b); x += o[0]; y += o[1]; z += o[2]; }
      const n = Math.max(1, state.bodies); x /= n; y /= n; z /= n;
    }
    eye = follow(eye, watched >= 0 ? 1 : AT_REST, Math.exp(-h / EYE_TAU));
    focus.x = x; focus.y = y; focus.z = z; focus.weight = eye;
  });

  return {
    // No visual memory: the bodies are sharp, and the dust's streaks are its own motion, not trails of the picture.
    id: 'fractured-expanse', seed: p.seed, tilt: 0, memory: 'off', observer: false, resonance: true, camera,
    tune: (fields, g) => {
      // A deep space: the field has room round the bodies, more as the sound opens.
      fields.radius = Math.min(2.2, fields.radius + 0.35 + 0.25 * g.particleSpread);
    },
    slots: [
      { id: BODIES_SLOT, base: true, create: (context) => (bodies = new SolidPrimitive(context, { solid: 0, solidRadius: 0.25, pointSize: p.pointSize }, topology, budget, population)) },
      { id: 'dust', base: true, create: (context) => new FieldTracerPrimitive(context, dust, p.dust, topology) },
      {
        id: 'constellation', cost: 0.6, attack: 1.2, release: 3,
        // Connections need a world with something in its highs to light them.
        affinity: (g) => unit(0.35 + 0.8 * g.energy),
        create: () => new ConstellationPrimitive(bodies!, p.reach),
      },
      { id: 'fronts', cost: 0.4, affinity: (g) => unit(0.2 + g.impulse), create: (context) => new ShockwavePrimitive(context) },
    ],
  };
};
