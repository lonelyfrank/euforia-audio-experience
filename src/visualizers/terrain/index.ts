import type { VisualizerPreset } from '../../types/visualizer';
import { defineRecipe } from '../../visual-engine/RecipeVisualizer';
import preset from './preset.json';
import { terrainRecipe, type GenerativeTerrainParams } from './recipe';

export default defineRecipe<GenerativeTerrainParams>({
  id: 'terrain',
  name: 'Generative Terrain',
  description: 'An endless low-poly valley flown over with the music: the ground swells, terraces, cracks and releases with the world.',
  order: 12,
  icon: 'scene',
  category: 'worlds',
  locomotion: ['glide'],
  // Bloom follows the level of the music only: light events belong to the world (wave fronts), not to the bloom.
  direction: { capabilities: { particles: true, cameraMotion: true, depth: true, distortion: true }, mappings: [{ source: 'intensity', target: 'bloom', amount: 0.4 }] },
  preset: preset satisfies VisualizerPreset<GenerativeTerrainParams>,
  recipe: terrainRecipe,
});
