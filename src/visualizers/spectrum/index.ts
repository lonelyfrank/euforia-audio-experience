import { defineVisualizer } from '../shared/defineVisualizer';
import type { VisualizerPreset } from '../../types/visualizer';
import preset from './preset.json';
import { SpectrumVisualizer, type SpectrumParams } from './SpectrumVisualizer';

export default defineVisualizer<SpectrumParams>({
  id: 'spectrum',
  name: 'Spectrum',
  description: '128 radial bars around a pulsing core.',
  order: 2,
  icon: 'spectrum',
  preset: preset satisfies VisualizerPreset<SpectrumParams>,
  create: (p) => new SpectrumVisualizer(p),
});
