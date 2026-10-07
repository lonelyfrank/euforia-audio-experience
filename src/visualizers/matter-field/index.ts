import type { VisualizerPreset } from '../../types/visualizer';
import { defineRecipe } from '../../visual-engine/RecipeVisualizer';
import preset from './preset.json';
import { matterFieldRecipe, type MatterFieldParams } from './recipe';

export default defineRecipe<MatterFieldParams>({
  id: 'matter-field',
  name: 'Matter Field',
  description: 'One persistent world: particles, filaments, a membrane and a lattice shaped together by the sound.',
  order: 9,
  icon: 'scene',
  // Bloom follows the level of the music only: light events belong to the world (wave fronts), not to the bloom.
  direction: { capabilities: { particles: true, cameraMotion: true, depth: true, distortion: true }, mappings: [{ source: 'intensity', target: 'bloom', amount: 0.4 }] },
  preset: preset satisfies VisualizerPreset<MatterFieldParams>,
  recipe: matterFieldRecipe,
});
