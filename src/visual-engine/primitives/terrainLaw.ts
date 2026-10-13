import { MAX_WAVES } from '../../render-systems/waves/WaveField';

/*
 * The terrain law: how high the ground is at one point of its lattice. Written
 * twice, side by side, and kept identical term by term: `terrainLawGlsl` runs
 * on the GPU for every vertex, `terrainHeight` is the CPU reference the tests
 * use (and any future backend implements).
 *
 * The ground is a lattice of cells that does not move: a vertex is a lattice
 * point (column j, row r), and travelling slides the mesh over the lattice by
 * whole cells (forwards, and sideways as the viewer follows the valley), so a
 * point of the landscape keeps its height as it comes closer and nothing
 * swims. The landscape is a pure function of the lattice point (a hash and two
 * lattices of smoothed values), so there is nothing to load, to generate ahead
 * or to keep: it repeats after PERIOD rows, which every lattice scale divides,
 * so the seam is not there.
 *
 *   landscape   a valley that meanders, walls of broad relief with a finer octave, roughness per vertex
 *   the world   pressure raises the relief, excitation the finer octave, the mids fold its crests sharp;
 *               stored potential cuts the ground into terraces and draws the valley in ahead; strain lifts
 *               whole plates; a release is a crest that runs down the valley and leaves another ground behind;
 *               the shared wave fronts cross it as rings; shimmer makes it tremble
 *
 * Every term the world adds is zero in a world at rest: what is left is the
 * landscape, still. Heights are bounded for any input (`terrainBound`).
 */

/** Rows after which the landscape repeats. Every lattice scale and every plate size divides it. */
export const PERIOD = 1024;
/** Cells of the broad lattice and of the finer one. */
const BROAD = 16;
const MID = 4;
/** Rows of the mesh behind the viewer: what is under and just behind the camera is ground too. */
export const BEHIND = 3;
/** Share of the relief the broad lattice has (the finer octave has the rest), and how much of it undulates the valley floor. */
const BROAD_SHARE = 0.62;
const FLOOR = 0.06;
/** The valley's walls rise over this many units from its floor. */
const SLOPE = 13;
/** The valley's centre wanders by these amplitudes (units) at these numbers of turns per period. */
const MEANDER = [[7, 3], [3.5, 7]] as const;
/** How far the far end leans with the stereo origin (units per unit of lean and squared unit of depth). */
const LEAN = 0.0035;
/** Depths (units) between which stored potential draws the valley in, and the most it takes of its width. */
const THROAT = [10, 90] as const;
const THROAT_SHARE = 0.55;
/** A release front is this deep (units). */
export const FRONT_WIDTH = 6;
/** Wave fronts: where they start ahead of the viewer (units), and how the world's units map to the ground's. */
const WAVE_AHEAD = 16;
const WAVE_REACH = 14;
const WAVE_SPREAD = [12, 20] as const;
/** How much less a high front lifts than a low one, and how a front thins as it spreads (per unit of radius). */
const WAVE_HIGH = 0.8;
const WAVE_THIN = 0.03;

/** Order of the packed terrain values (`uTerrain[i]` in GLSL, `packTerrain` in TS). */
const ORDER = [
  'row', 'shift', 'col', 'shiftX', 'cell', 'relief', 'rough', 'valley', 'crest', 'ridge', 'terrace', 'throat', 'lean', 'lift', 'front', 'release',
  'plateAfter', 'plateBefore', 'stepsAfter', 'stepsBefore', 'quake', 'bulge', 'wave', 'seedX', 'seedY',
] as const;
export type TerrainKey = typeof ORDER[number];
/** What the law reads, as the motion writes it every frame. */
export type TerrainValues = Record<TerrainKey, number>;
export const TERRAIN_VALUES = ORDER.length;
export const TERRAIN = Object.fromEntries(ORDER.map((key, i) => [key, i])) as { readonly [K in TerrainKey]: number };

/** A ground at rest: the landscape alone. `relief`, `rough`, `valley` and `cell` are the scene's own. */
export const createTerrain = (): TerrainValues => ({
  row: 0, shift: 0, col: 0, shiftX: 0, cell: 1, relief: 8, rough: 0.4, valley: 5, crest: 1, ridge: 0, terrace: 0, throat: 0, lean: 0, lift: 0, front: 1e4, release: 0,
  plateAfter: 8, plateBefore: 8, stepsAfter: 6, stepsBefore: 6, quake: 0, bulge: 0, wave: 0, seedX: 0, seedY: 0,
});

