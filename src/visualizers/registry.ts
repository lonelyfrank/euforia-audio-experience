import { SCENE_CATEGORIES, type SceneCategory, type VisualizerDefinition } from '../types/visualizer';

/**
 * Every `visualizers/<name>/index.ts` default-exports a VisualizerDefinition.
 * They are discovered at build time: adding a visualizer = adding a folder.
 */
const modules = import.meta.glob<VisualizerDefinition>('./*/index.ts', { eager: true, import: 'default' });

export const visualizers: readonly VisualizerDefinition[] = Object.values(modules).sort((a, b) => a.order - b.order);

/** The scenes of one family, in the registry's order. */
export function scenesOf(category: SceneCategory): VisualizerDefinition[] {
  return visualizers.filter((v) => v.category === category);
}

/** The families that hold at least one scene, in their fixed order (SCENE_CATEGORIES): what the Scene ring shows. */
export function sceneCategories(): typeof SCENE_CATEGORIES[number][] {
  return SCENE_CATEGORIES.filter((c) => visualizers.some((v) => v.category === c.id));
}

/** The family of a scene (product or laboratory), or undefined for an id nobody registered. */
export function categoryOf(id: string): SceneCategory | undefined {
  return findVisualizer(id)?.category;
}

/**
 * Scenes the development tools mount beside the product's (the engine cockpit's laboratories). They can be shown by id
 * but are not in `visualizers`: no menu lists them, the show never picks them and nothing saves them as a choice.
 */
const laboratories: VisualizerDefinition[] = [];

/** Makes a development scene mountable by id. Returns a function that withdraws it. */
export function registerLaboratory(definition: VisualizerDefinition): () => void {
  if (!laboratories.includes(definition)) laboratories.push(definition);
  return () => {
    const at = laboratories.indexOf(definition);
    if (at >= 0) laboratories.splice(at, 1);
  };
}

export function findVisualizer(id: string): VisualizerDefinition | undefined {
  return visualizers.find((v) => v.id === id) ?? laboratories.find((v) => v.id === id);
}

