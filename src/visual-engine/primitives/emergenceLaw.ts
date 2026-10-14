import { PERIOD, terrainAcross, terrainDepth, terrainHeight, type TerrainValues } from './terrainLaw';

/*
 * The emergence law: where a vertex of a structure that rises out of Generative Terrain is. Written twice, side by
 * side, and kept identical term by term (as the terrain law is): `emergenceLawGlsl` runs on the GPU for every vertex
 * of every structure, `emergentPoint` is the CPU reference the tests use.
 *
 * A structure belongs to the ground: it is anchored at a lattice point (column J, row R) — the lattice that does not
 * move, the one the mesh slides over — and it reads its ground through the terrain law itself (`terrainHeight`, the
 * same function, the same uniforms), never through a copy of the heights. So it travels with the ground, rises and
 * falls with its terraces, plates, fronts and releases, and cannot drift from it.
 *
 *   extrude    a cell of the ground raised: the four corners of its base are the ground's own vertices (the same
 *              call the ground makes for them), its top flat above the highest of them
 *   anchored   a solid standing in the ground: its base sunk below the lowest lattice point round it (so no part of the
 *              base is ever above the facets under it), leaning a little with the ground's normal there
 *
 * A structure is a template of three stacked pieces (each a ring of six corners at its bottom and at its top); a shape
 * says how many corners are distinct (6, 4, 3: the others coincide) and how it tapers. Its rise (0..1) is how far it
 * has come out (0: wholly under the ground, or flat in its cell); its pulse a uniform change of scale (≤ PULSE_LIMIT,
 * the height only for an extruded cell, which keeps its corners). Broken, the upper pieces move as rigid bodies, a
 * pure function of the age of the fracture (thrown, turning, falling back and sinking into the ground); the lowest
 * stays where it stands. Nothing here has a time of its own.
 */

/** Pieces of the template, corners of each of its rings. */
export const PIECES = 3;
export const CORNERS = 6;
/** Vertices of the template: a bottom and a top ring for each piece. */
export const TEMPLATE_VERTICES = PIECES * CORNERS * 2;

/** The shapes: distinct corners and how much the top keeps of the base's width. */
export const SHAPES = [
  { name: 'pillar', sides: 6, taper: 0.85 },
  { name: 'crystal', sides: 6, taper: 0.12 },
  { name: 'prism', sides: 3, taper: 0.7 },
  { name: 'block', sides: 4, taper: 1 },
] as const;
export type ShapeName = typeof SHAPES[number]['name'];
export const SHAPE = Object.fromEntries(SHAPES.map((s, i) => [s.name, i])) as { readonly [K in ShapeName]: number };

/** How far a fragment is thrown and falls (units/s, units/s²), how fast it turns (rad/s), when it lands and how fast it then sinks (s, units/s). */
const THROW = [2.5, 2] as const;
const LIFT = [3.5, 2.5] as const;
const GRAVITY = 16;
const SPIN = [1.5, 2.5] as const;
const LAND = 1.1;
const SINK = 2.5;
/** How far an anchored solid leans with the ground's normal at most (share of the normal's tilt). */
const LEAN = 0.45;
/** How far below the lowest lattice point round it an anchored solid's base sits (units). */
const BURY = 0.05;

/** One structure as the GPU receives it (three vec4 per instance). */
export interface Emergent {
  /** Lattice column and row of its anchor; 0 extrude, 1 anchored; shape index. */
  J: number; R: number; mode: number; shape: number;
  /** Full height (units), footprint radius (cells, anchored only), rise 0..1, pulse (share of its scale). */
  height: number; width: number; rise: number; pulse: number;
  /** Seconds since it broke (< 0: whole), its own number 0..1, light 0..1, turn about its axis (rad). */
  age: number; seed: number; light: number; turn: number;
}

/** Packs the instance attributes: aAnchor, aBody, aBreak. */
export function packEmergent(e: Readonly<Emergent>, anchor: Float32Array, body: Float32Array, brk: Float32Array, at: number): void {
  const o = at * 4;
  anchor[o] = e.J; anchor[o + 1] = e.R; anchor[o + 2] = e.mode; anchor[o + 3] = e.shape;
  body[o] = e.height; body[o + 1] = e.width; body[o + 2] = e.rise; body[o + 3] = e.pulse;
  brk[o] = e.age; brk[o + 1] = e.seed; brk[o + 2] = e.light; brk[o + 3] = e.turn;
}

