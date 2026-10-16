import { GLOWS } from './forestLaw';

/*
 * How Resonant Forest looks (docs/resonant-forest.md): the art direction's palette, its fog and its base light. The
 * forest has its own colours — dark obsidian volumes, light that is local and hierarchical — and does not take the
 * app's palette (the compositor's tint still leans the whole layer, as for every scene). Colours are display-space
 * (sRGB) values: the shaders shade, fog and add light in that space, as the art direction's reference does, and go to
 * linear once, at the end.
 *
 * Three layers of light, never mixed:
 *   base        a key from above left, a rim from the glow on the horizon, a bounce from the ground — constant: the
 *               forest's silhouette, its path and its depth are there in silence
 *   structural  emissive faces and veins, scaled by the structural emission E (0.30 in silence … 1.00 at a release)
 *   event       pulses, rings and flushes: only when something happened (forestGrowth.ts)
 */

export interface ForestLook {
  /** Emissive colours by index (forestLaw.ts: violet, magenta, blue, cyan, lilac) and the stone of the volumes. */
  glow: readonly string[];
  obsidian: string;
  /** Colour of the twigs: thin dark lines that only show against light. */
  twig: string;
  /** Fog colour at the ground and at `ceiling` units above it; density per unit of distance; how fast it thins with height (units). */
  fogLow: string;
  fogHigh: string;
  fog: number;
  lift: number;
  ceiling: number;
}

export const DEFAULT_LOOK: Readonly<ForestLook> = {
  glow: ['#7132db', '#de55ff', '#168aff', '#45e8ff', '#a06eff'],
  obsidian: '#10132e',
  twig: '#1e1846',
  fogLow: '#422696',
  fogHigh: '#101036',
  fog: 0.018,
  lift: 11,
  ceiling: 19,
};
export type ForestLookSettings = Partial<ForestLook>;

const HEX = /^#[0-9a-f]{6}$/i;
const colour = (x: unknown, fallback: string): string => (typeof x === 'string' && HEX.test(x) ? x : fallback);
const within = (x: unknown, lo: number, hi: number, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback);

/** Settings within their bounds; what is missing or wrong is the default's. */
export function forestLook(s: ForestLookSettings = {}): ForestLook {
  const d = DEFAULT_LOOK;
  return {
    glow: d.glow.map((g, i) => colour(s.glow?.[i], g)), obsidian: colour(s.obsidian, d.obsidian), twig: colour(s.twig, d.twig),
    fogLow: colour(s.fogLow, d.fogLow), fogHigh: colour(s.fogHigh, d.fogHigh), fog: within(s.fog, 0, 0.2, d.fog),
    lift: within(s.lift, 0.5, 200, d.lift), ceiling: within(s.ceiling, 0.5, 200, d.ceiling),
  };
}

/** A display-space colour as three numbers 0..1 into `out` at `at`. */
export function rgb(hex: string, out: Float32Array, at = 0): Float32Array {
  const n = parseInt(hex.slice(1), 16);
  out[at] = ((n >> 16) & 255) / 255; out[at + 1] = ((n >> 8) & 255) / 255; out[at + 2] = (n & 255) / 255;
  return out;
}

/** The emissive palette as the shaders bind it (`uGlow`). */
export function glowPalette(look: Readonly<ForestLook>): Float32Array {
  const out = new Float32Array(GLOWS * 3);
  for (let i = 0; i < GLOWS; i++) rgb(look.glow[i], out, i * 3);
  return out;
}

/**
 * GLSL of the air and of the base light, shared by every part of a tree. After the ground's uniforms (`uAir`, `uSpan`).
 *   forestAir(P, view)      fog share, fog colour and the fade at the mesh's far end and sides, as varyings
 *   forestBase(n, P, shade) the base light of a facet: obsidian, key, rim and bounce (display space)
 *   forestOut(c)            display space → linear, once
 */
export const forestAirGlsl = /* glsl */ `
// The ground's air: z the depth of its mesh (units), w presence; and its half width (units).
uniform vec4 uAir;
uniform float uSpan;
uniform vec4 uFog;
uniform vec3 uFogLow;
uniform vec3 uFogHigh;
varying float vFog;
varying float vFade;
varying vec3 vFogColour;
void forestAir(vec3 P, vec3 view) {
  float d = -P.z;
  vFog = (1.0 - exp(-length(view) * uFog.x)) * (0.62 + 0.38 * exp(-max(P.y, 0.0) / uFog.y));
  vFogColour = mix(uFogLow, uFogHigh, clamp(P.y / uFog.z, 0.0, 1.0));
  vFade = (1.0 - smoothstep(uAir.z * 0.75, uAir.z, d)) * (1.0 - smoothstep(0.85, 1.0, abs(P.x) / uSpan)) * uAir.w;
}
`;

export const forestLightGlsl = /* glsl */ `
uniform vec3 uObsidian;
varying float vFog;
varying float vFade;
varying vec3 vFogColour;
// The key from above left and in front, and the glow on the horizon the rim light comes from (the ground's space, units).
const vec3 KEY = vec3(-0.5, 0.55, 0.65) / 0.98742;
const vec3 RIM = vec3(0.0, 7.0, -220.0);
vec3 forestBase(vec3 n, vec3 P, float shade) {
  float k = max(dot(n, KEY), 0.0), b = max(dot(n, normalize(RIM - P)), 0.0);
  return uObsidian * shade + k * vec3(0.071, 0.118, 0.314) + b * b * vec3(0.361, 0.165, 0.725)
    + max(n.y, 0.0) * vec3(0.031, 0.031, 0.102) + max(-n.y, 0.0) * vec3(0.133, 0.063, 0.314);
}
vec4 forestOut(vec3 c) {
  return vec4(pow(max(c, vec3(0.0)), vec3(2.2)), 1.0);
}
`;
