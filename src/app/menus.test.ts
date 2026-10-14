import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '../stores/settingsStore';
import { SCENE_CATEGORIES } from '../types/visualizer';
import { categoryOf, findVisualizer, registerLaboratory, sceneCategories, scenesOf, visualizers } from '../visualizers/registry';
import { appMenu, coreTarget, familyMenu, familyOf, menuSelection, parentMenu } from './menus';

/** The wheel as App drives it: picks patch the settings and move between rings. */
function wheel(initial: Settings = DEFAULT_SETTINGS) {
  const state = { menu: null as string | null, settings: initial, commands: [] as string[], sources: [] as string[] };
  return {
    state,
    core() { state.menu = coreTarget(state.menu); },
    ids: () => appMenu(state.menu!, state.settings, false).items.map((item) => item.id),
    pick(id: string) {
      expect(appMenu(state.menu!, state.settings, false).items.map((item) => item.id)).toContain(id);
      const effect = menuSelection(state.menu!, id);
      if (effect.patch) state.settings = normalizeSettings({ ...state.settings, ...effect.patch });
      if (effect.source) state.sources.push(effect.source);
      if (effect.command) { state.commands.push(effect.command); state.menu = null; }
      else if (effect.open) state.menu = effect.open;
    },
  };
}

describe('wheel state machine', () => {
  it('keeps six root entries and opens Direction on two choices', () => {
    const w = wheel();
    w.core();
    expect(w.ids()).toEqual(['scene', 'audio', 'presets', 'settings', 'direction', 'fullscreen']);
    w.pick('direction');
    expect(w.ids()).toEqual(['auto', 'manual']);
  });

  it('walks back one ring at a time and closes from the root', () => {
    const w = wheel();
    w.core(); w.pick('direction'); w.pick('manual'); w.pick('mood');
    const path = [w.state.menu];
    for (let i = 0; i < 4; i++) { w.core(); path.push(w.state.menu); }
    expect(path).toEqual(['mood', 'manual', 'direction', 'root', null]);
    w.core(); w.pick('scene'); w.core();
    expect(w.state.menu).toBe('root');
  });

  it('applies sub-ring picks in place, and leaves the wheel only for settings and fullscreen', () => {
    const w = wheel();
    w.core(); w.pick('scene'); w.pick('spectrum'); w.pick('galaxy');
    expect(w.state).toMatchObject({ menu: 'scene:spectrum', settings: { scene: 'galaxy' } });
    // Back to the families; the next core goes to the root as before.
    w.core();
    w.core(); w.pick('audio'); w.pick('microphone');
    expect(w.state).toMatchObject({ menu: 'audio', sources: ['microphone'] });
    w.core(); w.pick('settings');
    w.core(); w.pick('fullscreen');
    expect(w.state).toMatchObject({ menu: null, commands: ['settings', 'fullscreen'] });
  });

  it('Auto is one pick; Manual leads to mood, experience and rig and remembers them', () => {
    const w = wheel();
    w.core(); w.pick('direction'); w.pick('manual');
    expect(w.ids()).toEqual(['mood', 'experience', 'rig']);
    w.pick('rig'); w.pick('free');
    expect(w.state.settings).toMatchObject({ direction: 'manual', rigMode: 'free', autoDirection: true });
    w.core(); w.pick('mood'); w.pick('dark');
    // A manual mood stops the automatic one but keeps the rig, as before the Auto / Manual control.
    expect(w.state.settings).toMatchObject({ mood: 'dark', rigMode: 'free', autoDirection: false });
    w.core(); w.core(); w.pick('auto');
    expect(w.state).toMatchObject({ menu: 'direction', settings: { direction: 'auto', mood: 'dark', rigMode: 'free' } });
    expect(appMenu('direction', w.state.settings, false).items.find((item) => item.selected)?.id).toBe('auto');
  });
});

/** The ids every scene had before the families: saved settings name them, so none may change. */
const IDS = ['tunnel', 'spectrum', 'particle-field', 'galaxy', 'liquid', 'oscilloscope', 'resonant-field', 'spectral-matter', 'matter-field', 'vector-field', 'spectral-shell', 'terrain'];

