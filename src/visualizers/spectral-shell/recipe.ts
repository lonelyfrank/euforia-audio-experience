import { unit } from '../../experience/types';
import { MatterPrimitive, matterQuality, type MatterParams } from '../../visual-engine/primitives/MatterPrimitive';
import { ShockwavePrimitive } from '../../visual-engine/primitives/ShockwavePrimitive';
import { RESONANT_DISC, surfaceResolution, WaveSurfacePrimitive } from '../../visual-engine/primitives/WaveSurfacePrimitive';
import type { RecipeBuilder } from '../../visual-engine/RecipeVisualizer';
import type { QualityProfile } from '../../types/visualizer';

export interface SpectralShellParams extends MatterParams {
  /** Seed of the world: the same seed is the same dust. */
  seed: number;
  /** Tilt of the world's axis away from the viewer (rad). */
  tilt: number;
  /** Rings of the live membrane at High quality. */
  rings: number;
  /** Shells of its past round it at High quality, and the age of the oldest (s of audio time). */
  shells: number;
  span: number;
}

/** Rings of a shell relative to the membrane's: the past is drawn coarser than the present. */
const SHELL_DETAIL = 0.6;

/** Fewer shells at lower quality (never fewer than two: one above, one below); the same membrane, the same ages. */
export function shellCount(shells: number, quality: QualityProfile): number {
  const density = Math.min(1, Math.max(0.1, quality.density));
  return Math.max(2, Math.round(shells * (density >= 0.9 ? 1 : density >= 0.6 ? 0.75 : 0.5)));
}

/**
 * Spectral Shell: the circular graph that shows inside Matter Field, on its
 * own. It is the same primitive with the same definition (RESONANT_DISC): a
 * disc held at its rim whose height is the membrane physics the audio engine
 * advances on the audio clock, twelve modes each driven by the pitches that
 * sound, and causal pulses from the events. Here it is the body of the world,
 * and it keeps its past round it:
 *
 *   shell       the live membrane and, round it, the same membrane as it rang a moment ago:   always there
 *               larger and fainter with age, bent into caps above and below
 *   shockwaves  the fronts of the events, visible                                             with any sound
 *   dust        a thin body of free matter under the same fields: the shell shows through it   dense, busy sound
 *
 * The sound gives the shape (which modes ring, how far, where a pulse
 * travels); the world decides how that shape stands in space: its pressure
 * sizes it, stored potential draws the shells in and closes them, an open
 * world holds them apart, its turning twists the stack, a moving centre
 * trails it, disorder tears the older shells, a release throws them open.
 * Nothing is animated: in silence the modes ring out, the memory empties and
 * the shells lie flat and dark.
 */
export const spectralShellRecipe: RecipeBuilder<SpectralShellParams> = (p, quality) => {
  const dust = matterQuality(p, quality);
  return {
    id: 'spectral-shell', seed: p.seed, tilt: p.tilt,
    // The memory is kept at half resolution at most, as in Matter Field: lines leave a short trace of where they were.
    memory: dust.feedback === 'off' ? 'off' : 'half',
    trail: 0.5, spatial: 0.5,
    // An open, wide sound lets the dust fill its volume instead of gathering on shells.
    tune: (fields, g) => { fields.gather *= 1 - 0.5 * g.particleSpread; },
    slots: [
      {
        id: 'shell', base: true,
        create: (context) => new WaveSurfacePrimitive(context, {
          ...RESONANT_DISC, resolution: p.rings, shells: { count: shellCount(p.shells, quality), span: p.span, detail: SHELL_DETAIL },
        }, surfaceResolution(p.rings, quality)),
      },
      // Events are rare and brief: their fronts take little of the budget and form at once.
      { id: 'shockwaves', cost: 0.3, attack: 0.3, release: 1.5, create: (context) => new ShockwavePrimitive(context) },
      {
        id: 'dust', cost: 1,
        // Dust belongs to a full, busy sound; a single clear voice leaves the shell bare.
        affinity: (g) => unit(0.25 + 0.9 * g.density + 0.5 * g.noiseShape),
        create: (context) => new MatterPrimitive(context, dust, { pointSize: p.pointSize, forms: false, mass: 0.5 }),
      },
    ],
  };
};
