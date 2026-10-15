import type { VisualizerPreset } from '../../types/visualizer';
import { defineRecipe } from '../../visual-engine/RecipeVisualizer';
import preset from './preset.json';
import { monolithDesertRecipe, type MonolithDesertParams } from './recipe';

export default defineRecipe<MonolithDesertParams>({
  id: 'monolith-desert',
  name: 'Monolith Desert',
  description: 'A geometric desert glided over slowly: monoliths rise out of the plain with the music\'s structure, ring with its groove and break only on a release heard.',
  order: 13,
  icon: 'scene',
  category: 'worlds',
  locomotion: ['glide', 'hover'],
  // As the terrain: bloom follows the level of the music only; light events are the world's (fronts, monoliths).
  direction: { capabilities: { particles: true, cameraMotion: true, depth: true, distortion: true }, mappings: [{ source: 'intensity', target: 'bloom', amount: 0.3 }] },
  preset: preset satisfies VisualizerPreset<MonolithDesertParams>,
  recipe: monolithDesertRecipe,
});
