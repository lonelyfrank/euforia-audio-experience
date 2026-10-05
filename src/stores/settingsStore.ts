import { DEFAULT_DIRECTION, MOODS, EXPERIENCES, clamp01 } from '../director/profiles';
import type { DirectionSettings } from '../director/types';
import { supportsSystemAudio } from '../platform';
import type { AudioSourceId } from '../types/audio';
import type { QualitySetting } from '../types/visualizer';
import type { PaletteId } from '../visualizers/palettes';
import { createStore } from './createStore';
import type { RigMode } from '../show/types';

const RIG_MODES: readonly RigMode[] = ['preset', 'hybrid', 'free'];

export type TrackInfoMode = 'always' | 'dim' | 'hidden';

/** User settings, persisted locally. Flat so partial updates stay simple. */
export interface Settings extends DirectionSettings {
  /** `file` is session-only and never persisted. */
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
}

const STORAGE_KEY = 'halo.settings.v1';

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
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
    const settings = { ...DEFAULT_SETTINGS, ...saved };
    // A file cannot be restored across sessions; system audio may be unavailable here.
    // 'file' was a source in older versions: only live sources remain.
    if ((settings.source as string) === 'file' || (settings.source === 'system' && !supportsSystemAudio)) {
      settings.source = DEFAULT_SETTINGS.source;
    }
    if (!MOODS.some((m) => m.id === settings.mood)) settings.mood = DEFAULT_DIRECTION.mood;
    if (!EXPERIENCES.some((m) => m.id === settings.experience)) settings.experience = DEFAULT_DIRECTION.experience;
    settings.moodIntensity = typeof settings.moodIntensity === 'number' && Number.isFinite(settings.moodIntensity) ? clamp01(settings.moodIntensity) : DEFAULT_DIRECTION.moodIntensity;
    // Older versions had an Auto toggle: it becomes the hybrid mode.
    if (!saved.rigMode || !RIG_MODES.includes(saved.rigMode)) settings.rigMode = saved.autoDirection === true ? 'hybrid' : 'preset';
    settings.autoDirection = settings.autoDirection === true && settings.rigMode !== 'preset';
    return settings;
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
