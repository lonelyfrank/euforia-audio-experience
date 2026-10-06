import { hslCss, type Palette } from '../visualizers/palettes';

/*
 * Euforia-Audio-Experience icon set: 24px grid, 1.5px stroke, round caps and joins, currentColor.
 * Ported from the design system runtime (`Euforia-Audio-Experience.icon`).
 */

const TAU = Math.PI * 2;

function cog(): string {
  const points: string[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    for (const [offset, radius] of [[-0.3, 6.6], [-0.17, 8.8], [0.17, 8.8], [0.3, 6.6]]) {
      points.push(`${(12 + Math.cos(a + offset) * radius).toFixed(2)} ${(12 + Math.sin(a + offset) * radius).toFixed(2)}`);
    }
  }
  return `<path d="M${points.join('L')}Z"/><circle cx="12" cy="12" r="2.8"/>`;
}

function bars(lit: number): string {
  const columns = [[7, 16, 13], [12, 16, 10], [17, 16, 7]];
  const paths = columns.map(([x, y1, y2], i) => `<path d="M${x} ${y1}V${y2}"${i < lit ? '' : ' opacity=".3"'}/>`);
  return `${paths.join('')}<path d="M5 19h14" opacity=".3"/>`;
}

const ICONS = {
  direction: '<path d="M12 3l7 17-7-4-7 4z"/>',
  mood: '<path d="M18 16A8 8 0 0 1 8 5a8 8 0 1 0 10 11z"/>',
  experience: '<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="4" ry="8"/><path d="M4 12h16"/>',
  bars: '<path d="M8 9.5v5M12 7v10M16 9.5v5"/>',
  back: '<path d="M14 7l-5 5 5 5"/>',
  scene: '<path d="M3.5 18.5l5.5-8 4 5.2 2.6-3.2 4.9 6z"/><circle cx="16.5" cy="7" r="1.6"/>',
  audio: '<path d="M4 10.5v3M7 8.5v7M10 5.5v13M13 8.5v7M16 6.5v11M19 10v4"/>',
  presets:
    '<rect x="4.5" y="4.5" width="6" height="6" rx="1.4"/><rect x="13.5" y="4.5" width="6" height="6" rx="1.4"/><rect x="4.5" y="13.5" width="6" height="6" rx="1.4"/><rect x="13.5" y="13.5" width="6" height="6" rx="1.4"/>',
  settings: cog(),
  quality: '<path d="M12 4.5l8 4-8 4-8-4z"/><path d="M4 12.5l8 4 8-4"/><path d="M4 16l8 4 8-4"/>',
  fullscreen: '<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/>',
  exitfull: '<path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5"/>',
  tunnel: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5.2"/><circle cx="12" cy="12" r="2"/>',
  spectrum: '<path d="M5 18.5v-4M8.5 18.5v-8M12 18.5V5.5M15.5 18.5v-6M19 18.5v-3"/>',
  particles:
    '<circle cx="6" cy="7" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="18" cy="8" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="16" cy="13" r="1"/><circle cx="6" cy="17" r="1"/><circle cx="12" cy="18" r="1"/><circle cx="19" cy="18" r="1"/>',
  scope: '<path d="M3 12c1.6-4.5 3.4-4.5 5 0s3.4 4.5 5 0 3.4-4.5 5 0 2.4 3 3 0"/>',
  liquid: '<path d="M3 9.5c3-3 6 3 9 0s6-3 9 0M3 14.5c3-3 6 3 9 0s6-3 9 0"/>',
  galaxy:
    '<path d="M12 12c1.6-1.2 3.4.4 2.4 2.2-1.3 2.3-5.2 1.9-6-.8-1-3.4 2.6-6.4 6.3-5.6 4.4 1 5.7 6.2 3 9.4"/><path d="M12 12c-1.6 1.2-3.4-.4-2.4-2.2" opacity=".6"/>',
  system: '<rect x="3.5" y="5" width="17" height="11.5" rx="2"/><path d="M9 20h6M12 16.5V20"/>',
  mic: '<rect x="9" y="3.5" width="6" height="10.5" rx="3"/><path d="M5.8 11a6.2 6.2 0 0 0 12.4 0M12 17.2V20.5"/>',
  qauto: '<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19.2 4.5v3.2H16"/><path d="M9.6 14.6l2.4-5.6 2.4 5.6M10.4 12.9h3.2"/>',
  qlow: bars(1),
  qmed: bars(2),
  qhigh: bars(3),
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  source: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.2"/>',
} as const;

export type IconName = keyof typeof ICONS;

/** Inline SVG markup for a Euforia-Audio-Experience icon (static, trusted strings). */
export function icon(name: IconName): string {
  const dots = name === 'particles';
  return `<svg viewBox="0 0 24 24" fill="${dots ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${dots ? 0 : 1.5}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** Three-dot swatch drawn from a palette, used in place of an icon for presets. */
export function swatch(palette: Palette): string {
  const [a, b, c] = palette.hues;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8.5" cy="14" r="4.2" fill="${hslCss(b)}"/><circle cx="15.5" cy="14" r="4.2" fill="${hslCss(c)}" opacity=".9"/><circle cx="12" cy="8" r="4.2" fill="${hslCss(a)}" opacity=".92"/></svg>`;
}