export function packTerrain(out: Float32Array, values: Readonly<TerrainValues>): Float32Array {
  for (let i = 0; i < ORDER.length; i++) out[i] = values[ORDER[i]];
  return out;
}

const defines = ORDER.map((key, i) => `#define T_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()} uTerrain[${i}]`).join('\n');
const glsl = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);
const meanderGlsl = MEANDER.map(([amplitude, turns]) => `${glsl(amplitude)} * sin(r * ${(2 * Math.PI * turns / PERIOD).toFixed(9)})`).join(' + ');

/**
 * GLSL ES 3.00. Declares `uTerrain`, `uWaveA`, `uWaveB` and:
 *   terrainDepth(k)            distance ahead of the viewer of mesh row k (units)
 *   terrainAcross(i, d)        where mesh column i is across the viewer at that depth (units): the far end leans
 *   terrainHeight(i, k, d)     height of the lattice point under column i of mesh row k; writes `terrainFront`
 *                              (how much of the wave fronts is passing there) and `terrainFine` (the point's own hash)
 */
export const terrainLawGlsl = /* glsl */ `
uniform float uTerrain[${TERRAIN_VALUES}];
uniform vec4 uWaveA[${MAX_WAVES}];
uniform vec4 uWaveB[${MAX_WAVES}];
${defines}

float terrainFront;
float terrainFine;

// A value each lattice point has for itself. Small whole numbers in, so it is the same on every GPU.
float terrainHash(vec2 c) {
  vec3 p = fract(vec3(c.x, c.y, c.x) * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

// Smoothed values on a lattice of \`scale\` cells; rows wrap at the period.
float terrainNoise(vec2 cell, float scale, float salt) {
  vec2 q = cell / scale;
  vec2 i = floor(q);
  vec2 f = q - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float wrap = ${glsl(PERIOD)} / scale;
  float y0 = mod(i.y, wrap), y1 = mod(i.y + 1.0, wrap);
  return mix(
    mix(terrainHash(vec2(i.x + salt, y0)), terrainHash(vec2(i.x + 1.0 + salt, y0)), u.x),
    mix(terrainHash(vec2(i.x + salt, y1)), terrainHash(vec2(i.x + 1.0 + salt, y1)), u.x),
    u.y
  );
}

// Where the valley's centre is at row r: periodic, so the landscape closes on itself.
float terrainMeander(float r) {
  return ${meanderGlsl};
}

float terrainDepth(float k) {
  return (k - T_SHIFT - ${glsl(BEHIND)}) * T_CELL;
}

// The pressure front of a release, where it is now.
float terrainBand(float d) {
  float x = (d - T_FRONT) / ${glsl(FRONT_WIDTH)};
  return exp(-x * x) * T_RELEASE;
}

// The far end leans towards where the sound is: the ground is bent as one piece, not reshaped.
float terrainAcross(float i, float d) {
  float ahead = max(d, 0.0);
  return (i - T_SHIFT_X) * T_CELL + T_LEAN * ahead * ahead * ${LEAN};
}

float terrainHeight(float i, float k, float d) {
  float r = mod(k + T_ROW, ${glsl(PERIOD)});
  float j = i + T_COL;
  vec2 cell = vec2(j + T_SEED_X, r);
  float x = (i - T_SHIFT_X) * T_CELL;
  float ahead = max(d, 0.0);

  // The valley: its centre wanders across the lattice (the viewer follows it); stored potential draws it in ahead.
  float width = T_VALLEY * (1.0 - ${THROAT_SHARE} * T_THROAT * smoothstep(${glsl(THROAT[0])}, ${glsl(THROAT[1])}, ahead));
  float walls = smoothstep(width, width + ${glsl(SLOPE)}, abs(j * T_CELL - terrainMeander(r)));

  // The landscape: broad relief, a finer octave whose crests the mids fold sharp, roughness per vertex.
  float broad = terrainNoise(cell, ${glsl(BROAD)}, T_SEED_Y);
  float mid = terrainNoise(cell, ${glsl(MID)}, T_SEED_Y + 31.0);
  float fine = terrainHash(cell + vec2(T_SEED_Y + 57.0, 0.0));
  terrainFine = fine;
  float fold = mix(mid, 1.0 - abs(2.0 * mid - 1.0), T_RIDGE);
  float h = T_RELIEF * (walls * (${BROAD_SHARE} * broad + ${(1 - BROAD_SHARE).toFixed(2)} * T_CREST * fold) + ${FLOOR} * (mid - 0.5) * (1.0 - walls));
  h += T_ROUGH * (fine - 0.5) * (1.0 - 0.8 * T_TERRACE);

  // Behind a release front the ground has its new configuration, ahead of it still the old one.
  bool passed = d < T_FRONT;
  float plate = passed ? T_PLATE_AFTER : T_PLATE_BEFORE;
  float steps = passed ? T_STEPS_AFTER : T_STEPS_BEFORE;
  // Stored potential organises the ground: its heights gather onto terraces.
  float stepHeight = T_RELIEF / steps;
  h = mix(h, floor(h / stepHeight + 0.5) * stepHeight, T_TERRACE);
  // Strain lifts whole plates: each moves as one rigid piece, by an amount of its own (no vertex moves alone).
  vec2 piece = floor(vec2(j + 512.0, r) / plate);
  h += (terrainHash(piece + vec2(T_SEED_Y + 91.0, 0.0)) - 0.5) * 2.0 * T_LIFT;
  // A release is a crest that runs down the valley.
  h += T_BULGE * terrainBand(d);

  // The world's wave fronts cross the ground as rings: low ones broad and tall, high ones thin and mostly light.
  float fronts = 0.0, lifted = 0.0;
  for (int w = 0; w < ${MAX_WAVES}; w++) {
    vec4 A = uWaveA[w];
    vec4 B = uWaveB[w];
    float radius = B.y * A.w * ${glsl(WAVE_REACH)};
    float reach = max(B.z * ${glsl(WAVE_REACH)} * 0.5, 1e-3);
    float off = (length(vec2(x - A.x * ${glsl(WAVE_SPREAD[0])}, d - ${glsl(WAVE_AHEAD)} - A.z * ${glsl(WAVE_SPREAD[1])})) - radius) / reach;
    float ring = B.x * exp(-off * off) / (1.0 + radius * ${WAVE_THIN});
    fronts += ring;
    lifted += ring * (B.w < 0.0 ? 0.7 : 1.0 - ${WAVE_HIGH} * B.w);
  }
  terrainFront = fronts;
  h += T_WAVE * lifted;
  // Shimmer: the ground trembles, each point its own way.
  h += T_QUAKE * (terrainHash(cell + vec2(T_SEED_Y + 113.0, 0.0)) - 0.5) * 2.0;
  return h;
}
`;

