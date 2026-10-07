import { defineVisualizer } from '../shared/defineVisualizer';
import type { VisualizerPreset } from '../../types/visualizer';
import preset from './preset.json';
import type { SpectralMatterParams } from './mapping';
import { SpectralMatterVisualizer } from './SpectralMatterVisualizer';

export default defineVisualizer<SpectralMatterParams>({
  id: 'spectral-matter',
  name: 'Spectral Matter',
  description: 'Persistent matter shaped by the fields, waves and memory of the world.',
  order: 8,
  icon: 'scene',
  // Bloom follows the level of the music only: light events belong to the matter (wave fronts), not to the bloom.
  direction: { capabilities: { particles: true, cameraMotion: true, depth: true }, mappings: [{ source: 'intensity', target: 'bloom', amount: 0.4 }] },
  preset: preset satisfies VisualizerPreset<SpectralMatterParams>,
  create: (p) => new SpectralMatterVisualizer(p),
});