/** The template: per vertex (corner, top of its piece 0/1, piece). Indices of its facets and of its edges. */
export function emergenceTemplate(): { position: Float32Array; faces: Uint16Array; edges: Uint16Array } {
  const position = new Float32Array(TEMPLATE_VERTICES * 3), faces: number[] = [], edges: number[] = [];
  const at = (p: number, l: number, c: number): number => (p * 2 + l) * CORNERS + c;
  for (let p = 0; p < PIECES; p++) for (let l = 0; l < 2; l++) for (let c = 0; c < CORNERS; c++) position.set([c, l, p], at(p, l, c) * 3);
  for (let p = 0; p < PIECES; p++) {
    for (let c = 0; c < CORNERS; c++) {
      const n = (c + 1) % CORNERS, a = at(p, 0, c), b = at(p, 0, n), d = at(p, 1, c), e = at(p, 1, n);
      faces.push(a, b, e, a, e, d);
      edges.push(a, b, d, e, a, d);
    }
    // Caps: the top of each piece, and its bottom (seen once the piece above or below it has gone).
    for (let c = 1; c < CORNERS - 1; c++) { faces.push(at(p, 1, 0), at(p, 1, c), at(p, 1, c + 1)); faces.push(at(p, 0, 0), at(p, 0, c + 1), at(p, 0, c)); }
  }
  return { position, faces: Uint16Array.from(faces), edges: Uint16Array.from(edges) };
}

const glsl = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/**
 * GLSL ES 3.00, after `terrainLawGlsl`. Declares `uShapes` and:
 *   emergentPoint(corner, top, piece)   the vertex of the instance (attributes aAnchor, aBody, aBreak) in the ground's space;
 *                                       writes `emergentLevel` (0..1 up the structure) and `emergentDepth` (its depth)
 */