// ---- CPU reference: the same terms in the same order, in single precision like the shader ----

const f = Math.fround;
const fract = (x: number): number => f(x - Math.floor(x));
const mix = (a: number, b: number, t: number): number => f(a * f(1 - t) + f(b * t));
const smoothstep = (lo: number, hi: number, x: number): number => {
  const t = Math.min(1, Math.max(0, f(f(x - lo) / f(hi - lo))));
  return f(f(t * t) * f(3 - f(2 * t)));
};
const mod = (x: number, y: number): number => f(x - f(y * Math.floor(f(x / y))));

export function terrainHash(cx: number, cy: number): number {
  let px = fract(f(f(cx) * f(0.1031))), py = fract(f(f(cy) * f(0.1031))), pz = px;
  const d = f(f(f(px * f(py + f(33.33))) + f(py * f(pz + f(33.33)))) + f(pz * f(px + f(33.33))));
  px = f(px + d); py = f(py + d); pz = f(pz + d);
  return fract(f(f(px + py) * pz));
}

function terrainNoise(cx: number, cy: number, scale: number, salt: number): number {
  const qx = f(cx / scale), qy = f(cy / scale), ix = Math.floor(qx), iy = Math.floor(qy), fx = f(qx - ix), fy = f(qy - iy);
  const ux = f(f(fx * fx) * f(3 - f(2 * fx))), uy = f(f(fy * fy) * f(3 - f(2 * fy)));
  const wrap = PERIOD / scale, y0 = mod(iy, wrap), y1 = mod(iy + 1, wrap);
  return mix(
    mix(terrainHash(ix + salt, y0), terrainHash(ix + 1 + salt, y0), ux),
    mix(terrainHash(ix + salt, y1), terrainHash(ix + 1 + salt, y1), ux),
    uy,
  );
}

/** Where the valley's centre is at row `r` (units across the lattice): what the viewer follows. */
export const terrainMeander = (r: number): number => MEANDER.reduce((sum, [amplitude, turns]) => sum + amplitude * Math.sin(r * (2 * Math.PI * turns / PERIOD)), 0);

