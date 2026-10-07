import type { VisualizerPreset } from '../../types/visualizer';
import { defineRecipe } from '../../visual-engine/RecipeVisualizer';
import preset from './preset.json';
import { spectralShellRecipe, type SpectralShellParams } from './recipe';

export default defineRecipe<SpectralShellParams>({
  id: 'spectral-shell',
  name: 'Spectral Shell',
  description: 'A resonant disc shaped by the pitches that sound, with its own past standing round it as shells.',
  order: 11,
  icon: 'scene',
  // Bloom follows the level of the music only: light events belong to the world (wave fronts), not to the bloom.
  direction: { capabilities: { particles: true, cameraMotion: true, depth: true, distortion: true }, mappings: [{ source: 'intensity', target: 'bloom', amount: 0.4 }] },
  preset: preset satisfies VisualizerPreset<SpectralShellParams>,
  recipe: spectralShellRecipe,
});