export const emergenceLawGlsl = /* glsl */ `
attribute vec4 aAnchor;
attribute vec4 aBody;
attribute vec4 aBreak;
// x: distinct corners, y: taper (per shape)
uniform vec4 uShapes[${SHAPES.length}];

float emergentLevel;
float emergentDepth;

float emergentGround(float i, float k) {
  return terrainHeight(i, k, terrainDepth(k));
}

vec3 emergentRotate(vec3 v, vec3 axis, float angle) {
  float c = cos(angle), s = sin(angle);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

vec3 emergentPoint(float corner, float top, float piece) {
  float J = aAnchor.x, R = aAnchor.y, mode = aAnchor.z;
  vec4 shape = uShapes[int(aAnchor.w + 0.5)];
  float i = J - T_COL, k = mod(R - T_ROW, ${glsl(PERIOD)});
  float level = (piece + top) / ${glsl(PIECES)};
  float height = aBody.x * aBody.z;
  vec3 P, base, up = vec3(0.0, 1.0, 0.0);
  float floorY;
  if (mode < 0.5) {
    // A cell raised: its base corners are the ground's vertices, its top flat above the highest of them.
    float c = min(corner, 3.0);
    float di = (c > 0.5 && c < 2.5) ? 1.0 : 0.0, dk = c > 1.5 ? 1.0 : 0.0;
    float h00 = emergentGround(i, k), h10 = emergentGround(i + 1.0, k), h11 = emergentGround(i + 1.0, k + 1.0), h01 = emergentGround(i, k + 1.0);
    float high = max(max(h00, h10), max(h11, h01)), low = min(min(h00, h10), min(h11, h01));
    float ground = c < 0.5 ? h00 : c < 1.5 ? h10 : c < 2.5 ? h11 : h01;
    float d = terrainDepth(k + dk);
    P = vec3(terrainAcross(i + di, d), mix(ground, high + height * (1.0 + aBody.w), level), -d);
    float dc = terrainDepth(k + 0.5);
    base = vec3(terrainAcross(i + 0.5, dc), low, -dc);
    floorY = low;
    emergentDepth = d;
  } else {
    // A solid standing in the ground: below the lowest lattice point round it, leaning with the ground there.
    float low = 1e9, hl = 0.0, hr = 0.0, hn = 0.0, hf = 0.0;
    for (int a = -1; a <= 1; a++) {
      for (int b = -1; b <= 1; b++) {
        float h = emergentGround(i + float(a), k + float(b));
        low = min(low, h);
        if (a == -1 && b == 0) hl = h;
        if (a == 1 && b == 0) hr = h;
        if (a == 0 && b == -1) hn = h;
        if (a == 0 && b == 1) hf = h;
      }
    }
    float cell = T_CELL, d = terrainDepth(k);
    vec3 normal = normalize(vec3(-(hr - hl) * 0.5 / cell, 1.0, (hf - hn) * 0.5 / cell));
    up = normalize(mix(up, normal, ${LEAN}));
    vec3 ex = normalize(vec3(1.0, 0.0, 0.0) - up * up.x), ez = cross(ex, up);
    float width = aBody.y * cell, scale = 1.0 + aBody.w;
    floorY = low - BURY_PLACEHOLDER - width * length(up.xz);
    base = vec3(terrainAcross(i, d), floorY, -d);
    float sides = shape.x, taper = shape.y;
    float angle = 6.2831853 * min(corner, sides - 1.0) / sides + aBreak.w;
    float r = width * mix(1.0, taper, level) * scale;
    P = base + ex * (cos(angle) * r) + up * (level * height * scale) + ez * (sin(angle) * r);
    emergentDepth = d;
  }
  emergentLevel = level;
  // Broken: the pieces above the lowest are rigid bodies, thrown, turning, falling back to the ground and sinking.
  float age = aBreak.x;
  if (age >= 0.0 && piece > 0.5) {
    float s = aBreak.y * 6.2831853 + piece * 2.3999632;
    float u = fract(aBreak.y * 7.31 + piece * 0.618034);
    vec3 centre = base + up * (height * (piece + 0.5) / ${glsl(PIECES)});
    vec3 axis = normalize(vec3(cos(s), 0.35, sin(s)));
    vec3 moved = centre + vec3(cos(s) * ${glsl(THROW[0])} * (1.0 + ${glsl(THROW[1] / THROW[0])} * u), ${glsl(LIFT[0])} + ${glsl(LIFT[1])} * piece * 0.5, sin(s) * ${glsl(THROW[0])} * (1.0 + ${glsl(THROW[1] / THROW[0])} * u)) * age;
    moved.y -= 0.5 * ${glsl(GRAVITY)} * age * age;
    moved.y = max(moved.y, floorY - ${glsl(SINK)} * max(age - ${glsl(LAND)}, 0.0));
    P = moved + emergentRotate(P - centre, axis, (${glsl(SPIN[0])} + ${glsl(SPIN[1])} * u) * age * (u < 0.5 ? -1.0 : 1.0));
  }
  return P;
}
`.replace('BURY_PLACEHOLDER', glsl(BURY));

/** The ground's vertex at a lattice point, as the ground's shader places it (the reference of what "on the ground" means). */
export function groundVertex(t: Readonly<TerrainValues>, i: number, k: number, waveA?: Float32Array, waveB?: Float32Array): [number, number, number] {
  const d = terrainDepth(t, k);
  return [terrainAcross(t, i, d), terrainHeight(t, i, k, waveA, waveB), -d];
}

/** Output of the reference beside the point: its level up the structure, where its base is, and the floor it rests on. Reused. */
export const emergentOut = { level: 0, floor: 0, base: [0, 0, 0] as [number, number, number] };

/**
 * CPU reference of the GLSL `emergentPoint`: the vertex (corner, top, piece) of the structure `e` over the ground `t`.
 * `shapes`: the uShapes uniform (sides, taper per shape).
 */
