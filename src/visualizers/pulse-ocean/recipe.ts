import { CameraRig, Drift, Glide, type DriftParams, type GlideParams, type RigLimits } from '../../render-systems/camera/locomotion';
import { BEHIND, oceanHeight, SWELLS } from '../../visual-engine/primitives/oceanLaw';
import type { OceanParams } from '../../visual-engine/primitives/oceanMotion';
import { OceanPrimitive, oceanQuality } from '../../visual-engine/primitives/OceanPrimitive';
import type { RecipeBuilder } from '../../visual-engine/RecipeVisualizer';
import { RigCamera } from '../../visual-engine/RigCamera';

export interface PulseOceanParams extends OceanParams {
  camera?: { glide?: Partial<GlideParams>; drift?: Partial<DriftParams>; limits?: Partial<RigLimits>; look?: number };
}

export const SEA_SLOT = 'sea';
/** How far ahead the observer looks at rest (units). */
const LOOK = 80;

/**
 * Pulse Ocean: an endless geometric sea glided over (docs/generative-worlds.md). No fluid is simulated: the sea is a
 * lattice the mesh slides over, its height the ocean law (a few travelling waves on three scales, the world's fronts,
 * a release front), its motion the sea's reading of the world (oceanMotion.ts).
 *
 *   sea        OceanPrimitive: swell from the persistent energy and the structure, the groove of the lows in the middle
 *              waves (peaked by hard mids), the highs as ripples and glints; a release runs away as a front and leaves
 *              the sea in another configuration
 *   observer   Glide + Drift: a steady height that rides the long swell under it, the sea carried past by the world's
 *              travel, a slow wander across its corridor whose bends follow turbulence and coherence
 *
 * The horizon stays readable: the observer's height is fixed but for the swell it rides, the lens and the roll are
 * bounded, and the sea fades into the dark at its far end. In silence the waves flatten and stand still.
 */
export const pulseOceanRecipe: RecipeBuilder<PulseOceanParams> = (p, quality) => {
  const params = oceanQuality(p, quality), c = p.camera ?? {};
  let sea: OceanPrimitive | null = null;
  const glide = new Glide({ ride: 0.35, ...c.glide });
  // The observer rides the long swell under where it stands (the sea's own law, its first waves only).
  glide.surface = (x, z) => {
    if (!sea) return 0;
    const v = sea.motion.values;
    return oceanHeight(v, sea.motion.swell, x / v.cell + v.shiftX, -z / v.cell + v.shift + BEHIND, undefined, undefined, SWELLS);
  };
  const rig = new CameraRig([{ profile: glide, weight: 1 }, { profile: new Drift(c.drift), weight: 1 }], { tz: -(c.look ?? LOOK) }, c.limits);
  const camera = new RigCamera(rig, undefined, (r) => { if (sea) sea.advance = r.advance; });
  return {
    id: 'pulse-ocean', seed: p.seed, tilt: 0, memory: 'off', observer: false, camera,
    slots: [{ id: SEA_SLOT, base: true, create: (context) => (sea = new OceanPrimitive(context, params)) }],
  };
};
