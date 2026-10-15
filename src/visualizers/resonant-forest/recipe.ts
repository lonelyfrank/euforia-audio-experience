import { CameraRig, Drift, Glide, type DriftParams, type GlideParams, type RigLimits } from '../../render-systems/camera/locomotion';
import type { ForestSettings } from '../../visual-engine/primitives/forestGrowth';
import { ForestPrimitive } from '../../visual-engine/primitives/ForestPrimitive';
import { TerrainPrimitive, terrainQuality } from '../../visual-engine/primitives/TerrainPrimitive';
import type { TerrainParams } from '../../visual-engine/primitives/terrainMotion';
import type { RecipeBuilder } from '../../visual-engine/RecipeVisualizer';
import { RigCamera } from '../../visual-engine/RigCamera';
import type { PrimitiveSlot } from '../../visual-engine/WorldRecipe';

export interface ResonantForestParams extends TerrainParams {
  /** The trees: where they stand, how they grow, what they remember (forestGrowth.ts). */
  forest: ForestSettings;
  camera?: { glide?: Partial<GlideParams>; drift?: Partial<DriftParams>; limits?: Partial<RigLimits>; look?: number };
}

export const TREES_SLOT = 'trees';
/** How far ahead the observer looks at rest (units). */
const LOOK = 50;

/**
 * Resonant Forest: an abstract forest that grows with the music, flown through slowly (docs/generative-worlds.md).
 *
 *   ground     Generative Terrain's ground with the forest's parameters: low hills, a clearing the flight follows
 *   trees      ForestField + ForestPrimitive: seeded beside the clearing as the ground comes into view, grown from the
 *              music heard then (a fixed shape), mature, resonating when the groove rings or when the music they grew
 *              in comes back, decaying in a breakdown or with age; filaments between trees that remember the same music
 *   observer   Glide + Drift: slow forward glide, a wander across the clearing that never reaches the trees (the
 *              drift's corridor is narrower than the clearing their crowns are kept out of)
 *
 * Nothing here is a copy of the terrain or of the emergence: the ground is TerrainPrimitive, the trees are anchored by
 * the terrain law on its own uniforms, as the emergence's structures are.
 */
export const resonantForestRecipe: RecipeBuilder<ResonantForestParams> = (p, quality) => {
  const params = terrainQuality(p, quality), c = p.camera ?? {};
  let ground: TerrainPrimitive | null = null;
  // The ground banks itself into the world's turn: the glide does not bank it twice.
  const rig = new CameraRig([{ profile: new Glide({ bank: 0, ...c.glide }), weight: 1 }, { profile: new Drift(c.drift), weight: 1 }], { tz: -(c.look ?? LOOK) }, c.limits);
  const camera = new RigCamera(rig);
  const slots: PrimitiveSlot[] = [{ id: 'ground', base: true, create: (context) => (ground = new TerrainPrimitive(context, params)) }];
  // After the ground: the trees read the ground of this frame, through the same uniforms. Switched off: the hills alone.
  if (p.forest.enabled !== false) slots.push({ id: TREES_SLOT, base: true, create: (context) => new ForestPrimitive(context, ground!, p.forest, context.quality) });
  return { id: 'resonant-forest', seed: p.seed, tilt: 0, memory: 'off', observer: false, camera, slots };
};
