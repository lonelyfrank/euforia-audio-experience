import type { ExperienceSnapshot } from '../experience/types';
import type { WorldView } from '../world/WorldView';
export type MoodId = 'euphoria' | 'dream' | 'dark' | 'pulse' | 'chaos' | 'ethereal' | 'melancholy' | 'focus';
export type ExperienceId = 'ambient' | 'immersive' | 'reactive' | 'cinematic' | 'minimal';

export interface DirectionSettings {
  mood: MoodId;
  moodIntensity: number;
  experience: ExperienceId;
  autoDirection: boolean;
}

/** Normalized controls. Scenes choose their physical units, never reclassify the music. */
export interface ModulationState {
  /** Shared grammar and physical memory, read-only and owned by the audio engine. */
  experienceState?: ExperienceSnapshot;
  /** This layer's view of the shared world (motion, pressure, fields), with the mood's gains. Read-only. */
  world?: WorldView;
  scale: number;
  distortion: number;
  cameraMotion: number;
  particleEmission: number;
  brightness: number;
  bloom: number;
  impact: number;
  persistence: number;
  depth: number;
  contrast: number;
  visibility: number;
}
export type ModulationKey = Exclude<keyof ModulationState, 'experienceState' | 'world'>;
export type Feature = 'low' | 'mid' | 'high' | 'transient' | 'pulse' | 'brightness' | 'flux' | 'intensity' | 'openness' | 'tension' | 'release' | 'warmth';
export interface Mapping { source: Feature; target: ModulationKey; amount: number }
export interface SceneCapabilities {
  particles?: boolean;
  cameraMotion?: boolean;
  distortion?: boolean;
  depth?: boolean;
}
export interface SceneDirection {
  capabilities: SceneCapabilities;
  /** Additional/replacement routes: a target present here replaces its default routes. */
  mappings?: readonly Mapping[];
}

/** Multipliers around 1; persistence and fluidity alter time constants, not sound levels. */
export interface Character {
  motion: number; fluidity: number; persistence: number;
  expansion: number; distortion: number; turbulence: number;
  particles: number; brightness: number; bloom: number; depth: number;
  camera: number; contrast: number; low: number; mid: number; high: number;
  structure: number;
}
export interface VisualMood { id: MoodId; name: string; character: Character }
export interface ExperienceMode { id: ExperienceId; name: string; character: Character; attack: number; release: number; minimal: number }
