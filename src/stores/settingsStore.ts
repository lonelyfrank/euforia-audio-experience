import { supportsSystemAudio } from '../platform';
import type { AudioSourceId } from '../types/audio';
import type { QualitySetting } from '../types/visualizer';
import type { PaletteId } from '../visualizers/palettes';
import { createStore } from './createStore';

export type TrackInfoMode = 'always' | 'dim' | 'hidden';

/** User settings, persisted locally. Flat so partial updates stay simple. */
export interface Settings {
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
}

const STORAGE_KEY = 'halo.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
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
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const settings = { ...DEFAULT_SETTINGS, ...(raw ? (JSON.parse(raw) as Partial<Settings>) : {}) };
    // A file cannot be restored across sessions; system audio may be unavailable here.
    if (settings.source === 'file' || (settings.source === 'system' && !supportsSystemAudio)) {
      settings.source = DEFAULT_SETTINGS.source;
    }
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
