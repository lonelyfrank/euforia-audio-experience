import type { VisualizerPreset } from '../../../types/visualizer';
import { defineRecipe } from '../../RecipeVisualizer';
import { structuralLabRecipe, type StructuralLabParams } from './recipe';

export const STRUCTURAL_LAB = 'structural-lab';

export const structuralLabPreset: VisualizerPreset<StructuralLabParams> = {
  name: 'Structural Lab',
  author: 'Euforia-Audio-Experience',
  version: 1,
  audio: { sensitivity: 1, smoothing: 1 },
  camera: { fov: 50, distance: 4.4, drift: 0 },
  bloom: { strength: 0.5, radius: 0.5, threshold: 0.12 },
  visual: { seed: 20261009, tilt: 0.3, elements: 120, polygon: 4, polygonRadius: 0.55, pointSize: 2.4, lines: 120, lineSegments: 20 },
};

/** The structural engine's sandbox as a scene definition: registered by the engine cockpit only (development builds). */
export default defineRecipe<StructuralLabParams>({
  id: STRUCTURAL_LAB,
  name: 'Structural Lab',
  description: 'Development sandbox of the structural engine: a wire polygon in free matter, the field that carries it and the fronts that strike it.',
  order: 1000,
  icon: 'scene',
  direction: { capabilities: { particles: true, cameraMotion: true, depth: true, distortion: true }, mappings: [{ source: 'intensity', target: 'bloom', amount: 0.4 }] },
  preset: structuralLabPreset,
  recipe: structuralLabRecipe,
});
