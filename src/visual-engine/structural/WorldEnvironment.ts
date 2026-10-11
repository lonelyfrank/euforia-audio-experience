import { FIELD, layerRadius, WAVE_PUSH } from '../../render-systems/fields/fieldLaw';
import { FRONT_SHIFT, frontsAt } from '../../render-systems/fields/flowLaw';
import { deriveTopology, fieldAt } from '../../render-systems/fields/vectorField';
import type { PrimitiveContext, WorldFrame } from '../Primitive';
import { createStillEnvironment, type StructuralEnvironment } from './StructuralTypes';

/*
 * The shared world as a structural system samples it: nothing of its own, only
 * the frame's fields, fronts and resonance. Every primitive that draws a
 * StructuralSystem (wire polygons, solids) reads the world through this, so
 * what carries a free element, a wire and a vertex of a body is one medium.
 */

/** Share of the matter's radial spring that structural elements feel: held in the body, free to deform within it. */
const HOLD = 0.35;
const fronts = WAVE_PUSH / FRONT_SHIFT;

/**
 * The environment of a world's structures: the same vector field the tracers follow, the same fronts that push the
 * matter, the same radial potential that holds it. `topology` is the packed topology of that field, shared with
 * whatever else in the world shows it.
 */
export function createWorldEnvironment({ uField, uWaveA, uWaveB }: PrimitiveContext, topology: Float32Array): StructuralEnvironment {
  return {
    ...createStillEnvironment(),
    flow: (x, y, z, out) => { const F = fieldAt(x, y, z, uField, topology); out[0] = F[0]; out[1] = F[1]; out[2] = F[2]; },
    push: (x, y, z, affinity, out) => { const F = frontsAt(x, y, z, affinity, uWaveA, uWaveB); out[0] = F[0] * fronts; out[1] = F[1] * fronts; out[2] = F[2] * fronts; },
    // The radial spring of the field law, as the matter of that layer feels it: the world's pressure moves the radius it rests at.
    hold: (x, y, z, home, out) => {
      const px = x - uField[FIELD.lateral], r = Math.max(Math.sqrt(px * px + y * y + z * z), 1e-4);
      const k = -HOLD * uField[FIELD.stiffness] * (r - layerRadius(home, uField[FIELD.radius], uField[FIELD.gather])) / r;
      out[0] = px * k; out[1] = y * k; out[2] = z * k;
    },
  };
}

/** The frame's levels into the environment, and the field's topology derived (here too, so nothing depends on who was updated first). */
export function readWorld(env: StructuralEnvironment, frame: Readonly<WorldFrame>, topology: Float32Array): void {
  const { geometry: g, fields } = frame;
  deriveTopology(topology, g, fields);
  env.coherence = g.coherence; env.harmony = g.symmetry; env.turbulence = g.disorder; env.tension = g.tension;
  env.energy = g.energy; env.release = g.fracture; env.drag = fields.drag;
  env.resonance = frame.resonance ?? null;
}
