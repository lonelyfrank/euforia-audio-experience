import { describe, expect, it } from 'vitest';
import { AUTO_DIRECTION, DEFAULT_SETTINGS, normalizeSettings, resolveDirection } from './settingsStore';
import { AutoDirection } from '../director/AutoDirection';
import type { DirectionSettings } from '../director/types';
import { MusicInterpreter } from '../audio/interpretation/MusicInterpreter';
import { createStore } from './createStore';

describe('persisted settings', () => {
  it('rejects invalid shapes, enum values and numbers', () => {
    for (const invalid of [null, 'oops', 42, []]) expect(normalizeSettings(invalid)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ quality: 'ultra', source: 'file', preset: 'gone', reflection: 'false', sensitivity: NaN,
      smoothing: Infinity, hideDelay: -1, scene: '', direction: 'both', extra: true })).toEqual({ ...DEFAULT_SETTINGS, direction: 'manual' });
  });
  it('follows a renamed scene to its new id and keeps any other choice as saved', () => {
    expect(normalizeSettings({ scene: 'field' }).scene).toBe('vector-field');
    expect(normalizeSettings({ scene: 'spectral-shell' }).scene).toBe('spectral-shell');
  });

  it('clamps controls and preserves supported negative audio delay', () => {
    expect(normalizeSettings({ sensitivity: 999, smoothing: -1, moodIntensity: 8, audioDelay: -50 })).toMatchObject({
      sensitivity: 1.8, smoothing: 0, moodIntensity: 1, audioDelay: -50,
    });
  });
  it('migrates Auto and keeps explicit manual mood overrides', () => {
    expect(normalizeSettings({ autoDirection: true })).toMatchObject({ rigMode: 'hybrid', autoDirection: true });
    expect(normalizeSettings({ rigMode: 'preset', autoDirection: true }).autoDirection).toBe(false);
    expect(normalizeSettings({ rigMode: 'free', autoDirection: false }).autoDirection).toBe(false);
  });
});

describe('direction: Auto / Manual', () => {
  const legacy = [
    { rigMode: 'preset', autoDirection: false, mood: 'dark', experience: 'cinematic', moodIntensity: 0.3 },
    { rigMode: 'hybrid', autoDirection: true, mood: 'chaos' },
    { rigMode: 'free', autoDirection: false, experience: 'minimal' },
    { autoDirection: true },
  ];
  it('settings saved before the control load as Manual with every value intact', () => {
    for (const saved of legacy) {
      const s = normalizeSettings(saved);
      expect(s.direction).toBe('manual');
      expect(s).toMatchObject({ ...saved, autoDirection: s.autoDirection });
      // Reloading what was just saved changes nothing.
      expect(normalizeSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
    }
    expect(normalizeSettings({ direction: 'auto', rigMode: 'free', mood: 'dark' })).toMatchObject({ direction: 'auto', rigMode: 'free', mood: 'dark' });
  });
  it('Manual hands the rig and the directors the stored values themselves', () => {
    for (const saved of legacy) {
      const s = normalizeSettings(saved);
      expect(resolveDirection(s)).toBe(s);
    }
  });
  it('Auto ignores the manual choices and directs like the Hybrid rig with its automatic mood', () => {
    const manual = normalizeSettings({ rigMode: 'preset', mood: 'dark', experience: 'minimal', moodIntensity: 0, direction: 'auto' });
    const hybrid = normalizeSettings({ rigMode: 'hybrid', autoDirection: true });
    expect(resolveDirection(manual)).toBe(AUTO_DIRECTION);
    const { mood, experience, moodIntensity, autoDirection, rigMode } = hybrid;
    expect(AUTO_DIRECTION).toEqual({ mood, experience, moodIntensity, autoDirection, rigMode });

    // Same music, same decisions: a steady percussive groove moves both to Pulse / Reactive.
    const music = new MusicInterpreter().frame;
    Object.assign(music, { audible: 1, weight: 0.5, motion: 0.4, rhythmicConfidence: 0.8 });
    music.music.lowPercussion = 0.5;
    const a = new AutoDirection();
    const b = new AutoDirection();
    // The renderer hands AutoDirection these four fields (RenderEngine.setDirection).
    const direction = ({ mood, moodIntensity, experience, autoDirection }: DirectionSettings): DirectionSettings => ({ mood, moodIntensity, experience, autoDirection });
    for (let i = 0; i < 22 * 60; i++) {
      a.update(music, direction(resolveDirection(manual)), 1 / 60, i / 60);
      b.update(music, direction(resolveDirection(hybrid)), 1 / 60, i / 60);
      expect(a.settings).toEqual(b.settings);
    }
    expect(a.settings).toMatchObject({ mood: 'pulse', experience: 'reactive' });
  });
});

describe('store updates', () => {
  it('persists and notifies only actual changes, including functional patches', () => {
    const saved: unknown[] = [];
    const seen: unknown[] = [];
    const store = createStore({ value: 1 }, (s) => saved.push(s));
    const original = store.get();
    const unsubscribe = store.subscribe((s, previous) => seen.push([s, previous]));
    store.set({});
    store.set({ value: 1 });
    store.set((s) => ({ value: s.value }));
    expect(store.get()).toBe(original);
    expect(saved).toHaveLength(0);
    store.set({ value: 2 });
    expect(seen).toEqual([[{ value: 2 }, original]]);
    unsubscribe();
    store.set({ value: 3 });
    expect(saved).toHaveLength(2);
    expect(seen).toHaveLength(1);
  });
});
