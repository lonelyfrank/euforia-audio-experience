import { DEFAULT_DIRECTION, MOODS, EXPERIENCES } from '../director/profiles';
import type { DirectionSettings } from '../director/types';
import { supportsSystemAudio } from '../platform';
import type { AudioSourceId } from '../types/audio';
import type { QualitySetting } from '../types/visualizer';
import { PALETTES, type PaletteId } from '../visualizers/palettes';
import { createStore } from './createStore';
import type { RigMode } from '../show/types';

const RIG_MODES: readonly RigMode[] = ['preset', 'hybrid', 'free'];

/** Who directs: the system (auto), or the user's own mood, experience, intensity and rig (manual). */
export type DirectionMode = 'auto' | 'manual';
const DIRECTION_MODES: readonly DirectionMode[] = ['auto', 'manual'];
/**
 * Direction of a fresh install. Manual with the defaults below is the chosen
 * scene as designed (rig Preset); switch to 'auto' to let the system direct
 * from the first launch. Settings saved before this control existed stay manual.
 */
export const DEFAULT_DIRECTION_MODE: DirectionMode = 'manual';

export type TrackInfoMode = 'always' | 'dim' | 'hidden';

/** User settings, persisted locally. Flat so partial updates stay simple. */
export interface Settings extends DirectionSettings {
  /** Live input; legacy file sources are discarded on load. */
  source: AudioSourceId;
  scene: string;
  preset: PaletteId;
  quality: QualitySetting;
  /** 0.4..1.8 */
  sensitivity: number;
  /** 0..0.95 */
  smoothing: number;
  beatResponse: boolean;
  trackInfo: TrackInfoMode;
  /** Inactivity (ms) before the UI hides: 3000, 5000 or 10000. */
  hideDelay: number;
  hideCursor: boolean;
  /** Ms the visuals wait for the sound (output latency, e.g. Bluetooth headphones). */
  audioDelay: number;
  /** Reflective water floor below the horizon; off = the scene uses the whole window. */
  reflection: boolean;
  /** Photosensitivity: at most one flash a second, at half strength (always at most three). */
  reduceFlashing: boolean;
  /**
   * How freely the show is directed: preset (the chosen scene as designed),
   * hybrid (the chosen scene with variations at phrase boundaries and an
   * automatic mood), free (the director composes the fixtures). Replaces the
   * old Auto direction; `autoDirection` now follows it (and a manual mood pick).
   */
  rigMode: RigMode;
  /**
   * Auto ignores mood, experience, moodIntensity, rigMode and autoDirection
   * (they stay stored as the manual choice); read them through `resolveDirection`.
   */
  direction: DirectionMode;
}

/** What the rig and the directors actually follow. */
export type ResolvedDirection = DirectionSettings & { readonly rigMode: RigMode };
/** Auto: the chosen scene with variations and supports, the mood follows the music. */
export const AUTO_DIRECTION: ResolvedDirection = Object.freeze({ ...DEFAULT_DIRECTION, autoDirection: true, rigMode: 'hybrid' });
/** Manual is the stored settings themselves (no copy: callable every frame). */
export function resolveDirection(s: Settings): ResolvedDirection {
  return s.direction === 'auto' ? AUTO_DIRECTION : s;
}

const STORAGE_KEY = 'euforia-audio-experience.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_DIRECTION,
  source: supportsSystemAudio ? 'system' : 'fake',
  scene: 'tunnel',
  preset: 'nebula',
  quality: 'auto',
  sensitivity: 1,
  smoothing: 0.55,
  beatResponse: true,
  trackInfo: 'dim',
  hideDelay: 5000,
  hideCursor: true,
  audioDelay: 0,
  reflection: true,
  reduceFlashing: false,
  rigMode: 'preset',
  direction: DEFAULT_DIRECTION_MODE,
};

/** Scenes that changed id: a saved choice follows the scene to its new name. */
const RENAMED_SCENES: Readonly<Record<string, string>> = { field: 'vector-field' };

/** Validate persisted data before it can reach audio math or quality profiles. */
export function normalizeSettings(value: unknown): Settings {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const settings = { ...DEFAULT_SETTINGS };
  const choice = <T>(value: unknown, choices: readonly T[], fallback: T): T =>
    choices.includes(value as T) ? value as T : fallback;
  const number = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

  settings.source = choice(saved.source, ['system', 'microphone', 'fake'], settings.source);
  if (settings.source === 'system' && !supportsSystemAudio) settings.source = DEFAULT_SETTINGS.source;
  if (typeof saved.scene === 'string' && saved.scene.trim()) settings.scene = RENAMED_SCENES[saved.scene] ?? saved.scene;
  settings.preset = choice(saved.preset, PALETTES.map((p) => p.id), settings.preset);
  settings.quality = choice(saved.quality, ['auto', 'low', 'medium', 'high'], settings.quality);
  settings.mood = choice(saved.mood, MOODS.map((m) => m.id), settings.mood);
  settings.experience = choice(saved.experience, EXPERIENCES.map((m) => m.id), settings.experience);
  settings.trackInfo = choice(saved.trackInfo, ['always', 'dim', 'hidden'], settings.trackInfo);
  settings.hideDelay = choice(saved.hideDelay, [3000, 5000, 10000], settings.hideDelay);
  settings.moodIntensity = number(saved.moodIntensity, 0, 1, settings.moodIntensity);
  settings.sensitivity = number(saved.sensitivity, 0.4, 1.8, settings.sensitivity);
  settings.smoothing = number(saved.smoothing, 0, 0.95, settings.smoothing);
  settings.audioDelay = number(saved.audioDelay, -100, 400, settings.audioDelay);
  for (const key of ['beatResponse', 'hideCursor', 'reflection', 'reduceFlashing'] as const) {
    if (typeof saved[key] === 'boolean') settings[key] = saved[key];
  }
  // Older versions had an Auto toggle: it becomes the hybrid mode.
  settings.rigMode = choice(saved.rigMode, RIG_MODES, saved.autoDirection === true ? 'hybrid' : 'preset');
  settings.autoDirection = saved.autoDirection === true && settings.rigMode !== 'preset';
  // Settings saved before the Auto / Manual control keep behaving as they did.
  settings.direction = choice(saved.direction, DIRECTION_MODES, Object.keys(saved).length ? 'manual' : DEFAULT_DIRECTION_MODE);
  return settings;
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function save(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (private mode, quota): settings just won't persist.
  }
}

export const settingsStore = createStore<Settings>(load(), save);
