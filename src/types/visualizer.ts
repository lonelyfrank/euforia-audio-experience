import type { Camera, Color, Scene, WebGLRenderer } from 'three';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { AudioFrame, VisualResponseFrame } from './audio';

export type QualitySetting = 'auto' | 'low' | 'medium' | 'high';

/** Concrete knobs derived from a quality setting. */
export interface QualityProfile {
  level: QualitySetting;
  /** Multiplier on the (capped) device pixel ratio. */
  pixelScale: number;
  /** Upper bound for devicePixelRatio. */
  maxPixelRatio: number;
  /** Multiplier for particle / instance counts (1 = preset value). */
  density: number;
  bloom: boolean;
}

/**
 * Serializable description of how a visualizer looks and reacts.
 * Stored as `preset.json` next to each visualizer; in the future presets will
 * be importable from the community, so they must stay plain JSON.
 */
export interface VisualizerPreset<TVisual = Record<string, unknown>> {
  name: string;
  author: string;
  version: number;
  audio: {
    /** Multiplier on the user's sensitivity. */
    sensitivity: number;
    /** Multiplier on the user's smoothing. */
    smoothing: number;
  };
  camera: {
    fov: number;
    distance: number;
    /** Amount of slow ambient camera motion, 0 = static. */
    drift: number;
  };
  bloom: {
    strength: number;
    radius: number;
    threshold: number;
  };
  visual: TVisual;
}

/** Per-frame audio input of the render engine: stable objects, updated in place. */
export interface SceneInput {
  audio: AudioFrame;
  response: VisualResponseFrame;
}

/** What the engine hands to a visualizer when it is mounted. */
export interface VisualizerContext {
  renderer: WebGLRenderer;
  width: number;
  height: number;
  quality: QualityProfile;
  /**
   * Adds a post-processing pass, either before bloom (e.g. trails) or after it
   * (e.g. screen effects; default). Passes are disposed on unmount.
   */
  addPass(pass: Pass, stage?: 'pre-bloom' | 'post-bloom'): void;
}

/** The three hues of the active preset, as linear three.js colours. */
export type PaletteColors = readonly [Color, Color, Color];

/**
 * Contract every visualizer implements. A visualizer owns its scene and
 * camera and only ever sees AudioFrame values, never the audio source.
 */
export interface Visualizer {
  readonly scene: Scene;
  readonly camera: Camera;
  init(context: VisualizerContext): void;
  /** Called after init and whenever the preset (palette) changes. Must not allocate. */
  setPalette(colors: PaletteColors): void;
  /** `response` is derived from `frame` (musical roles: weight, flow, detail, impact…); both are read-only and reused. */
  update(frame: AudioFrame, deltaTime: number, time: number, response: VisualResponseFrame): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** Icons available for scenes in the Scene ring (see ui/icons.ts). */
export type SceneIcon = 'tunnel' | 'spectrum' | 'particles' | 'galaxy' | 'liquid' | 'scope' | 'scene';

/** Registry entry: metadata + factory. Exported as default by each visualizer module. */
export interface VisualizerDefinition<TVisual = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  icon: SceneIcon;
  /** Sort order in the UI. */
  order: number;
  preset: VisualizerPreset<TVisual>;
  create(preset: VisualizerPreset<TVisual>): Visualizer;
}
