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
  direction: { capabilities: { particles: true, cameraMotion: true, distortion: true, depth: true }, mappings: [{ source: 'intensity', target: 'particleEmission', amount: 0.6 }, { source: 'high', target: 'particleEmission', amount: 0.4 }] },
  preset: preset satisfies VisualizerPreset<ParticleFieldParams>,
  create: (p) => new ParticleFieldVisualizer(p),
});
