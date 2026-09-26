import { defineVisualizer } from '../shared/defineVisualizer';
import type { VisualizerPreset } from '../../types/visualizer';
import preset from './preset.json';
import { ParticleFieldVisualizer, type ParticleFieldParams } from './ParticleFieldVisualizer';

export default defineVisualizer<ParticleFieldParams>({
  id: 'particle-field',
  name: 'Particle Field',
  description: 'A 3D particle flight pushed by bass and mids.',
  order: 3,
  icon: 'particles',
  preset: preset satisfies VisualizerPreset<ParticleFieldParams>,
  create: (p) => new ParticleFieldVisualizer(p),
});
