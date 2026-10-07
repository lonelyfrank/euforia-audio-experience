import type { VisualizerPreset } from '../../types/visualizer';
import { defineRecipe } from '../../visual-engine/RecipeVisualizer';
import preset from './preset.json';
import { fieldRecipe, type FieldParams } from './recipe';

export default defineRecipe<FieldParams>({
  id: 'field',
  name: 'Field',
  description: 'The world as a vector field: tracers and field lines show its sources, vortices, shells and fronts.',
  order: 10,
  icon: 'scene',
  // Bloom follows the level of the music only: light events belong to the world (wave fronts), not to the bloom.
  direction: { capabilities: { particles: true, cameraMotion: true, depth: true, distortion: true }, mappings: [{ source: 'intensity', target: 'bloom', amount: 0.4 }] },
  preset: preset satisfies VisualizerPreset<FieldParams>,
  recipe: fieldRecipe,
});
