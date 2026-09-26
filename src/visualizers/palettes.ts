import type { Color } from 'three';

export type PaletteId = 'nebula' | 'aurora' | 'ember' | 'mono';

/** HSL triple: hue in degrees, saturation and lightness in percent. */
export type Hsl = readonly [number, number, number];

/**
 * A preset is a palette of three hues every scene draws with. The first hue
 * also becomes the UI accent (`--accent-live`).
 */
export interface Palette {
  id: PaletteId;
  name: string;
  hues: readonly [Hsl, Hsl, Hsl];
}

export const PALETTES: readonly Palette[] = [
  { id: 'nebula', name: 'Nebula', hues: [[258, 92, 72], [220, 96, 64], [316, 76, 70]] },
  { id: 'aurora', name: 'Aurora', hues: [[168, 70, 58], [202, 92, 62], [250, 78, 72]] },
  { id: 'ember', name: 'Ember', hues: [[14, 90, 62], [336, 76, 66], [38, 92, 64]] },
  { id: 'mono', name: 'Mono', hues: [[230, 18, 86], [244, 24, 72], [220, 14, 96]] },
];

export function findPalette(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}

export function hslCss([h, s, l]: Hsl, alpha = 1): string {
  return `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
}

/** Writes the palette's three hues into `out` as (linear) three.js colors. */
export function paletteColors(palette: Palette, out: [Color, Color, Color]): [Color, Color, Color] {
  palette.hues.forEach(([h, s, l], i) => out[i].setHSL(h / 360, s / 100, l / 100));
  return out;
}
