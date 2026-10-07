import type { VisualizerPreset } from '../../types/visualizer';
import { RecipeVisualizer } from '../../visual-engine/RecipeVisualizer';
import { defineVisualizer } from '../shared/defineVisualizer';
import preset from './preset.json';
import { resonantFieldRecipe } from './recipe';
import { ResonantFieldVisualizer, type ResonantFieldParams } from './ResonantFieldVisualizer';

/**
 * Development only: `?legacy=resonant-field` mounts the scene as it was before it became a recipe, to compare the
 * two side by side while the migration is judged by eye.
 */
const legacy = import.meta.env.DEV && typeof location !== 'undefined' && (new URLSearchParams(location.search).get('legacy') ?? '').split(',').includes('resonant-field');

export default defineVisualizer<ResonantFieldParams>({
  id: 'resonant-field', name: 'Resonant Field', description: 'Resonant modes and reflecting waves excited by live sound.',
  icon: 'scene', order: 7,
  direction: { capabilities: { distortion: true, depth: true } },
  preset: preset satisfies VisualizerPreset<ResonantFieldParams>,
  create: (p) => (legacy ? new ResonantFieldVisualizer(p) : new RecipeVisualizer(p, resonantFieldRecipe)),
});
