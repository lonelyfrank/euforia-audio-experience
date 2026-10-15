import type { VisualizerPreset } from '../../types/visualizer';
import { defineRecipe } from '../../visual-engine/RecipeVisualizer';
import preset from './preset.json';
import { pulseOceanRecipe, type PulseOceanParams } from './recipe';

export default defineRecipe<PulseOceanParams>({
  id: 'pulse-ocean',
  name: 'Pulse Ocean',
  description: 'An endless geometric sea glided over: long swells of the music\'s energy, the groove in its waves, the highs glinting on the surface, a release running away as a front.',
  order: 15,
  icon: 'liquid',
  category: 'worlds',
  locomotion: ['glide', 'drift'],
  direction: { capabilities: { particles: true, cameraMotion: true, depth: true, distortion: true }, mappings: [{ source: 'intensity', target: 'bloom', amount: 0.35 }] },
  preset: preset satisfies VisualizerPreset<PulseOceanParams>,
  recipe: pulseOceanRecipe,
});
