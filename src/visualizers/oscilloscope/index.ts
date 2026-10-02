import { defineVisualizer } from '../shared/defineVisualizer';
import type { VisualizerPreset } from '../../types/visualizer';
import preset from './preset.json';
import { OscilloscopeVisualizer, type OscilloscopeParams } from './OscilloscopeVisualizer';

export default defineVisualizer<OscilloscopeParams>({
  id: 'oscilloscope',
  name: 'Oscilloscope',
  description: 'Three-channel scope: the input, the bass line and the lead, with phosphor persistence.',
  order: 6,
  icon: 'scope',
  direction: { capabilities: { distortion: true }, mappings: [{ source: 'mid', target: 'distortion', amount: 0.65 }, { source: 'low', target: 'scale', amount: 0.65 }] },
  preset: preset satisfies VisualizerPreset<OscilloscopeParams>,
  create: (p) => new OscilloscopeVisualizer(p),
});
