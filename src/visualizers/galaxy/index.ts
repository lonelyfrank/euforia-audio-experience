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
  preset: preset satisfies VisualizerPreset<GalaxyParams>,
  create: (p) => new GalaxyVisualizer(p),
});
