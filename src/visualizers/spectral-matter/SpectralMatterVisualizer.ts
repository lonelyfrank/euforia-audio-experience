import type { VisualizerPreset } from '../../types/visualizer';
import { MatterPrimitive } from '../../visual-engine/primitives/MatterPrimitive';
import { RecipeVisualizer, type RecipeBuilder } from '../../visual-engine/RecipeVisualizer';
import { matterQuality, type SpectralMatterParams } from './mapping';

/**
 * A persistent body of matter under the fields of the shared world: the
 * laboratory of the matter engine (docs/matter-engine.md). It has no final
 * shape. As free matter it is cloud, shells, disc, vortex, filaments and
 * grains; where the sound is one repeating cycle part of it gathers on the
 * curve the waveform draws (ring, ribbons, a surface receding in time); where
 * the sound is stacked partials part of it condenses on the network they span
 * (filaments, polygons). The same elements pass from one state to another and
 * back to particles: nothing is created for a shape or removed with it.
 *
 * As a recipe it is the smallest visual world there is: the matter alone,
 * with the world's shared fields, fronts, material, memory and observer
 * (docs/visual-engine.md). Matter Field adds the other primitive systems to
 * the same body.
 */
export const spectralMatterRecipe: RecipeBuilder<SpectralMatterParams> = (p, quality) => {
  const q = matterQuality(p, quality);
  return {
    id: 'spectral-matter', seed: p.seed, tilt: p.tilt, memory: q.feedback,
    slots: [{ id: 'matter', base: true, create: (context) => new MatterPrimitive(context, q, { pointSize: p.pointSize, forms: true }) }],
  };
};

export class SpectralMatterVisualizer extends RecipeVisualizer<SpectralMatterParams> {
  constructor(preset: VisualizerPreset<SpectralMatterParams>) {
    super(preset, spectralMatterRecipe);
  }
}
