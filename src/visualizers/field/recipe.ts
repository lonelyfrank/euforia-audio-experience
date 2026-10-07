import { unit } from '../../experience/types';
import { TOPOLOGY_VALUES } from '../../render-systems/fields/vectorField';
import { fieldLineQuality, FieldLinePrimitive, type FieldLineParams } from '../../visual-engine/primitives/FieldLinePrimitive';
import { FieldTracerPrimitive, tracerQuality, type TracerParams } from '../../visual-engine/primitives/FieldTracerPrimitive';
import type { RecipeBuilder } from '../../visual-engine/RecipeVisualizer';

export interface FieldParams extends TracerParams, FieldLineParams {
  /** Seed of the world: the same seed is the same tracers and the same lines. */
  seed: number;
  /** Tilt of the world's axis away from the viewer (rad). */
  tilt: number;
}

/** Share of its tracers a living field renews per second at full energy: what gathered on a shell or left the body comes back into the volume. */
const RENEWAL = 0.12;

/**
 * Field: the world as a vector field, with nothing in it but what shows the
 * field. It is the flow that moves the free matter and the filaments of
 * Matter Field, on its own and completed into F(P)
 * (render-systems/fields/vectorField.ts): the world's radial velocity is a
 * source or a sink, its spin a vortex about the axis, its travel a roll, its
 * stereo origin the centre and a drift, its disorder a disordered flow and
 * local eddies that wake one by one, its order and stored potential shells
 * the flow converges on, its events fronts that cross it.
 *
 *   tracers  what the field carries: seen by their motion, almost invisible at rest   always there
 *   lines    the field as it is this instant, drawn downstream from seeded points       as the music can carry structure
 *
 * Both read the same packed fields, fronts and topology, so a line is where a
 * tracer is about to go. Nothing is animated: in a silent, still world the
 * field is zero, the lines have no length and the tracers stay where they are
 * and go dark.
 */
export const fieldRecipe: RecipeBuilder<FieldParams> = (p, quality) => {
  const tracers = tracerQuality(p, quality), lines = fieldLineQuality(p, quality);
  // One packed topology for everything in this world that reads the vector field.
  const topology = new Float32Array(TOPOLOGY_VALUES);
  return {
    id: 'field', seed: p.seed, tilt: p.tilt, memory: tracers.feedback, trail: 0.7, spatial: 0.5,
    tune: (fields, g) => {
      // An open, wide sound gives the field more room.
      fields.radius = Math.min(1.9, fields.radius + 0.25 * g.particleSpread);
      // A field renews its tracers only while it is alive: silence keeps what is there.
      fields.lifetimeRate = Math.max(fields.lifetimeRate, RENEWAL * g.energy);
    },
    slots: [
      { id: 'tracers', base: true, create: (context) => new FieldTracerPrimitive(context, tracers, p, topology) },
      {
        id: 'lines', cost: 0.5, attack: 0.9, release: 2.2,
        // Lines need a field that is alive and going somewhere.
        affinity: (g) => unit(0.3 + 0.9 * g.energy + 0.6 * g.waveVelocity),
        create: (context) => new FieldLinePrimitive(context, lines, topology),
      },
    ],
  };
};
