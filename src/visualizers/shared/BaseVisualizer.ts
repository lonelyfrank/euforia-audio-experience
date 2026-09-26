import { PerspectiveCamera, Scene } from 'three';
import type { AudioFrame } from '../../types/audio';
import type { PaletteColors, Visualizer, VisualizerContext, VisualizerPreset } from '../../types/visualizer';
import { disposeObject } from './dispose';

/**
 * Common plumbing for perspective-camera visualizers: scene/camera creation
 * from the preset, aspect handling and full GPU cleanup on dispose.
 */
export abstract class BaseVisualizer<TVisual> implements Visualizer {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;

  constructor(protected readonly preset: VisualizerPreset<TVisual>) {
    this.camera = new PerspectiveCamera(preset.camera.fov, 1, 0.1, 500);
  }

  abstract init(context: VisualizerContext): void;
  abstract setPalette(colors: PaletteColors): void;
  abstract update(frame: AudioFrame, deltaTime: number, time: number): void;

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    disposeObject(this.scene);
    this.scene.clear();
  }
}
