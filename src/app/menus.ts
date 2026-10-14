import { MOODS, EXPERIENCES } from '../director/profiles';
import type { ExperienceId, MoodId } from '../director/types';
import type { Settings } from '../stores/settingsStore';
import type { RigMode } from '../show/types';
import type { AudioSourceId } from '../types/audio';
import type { DialMenu } from '../ui/Dial';
import { swatch } from '../ui/icons';
import { PALETTES, type PaletteId } from '../visualizers/palettes';
import { SCENE_CATEGORIES, type SceneCategory } from '../types/visualizer';
import { categoryOf, findVisualizer, sceneCategories, scenesOf } from '../visualizers/registry';

const RIG_LABELS: Readonly<Record<RigMode, string>> = { preset: 'Preset', hybrid: 'Hybrid', free: 'Free' };

/** The ring of one family of scenes: `scene:<category>`, opened from the Scene ring. */
const FAMILY = 'scene:';
export const familyMenu = (category: SceneCategory): string => `${FAMILY}${category}`;
/** The family a menu key names, or null when it is not a family's ring. */
export function familyOf(menu: string): SceneCategory | null {
  if (!menu.startsWith(FAMILY)) return null;
  const id = menu.slice(FAMILY.length);
  return SCENE_CATEGORIES.some((c) => c.id === id) ? id as SceneCategory : null;
}

export function appMenu(key: string, s: Settings, fullscreen: boolean): DialMenu {
  switch (key) {
    case 'direction':
      return { caption: 'Direction', layout: 'arc', items: [
        { id: 'auto', label: 'Auto', icon: 'qauto', selected: s.direction === 'auto' },
        { id: 'manual', label: 'Manual', icon: 'direction', selected: s.direction === 'manual' },
      ] };
    case 'manual':
      return { caption: 'Manual', actions: true, layout: 'arc', items: [
        { id: 'mood', label: 'Mood', icon: 'mood' },
        { id: 'experience', label: 'Experience', icon: 'experience' },
        { id: 'rig', label: `Rig · ${RIG_LABELS[s.rigMode]}`, icon: 'qauto', selected: s.rigMode !== 'preset' },
      ] };
    case 'rig':
      return {
        caption: 'Rig',
        layout: 'arc',
        items: (['preset', 'hybrid', 'free'] as const).map((id) => ({ id, label: RIG_LABELS[id], icon: id === 'free' ? 'qauto' : id === 'hybrid' ? 'mood' : 'scene', selected: s.rigMode === id })),
      };
    case 'mood':
      return { caption: 'Mood', items: MOODS.map((m) => ({ id: m.id, label: m.name, icon: 'mood', selected: m.id === s.mood })) };
    case 'experience':
      return { caption: 'Experience', items: EXPERIENCES.map((m) => ({ id: m.id, label: m.name, icon: 'experience', selected: m.id === s.experience })) };
    case 'scene': {
      // The families, from the scenes' own metadata; the one holding the scene in use is marked.
      const current = categoryOf(s.scene);
      return { caption: 'Scene', layout: 'arc', items: sceneCategories().map((c) => ({ id: c.id, label: c.name, icon: c.icon, selected: c.id === current })) };
    }
    case 'audio':
      return {
        caption: 'Audio',
        layout: 'arc',
        items: [
          { id: 'system', label: 'System Audio', icon: 'system', selected: s.source === 'system' },
          { id: 'microphone', label: 'Microphone', icon: 'mic', selected: s.source === 'microphone' },
        ],
      };
    case 'presets':
      return {
        caption: `Palette · ${findVisualizer(s.scene)?.name ?? ''}`,
        layout: 'arc',
        items: PALETTES.map((p) => ({ id: p.id, label: p.name, iconHtml: swatch(p), selected: p.id === s.preset })),
      };
    default: {
      const family = familyOf(key);
      if (family) {
        const name = SCENE_CATEGORIES.find((c) => c.id === family)!.name;
        return { caption: `Scene · ${name}`, items: scenesOf(family).map((v) => ({ id: v.id, label: v.name, icon: v.icon, selected: v.id === s.scene })) };
      }
      return {
        items: [
          { id: 'scene', label: 'Scene', icon: 'scene' },
          { id: 'audio', label: 'Audio', icon: 'audio' },
          { id: 'presets', label: 'Palette', icon: 'presets' },
          { id: 'settings', label: 'Settings', icon: 'settings' },
          { id: 'direction', label: 'Direction', icon: 'direction' },
          { id: 'fullscreen', label: 'Fullscreen', icon: fullscreen ? 'exitfull' : 'fullscreen' },
        ],
      };
    }
  }
}

/** Where the core's back action leads from a sub-ring. */
export function parentMenu(menu: string): string {
  if (menu === 'mood' || menu === 'experience' || menu === 'rig') return 'manual';
  if (familyOf(menu)) return 'scene';
  return menu === 'manual' ? 'direction' : 'root';
}

/** Core click on the wheel: closed → root, root → closed (null), sub-ring → its parent. */
export function coreTarget(menu: string | null): string | null {
  if (menu === null) return 'root';
  return menu === 'root' ? null : parentMenu(menu);
}

/** What picking an item does. Without `open` or `command` the ring stays open on the pick. */
export interface MenuEffect {
  patch?: Partial<Settings>;
  open?: string;
  /** Leaves the wheel. */
  command?: 'fullscreen' | 'settings';
  source?: AudioSourceId;
}

export function menuSelection(menu: string, id: string): MenuEffect {
  switch (menu) {
    case 'root':
      return id === 'fullscreen' || id === 'settings' ? { command: id } : { open: id };
    case 'direction':
      // Manual leads on to its own choices; Auto has none.
      return id === 'manual' ? { patch: { direction: 'manual' }, open: 'manual' } : { patch: { direction: 'auto' } };
    case 'manual':
      return { open: id };
    // Hybrid and free choose the mood themselves; a manual pick keeps the mode but stops that.
    case 'rig':
      return { patch: { rigMode: id as RigMode, autoDirection: id !== 'preset' } };
    case 'mood':
      return { patch: { mood: id as MoodId, autoDirection: false } };
    case 'experience':
      return { patch: { experience: id as ExperienceId, autoDirection: false } };
    // A family only leads on to its scenes: nothing is applied, the capture is not touched.
    case 'scene':
      return SCENE_CATEGORIES.some((c) => c.id === id) ? { open: familyMenu(id as SceneCategory) } : {};
    case 'presets':
      return { patch: { preset: id as PaletteId } };
    case 'audio':
      return { source: id as AudioSourceId };
    default: {
      // A scene of that family: the normal flow of the settings, as the flat list had (never a laboratory's world).
      const family = familyOf(menu);
      return family && scenesOf(family).some((v) => v.id === id) ? { patch: { scene: id } } : {};
    }
  }
}
