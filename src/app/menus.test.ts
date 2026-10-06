import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '../stores/settingsStore';
import { appMenu, coreTarget, menuSelection } from './menus';

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
    w.core(); w.pick('scene'); w.pick('galaxy');
    expect(w.state).toMatchObject({ menu: 'scene', settings: { scene: 'galaxy' } });
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
