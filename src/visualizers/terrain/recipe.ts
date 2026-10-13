import { TerrainPrimitive, terrainQuality } from '../../visual-engine/primitives/TerrainPrimitive';
import type { TerrainParams } from '../../visual-engine/primitives/terrainMotion';
import type { RecipeBuilder } from '../../visual-engine/RecipeVisualizer';

export type GenerativeTerrainParams = TerrainParams;

/**
 * Generative Terrain: the shared world as ground to fly over. A valley that
 * goes on for ever, between walls of low-poly relief, seen from just above
 * its floor; the viewer does not move, the ground travels under it with the
 * world's own travel (the tunnel's motion, on open ground).
 *
 *   ground   the lattice of facets and its wire: the whole scene, always there
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
  const ground = terrainQuality(p, quality);
  return {
    id: 'terrain', seed: p.seed, tilt: 0, memory: 'off', observer: false,
    slots: [{ id: 'ground', base: true, create: (context) => new TerrainPrimitive(context, ground) }],
  };
};
