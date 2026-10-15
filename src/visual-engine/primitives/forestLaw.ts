import { PERIOD, terrainAcross, terrainDepth, terrainHeight, type TerrainValues } from './terrainLaw';

/*
 * The forest law (Resonant Forest): where a vertex of a tree is. Written twice, side by side, and kept identical term
 * by term (as the terrain and emergence laws are): `forestLawGlsl` runs on the GPU for every vertex of every branch,
 * leaf and filament, `branchPoint` / `leafPoint` are the CPU references the tests use.
 *
 * A tree belongs to the ground: it is anchored at a lattice point (column J, row R) and stands on the ground's own
 * vertex there — the terrain law itself, on the same uniforms, never a copy — a little sunk into it, so it travels with
 * the ground and cannot float. Its shape is fixed when it is seeded (`growTree`: deterministic segments from a seed and
 * the music heard then); what changes is how far it has grown (each segment grows from its start in the order of its
 * depth, and retracts tip first as the tree decays), a rigid lean about its root (the wind of the world's stereo side,
 * bounded), and its light. Nothing here has a time of its own.
 *
 *   branch     a segment as a three-sided prism's edges: three lines from its start to where it has grown to
 *   leaf       a flat triangle at the end of a terminal segment, open once the tree is mature; it falls as the tree decays
 *   node       a small triangle at a junction, lit as the tree resonates
 *   filament   a line between the crowns of two trees that resonate with the same remembered music
 */

/** Trees at most, segments and leaves per tree, filaments in all. */
export const MAX_TREES = 40;
export const MAX_SEGMENTS = 24;
export const MAX_LEAVES = 24;
export const MAX_FILAMENTS = 48;
/** Corners of a branch's section, and the vertices of its template (a start and an end per corner). */
export const SIDES = 3;
export const BRANCH_VERTICES = SIDES * 2;
/** How far below the ground's vertex a trunk starts (units): it stands in the ground, never on air. */
const SINK = 0.08;
/** How far a leaf drops as the tree decays (units at full fall), and a leaf's size relative to its branch. */
const LEAF_DROP = 3.5;

/** The traits a tree is grown from: read from the music when it is seeded, quantized so a frame's difference does not change a tree. */
export interface TreeTraits {
  /** Branches per junction 2..3 (the geometry's branching), spread of the branches (rad), how they reach up (0 spread, 1 upright). */
  branching: number;
  spread: number;
  upright: number;
  /** Height of the tree (units), and how many leaves per terminal branch (0..1 share). */
  height: number;
  foliage: number;
}

/** One tree's segments and leaves, as its instances carry them (written once at seeding). */
export interface TreeShape {
  segments: number;
  leaves: number;
  /** Per segment: start xyz, depth; end xyz, birth (share of the tree's growth at which it starts growing); radius at the start. */
  from: Float32Array;
  to: Float32Array;
  radius: Float32Array;
  /** Per leaf: where (xyz) and the birth of the branch it ends; size, turn, kind (0 leaf, 1 node), its own number. */
  leaf: Float32Array;
  leafLook: Float32Array;
  /** Highest point of the crown (units above the root) and its widest reach (units from the axis). */
  top: number;
  reach: number;
}

export const createShape = (): TreeShape => ({
  segments: 0, leaves: 0, from: new Float32Array(MAX_SEGMENTS * 4), to: new Float32Array(MAX_SEGMENTS * 4), radius: new Float32Array(MAX_SEGMENTS),
  leaf: new Float32Array(MAX_LEAVES * 4), leafLook: new Float32Array(MAX_LEAVES * 4), top: 0, reach: 0,
});

