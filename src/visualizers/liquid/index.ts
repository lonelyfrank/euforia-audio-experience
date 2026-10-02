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
  direction: { capabilities: { distortion: true }, mappings: [{ source: 'mid', target: 'distortion', amount: 0.5 }, { source: 'warmth', target: 'distortion', amount: 0.25 }, { source: 'flux', target: 'turbulence', amount: 0.7 }, { source: 'release', target: 'turbulence', amount: 0.3 }] },
  preset: preset satisfies VisualizerPreset<LiquidParams>,
  create: (p) => new LiquidVisualizer(p),
});
