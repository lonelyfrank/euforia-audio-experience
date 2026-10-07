import { unit } from '../../experience/types';
import { ConnectionGraphPrimitive, graphNodes, type GraphParams } from '../../visual-engine/primitives/ConnectionGraphPrimitive';
import { FilamentPrimitive, filamentQuality, type FilamentParams } from '../../visual-engine/primitives/FilamentPrimitive';
import { MatterPrimitive, matterQuality, type MatterParams } from '../../visual-engine/primitives/MatterPrimitive';
import { ShockwavePrimitive } from '../../visual-engine/primitives/ShockwavePrimitive';
import { surfaceResolution, WaveSurfacePrimitive } from '../../visual-engine/primitives/WaveSurfacePrimitive';
import type { RecipeBuilder } from '../../visual-engine/RecipeVisualizer';

export interface MatterFieldParams extends MatterParams, FilamentParams, GraphParams {
  /** Seed of the world: the same seed is the same matter, filaments and lattice. */
  seed: number;
  /** Tilt of the world's axis away from the viewer (rad). */
  tilt: number;
  /** Rings of the membrane at High quality. */
  surface: number;
}

/**
 * Matter Field: one persistent world in which the sound takes shape. A body
 * of matter is always there (free particles that condense on the waveform's
 * curve and on the partials' network); around and through it the other
 * primitive systems form as the music can carry them, in this order, and
 * dissolve again:
 *
 *   shockwaves  the fronts of the events, visible                 with any sound
 *   filaments   the world's flow as lines, vibrating as the voices  continuous, moving sound
 *   surface     a membrane through the body: modes, pulses, ripples sustained, resonant sound
 *   graph       a cage of joints round the matter                  ordered, related sound
 *
 * All of them read the same fields, the same fronts and the same geometry, so
 * a vortex winds the particles, the filaments, the lattice and the membrane
 * together, a build tightens them together and a release opens them together.
 * Nothing is switched on a cue and nothing is rebuilt: structures form,
 * break and close again as the world does.
 */
export const matterFieldRecipe: RecipeBuilder<MatterFieldParams> = (p, quality) => {
  const matter = matterQuality(p, quality), filaments = filamentQuality(p, quality);
  return {
    id: 'matter-field', seed: p.seed, tilt: p.tilt,
    // The memory is kept at half resolution at most: more is drawn here than in a body of matter alone.
    memory: matter.feedback === 'off' ? 'off' : 'half',
    trail: 0.5, spatial: 0.5,
    // An open, wide sound lets the matter fill its volume instead of gathering on shells.
    tune: (fields, g) => { fields.gather *= 1 - 0.5 * g.particleSpread; },
    slots: [
      { id: 'matter', base: true, create: (context) => new MatterPrimitive(context, matter, { pointSize: p.pointSize, forms: true, mass: 0.5 }) },
      // Events are rare and brief: their fronts take little of the budget and form at once.
      { id: 'shockwaves', cost: 0.3, attack: 0.3, release: 1.5, create: (context) => new ShockwavePrimitive(context) },
      {
        id: 'filaments', cost: 1,
        affinity: (g) => unit(0.2 + 1.2 * Math.max(g.tonalShape, g.continuity) + 0.6 * g.waveVelocity),
        create: (context) => new FilamentPrimitive(context, filaments),
      },
      {
        id: 'surface', cost: 1,
        affinity: (g) => unit(0.15 + 1.3 * g.elasticity + 0.8 * g.surfaceDisplacement),
        create: (context) => new WaveSurfacePrimitive(context, {
          topology: 'polar', style: 'wire', plane: 'axial', size: 1.35, follow: 1, turn: true, grammar: 1, relief: 1.2, pointSize: 2, exposure: 0.6,
          resolution: p.surface,
        }, surfaceResolution(p.surface, quality)),
      },
      {
        id: 'graph', cost: 1,
        affinity: (g) => unit(2.4 * g.connectionRadius * (1 - 0.5 * g.fragmentation)),
        create: (context) => new ConnectionGraphPrimitive(context, graphNodes(p, quality), 2.2),
      },
    ],
  };
};
