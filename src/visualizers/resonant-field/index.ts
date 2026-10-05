import { defineVisualizer } from '../shared/defineVisualizer';
import type { VisualizerPreset } from '../../types/visualizer';
import preset from './preset.json';
import { ResonantFieldVisualizer, type ResonantFieldParams } from './ResonantFieldVisualizer';
export default defineVisualizer<ResonantFieldParams>({
  id: 'resonant-field', name: 'Resonant Field', description: 'Resonant modes and reflecting waves excited by live sound.',
  icon: 'scene', order: 7,
  direction: { capabilities: { distortion: true, depth: true, rotation: true } },
  preset: preset satisfies VisualizerPreset<ResonantFieldParams>,
  create: p => new ResonantFieldVisualizer(p),
});
