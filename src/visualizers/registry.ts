import type { VisualizerDefinition } from '../types/visualizer';

/**
 * Every `visualizers/<name>/index.ts` default-exports a VisualizerDefinition.
 * They are discovered at build time: adding a visualizer = adding a folder.
 */
const modules = import.meta.glob<VisualizerDefinition>('./*/index.ts', { eager: true, import: 'default' });

export const visualizers: readonly VisualizerDefinition[] = Object.values(modules).sort((a, b) => a.order - b.order);

export function findVisualizer(id: string): VisualizerDefinition | undefined {
  return visualizers.find((v) => v.id === id);
}

