import { TOPOLOGY_VALUES } from '../../render-systems/fields/vectorField';
import { DEFAULT_SOLID_BUDGET } from '../structural/SolidTypes';
import type { PrimitiveSlot } from '../WorldRecipe';
import { SolidPrimitive, type SolidPopulation } from './SolidPrimitive';

/*
 * Solids among the matter of a Particles scene: an experiment of the development tools (docs/scene-families.md), not
 * part of any product recipe. A world that runs takes the slot with `VisualWorld.add` and gives it back with `remove`,
 * so the scene without it is the scene as it always was. The bodies are those of the structural engine (one solver,
 * SolidSystem): they sample the same fields and fronts as the scene's matter, form from free elements when the world
 * lets them, hold their shape (rigid material), and break only on the musical cues a scene may act on.
 */

export const SOLIDS_SLOT = 'solids';

/** Three small bodies round the matter's shell, seeded apart: the scene's particles stay what they are, these few form. */
export const MIXED_POPULATION: Readonly<SolidPopulation> = {
  start: 'free', fracture: 'release', profile: 'rigid',
  bodies: [
    { kind: 'tetrahedron', radius: 0.22, x: 0.78, y: 0.18, z: 0.1, turn: 0.3, tilt: 0.5 },
    { kind: 'cube', radius: 0.2, x: -0.72, y: -0.12, z: 0.2, turn: 1.1, tilt: 0.4 },
    { kind: 'icosahedron', radius: 0.24, x: 0.05, y: 0.62, z: -0.3, turn: 2, tilt: 0.7 },
  ],
};

/** The slot a world mounts to hold a population of solids: always present while mounted, outside the structural budget. */
export function solidSlot(population: Readonly<SolidPopulation> = MIXED_POPULATION, pointSize = 2.4): PrimitiveSlot {
  return {
    id: SOLIDS_SLOT, base: true,
    create: (context) => new SolidPrimitive(context, { solid: 0, solidRadius: 0.2, pointSize }, new Float32Array(TOPOLOGY_VALUES), DEFAULT_SOLID_BUDGET, population),
  };
}
