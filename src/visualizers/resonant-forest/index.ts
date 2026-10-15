import type { VisualizerPreset } from '../../types/visualizer';
import { defineRecipe } from '../../visual-engine/RecipeVisualizer';
import preset from './preset.json';
import { resonantForestRecipe, type ResonantForestParams } from './recipe';

export default defineRecipe<ResonantForestParams>({
  id: 'resonant-forest',
  name: 'Resonant Forest',
  description: 'An abstract forest flown through slowly: trees grow from the music they hear, ring with its groove, resonate again when that music comes back, and decay in a breakdown.',
  order: 16,
  icon: 'scene',
  category: 'worlds',
  locomotion: ['glide', 'drift'],
  direction: { capabilities: { particles: true, cameraMotion: true, depth: true, distortion: true }, mappings: [{ source: 'intensity', target: 'bloom', amount: 0.3 }] },
  preset: preset satisfies VisualizerPreset<ResonantForestParams>,
  recipe: resonantForestRecipe,
});
