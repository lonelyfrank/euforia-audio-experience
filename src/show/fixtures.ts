import type { FixtureSpec } from './types';

/**
 * The scenes as fixtures: relative GPU cost (measured on the Intel iGPU:
 * Liquid's phosphor and Oscilloscope's afterimage make them heavier at High)
 * and where each fits in a song.
 */
export const FIXTURES: readonly FixtureSpec[] = [
  { id: 'resonant-field', cost: 1, affinity: { intro: 0.8, build: 0.7, drop: 0.6, break: 0.9, outro: 0.9 } },
  { id: 'liquid', cost: 1.2, affinity: { intro: 0.8, build: 0.5, drop: 0.4, break: 0.9, outro: 0.9 } },
  { id: 'galaxy', cost: 1, affinity: { intro: 0.7, build: 0.6, drop: 0.7, break: 0.8, outro: 0.8 } },
  { id: 'tunnel', cost: 1, affinity: { intro: 0.4, build: 0.9, drop: 1, break: 0.3, outro: 0.4 } },
  { id: 'particle-field', cost: 1, affinity: { intro: 0.5, build: 0.8, drop: 0.9, break: 0.5, outro: 0.6 } },
  { id: 'oscilloscope', cost: 0.9, affinity: { intro: 0.9, build: 0.6, drop: 0.5, break: 0.7, outro: 0.7 } },
  { id: 'spectral-matter', cost: 1.2, affinity: { intro: 0.7, build: 0.9, drop: 0.9, break: 0.7, outro: 0.7 } },
  { id: 'matter-field', cost: 1.2, affinity: { intro: 0.75, build: 0.9, drop: 0.95, break: 0.75, outro: 0.7 } },
  { id: 'vector-field', cost: 1, affinity: { intro: 0.8, build: 0.85, drop: 0.85, break: 0.8, outro: 0.75 } },
  { id: 'spectral-shell', cost: 1, affinity: { intro: 0.85, build: 0.8, drop: 0.8, break: 0.9, outro: 0.85 } },
  { id: 'spectrum', cost: 0.9, affinity: { intro: 0.7, build: 0.7, drop: 0.8, break: 0.6, outro: 0.6 } },
];

export function fixtureById(id: string): FixtureSpec | undefined {
  return FIXTURES.find((f) => f.id === id);
}
