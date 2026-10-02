import { defineVisualizer } from '../shared/defineVisualizer';
import type { VisualizerPreset } from '../../types/visualizer';
import preset from './preset.json';
import { GalaxyVisualizer, type GalaxyParams } from './GalaxyVisualizer';

export default defineVisualizer<GalaxyParams>({
  id: 'galaxy',
  name: 'Galaxy',
  description: 'A three-armed spiral disc that swells on the kick.',
  icon: 'galaxy',
  order: 4,
  direction: {
    capabilities: { particles: true, cameraMotion: true, distortion: true, depth: true, rotation: true },
    mappings: [
      { source: 'mid', target: 'distortion', amount: 0.75 },
      { source: 'flux', target: 'distortion', amount: 0.25 },
      { source: 'warmth', target: 'expansion', amount: 0.3 },
      { source: 'openness', target: 'expansion', amount: 0.4 },
      { source: 'release', target: 'expansion', amount: 0.4 },
    ],
  },
  preset: preset satisfies VisualizerPreset<GalaxyParams>,
  create: (p) => new GalaxyVisualizer(p),
});
