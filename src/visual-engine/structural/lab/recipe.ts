import { unit } from '../../../experience/types';
import { TOPOLOGY_VALUES } from '../../../render-systems/fields/vectorField';
import { fieldLineQuality, FieldLinePrimitive, type FieldLineParams } from '../../primitives/FieldLinePrimitive';
import { ShockwavePrimitive } from '../../primitives/ShockwavePrimitive';
import { structureQuality, WirePolygonPrimitive, type StructureParams } from '../../primitives/WirePolygonPrimitive';
import type { RecipeBuilder } from '../../RecipeVisualizer';

export interface StructuralLabParams extends StructureParams, FieldLineParams {
  /** Seed of the world: the same seed is the same matter. */
  seed: number;
  /** Tilt of the world's axis away from the viewer (rad). */
  tilt: number;
}

/**
 * Structural Lab: the development sandbox of the structural engine, not a
 * scene of the product (the engine cockpit mounts it; no menu lists it). One
 * world with what is needed to watch a structure live and nothing else:
 *
 *   structure   a polygon's worth of wires in a population of free matter      always there
 *   shockwaves  the fronts of the events that strike it, visible               with any sound
 *   lines       the vector field that carries it, as it is this instant        as the music can carry structure
 *
 * The structure samples the same packed fields, fronts and topology the lines
 * draw, so a line is where a fragment is about to go. Its matter answers the
 * multiscale resonance by its own pitch (`resonance`).
 */
export const structuralLabRecipe: RecipeBuilder<StructuralLabParams> = (p, quality) => {
  const structure = structureQuality(p, quality), lines = fieldLineQuality(p, quality);
  // One packed topology for everything in this world that reads the vector field.
  const topology = new Float32Array(TOPOLOGY_VALUES);
  return {
    // No visual memory: a sandbox shows what is there this instant, not where it has been.
    id: 'structural-lab', seed: p.seed, tilt: p.tilt, memory: 'off', spatial: 0.3, resonance: true,
    // The roll of the world's travel is taken lightly, so a figure under study keeps facing the viewer.
    tune: (fields) => { fields.advection *= 0.3; },
    slots: [
      { id: 'structure', base: true, create: (context) => new WirePolygonPrimitive(context, structure, p, topology) },
      { id: 'shockwaves', cost: 0.3, attack: 0.3, release: 1.5, create: (context) => new ShockwavePrimitive(context) },
      {
        id: 'lines', cost: 0.5, attack: 0.9, release: 2.2,
        affinity: (g) => unit(0.3 + 0.9 * g.energy + 0.6 * g.waveVelocity),
        create: (context) => new FieldLinePrimitive(context, lines, topology),
      },
    ],
  };
};
