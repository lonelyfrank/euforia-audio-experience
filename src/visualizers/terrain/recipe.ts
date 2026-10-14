import { EmergencePrimitive } from '../../visual-engine/primitives/EmergencePrimitive';
import type { EmergenceSettings } from '../../visual-engine/primitives/terrainEmergence';
import { TerrainPrimitive, terrainQuality } from '../../visual-engine/primitives/TerrainPrimitive';
import type { TerrainParams } from '../../visual-engine/primitives/terrainMotion';
import type { RecipeBuilder } from '../../visual-engine/RecipeVisualizer';
import type { PrimitiveSlot } from '../../visual-engine/WorldRecipe';

export interface GenerativeTerrainParams extends TerrainParams {
  /** Structures that rise out of the ground (docs/scene-families.md); absent or `enabled: false`: the ground alone, as it was. */
  emergence?: EmergenceSettings;
}

export const EMERGENCE_SLOT = 'emergence';

/** The slot of the structures standing on `ground` (the primitive the ground slot created): mounted after it, updated after it. */
export function emergenceSlot(ground: () => TerrainPrimitive, params: EmergenceSettings): PrimitiveSlot {
  return { id: EMERGENCE_SLOT, base: true, create: (context) => new EmergencePrimitive(context, ground(), params, context.quality) };
}

/**
 * Generative Terrain: the shared world as ground to fly over. A valley that
 * goes on for ever, between walls of low-poly relief, seen from just above
 * its floor; the viewer does not move, the ground travels under it with the
 * world's own travel (the tunnel's motion, on open ground).
 *
 *   ground      the lattice of facets and its wire: the scene's body, always there
 *   emergence   structures rising out of the ground where it is, when the music asks for them (optional)
 *
 * One primitive, no visual memory and no observer: the view is the flight's.
 * What the music does to the ground is the terrain's reading of the world
 * (visual-engine/primitives/terrainMotion.ts) and the terrain law
 * (terrainLaw.ts); the wave fronts that cross it are the world's own, the
 * same every recipe shares. In a silent, still world the landscape is there,
 * dim, and nothing moves.
 *
 * An environment of its own: nothing here knows of the tunnel, and the tunnel
 * knows nothing of it (docs/generative-terrain.md, docs/world-transitions.md).
 */
export const terrainRecipe: RecipeBuilder<GenerativeTerrainParams> = (p, quality) => {
  const params = terrainQuality(p, quality);
  let ground: TerrainPrimitive | null = null;
  const slots: PrimitiveSlot[] = [{ id: 'ground', base: true, create: (context) => (ground = new TerrainPrimitive(context, params)) }];
  // After the ground, so it is created and updated first: what stands on it reads the ground of this frame.
  if (p.emergence?.enabled) slots.push(emergenceSlot(() => ground!, p.emergence));
  return { id: 'terrain', seed: p.seed, tilt: 0, memory: 'off', observer: false, slots };
};
