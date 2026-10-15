import type { VisualizerPreset } from '../../types/visualizer';
import { defineRecipe } from '../../visual-engine/RecipeVisualizer';
import preset from './preset.json';
import { fracturedExpanseRecipe, type FracturedExpanseParams } from './recipe';

export default defineRecipe<FracturedExpanseParams>({
  id: 'fractured-expanse',
  name: 'Fractured Expanse',
  description: 'A deep space of suspended bodies circled slowly: they gather, hold their shape, ring with the mids, break on a release heard and find each other again.',
  order: 14,
  icon: 'scene',
  category: 'worlds',
  locomotion: ['orbit'],
  direction: { capabilities: { particles: true, cameraMotion: true, depth: true }, mappings: [{ source: 'intensity', target: 'bloom', amount: 0.35 }] },
  preset: preset as unknown as VisualizerPreset<FracturedExpanseParams>,
  recipe: fracturedExpanseRecipe,
});
