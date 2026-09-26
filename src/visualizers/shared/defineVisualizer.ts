import type { VisualizerDefinition } from '../../types/visualizer';

/** Identity helper that ties a preset's `visual` block to its factory's type. */
export function defineVisualizer<TVisual>(definition: VisualizerDefinition<TVisual>): VisualizerDefinition {
  return definition as unknown as VisualizerDefinition;
}
