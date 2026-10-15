import { MAX_WAVES } from '../../render-systems/waves/WaveField';

/*
 * The ocean law (Pulse Ocean): how high the sea is at one point of its lattice. Written twice, side by side, and kept
 * identical term by term: `oceanLawGlsl` runs on the GPU for every vertex, `oceanHeight` is the CPU reference the
 * tests, the parity check and the observer (which rides the swell) use.
 *
 * The sea is a lattice that does not move, the mesh slides over it by whole cells as the observer glides (as Generative
 * Terrain's ground does). Its height is a sum of a few travelling waves on three scales, the world's fronts and a
 * release front; no fluid is simulated:
 *
 *   swell     two long waves: the persistent energy and the structure of the music (their direction is the sea's
 *             configuration, which only a release changes)
 *   groove    three middle waves: the groove of the lows, their crests peaked by hard-edged mids
 *   ripple    two short waves: the activity of the highs, on the surface
 *   fronts    the world's dated wave fronts cross it as rings; a release is a front that runs away from the viewer
 *
 * A wave is (kx, kz, phase, amplitude): radians per cell across and along, and the phase at the mesh's own origin,
 * computed on the CPU in double precision from the lattice point the mesh starts at and the waves' own lived time —
 * so nothing wraps and nothing loses precision however long the sea has been travelled. Every amplitude is zero in a
 * world at rest: what is left is a flat, still sea. Heights are bounded for any input (`oceanBound`).
 */

/** Waves of each scale, in this order in `uSwell`: swell, groove, ripple. */
export const SWELLS = 2;
export const GROOVES = 3;
export const RIPPLES = 2;
export const WAVES = SWELLS + GROOVES + RIPPLES;
/** Rows of the mesh behind the viewer. */
export const BEHIND = 3;
/** A release front is this deep (units). */
export const FRONT_WIDTH = 9;
/** Wave fronts: where they start ahead of the viewer (units), and how the world's units map to the sea's. */
const WAVE_AHEAD = 22;
const WAVE_REACH = 18;
const WAVE_SPREAD = [16, 26] as const;
const WAVE_THIN = 0.025;

/** Order of the packed values (`uOcean[i]` in GLSL, `packOcean` in TS). */
const ORDER = ['shift', 'shiftX', 'cell', 'chop', 'front', 'release', 'bulge', 'wave', 'seed', 'row'] as const;
export type OceanKey = typeof ORDER[number];
export type OceanValues = Record<OceanKey, number>;
export const OCEAN_VALUES = ORDER.length;

/** A sea at rest: flat, still. */
export const createOcean = (): OceanValues => ({ shift: 0, shiftX: 0, cell: 1, chop: 0, front: 1e4, release: 0, bulge: 0, wave: 0, seed: 0, row: 0 });
/** Rows after which a point's own values (`oceanGrain`) repeat: the lattice row the mesh starts at, modulo this, is what the GPU gets. */
export const GRAIN_PERIOD = 4096;

export function packOcean(out: Float32Array, values: Readonly<OceanValues>): Float32Array {
  for (let i = 0; i < ORDER.length; i++) out[i] = values[ORDER[i]];
  return out;
}

const defines = ORDER.map((key, i) => `#define O_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()} uOcean[${i}]`).join('\n');
const glsl = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/**
 * GLSL ES 3.00. Declares `uOcean`, `uSwell`, `uWaveA`, `uWaveB` and:
 *   oceanDepth(k)        distance ahead of the viewer of mesh row k (units)
 *   oceanAcross(i)       where mesh column i is across the viewer (units)
 *   oceanHeight(i, k)    height of the sea at mesh column i, row k; writes `oceanFront` (how much of the fronts is
 *                        passing there) and `oceanCrest` (how far up its waves the point is, −1 … 1)
 *   oceanGrain(i, k)     the lattice point's own number 0..1 (where the highs glint)
 */
