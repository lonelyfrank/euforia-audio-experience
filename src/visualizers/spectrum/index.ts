import { defineVisualizer } from '../shared/defineVisualizer';
import type { VisualizerPreset } from '../../types/visualizer';
import preset from './preset.json';
import { SpectrumVisualizer, type SpectrumParams } from './SpectrumVisualizer';

export default defineVisualizer<SpectrumParams>({
  id: 'spectrum',
  name: 'Spectrum',
  description: 'Radial spectrogram: a spectrum ring with echoes, voice-shaped core and orbit.',
  order: 2,
  icon: 'spectrum',
  preset: preset satisfies VisualizerPreset<SpectrumParams>,
  create: (p) => new SpectrumVisualizer(p),
});