/** Distance ahead of the viewer of mesh row `k` (units). */
export const terrainDepth = (t: Readonly<TerrainValues>, k: number): number => (k - t.shift - BEHIND) * t.cell;

/** Where mesh column `i` is across the viewer at depth `d` (units). */
export const terrainAcross = (t: Readonly<TerrainValues>, i: number, d: number): number => (i - t.shiftX) * t.cell + t.lean * Math.max(d, 0) ** 2 * LEAN;

/** The release front's pressure at depth `d`. */
export const terrainBand = (t: Readonly<TerrainValues>, d: number): number => {
  const x = (d - t.front) / FRONT_WIDTH;
  return Math.exp(-x * x) * t.release;
};

/** Result of the reference beside the height: how much of the wave fronts is passing, and the point's own hash. Reused. */
export const terrainOut = { front: 0, fine: 0 };

/**
 * CPU reference of the GLSL `terrainHeight`: the lattice point under column `i` of mesh row `k`. `waveA` / `waveB`
 * are the packed fronts (fields/fieldLaw.ts `packWaves`), or none.
 */
export function terrainHeight(t: Readonly<TerrainValues>, i: number, k: number, waveA?: Float32Array, waveB?: Float32Array): number {
  const d = terrainDepth(t, k), r = mod(k + t.row, PERIOD), j = i + t.col, cx = j + t.seedX, x = (i - t.shiftX) * t.cell, ahead = Math.max(d, 0);
  const width = t.valley * (1 - THROAT_SHARE * t.throat * smoothstep(THROAT[0], THROAT[1], ahead));
  const walls = smoothstep(width, width + SLOPE, Math.abs(j * t.cell - terrainMeander(r)));
  const broad = terrainNoise(cx, r, BROAD, t.seedY), mid = terrainNoise(cx, r, MID, t.seedY + 31), fine = terrainHash(cx + t.seedY + 57, r);
  const fold = mid + (1 - Math.abs(2 * mid - 1) - mid) * t.ridge;
  let h = t.relief * (walls * (BROAD_SHARE * broad + (1 - BROAD_SHARE) * t.crest * fold) + FLOOR * (mid - 0.5) * (1 - walls));
  h += t.rough * (fine - 0.5) * (1 - 0.8 * t.terrace);
  const passed = d < t.front, plate = passed ? t.plateAfter : t.plateBefore, steps = passed ? t.stepsAfter : t.stepsBefore;
  const stepHeight = t.relief / steps;
  h += (Math.floor(h / stepHeight + 0.5) * stepHeight - h) * t.terrace;
  h += (terrainHash(Math.floor((j + 512) / plate) + t.seedY + 91, Math.floor(r / plate)) - 0.5) * 2 * t.lift;
  h += t.bulge * terrainBand(t, d);
  let fronts = 0, lifted = 0;
  if (waveA && waveB) {
    for (let w = 0; w < MAX_WAVES; w++) {
      const radius = waveB[w * 4 + 1] * waveA[w * 4 + 3] * WAVE_REACH, reach = Math.max(waveB[w * 4 + 2] * WAVE_REACH * 0.5, 1e-3), band = waveB[w * 4 + 3];
      const off = (Math.hypot(x - waveA[w * 4] * WAVE_SPREAD[0], d - WAVE_AHEAD - waveA[w * 4 + 2] * WAVE_SPREAD[1]) - radius) / reach;
      const ring = waveB[w * 4] * Math.exp(-off * off) / (1 + radius * WAVE_THIN);
      fronts += ring; lifted += ring * (band < 0 ? 0.7 : 1 - WAVE_HIGH * band);
    }
  }
  terrainOut.front = fronts; terrainOut.fine = fine;
  h += t.wave * lifted;
  h += t.quake * (terrainHash(cx + t.seedY + 113, r) - 0.5) * 2;
  return h;
}

/** No height the law gives is further from the valley floor than this, whatever the fronts (each of amplitude ≤ 2). */
export function terrainBound(t: Readonly<TerrainValues>): number {
  return Math.abs(t.relief) * (BROAD_SHARE + (1 - BROAD_SHARE) * Math.abs(t.crest) + FLOOR) * 1.5 + Math.abs(t.rough) + Math.abs(t.lift) + Math.abs(t.bulge) +
    Math.abs(t.wave) * 2 * MAX_WAVES + Math.abs(t.quake);
}