describe('scene families', () => {
  it('every scene of the registry is in exactly one family; ids, order and the count are as they were', () => {
    expect(visualizers.map((v) => v.id).sort()).toEqual([...IDS].sort());
    const listed = SCENE_CATEGORIES.flatMap((c) => scenesOf(c.id).map((v) => v.id));
    expect(listed.sort()).toEqual([...IDS].sort());
    expect(new Set(listed).size).toBe(listed.length);
    for (const v of visualizers) expect(categoryOf(v.id)).toBe(v.category);
    // Within a family the registry's own order holds.
    for (const c of SCENE_CATEGORIES) { const orders = scenesOf(c.id).map((v) => v.order); expect(orders).toEqual([...orders].sort((a, b) => a - b)); }
  });

  it('classifies by behaviour: matter and fields, spaces to travel, the signal itself', () => {
    const of = (category: string) => scenesOf(category as never).map((v) => v.id).sort();
    expect(of('particles')).toEqual(['matter-field', 'particle-field', 'resonant-field', 'spectral-matter', 'spectral-shell', 'vector-field']);
    expect(of('worlds')).toEqual(['terrain', 'tunnel']);
    // Galaxy draws the spectrum along its radius and the voices along its arms: a signal scene made of stars.
    expect(of('spectrum')).toEqual(['galaxy', 'liquid', 'oscilloscope', 'spectrum']);
    expect(sceneCategories().map((c) => c.id)).toEqual(['particles', 'worlds', 'spectrum']);
  });

  it('Scene opens the three families, a family its scenes; nothing is applied and the capture is not touched on the way', () => {
    const w = wheel();
    w.core(); w.pick('scene');
    expect(w.ids()).toEqual(['particles', 'worlds', 'spectrum']);
    for (const family of ['particles', 'worlds', 'spectrum'] as const) {
      expect(menuSelection('scene', family)).toEqual({ open: familyMenu(family) });
      const items = appMenu(familyMenu(family), w.state.settings, false).items.map((item) => item.id);
      expect(items).toEqual(scenesOf(family).map((v) => v.id));
      expect(new Set(items).size).toBe(items.length);
    }
    const before = w.state.settings;
    w.pick('particles');
    expect(w.state.settings).toBe(before);
    expect(w.state.sources).toEqual([]);
    expect(appMenu('scene:particles', w.state.settings, false).caption).toBe('Scene · Particles');
  });

  it('Root → Scene → Particles → Matter Field, and back one ring at a time to closed', () => {
    const w = wheel();
    w.core(); w.pick('scene'); w.pick('particles'); w.pick('matter-field');
    // A pick applies in place and keeps the family open, as the flat list did.
    expect(w.state).toMatchObject({ menu: 'scene:particles', settings: { scene: 'matter-field' }, sources: [] });
    const path = [w.state.menu];
    for (let i = 0; i < 3; i++) { w.core(); path.push(w.state.menu); }
    expect(path).toEqual(['scene:particles', 'scene', 'root', null]);
    expect(parentMenu('scene:worlds')).toBe('scene');
  });

  it('marks the family of the scene in use and the scene itself; persists the pick through the settings', () => {
    let settings = normalizeSettings({ ...DEFAULT_SETTINGS, scene: 'terrain' });
    expect(appMenu('scene', settings, false).items.filter((i) => i.selected).map((i) => i.id)).toEqual(['worlds']);
    expect(appMenu('scene:worlds', settings, false).items.filter((i) => i.selected).map((i) => i.id)).toEqual(['terrain']);
    expect(appMenu('scene:particles', settings, false).items.some((i) => i.selected)).toBe(false);
    settings = normalizeSettings({ ...settings, ...menuSelection('scene:spectrum', 'liquid').patch });
    expect(settings.scene).toBe('liquid');
    expect(appMenu('scene', settings, false).items.find((i) => i.selected)?.id).toBe('spectrum');
  });

  it('saved settings keep their scene; a family never applies a scene that is not its own, nor a laboratory\'s world', () => {
    for (const id of IDS) expect(normalizeSettings({ ...DEFAULT_SETTINGS, scene: id }).scene).toBe(id);
    expect(menuSelection('scene:worlds', 'matter-field')).toEqual({});
    expect(menuSelection('scene:worlds', 'nothing')).toEqual({});
    expect(menuSelection('scene', 'tunnel')).toEqual({});
    expect(familyOf('scene:unknown')).toBeNull(); expect(familyOf('scene')).toBeNull();
    const lab = { ...findVisualizer('terrain')!, id: 'some-lab', category: 'worlds' as const };
    const withdraw = registerLaboratory(lab);
    try {
      expect(findVisualizer('some-lab')).toBe(lab);
      expect(scenesOf('worlds').map((v) => v.id)).not.toContain('some-lab');
      expect(menuSelection('scene:worlds', 'some-lab')).toEqual({});
    } finally { withdraw(); }
  });

  it('the root ring and every other ring are as they were', () => {
    const w = wheel();
    w.core();
    expect(w.ids()).toEqual(['scene', 'audio', 'presets', 'settings', 'direction', 'fullscreen']);
    expect(appMenu('presets', w.state.settings, false).caption).toBe(`Palette · ${findVisualizer(w.state.settings.scene)!.name}`);
    expect(menuSelection('audio', 'system')).toEqual({ source: 'system' });
    expect(coreTarget('scene:spectrum')).toBe('scene');
  });
});