/** A number 0..1 for a seed and a salt, the same everywhere. */
export function forestHash(seed: number, salt: number): number {
  let h = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((salt | 0) + 0x632be59b, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const four = (a: Float32Array, at: number, x: number, y: number, z: number, w: number): void => { a[at * 4] = x; a[at * 4 + 1] = y; a[at * 4 + 2] = z; a[at * 4 + 3] = w; };

/** Depths of a tree: the trunk (0) and three orders of branches. Growth goes through them in order. */
export const DEPTHS = 4;
/** Share of the tree's growth one depth takes. */
export const SPAN = 1 / DEPTHS;

/**
 * Grows the shape of a tree from its seed and its traits into `out` (its arrays reused; nothing allocated). The trunk
 * leans a little; each junction opens `branching` branches round the parent's axis, each shorter and thinner, tilted by
 * the spread and drawn up by `upright`; leaves at the ends of the last ones, nodes at the junctions.
 */
export function growTree(seed: number, t: Readonly<TreeTraits>, out: TreeShape): TreeShape {
  let n = 0, leaves = 0, top = 0, reach = 0;
  const trunk = t.height * 0.38, lean = 0.12 * (forestHash(seed, 1) - 0.5), turn = 2 * Math.PI * forestHash(seed, 2);
  const put = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, depth: number, radius: number): number => {
    if (n >= MAX_SEGMENTS) return -1;
    four(out.from, n, x0, y0, z0, depth); four(out.to, n, x1, y1, z1, depth * SPAN); out.radius[n] = radius;
    top = Math.max(top, y1); reach = Math.max(reach, Math.hypot(x1, z1));
    return n++;
  };
  put(0, 0, 0, Math.sin(lean) * Math.cos(turn) * trunk, Math.cos(lean) * trunk, Math.sin(lean) * Math.sin(turn) * trunk, 0, 0.22 + 0.02 * t.height);
  // Breadth first: every segment of a depth before the next, so growth reaches the tips last.
  for (let first = 0, depth = 1; depth < DEPTHS; depth++) {
    const last = n;
    for (let s = first; s < last; s++) {
      const o = s * 4, px = out.to[o], py = out.to[o + 1], pz = out.to[o + 2];
      const dx = px - out.from[o], dy = py - out.from[o + 1], dz = pz - out.from[o + 2], length = Math.hypot(dx, dy, dz) || 1;
      const ux = dx / length, uy = dy / length, uz = dz / length;
      const count = depth === 1 ? Math.round(2 + t.branching) : Math.round(2 + t.branching * forestHash(seed, 10 + s));
      const base = 2 * Math.PI * forestHash(seed, 20 + s);
      for (let c = 0; c < count; c++) {
        const around = base + (2 * Math.PI * c) / count + 0.4 * (forestHash(seed, 30 + s * 4 + c) - 0.5);
        const tilt = t.spread * (0.75 + 0.5 * forestHash(seed, 60 + s * 4 + c)) * (1 - 0.45 * t.upright);
        // A direction tilted off the parent's axis, round it, then drawn up a little.
        const ax = Math.abs(uy) < 0.9 ? 0 : 1, ay = Math.abs(uy) < 0.9 ? 1 : 0;
        let vx = uy * 0 - uz * ay, vy = uz * ax - ux * 0, vz = ux * ay - uy * ax;
        const vl = Math.hypot(vx, vy, vz) || 1; vx /= vl; vy /= vl; vz /= vl;
        const wx = uy * vz - uz * vy, wy = uz * vx - ux * vz, wz = ux * vy - uy * vx;
        const ca = Math.cos(around), sa = Math.sin(around), ct = Math.cos(tilt), st = Math.sin(tilt);
        let bx = ux * ct + (vx * ca + wx * sa) * st, by = uy * ct + (vy * ca + wy * sa) * st + 0.25 * t.upright, bz = uz * ct + (vz * ca + wz * sa) * st;
        const bl = Math.hypot(bx, by, bz) || 1; bx /= bl; by /= bl; bz /= bl;
        const child = length * (0.62 + 0.12 * forestHash(seed, 90 + s * 4 + c)), radius = out.radius[s] * 0.55;
        if (put(px, py, pz, px + bx * child, py + by * child, pz + bz * child, depth, radius) < 0) break;
      }
      // A node at the junction: it lights as the tree resonates.
      if (leaves < MAX_LEAVES) { four(out.leaf, leaves, px, py, pz, depth * SPAN); four(out.leafLook, leaves, 0.35 + 0.15 * (DEPTHS - depth), 0, 1, forestHash(seed, 200 + s)); leaves++; }
    }
    first = last;
  }
  // Leaves at the ends of the last branches, as many as the foliage allows.
  for (let s = 0; s < n && leaves < MAX_LEAVES; s++) {
    if (out.from[s * 4 + 3] !== DEPTHS - 1 || forestHash(seed, 300 + s) > 0.35 + 0.65 * t.foliage) continue;
    four(out.leaf, leaves, out.to[s * 4], out.to[s * 4 + 1], out.to[s * 4 + 2], 1);
    four(out.leafLook, leaves, 0.9 + 0.9 * forestHash(seed, 400 + s), 2 * Math.PI * forestHash(seed, 500 + s), 0, forestHash(seed, 600 + s));
    leaves++;
  }
  out.segments = n; out.leaves = leaves; out.top = top; out.reach = reach;
  return out;
}

const glsl = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/**
 * GLSL ES 3.00, after `terrainLawGlsl`. Declares `uTrees`, `uTreeLean` and:
 *   forestRoot(J, R)              where the tree anchored at lattice point (J, R) stands, in the ground's space
 *   forestLean(p, slot)           a point of a tree's frame turned rigidly about its root by the tree's lean
 *   forestGrown(birth, slot)      how much of a segment born at `birth` has grown, 0..1
 * `uTrees[slot]`: growth (0 … 1, past 1 the leaves open), lean (rad), light, decay (0..1: how far its leaves have fallen).
 * `uTreeLean[slot]`: the lean's direction (rad about the vertical), resonance 0..1, leaf share 0..1, the tree's flush 0..1.
 */
export const forestLawGlsl = /* glsl */ `
uniform vec4 uTrees[${MAX_TREES}];
uniform vec4 uTreeLean[${MAX_TREES}];

vec3 forestRoot(float J, float R) {
  float i = J - T_COL, k = mod(R - T_ROW, ${glsl(PERIOD)});
  float d = terrainDepth(k);
  return vec3(terrainAcross(i, d), terrainHeight(i, k, d) - ${glsl(SINK)}, -d);
}

vec3 forestLean(vec3 p, int slot) {
  float angle = uTrees[slot].y, around = uTreeLean[slot].x;
  vec3 axis = vec3(cos(around), 0.0, sin(around));
  float c = cos(angle), s = sin(angle);
  return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
}

float forestGrown(float birth, int slot) {
  return clamp((uTrees[slot].x - birth) / ${glsl(SPAN)}, 0.0, 1.0);
}
`;

// ---- CPU references ----

/** One tree as the GPU receives it (`uTrees`, `uTreeLean`). */
export interface TreeState { J: number; R: number; growth: number; lean: number; around: number; light: number; decay: number; resonance: number; leaves: number; flush: number }

export function forestRoot(t: Readonly<TerrainValues>, J: number, R: number): [number, number, number] {
  const i = J - t.col, k = ((R - t.row) % PERIOD + PERIOD) % PERIOD, d = terrainDepth(t, k);
  return [terrainAcross(t, i, d), terrainHeight(t, i, k) - SINK, -d];
}

export function forestLean(p: readonly [number, number, number], angle: number, around: number): [number, number, number] {
  const ax = Math.cos(around), az = Math.sin(around), c = Math.cos(angle), s = Math.sin(angle), dot = ax * p[0] + az * p[2];
  // cross((ax, 0, az), p)
  const cx = -az * p[1], cy = az * p[0] - ax * p[2], cz = ax * p[1];
  return [p[0] * c + cx * s + ax * dot * (1 - c), p[1] * c + cy * s, p[2] * c + cz * s + az * dot * (1 - c)];
}

export const forestGrown = (birth: number, growth: number): number => Math.min(1, Math.max(0, (growth - birth) / SPAN));

/** CPU reference: vertex `corner` (0..2) at `end` (0 start, 1 where it has grown to) of segment `s` of a tree over the ground `t`. */
export function branchPoint(t: Readonly<TerrainValues>, tree: Readonly<TreeState>, shape: Readonly<TreeShape>, s: number, corner: number, end: number): [number, number, number] {
  const o = s * 4, grown = forestGrown(shape.to[o + 3], tree.growth), along = end * grown;
  const x = shape.from[o] + (shape.to[o] - shape.from[o]) * along, y = shape.from[o + 1] + (shape.to[o + 1] - shape.from[o + 1]) * along, z = shape.from[o + 2] + (shape.to[o + 2] - shape.from[o + 2]) * along;
  // The prism's corner: round the segment's axis at its radius, tapering to two thirds at its end.
  const r = shape.radius[s] * (1 - 0.33 * along) * grown, angle = (2 * Math.PI * corner) / SIDES;
  const local = forestLean([x + Math.cos(angle) * r, y, z + Math.sin(angle) * r], tree.lean, tree.around), root = forestRoot(t, tree.J, tree.R);
  return [root[0] + local[0], root[1] + local[1], root[2] + local[2]];
}

/** CPU reference: corner `c` (0..2) of leaf `l` of a tree (a node when its kind is 1). */
export function leafPoint(t: Readonly<TerrainValues>, tree: Readonly<TreeState>, shape: Readonly<TreeShape>, l: number, c: number): [number, number, number] {
  const o = l * 4, node = shape.leafLook[o + 2] > 0.5, open = node ? forestGrown(shape.leaf[o + 3], tree.growth) : Math.min(1, Math.max(0, (tree.growth - 1) * 4)) * tree.leaves;
  const size = shape.leafLook[o] * (node ? 0.45 : 1) * open, angle = shape.leafLook[o + 1] + (2 * Math.PI * c) / 3;
  const fall = node ? 0 : tree.decay * tree.decay * LEAF_DROP;
  const p: [number, number, number] = [shape.leaf[o] + Math.cos(angle) * size, shape.leaf[o + 1] + (c === 0 ? 0.5 * size : -0.2 * size) - fall, shape.leaf[o + 2] + Math.sin(angle) * size];
  const local = forestLean(p, tree.lean, tree.around), root = forestRoot(t, tree.J, tree.R);
  return [root[0] + local[0], root[1] + local[1], root[2] + local[2]];
}

/** The GLSL of a branch vertex and of a leaf vertex (same terms as the references above). */
export const branchGlsl = /* glsl */ `
// x: corner, y: end (0 start, 1 grown tip)
attribute vec4 aFrom;
attribute vec4 aTo;
// x: J, y: R, z: slot, w: radius at the start
attribute vec4 aTree;
float branchGrown;
float branchDepth;
vec3 branchPoint(float corner, float end) {
  int slot = int(aTree.z + 0.5);
  float grown = forestGrown(aTo.w, slot), along = end * grown;
  vec3 p = mix(aFrom.xyz, aTo.xyz, along);
  float r = aTree.w * (1.0 - 0.33 * along) * grown, angle = 6.2831853 * corner / ${glsl(SIDES)};
  p += vec3(cos(angle) * r, 0.0, sin(angle) * r);
  branchGrown = grown;
  branchDepth = aFrom.w;
  return forestRoot(aTree.x, aTree.y) + forestLean(p, slot);
}
`;

export const leafGlsl = /* glsl */ `
// xyz: where, w: birth of the branch it ends
attribute vec4 aLeaf;
// x: size, y: turn, z: kind (0 leaf, 1 node), w: its own number
attribute vec4 aLeafLook;
// x: J, y: R, z: slot, w: unused
attribute vec4 aTree;
float leafOpen;
float leafNode;
vec3 leafPoint(float c) {
  int slot = int(aTree.z + 0.5);
  vec4 tree = uTrees[slot], look = uTreeLean[slot];
  bool node = aLeafLook.z > 0.5;
  float open = node ? forestGrown(aLeaf.w, slot) : clamp((tree.x - 1.0) * 4.0, 0.0, 1.0) * look.z;
  float size = aLeafLook.x * (node ? 0.45 : 1.0) * open, angle = aLeafLook.y + 6.2831853 * c / 3.0;
  float fall = node ? 0.0 : tree.w * tree.w * ${glsl(LEAF_DROP)};
  vec3 p = vec3(aLeaf.x + cos(angle) * size, aLeaf.y + (c < 0.5 ? 0.5 * size : -0.2 * size) - fall, aLeaf.z + sin(angle) * size);
  leafOpen = open;
  leafNode = node ? 1.0 : 0.0;
  return forestRoot(aTree.x, aTree.y) + forestLean(p, slot);
}
`;
