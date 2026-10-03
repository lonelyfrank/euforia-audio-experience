import type { ModulationState, SceneDirection } from '../director/types';
import type { Camera, Color, Scene, WebGLRenderer } from 'three';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { AudioFrame, MusicState, VisualResponseFrame } from './audio';

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

/**
 * Where the scene sits in the window (fractions of width/height from the
 * top-left). With the water reflection the scene sits above a fixed horizon;
 * without it the scene uses the whole window and floats gently with the music.
 */
export interface SceneLayout {
  centerX: number;
  centerY: number;
  /** Line ground-anchored scenes rest on (the water's edge when the reflection is on). */
  horizon: number;
  /** 0..1: how much of the water reflection is showing (animated when toggled). */
  reflection: number;
}

/** Per-frame audio input of the render engine: stable objects, updated in place. */
export interface SceneInput {
  audio: AudioFrame;
  response: MusicState;
  /** Fixture values from the Dynamics layer (read every frame; stable object). */
  rig?: RigValues;
}

/** Fixture parameters driven by the Dynamics layer (migrated one at a time). */
export interface RigValues {
  /** Audio clock (s) heard when this frame is seen: the Dynamics clock. */
  time: number;
  /** Whether `time` is valid (the clock is synchronized). */
  timed: boolean;
  /** Halo composition: the brief halo pulse on beats and kicks (instant attack, decay). */
  haloPulse: number;
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
  update(frame: AudioFrame, deltaTime: number, time: number, response: VisualResponseFrame, modulation?: ModulationState): void;
  /** Optional: called when the layout changes (reflection toggled, floating without it). Must not allocate. */
  setLayout?(layout: SceneLayout): void;
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
  direction?: SceneDirection;
  preset: VisualizerPreset<TVisual>;
  create(preset: VisualizerPreset<TVisual>): Visualizer;
}
