import { defineVisualizer } from '../shared/defineVisualizer';
import type { VisualizerPreset } from '../../types/visualizer';
import preset from './preset.json';
import { TunnelVisualizer, type TunnelParams } from './TunnelVisualizer';

export default defineVisualizer<TunnelParams>({
  id: 'tunnel',
  name: 'Infinite Tunnel',
  description: 'An endless bending tunnel that breathes with the bass.',
  order: 1,
  icon: 'tunnel',
  direction: { capabilities: { particles: true, cameraMotion: true, distortion: true, depth: true, rotation: true }, mappings: [{ source: 'low', target: 'distortion', amount: 0.55 }, { source: 'tension', target: 'distortion', amount: 0.4 }] },
  preset: preset satisfies VisualizerPreset<TunnelParams>,
  create: (p) => new TunnelVisualizer(p),
});
