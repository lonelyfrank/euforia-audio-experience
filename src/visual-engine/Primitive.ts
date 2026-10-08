import type { Object3D, WebGLRenderer } from 'three';
import type { ModulationState } from '../director/types';
import type { ExperienceSnapshot } from '../experience/types';
import type { SpatialFields } from '../render-systems/fields/SpatialFields';
import type { WaveField } from '../render-systems/waves/WaveField';
import type { AudioFrame, VisualResponseFrame } from '../types/audio';
import type { PaletteColors, QualityProfile, SceneClock } from '../types/visualizer';
import type { WorldView } from '../world/WorldView';
import type { GeometryState } from './geometry/GeometryState';
import type { VoiceCycles } from './geometry/VoiceCycles';
import type { MaterialState } from './material/MaterialState';
import type { ResonanceField } from './structural/ResonanceField';

/**
 * What a world shares with its primitives for as long as it lives: the
 * renderer, the quality it was mounted at, and the uniform arrays every shader
 * binds once (they are stable objects, rewritten in place each frame), so all
 * primitives read the same fields and the same fronts without copies.
 */
export interface PrimitiveContext {
  renderer: WebGLRenderer;
  quality: QualityProfile;
  /** Seed of the world: the same seed is the same structures. */
  seed: number;
  /** Packed fields (`uField` of the field header) and wave fronts (`uWaveA`, `uWaveB`). */
  uField: Float32Array;
  uWaveA: Float32Array;
  uWaveB: Float32Array;
  /** The voices' live cycles (`tVoices`). */
  voices: VoiceCycles;
}

/**
 * One frame of a visual world, as every primitive sees it: a stable object,
 * updated in place. Everything musical in it has already been interpreted
 * (the world, the geometry, the material); `audio` and `response` are there
 * for what is drawn from the signal itself (waveforms, voices), never to be
 * analysed again.
 */
export interface WorldFrame {
  dt: number;
  /** Audio time heard when this frame is seen (the render clock while no audio clock is synchronized). */
  time: number;
  /** Whether `time` is the audio clock: dated things (fronts, pulses) exist only then. */
  timed: boolean;
  view: Readonly<WorldView>;
  geometry: Readonly<GeometryState>;
  fields: Readonly<SpatialFields>;
  look: Readonly<MaterialState>;
  waves: WaveField;
  /** What matter of each natural frequency takes of the sound right now; only in worlds whose recipe asks for it. */
  resonance?: ResonanceField;
  snapshot?: ExperienceSnapshot;
  audio: AudioFrame;
  response: VisualResponseFrame;
  modulation?: ModulationState;
  clock?: SceneClock;
}

/**
 * A primitive system of the visual world: particles, filaments, a surface, a
 * graph, wave fronts … It owns GPU resources and rendering history, never
 * musical state: what it shows is the frame's geometry, fields and material in
 * its own topology. A world keeps it mounted and tells it how present it is;
 * it fades itself in and out, so structures appear, combine and dissolve
 * without anything being rebuilt.
 */
export interface Primitive {
  /** Add to the world's group (the world owns the transform). */
  readonly object: Object3D;
  /** Numbers for the development overlay: a stable object, updated in place. */
  readonly debug: Record<string, number>;
  /** What is submitted to the GPU per frame at full presence (the world's budget and the overlay read it). */
  readonly elements: number;
  readonly vertices: number;
  /** Must not allocate. */
  setPalette(colors: PaletteColors): void;
  /**
   * One frame. `presence` 0..1 is how much of the primitive the world wants
   * now, already eased: 0 = it shows nothing (and should do no avoidable work).
   * Must not allocate.
   */
  update(frame: Readonly<WorldFrame>, presence: number): void;
  /** Point sizes and line widths are in device pixels. */
  setPixelRatio?(ratio: number): void;
  /** A new audio session: forget the rendering history of the previous one. */
  reset(): void;
  dispose(): void;
}
