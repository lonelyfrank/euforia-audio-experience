import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from './settingsStore';
import { createStore } from './createStore';

describe('persisted settings', () => {
  it('rejects invalid shapes, enum values and numbers', () => {
    for (const invalid of [null, 'oops', 42, []]) expect(normalizeSettings(invalid)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ quality: 'ultra', source: 'file', preset: 'gone', reflection: 'false', sensitivity: NaN,
      smoothing: Infinity, hideDelay: -1, scene: '', extra: true })).toEqual(DEFAULT_SETTINGS);
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
