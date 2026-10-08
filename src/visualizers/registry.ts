import type { VisualizerDefinition } from '../types/visualizer';

/**
 * Every `visualizers/<name>/index.ts` default-exports a VisualizerDefinition.
 * They are discovered at build time: adding a visualizer = adding a folder.
 */
const modules = import.meta.glob<VisualizerDefinition>('./*/index.ts', { eager: true, import: 'default' });

export const visualizers: readonly VisualizerDefinition[] = Object.values(modules).sort((a, b) => a.order - b.order);

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

