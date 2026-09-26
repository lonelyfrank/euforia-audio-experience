import { defineVisualizer } from '../shared/defineVisualizer';
import type { VisualizerPreset } from '../../types/visualizer';
import preset from './preset.json';
import { OscilloscopeVisualizer, type OscilloscopeParams } from './OscilloscopeVisualizer';

export default defineVisualizer<OscilloscopeParams>({
  id: 'oscilloscope',
  name: 'Oscilloscope',
  description: 'Three luminous waveform lines with phosphor persistence.',
  order: 6,
  icon: 'scope',
  preset: preset satisfies VisualizerPreset<OscilloscopeParams>,
  create: (p) => new OscilloscopeVisualizer(p),
});