export const oceanLawGlsl = /* glsl */ `
uniform float uOcean[${OCEAN_VALUES}];
uniform vec4 uSwell[${WAVES}];
uniform vec4 uWaveA[${MAX_WAVES}];
uniform vec4 uWaveB[${MAX_WAVES}];
${defines}

float oceanFront;
float oceanCrest;

float oceanDepth(float k) {
  return (k - O_SHIFT - ${glsl(BEHIND)}) * O_CELL;
}

float oceanAcross(float i) {
  return (i - O_SHIFT_X) * O_CELL;
}

// A value each lattice point has for itself (the glints of the highs): small whole numbers in.
float oceanGrain(float i, float k) {
  vec3 p = fract(vec3(i + O_SEED, mod(k + O_ROW, ${glsl(GRAIN_PERIOD)}), i + O_SEED) * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float oceanBand(float d) {
  float x = (d - O_FRONT) / ${glsl(FRONT_WIDTH)};
  return exp(-x * x) * O_RELEASE;
}

float oceanHeight(float i, float k) {
  float x = oceanAcross(i), d = oceanDepth(k);
  float h = 0.0, total = 1e-4;
  for (int n = 0; n < ${WAVES}; n++) {
    vec4 s = uSwell[n];
    float theta = s.x * i + s.y * k + s.z;
    // The groove's crests are peaked by hard-edged mids: a sine leaning towards a cusp at its top.
    float chop = (n >= ${SWELLS} && n < ${SWELLS + GROOVES}) ? O_CHOP : 0.0;
    float shaped = mix(sin(theta), 1.0 - 2.0 * abs(cos(0.5 * theta + 0.7853982)), chop);
    h += s.w * shaped;
    total += abs(s.w);
  }
  oceanCrest = h / total;
  // A release: a front that runs away from the viewer.
  h += O_BULGE * oceanBand(d);
  // The world's fronts cross the sea as rings.
  float fronts = 0.0, lifted = 0.0;
  for (int w = 0; w < ${MAX_WAVES}; w++) {
    vec4 A = uWaveA[w];
    vec4 B = uWaveB[w];
    float radius = B.y * A.w * ${glsl(WAVE_REACH)};
    float reach = max(B.z * ${glsl(WAVE_REACH)} * 0.5, 1e-3);
    float off = (length(vec2(x - A.x * ${glsl(WAVE_SPREAD[0])}, d - ${glsl(WAVE_AHEAD)} - A.z * ${glsl(WAVE_SPREAD[1])})) - radius) / reach;
    float ring = B.x * exp(-off * off) / (1.0 + radius * ${WAVE_THIN});
    fronts += ring;
    lifted += ring * (B.w < 0.0 ? 0.7 : 1.0 - 0.8 * B.w);
  }
  oceanFront = fronts;
  return h + O_WAVE * lifted;
}
`;

// ---- CPU reference: the same terms in the same order, in single precision like the shader ----

const f = Math.fround;

/** Distance ahead of the viewer of mesh row `k` (units), and where mesh column `i` is across (units). */
export const oceanDepth = (o: Readonly<OceanValues>, k: number): number => f(f(k - o.shift - BEHIND) * o.cell);
export const oceanAcross = (o: Readonly<OceanValues>, i: number): number => f(f(i - o.shiftX) * o.cell);

/** Result of the reference beside the height: the fronts passing and how far up its waves the point is. Reused. */
export const oceanOut = { front: 0, crest: 0 };

/**
 * CPU reference of the GLSL `oceanHeight`: the sea at mesh column `i`, row `k`. `swell` holds the waves as the shader
 * receives them (vec4 each); `waveA` / `waveB` the packed fronts, or none. `scales` limits the sum to the first waves
 * (SWELLS: the long swell alone, what an observer riding the sea feels).
 */
export function oceanHeight(o: Readonly<OceanValues>, swell: Float32Array, i: number, k: number, waveA?: Float32Array, waveB?: Float32Array, scales = WAVES): number {
  const x = oceanAcross(o, i), d = oceanDepth(o, k);
  let h = 0, total = 1e-4;
  for (let n = 0; n < Math.min(WAVES, scales); n++) {
    const theta = f(f(f(swell[n * 4] * i) + f(swell[n * 4 + 1] * k)) + swell[n * 4 + 2]);
    const chop = n >= SWELLS && n < SWELLS + GROOVES ? o.chop : 0;
    const peaked = f(1 - f(2 * Math.abs(Math.cos(f(f(0.5 * theta) + f(0.7853982))))));
    const shaped = f(Math.sin(theta) + f(f(peaked - Math.sin(theta)) * chop));
    h = f(h + f(swell[n * 4 + 3] * shaped));
    total += Math.abs(swell[n * 4 + 3]);
  }
  oceanOut.crest = h / total;
  const band = Math.exp(-(((d - o.front) / FRONT_WIDTH) ** 2)) * o.release;
  h += o.bulge * band;
  let fronts = 0, lifted = 0;
  if (waveA && waveB) {
    for (let w = 0; w < MAX_WAVES; w++) {
      const radius = waveB[w * 4 + 1] * waveA[w * 4 + 3] * WAVE_REACH, reach = Math.max(waveB[w * 4 + 2] * WAVE_REACH * 0.5, 1e-3), b = waveB[w * 4 + 3];
      const off = (Math.hypot(x - waveA[w * 4] * WAVE_SPREAD[0], d - WAVE_AHEAD - waveA[w * 4 + 2] * WAVE_SPREAD[1]) - radius) / reach;
      const ring = waveB[w * 4] * Math.exp(-off * off) / (1 + radius * WAVE_THIN);
      fronts += ring; lifted += ring * (b < 0 ? 0.7 : 1 - 0.8 * b);
    }
  }
  oceanOut.front = fronts;
  return h + o.wave * lifted;
}

/** No height the law gives is further from the still sea than this, whatever the fronts (each of amplitude ≤ 2). */
export function oceanBound(o: Readonly<OceanValues>, swell: Float32Array): number {
  let sum = 0;
  for (let n = 0; n < WAVES; n++) sum += Math.abs(swell[n * 4 + 3]);
  return sum + Math.abs(o.bulge) + Math.abs(o.wave) * 2 * MAX_WAVES;
}
