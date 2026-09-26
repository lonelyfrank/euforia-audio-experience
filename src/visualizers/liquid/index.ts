import { defineVisualizer } from '../shared/defineVisualizer';
import type { VisualizerPreset } from '../../types/visualizer';
import preset from './preset.json';
import { LiquidVisualizer, type LiquidParams } from './LiquidVisualizer';

export default defineVisualizer<LiquidParams>({
  id: 'liquid',
  name: 'Liquid',
  description: 'Layered ribbons over the horizon: lows on the bottom, highs in the sky.',
  icon: 'liquid',
  order: 5,
  preset: preset satisfies VisualizerPreset<LiquidParams>,
  create: (p) => new LiquidVisualizer(p),
});
