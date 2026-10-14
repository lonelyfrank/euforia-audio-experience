import { unit } from '../../../experience/types';
import { TOPOLOGY_VALUES } from '../../../render-systems/fields/vectorField';
import type { VisualizerPreset } from '../../../types/visualizer';
import { fieldLineQuality, FieldLinePrimitive, type FieldLineParams } from '../../primitives/FieldLinePrimitive';
import { ShockwavePrimitive } from '../../primitives/ShockwavePrimitive';
import { SolidPrimitive, type SolidParams } from '../../primitives/SolidPrimitive';
import { defineRecipe, type RecipeBuilder } from '../../RecipeVisualizer';

export const SOLID_LAB = 'solid-lab';

export interface SolidLabParams extends SolidParams, FieldLineParams {
  /** Seed of the world: the same seed is the same matter. */
  seed: number;
  /** Tilt of the world's axis away from the viewer (rad). */
  tilt: number;
}

/**
 * Solid Dynamics: the development sandbox of the volumetric bodies, not a
 * scene of the product (the laboratory mounts it; no menu lists it). One
 * world with what is needed to watch a body live and nothing else:
 *
 *   solid       one body of the structural engine: vertices, links, faces, cells      always there
 *   shockwaves  the fronts of the events that strike it, visible                      with any sound
 *   lines       the vector field that carries it, as it is this instant               as the music can carry structure
 *
 * The body samples the same packed fields, fronts and topology the lines
 * draw, and its matter answers the multiscale resonance by its own pitch
 * (`resonance`).
 */
export const solidLabRecipe: RecipeBuilder<SolidLabParams> = (p, quality) => {
  const lines = fieldLineQuality(p, quality);
  // One packed topology for everything in this world that reads the vector field.
  const topology = new Float32Array(TOPOLOGY_VALUES);
  return {
    // No visual memory: a sandbox shows what is there this instant, not where it has been.
    id: SOLID_LAB, seed: p.seed, tilt: p.tilt, memory: 'off', spatial: 0.3, resonance: true,
    // The roll of the world's travel is taken lightly, so a body under study keeps facing the viewer.
    tune: (fields) => { fields.advection *= 0.3; },
    slots: [
      // The quality tier changes how much of the field is drawn round the body, never the body: its topology is the simulation's.
      { id: 'solid', base: true, create: (context) => new SolidPrimitive(context, p, topology) },
      { id: 'shockwaves', cost: 0.3, attack: 0.3, release: 1.5, create: (context) => new ShockwavePrimitive(context) },
      {
        id: 'lines', cost: 0.5, attack: 0.9, release: 2.2,
        affinity: (g) => unit(0.3 + 0.9 * g.energy + 0.6 * g.waveVelocity),
        create: (context) => new FieldLinePrimitive(context, lines, topology),
      },
    ],
  };
};

export const solidLabPreset: VisualizerPreset<SolidLabParams> = {
  name: 'Solid Dynamics',
  author: 'Euforia-Audio-Experience',
  version: 1,
  audio: { sensitivity: 1, smoothing: 1 },
  camera: { fov: 50, distance: 3.8, drift: 0 },
  bloom: { strength: 0.45, radius: 0.5, threshold: 0.12 },
  visual: { seed: 20261011, tilt: 0.3, solid: 0, solidRadius: 0.62, pointSize: 3, lines: 90, lineSegments: 20 },
};

/** The solid bodies' sandbox as a scene definition: registered by the Solid Dynamics laboratory only (development builds). */
export default defineRecipe<SolidLabParams>({
  id: SOLID_LAB,
  name: 'Solid Dynamics',
  description: 'Development sandbox of the volumetric bodies: one solid of the structural engine, the field that carries it and the fronts that strike it.',
  order: 1001,
  icon: 'scene',
  category: 'particles',
  direction: { capabilities: { particles: true, cameraMotion: true, depth: true, distortion: true }, mappings: [{ source: 'intensity', target: 'bloom', amount: 0.4 }] },
  preset: solidLabPreset,
  recipe: solidLabRecipe,
});
