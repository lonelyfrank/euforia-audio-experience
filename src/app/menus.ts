import { MOODS, EXPERIENCES } from '../director/profiles';
import type { QualitySetting } from '../types/visualizer';
import type { Settings } from '../stores/settingsStore';
import type { RigMode } from '../show/types';
import type { DialMenu } from '../ui/Dial';
import { swatch } from '../ui/icons';
import { PALETTES } from '../visualizers/palettes';
import { findVisualizer, visualizers } from '../visualizers/registry';

const QUALITIES: { id: QualitySetting; label: string; icon: 'qauto' | 'qlow' | 'qmed' | 'qhigh' }[] = [
  { id: 'auto', label: 'Auto', icon: 'qauto' },
  { id: 'low', label: 'Low', icon: 'qlow' },
  { id: 'medium', label: 'Medium', icon: 'qmed' },
  { id: 'high', label: 'High', icon: 'qhigh' },
];

const RIG_LABELS: Readonly<Record<RigMode, string>> = { preset: 'Preset', hybrid: 'Hybrid', free: 'Free' };

export function appMenu(key: string, s: Settings, fullscreen: boolean): DialMenu {
  switch (key) {
    case 'direction':
      return { caption: 'Direction', actions: true, items: [
        { id: 'mood', label: 'Mood', icon: 'mood' },
        { id: 'experience', label: 'Experience', icon: 'experience' },
        { id: 'rig', label: `Rig · ${RIG_LABELS[s.rigMode]}`, icon: 'qauto', selected: s.rigMode !== 'preset' },
        { id: 'quality', label: 'Quality', icon: 'quality' },
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
    case 'scene':
      return {
        caption: 'Scene',
        items: visualizers.map((v) => ({ id: v.id, label: v.name, icon: v.icon, selected: v.id === s.scene })),
      };
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
    case 'quality':
      return { caption: 'Quality', layout: 'arc', items: QUALITIES.map((q) => ({ ...q, selected: q.id === s.quality })) };
    default:
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
