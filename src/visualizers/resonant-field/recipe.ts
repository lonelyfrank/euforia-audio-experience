import { surfaceResolution, WaveSurfacePrimitive } from '../../visual-engine/primitives/WaveSurfacePrimitive';
import type { RecipeBuilder } from '../../visual-engine/RecipeVisualizer';
import type { ResonantFieldParams } from './ResonantFieldVisualizer';

/**
 * Resonant Field as a visual world: the same membrane of points (modes and
 * causal, reflecting pulses from ResonantPhysics), now the shared wave
 * surface primitive in a world of its own. What the scene did by hand it gets
 * from the shared systems: its size follows the radius the fields hold the
 * matter at, it turns with the world's structure, the stereo width stretches
 * it and the lateral force tilts it. What it gains: the world's dated fronts
 * cross it, and the geometry shapes it (pressure bows it, roughness ripples
 * it, a stepped voice terraces it), by a share so it stays the scene it was.
 * It is a recipe of one primitive; particles and filaments of the same world
 * can join it with a line each (docs/visual-engine.md).
 */
/**
 * Light of one point. The scene used to draw an indexed plane as points, so every point was submitted about six
 * times and added its light six times over; here each is drawn once and carries that light itself (same picture,
 * a sixth of the vertices), less what the shared material's light is brighter than the scene's own was.
 */
const EXPOSURE = 4.2;

export const resonantFieldRecipe: RecipeBuilder<ResonantFieldParams> = (p, quality) => ({
  id: 'resonant-field', seed: 20261005, tilt: 0.5, roll: Math.PI / 4, memory: 'off', observer: false,
  slots: [{
    id: 'membrane', base: true,
    create: (context) => new WaveSurfacePrimitive(context, {
      topology: 'grid', style: 'points', plane: 'equator', size: 3, follow: 0.4, turn: true, grammar: 0.6, relief: 2.5 / 3, pointSize: 2.3, exposure: EXPOSURE,
      resolution: p.resolution,
    }, Math.max(32, surfaceResolution(p.resolution, quality))),
  }],
});