export function emergentPoint(t: Readonly<TerrainValues>, e: Readonly<Emergent>, corner: number, top: number, piece: number, waveA?: Float32Array, waveB?: Float32Array): [number, number, number] {
  const i = e.J - t.col, k = ((e.R - t.row) % PERIOD + PERIOD) % PERIOD, level = (piece + top) / PIECES, height = e.height * e.rise;
  const ground = (a: number, b: number): number => terrainHeight(t, a, b, waveA, waveB);
  let P: [number, number, number], base: [number, number, number], up: [number, number, number] = [0, 1, 0], floorY: number;
  if (e.mode < 0.5) {
    const c = Math.min(corner, 3), di = c > 0.5 && c < 2.5 ? 1 : 0, dk = c > 1.5 ? 1 : 0;
    const h00 = ground(i, k), h10 = ground(i + 1, k), h11 = ground(i + 1, k + 1), h01 = ground(i, k + 1);
    const high = Math.max(h00, h10, h11, h01), low = Math.min(h00, h10, h11, h01), g = [h00, h10, h11, h01][c];
    const d = terrainDepth(t, k + dk);
    P = [terrainAcross(t, i + di, d), g + (high + height * (1 + e.pulse) - g) * level, -d];
    const dc = terrainDepth(t, k + 0.5);
    base = [terrainAcross(t, i + 0.5, dc), low, -dc];
    floorY = low;
  } else {
    let low = Infinity;
    const h: number[] = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const x = ground(i + a, k + b); h.push(x); low = Math.min(low, x); }
    const hl = h[1], hr = h[7], hn = h[3], hf = h[5], cell = t.cell, d = terrainDepth(t, k);
    const nx = -(hr - hl) * 0.5 / cell, nz = (hf - hn) * 0.5 / cell, nl = Math.hypot(nx, 1, nz);
    const mx = LEAN * nx / nl, my = 1 + LEAN * (1 / nl - 1), mz = LEAN * nz / nl, ml = Math.hypot(mx, my, mz);
    up = [mx / ml, my / ml, mz / ml];
    let ex: [number, number, number] = [1 - up[0] * up[0], -up[1] * up[0], -up[2] * up[0]];
    const el = Math.hypot(...ex); ex = [ex[0] / el, ex[1] / el, ex[2] / el];
    const ez: [number, number, number] = [ex[1] * up[2] - ex[2] * up[1], ex[2] * up[0] - ex[0] * up[2], ex[0] * up[1] - ex[1] * up[0]];
    const width = e.width * cell, scale = 1 + e.pulse, shape = SHAPES[Math.round(e.shape)];
    floorY = low - BURY - width * Math.hypot(up[0], up[2]);
    base = [terrainAcross(t, i, d), floorY, -d];
    const angle = 2 * Math.PI * Math.min(corner, shape.sides - 1) / shape.sides + e.turn, r = width * (1 + (shape.taper - 1) * level) * scale, lift = level * height * scale;
    P = [0, 1, 2].map((q) => base[q] + ex[q] * Math.cos(angle) * r + up[q] * lift + ez[q] * Math.sin(angle) * r) as [number, number, number];
  }
  if (e.age >= 0 && piece > 0.5) {
    const s = e.seed * 2 * Math.PI + piece * 2.3999632, u = ((e.seed * 7.31 + piece * 0.618034) % 1 + 1) % 1, age = e.age;
    const centre = [0, 1, 2].map((q) => base[q] + up[q] * height * (piece + 0.5) / PIECES);
    let ax = Math.cos(s), ay = 0.35, az = Math.sin(s);
    const al = Math.hypot(ax, ay, az); ax /= al; ay /= al; az /= al;
    const throw_ = THROW[0] * (1 + THROW[1] / THROW[0] * u);
    const moved = [centre[0] + Math.cos(s) * throw_ * age, centre[1] + (LIFT[0] + LIFT[1] * piece * 0.5) * age - 0.5 * GRAVITY * age * age, centre[2] + Math.sin(s) * throw_ * age];
    moved[1] = Math.max(moved[1], floorY - SINK * Math.max(age - LAND, 0));
    const angle = (SPIN[0] + SPIN[1] * u) * age * (u < 0.5 ? -1 : 1), c = Math.cos(angle), sn = Math.sin(angle);
    const v = [P[0] - centre[0], P[1] - centre[1], P[2] - centre[2]], dot = ax * v[0] + ay * v[1] + az * v[2];
    const cross = [ay * v[2] - az * v[1], az * v[0] - ax * v[2], ax * v[1] - ay * v[0]], axis = [ax, ay, az];
    P = [0, 1, 2].map((q) => moved[q] + v[q] * c + cross[q] * sn + axis[q] * dot * (1 - c)) as [number, number, number];
  }
  emergentOut.level = level; emergentOut.floor = floorY; emergentOut.base = base;
  return P;
}
