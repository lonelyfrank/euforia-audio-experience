import type { QualityProfile } from '../../types/visualizer';
import { PERIOD, terrainAcross, terrainDepth, terrainHeight, terrainMeander, type TerrainValues } from './terrainLaw';

/*
 * The forest law (Resonant Forest): where a vertex of a tree is. Written twice, side by side, and kept identical term
 * by term (as the terrain and emergence laws are): `forestLawGlsl` + `barkGlsl` / `leafGlsl` run on the GPU for every
 * vertex of every trunk, branch, twig, blossom and filament, `barkPoint` / `leafPoint` are the CPU references the tests
 * and the parity check use.
 *
 * A tree belongs to the ground: it is anchored at a lattice point (column J, row R) and stands on the ground's own
 * vertex there — the terrain law itself, on the same uniforms, never a copy — a little sunk into it, so it travels with
 * the ground and cannot float. Its shape is fixed when it is seeded (`growTree`: a crystalline tree of closed, faceted
 * tubes, deterministic from a seed and the music heard then, docs/resonant-forest.md); what changes is how far it has
 * grown (each segment grows out of its start in the order of its depth, and retracts tip first as the tree decays), a
 * rigid lean about its root (the wind of the world's stereo side, bounded), and its light. No vertex is ever moved by
 * the sound: every variation is decided at seeding.
 *
 *   bark       trunk, roots, limbs and branches: closed tubes of 3–8 faceted sides, ring after ring, each ring turned
 *              and of its own radius; a face may glow (structural emission), one or two edge columns are veins
 *   twig       thin lines at the ends of the last branches (and branches too thin to be tubes)
 *   blossom    a small triangle at the end of a twig, open once the tree is mature; it falls as the tree decays
 *   node       a small triangle at a junction, lit as the tree resonates
 *   shard      a root crystal: an obsidian pyramid on the ground round the trunk, on its own lattice point
 *   crystal    a translucent bipyramid: at a fork, hanging from a twig on a thread, floating by a monumental tree, or
 *              floating over the forest (the crystal field, on the ground's own slot: `GROUND_SLOT`)
 *   filament   a catenary between anchors of two crowns (the resonance network), formed when a tree matures
 */

/** Trees at most, blossoms and nodes per tree, filaments in all, network anchors per tree. */
export const MAX_TREES = 40;
export const MAX_LEAVES = 96;
export const MAX_FILAMENTS = 128;
export const MAX_ANCHORS = 8;
/** The slot of what belongs to the ground rather than to a tree (the floating crystals): always grown, never leaning. */
export const GROUND_SLOT = MAX_TREES;
/** Slots the per-tree uniforms hold: the trees and the ground's. */
export const SLOTS = MAX_TREES + 1;
/** How far below the ground's vertex a tree's root point is (units): it stands in the ground, never on air. */
const SINK = 0.08;
/** How far a blossom drops as the tree decays (units at full fall). */
const LEAF_DROP = 3.5;

/** Emissive colours of the forest, by index (the palette is the recipe's: `forestLook.ts`). */
export const VIOLET = 0, MAGENTA = 1, BLUE = 2, CYAN = 3, LILAC = 4;
export const GLOWS = 5;
/** Colours a vein, a blossom (the first three for scattered ones) and a junction's node are drawn from. */
const VEIN = [VIOLET, BLUE, MAGENTA, LILAC];
const BLOSSOM = [VIOLET, LILAC, MAGENTA, BLUE];
const NODE = [CYAN, BLUE, LILAC];
const FORK = [CYAN, BLUE, LILAC];
const HANGING = [CYAN, BLUE, VIOLET, LILAC];
const FLOATING = [CYAN, BLUE, VIOLET, LILAC, MAGENTA];
/** A crystal's scale: the structural emission E, or the nodes (strongest in a build-up). */
export const SCALE_E = 0, SCALE_NODES = 1;

/** The traits a tree is grown from: read from the music when it is seeded, quantized so a frame's difference does not change a tree. */
export interface TreeTraits {
  /** Share of junctions that open three branches rather than two, how far branches reach out (0.55..1), how they reach up (0..1). */
  branching: number;
  spread: number;
  upright: number;
  /** Height of the tree (units), and how much it blossoms (0..1). */
  height: number;
  foliage: number;
}

/**
 * How finely a tree is made: fixed for the life of the forest (the quality it was mounted at). Sides and rings of the
 * trunk (a branch has one side less per depth, at least three), the deepest branch order (1: limbs only … 3), shares of
 * roots, twigs and blossoms, and the vertices of bark and of twigs one tree may use (what does not fit is not made).
 */
export interface TreeDetail {
  sides: number;
  rings: number;
  depth: number;
  roots: number;
  twigs: number;
  blossoms: number;
  flare: number;
  /** Share of crystals (root, fork, hanging, floating), the vertices of crystals one tree may use, the neighbours a tree links to. */
  crystals: number;
  gem: number;
  links: number;
  bark: number;
  twig: number;
}

/** (Bark budgets are whole triangles and twig budgets whole lines: a slot's part of the buffers starts on a primitive.) */
export const TREE_DETAIL: Readonly<Record<'low' | 'medium' | 'high', Readonly<TreeDetail>>> = {
  low: { sides: 5, rings: 3, depth: 2, roots: 0.6, twigs: 0.5, blossoms: 0.45, flare: 1.35, crystals: 0.45, gem: 216, links: 1, bark: 864, twig: 192 },
  medium: { sides: 6, rings: 5, depth: 3, roots: 1, twigs: 0.8, blossoms: 0.8, flare: 1.65, crystals: 0.75, gem: 324, links: 2, bark: 2142, twig: 384 },
  high: { sides: 7, rings: 7, depth: 3, roots: 1, twigs: 1, blossoms: 1, flare: 1.65, crystals: 1, gem: 432, links: 3, bark: 2700, twig: 512 },
};

/** The detail of a quality: Low simplifies geometry and population, it does not switch the forest off. */
export const treeDetail = (quality: Pick<QualityProfile, 'density'>): Readonly<TreeDetail> => (quality.density >= 0.9 ? TREE_DETAIL.high : quality.density >= 0.5 ? TREE_DETAIL.medium : TREE_DETAIL.low);

/** One tree's geometry, as the GPU receives it (written once at seeding). */
export interface TreeShape {
  /** Bark vertices (triangles, three by three) and twig vertices (lines, two by two) in use. */
  bark: number;
  twigs: number;
  /** Per bark vertex: where it is when fully grown (xyz, the tree's own frame). */
  point: Float32Array;
  /** Per bark vertex: the start of its segment's axis (xyz), which it grows out of, and the segment's birth (share of growth). */
  base: Float32Array;
  /** Per bark vertex: emissive colour, emission (0: a dark face), how bright this corner of the face is (0..1), shade of the stone. */
  glow: Float32Array;
  /** Per bark vertex: vein colour, 1 on a vein edge (0 elsewhere), the vein's intensity. */
  vein: Float32Array;
  /** Per bark vertex: the lattice point it stands on, as columns and rows from the tree's (a root crystal stands on its own). */
  site: Float32Array;
  /** Per twig vertex: where (xyz), and its start and birth as for bark; colour (-1: a dark twig) and emission (a crystal's thread). */
  twigPoint: Float32Array;
  twigBase: Float32Array;
  twigLook: Float32Array;
  /** The tree's crystals (fork, hanging, resonance), in its own frame. */
  crystals: GemSink;
  /** Blossoms and nodes in use. Per leaf: where (xyz) and the birth of the branch it ends; size, turn, kind (0 blossom, 1 node), colour. */
  leaves: number;
  leaf: Float32Array;
  leafLook: Float32Array;
  /** Ends of second-order branches (the resonance network's anchors, xyz), as many as `anchors`. */
  anchors: number;
  anchor: Float32Array;
  /** Highest point of the crown (units above the root) and its widest reach (units from the axis). */
  top: number;
  reach: number;
  /** Radius of the trunk at its base (units), and whether the tree is one of the forest's monumental ones. */
  radius: number;
  monumental: boolean;
}

/** Where crystals' vertices go: per vertex where it is, the point it grows out of and its birth, its look (colour, intensity, scale, corner). */
export interface GemSink { count: number; limit: number; point: Float32Array; base: Float32Array; look: Float32Array }
export const createGems = (limit: number): GemSink => ({ count: 0, limit, point: new Float32Array(limit * 3), base: new Float32Array(limit * 4), look: new Float32Array(limit * 4) });

export const createShape = (detail: Readonly<TreeDetail> = TREE_DETAIL.high): TreeShape => ({
  bark: 0, twigs: 0, point: new Float32Array(detail.bark * 3), base: new Float32Array(detail.bark * 4), glow: new Float32Array(detail.bark * 4),
  vein: new Float32Array(detail.bark * 3), site: new Float32Array(detail.bark * 2), twigPoint: new Float32Array(detail.twig * 3), twigBase: new Float32Array(detail.twig * 4),
  twigLook: new Float32Array(detail.twig * 2), crystals: createGems(detail.gem),
  leaves: 0, leaf: new Float32Array(MAX_LEAVES * 4), leafLook: new Float32Array(MAX_LEAVES * 4), anchors: 0, anchor: new Float32Array(MAX_ANCHORS * 3),
  top: 0, reach: 0, radius: 0, monumental: false,
});

/** A number 0..1 for a seed and a salt, the same everywhere. */
export function forestHash(seed: number, salt: number): number {
  let h = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((salt | 0) + 0x632be59b, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Depths of a tree: the trunk and roots (0) and three orders of branches. Growth goes through them in order; twigs come last. */
export const DEPTHS = 4;
/** Share of the tree's growth one depth takes. */
export const SPAN = 1 / DEPTHS;
/** Birth of the twigs: they grow while the blossoms open (growth 1 → 1.25). */
const TWIG_BIRTH = 1;
/** Share of the forest's trees that are monumental, and how much taller and wider they are. */
const MONUMENTAL = 0.12;
const MONUMENTAL_HEIGHT = 1.5;
/** Rings of a branch by its depth (a limb has three, at Low two). */
const BRANCH_RINGS = [0, 3, 2, 1];

// Scratch of the grower, sized for the finest detail (rings ≤ 10, sides ≤ 8); nothing is allocated while a tree grows.
const ringScratch = new Float32Array(11 * 9 * 3);
const centreScratch = new Float32Array(11 * 3);
const tip = new Float32Array(6);
/** Pending branches, breadth first (so growth, and a budget that runs out, reach the tips last): p, dir, length, radius, depth. */
const QUEUE = 96;
const queue = new Float32Array(QUEUE * 9);
/** A quad's two triangles (corners 0..3), split along one diagonal or the other; the edge 0–3 is last in the second of either. */
const SPLIT_AC = [0, 1, 2, 0, 2, 3];
const SPLIT_BD = [1, 2, 3, 0, 1, 3];
const gemRing = new Float32Array(9 * 3);

/**
 * A crystal into `sink`: a bipyramid of `sides` round (cx, cy, cz), its apexes `elong` times its size up and down, every
 * point jittered (the art direction's gem). It grows out of (ax, ay, az) from `birth`. False when the sink is full.
 */
export function crystal(sink: GemSink, rnd: () => number, cx: number, cy: number, cz: number, size: number, elong: number, sides: number,
  colour: number, intensity: number, scale: number, ax: number, ay: number, az: number, birth: number): boolean {
  if (sink.count + sides * 6 > sink.limit) return false;
  const tx = cx + (rnd() - 0.5) * size * 0.4, ty = cy + size * elong * (0.7 + 0.5 * rnd()), tz = cz + (rnd() - 0.5) * size * 0.4;
  const bx = cx + (rnd() - 0.5) * size * 0.4, by = cy - size * elong * (0.9 + 0.6 * rnd()), bz = cz + (rnd() - 0.5) * size * 0.4;
  const a0 = 2 * Math.PI * rnd();
  for (let j = 0; j < sides; j++) {
    const a = a0 + (j / sides) * 2 * Math.PI + (rnd() - 0.5) * 0.4, r = size * (0.8 + 0.4 * rnd());
    gemRing[j * 3] = cx + Math.cos(a) * r; gemRing[j * 3 + 1] = cy + (rnd() - 0.5) * size * 0.4; gemRing[j * 3 + 2] = cz + Math.sin(a) * r;
  }
  const P = sink.point, B = sink.base, L = sink.look;
  let w = sink.count;
  const put = (x: number, y: number, z: number, corner: number): void => {
    P[w * 3] = x; P[w * 3 + 1] = y; P[w * 3 + 2] = z;
    B[w * 4] = ax; B[w * 4 + 1] = ay; B[w * 4 + 2] = az; B[w * 4 + 3] = birth;
    L[w * 4] = colour; L[w * 4 + 1] = intensity; L[w * 4 + 2] = scale; L[w * 4 + 3] = corner;
    w++;
  };
  for (let j = 0; j < sides; j++) {
    const a = j * 3, b = ((j + 1) % sides) * 3;
    put(tx, ty, tz, 0); put(gemRing[a], gemRing[a + 1], gemRing[a + 2], 1); put(gemRing[b], gemRing[b + 1], gemRing[b + 2], 2);
    put(bx, by, bz, 0); put(gemRing[b], gemRing[b + 1], gemRing[b + 2], 1); put(gemRing[a], gemRing[a + 1], gemRing[a + 2], 2);
  }
  sink.count = w;
  return true;
}

/**
 * Grows the shape of a tree from its seed and its traits into `out` (its arrays reused; nothing allocated): a flared,
 * bent trunk of `detail.sides` faces split at 40–58 % of the height into two or three limbs, a recursive hierarchy of
 * branches (each ×0.62–0.78 in length, ×0.53–0.61 in radius, pushed up), roots spreading from the flare, twigs and
 * blossoms at the ends. Emissive faces are more likely low on the trunk (magenta and violet there, violet, lilac, blue
 * and cyan above); one or two edge columns of the trunk are veins, brightest at the base. Crystals: obsidian shards round
 * the foot (each on its own lattice point, `cell` units apart), bipyramids under some forks and hanging from some twigs,
 * and one floating by every monumental tree (and some others).
 */
export function growTree(seed: number, t: Readonly<TreeTraits>, detail: Readonly<TreeDetail>, out: TreeShape, cell = 1.5): TreeShape {
  let salt = 0;
  const rnd = (): number => forestHash(seed, 1000 + salt++);
  let top = 0, reach = 0, bark = 0, twigs = 0, leaves = 0, anchors = 0;
  const gems = out.crystals;
  gems.count = 0;
  const monumental = forestHash(seed, 7) < MONUMENTAL;
  const H = t.height * (monumental ? MONUMENTAL_HEIGHT : 1);
  const r0 = H * (0.048 + 0.014 * rnd()) * (monumental ? 1.12 : 1);
  const thin = 0.004 * H;
  const spread = t.spread / 0.775, upright = t.upright;
  const glow = (0.5 + 0.6 * rnd()) * (monumental ? 1.2 : 1);
  const veinColour = VEIN[Math.floor(rnd() * 4)];

  const extent = (x: number, y: number, z: number): void => { top = Math.max(top, y); reach = Math.max(reach, Math.sqrt(x * x + z * z)); };
  const pick = (h: number): number => {
    const r = rnd();
    if (h < 0.3) return r < 0.55 ? (rnd() < 0.6 ? MAGENTA : VIOLET) : r < 0.85 ? VIOLET : BLUE;
    return r < 0.45 ? VIOLET : r < 0.7 ? LILAC : r < 0.88 ? BLUE : CYAN;
  };

  /**
   * A closed tube from p along d (unit) of `length`, radius r0 → r1, into the bark. The end of its axis and its last
   * direction go to `tip`. False when the bark budget has no room for it (nothing written).
   */
  const tube = (px: number, py: number, pz: number, dx: number, dy: number, dz: number, length: number, ra: number, rb: number, sides: number, rings: number,
    flare: number, emBase: number, trunk: boolean, veinA: number, veinB: number, birth: number): boolean => {
    if (bark + sides * rings * 6 > detail.bark) return false;
    // A frame round the axis: u = d × h (h the world's x for an upright axis, else its up), v = d × u.
    const hx = Math.abs(dy) > 0.9 ? 1 : 0, hy = 1 - hx;
    let ux = -dz * hy, uy = dz * hx, uz = dx * hy - dy * hx;
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
    let bx = rnd() - 0.5, bz = rnd() - 0.5;
    const bl = Math.sqrt(bx * bx + bz * bz) || 1; bx /= bl; bz /= bl;
    const bend = length * (0.05 + 0.07 * rnd()), phase = 2 * Math.PI * rnd();
    for (let k = 0; k <= rings; k++) {
      const s = k / rings, sway = bend * Math.sin(s * Math.PI * 0.9);
      const cx = px + dx * length * s + bx * sway, cy = py + dy * length * s, cz = pz + dz * length * s + bz * sway;
      centreScratch[k * 3] = cx; centreScratch[k * 3 + 1] = cy; centreScratch[k * 3 + 2] = cz;
      let r = ra + (rb - ra) * Math.pow(s, 0.85);
      if (k === 0) r *= flare; else if (k === 1) r *= 1 + (flare - 1) * 0.3;
      const turn = phase + k * (0.35 + 0.3 * rnd());
      for (let j = 0; j < sides; j++) {
        const a = turn + (j / sides) * 2 * Math.PI + (rnd() - 0.5) * 0.35, rr = r * (0.85 + 0.3 * rnd());
        const o = (k * sides + j) * 3, ca = Math.cos(a) * rr, sa = Math.sin(a) * rr;
        ringScratch[o] = cx + ux * ca + vx * sa; ringScratch[o + 1] = cy + uy * ca + vy * sa; ringScratch[o + 2] = cz + uz * ca + vz * sa;
        extent(ringScratch[o], ringScratch[o + 1], ringScratch[o + 2]);
      }
    }
    const P = out.point, B = out.base, G = out.glow, V = out.vein, S = out.site;
    let w = bark;
    for (let k = 0; k < rings; k++) {
      const h = (k + 0.5) / rings, veinLight = (0.55 + 0.45 * (1 - h)) * glow;
      for (let j = 0; j < sides; j++) {
        // The quad's corners: 0 (k, j), 1 (k, j+1), 2 (k+1, j+1), 3 (k+1, j), split along a random diagonal. A vein runs
        // along column j (the edge 0–3): it lights the triangle that has that whole edge.
        const j1 = (j + 1) % sides, tris = rnd() < 0.5 ? SPLIT_AC : SPLIT_BD, isVein = j === veinA || j === veinB;
        for (let q = 0; q < 2; q++) {
          // One draw per triangle: whether it glows, how much, and the shade of its stone (independent digits of it).
          const pe = isVein ? 0.5 : emBase * (trunk ? 0.4 + 1.6 * (1 - h) * (1 - h) : 1), u = rnd();
          const em = u < pe ? (0.35 + 0.65 * digit(u, 7919)) * glow : 0;
          const colour = em > 0 ? pick(trunk ? h * 0.7 : 0.6) : 0, shade = 0.75 + 0.5 * digit(u, 104729);
          const edge = isVein && tris[q * 3] === 0 && tris[q * 3 + 2] === 3;
          for (let v = 0; v < 3; v++) {
            const c = tris[q * 3 + v], o = ((k + (c >= 2 ? 1 : 0)) * sides + (c === 1 || c === 2 ? j1 : j)) * 3, w3 = w * 3, w4 = w * 4;
            P[w3] = ringScratch[o]; P[w3 + 1] = ringScratch[o + 1]; P[w3 + 2] = ringScratch[o + 2];
            B[w4] = px; B[w4 + 1] = py; B[w4 + 2] = pz; B[w4 + 3] = birth;
            G[w4] = colour; G[w4 + 1] = em; G[w4 + 2] = v === 0 ? 1 : 0; G[w4 + 3] = shade;
            V[w3] = veinColour; V[w3 + 1] = edge && (c === 0 || c === 3) ? 1 : 0; V[w3 + 2] = isVein ? veinLight : 0;
            S[w * 2] = 0; S[w * 2 + 1] = 0;
            w++;
          }
        }
      }
    }
    bark = w;
    const e = rings * 3, f = (rings - 1) * 3;
    let ex = centreScratch[e] - centreScratch[f], ey = centreScratch[e + 1] - centreScratch[f + 1], ez = centreScratch[e + 2] - centreScratch[f + 2];
    const el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1; ex /= el; ey /= el; ez /= el;
    tip[0] = centreScratch[e]; tip[1] = centreScratch[e + 1]; tip[2] = centreScratch[e + 2]; tip[3] = ex; tip[4] = ey; tip[5] = ez;
    return true;
  };
  const line = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, birth: number, colour = -1, emission = 0): boolean => {
    if (twigs + 2 > detail.twig) return false;
    for (let v = 0; v < 2; v++) {
      const w = twigs * 3, w4 = twigs * 4;
      out.twigPoint[w] = v ? x1 : x0; out.twigPoint[w + 1] = v ? y1 : y0; out.twigPoint[w + 2] = v ? z1 : z0;
      out.twigBase[w4] = x0; out.twigBase[w4 + 1] = y0; out.twigBase[w4 + 2] = z0; out.twigBase[w4 + 3] = birth;
      out.twigLook[twigs * 2] = colour; out.twigLook[twigs * 2 + 1] = emission;
      twigs++;
    }
    extent(x1, y1, z1);
    return true;
  };
  const leaf = (x: number, y: number, z: number, birth: number, size: number, kind: number, colour: number): void => {
    if (leaves >= MAX_LEAVES) return;
    const o = leaves * 4;
    out.leaf[o] = x; out.leaf[o + 1] = y; out.leaf[o + 2] = z; out.leaf[o + 3] = birth;
    out.leafLook[o] = size; out.leafLook[o + 1] = 2 * Math.PI * rnd(); out.leafLook[o + 2] = kind; out.leafLook[o + 3] = colour;
    leaves++;
  };
  const gem = (cx: number, cy: number, cz: number, size: number, elong: number, sides: number, colour: number, intensity: number, ax: number, ay: number, az: number, birth: number): void => {
    const from = gems.count;
    if (!crystal(gems, rnd, cx, cy, cz, size, elong, sides, colour, intensity, SCALE_NODES, ax, ay, az, birth)) return;
    for (let v = from; v < gems.count; v++) extent(gems.point[v * 3], gems.point[v * 3 + 1], gems.point[v * 3 + 2]);
  };
  const twigsAt = (ex: number, ey: number, ez: number, dx: number, dy: number, dz: number, length: number): void => {
    const n = Math.max(1, Math.round(4 * detail.twigs)), sub = detail.twigs >= 0.75 ? 2 : 1, bloom = detail.blossoms * (0.4 + 0.6 * t.foliage);
    for (let i = 0; i < n; i++) {
      let ax = dx + (rnd() - 0.5) * 1.5, ay = dy + rnd() * 0.7, az = dz + (rnd() - 0.5) * 1.5;
      const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1; ax /= al; ay /= al; az /= al;
      const l1 = length * (0.5 + 0.5 * rnd()), x1 = ex + ax * l1, y1 = ey + ay * l1, z1 = ez + az * l1;
      if (!line(ex, ey, ez, x1, y1, z1, TWIG_BIRTH)) return;
      // Now and then a crystal hangs from the twig on a thread, anchored where the twig forks.
      if (rnd() < 0.06 * detail.crystals * (monumental ? 2 : 1)) {
        const drop = 0.35 + 0.8 * rnd(), gx = x1, gy = y1 - drop, gz = z1;
        if (line(x1, y1, z1, gx, gy, gz, TWIG_BIRTH, LILAC, 0.45)) gem(gx, gy, gz, (0.11 + 0.2 * rnd()) * (monumental ? 1.7 : 1), 1.6, 4, HANGING[Math.floor(rnd() * 4)], 0.85 + 0.35 * rnd(), x1, y1, z1, TWIG_BIRTH);
      }
      for (let m = 0; m < sub; m++) {
        let bx = ax + (rnd() - 0.5) * 1.2, by = ay + rnd() * 0.5, bz = az + (rnd() - 0.5) * 1.2;
        const bl = Math.sqrt(bx * bx + by * by + bz * bz) || 1; bx /= bl; by /= bl; bz /= bl;
        const l2 = length * 0.45 * (0.5 + rnd()), x2 = x1 + bx * l2, y2 = y1 + by * l2, z2 = z1 + bz * l2;
        if (!line(x1, y1, z1, x2, y2, z2, TWIG_BIRTH)) return;
        if (rnd() < 0.8 * bloom) leaf(x2, y2, z2, 1, H * (0.006 + 0.006 * rnd()), 0, BLOSSOM[Math.floor(rnd() * 4)]);
      }
    }
    const scatter = Math.round(3 * bloom);
    for (let i = 0; i < scatter; i++) leaf(ex + (rnd() - 0.5) * length, ey + (rnd() - 0.3) * length * 0.65, ez + (rnd() - 0.5) * length, 1, H * (0.005 + 0.005 * rnd()), 0, BLOSSOM[Math.floor(rnd() * 3)]);
  };

  /**
   * A root crystal into the bark: a four-sided obsidian pyramid on the lattice point (dJ, dR) from the tree's, at (x, z)
   * from that point, `h` tall, leaning by (tx, tz); its faces glow more often than the trunk's, one edge may be a vein.
   */
  const shard = (x: number, z: number, dJ: number, dR: number, h: number, width: number, tx: number, tz: number): boolean => {
    if (bark + 12 > detail.bark) return false;
    const a0 = 2 * Math.PI * rnd(), colour = rnd() < 0.55 ? VIOLET : rnd() < 0.6 ? MAGENTA : BLUE, veined = rnd() < 0.6;
    for (let j = 0; j < 4; j++) {
      const a = a0 + (j / 4) * 2 * Math.PI, r = width * (0.7 + 0.6 * rnd());
      gemRing[j * 3] = x + Math.cos(a) * r; gemRing[j * 3 + 1] = -0.15; gemRing[j * 3 + 2] = z + Math.sin(a) * r;
    }
    const apx = x + tx * h, apy = h, apz = z + tz * h;
    for (let j = 0; j < 4; j++) {
      const u = rnd(), em = u < 0.55 ? (0.4 + 0.6 * digit(u, 7919)) * glow : 0, shade = 0.8 + 0.4 * digit(u, 104729), b = ((j + 1) % 4) * 3;
      for (let v = 0; v < 3; v++) {
        const w = bark, px = v === 0 ? gemRing[j * 3] : v === 1 ? gemRing[b] : apx, py = v === 0 ? gemRing[j * 3 + 1] : v === 1 ? gemRing[b + 1] : apy, pz = v === 0 ? gemRing[j * 3 + 2] : v === 1 ? gemRing[b + 2] : apz;
        out.point[w * 3] = px; out.point[w * 3 + 1] = py; out.point[w * 3 + 2] = pz;
        out.base[w * 4] = x; out.base[w * 4 + 1] = -0.15; out.base[w * 4 + 2] = z; out.base[w * 4 + 3] = 0;
        out.glow[w * 4] = colour; out.glow[w * 4 + 1] = em; out.glow[w * 4 + 2] = v === 2 ? 1 : 0; out.glow[w * 4 + 3] = shade;
        // The edge from the first corner to the apex: a vein, on the first face.
        const vein = veined && j === 0 && v !== 1;
        out.vein[w * 3] = colour; out.vein[w * 3 + 1] = vein ? 1 : 0; out.vein[w * 3 + 2] = veined && j === 0 ? 0.7 * glow : 0;
        out.site[w * 2] = dJ; out.site[w * 2 + 1] = dR;
        bark++;
      }
    }
    return true;
  };

  // ---- trunk: from a little under the root point, leaning a little, split at 40–58 % of the height ----
  const split = 0.4 + 0.18 * rnd();
  let lx = (rnd() - 0.5) * 0.2, ly = 1, lz = (rnd() - 0.5) * 0.2;
  const ll = Math.sqrt(lx * lx + ly * ly + lz * lz); lx /= ll; ly /= ll; lz /= ll;
  const sides = Math.min(8, detail.sides + (monumental ? 1 : 0)), rings = detail.rings + (monumental ? (detail.rings >= 5 ? 2 : 1) : 0);
  const veinA = Math.floor(rnd() * sides), veinB = rnd() < 0.65 ? (veinA + 2 + Math.floor(rnd() * 2)) % sides : -1;
  const baseY = -0.5 * r0;
  tube(0, baseY, 0, lx, ly, lz, H * split + 0.5 * r0, r0, 0.6 * r0, sides, rings, detail.flare, 0.1, true, veinA, veinB, 0);
  const tx = tip[0], ty = tip[1], tz = tip[2], tdx = tip[3], tdy = tip[4], tdz = tip[5];

  // ---- roots: from the flare, out and down into the ground ----
  const roots = Math.max(2, Math.round((monumental ? 6 : 3 + Math.floor(rnd() * 2)) * detail.roots)), around = 2 * Math.PI * rnd();
  for (let i = 0; i < roots; i++) {
    const a = around + (i / roots) * 2 * Math.PI + (rnd() - 0.5) * 0.5, cx = Math.cos(a), cz = Math.sin(a);
    let dx = cx, dy = -0.45 - 0.2 * rnd(), dz = cz;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz); dx /= dl; dy /= dl; dz /= dl;
    tube(cx * 0.7 * r0, r0 * (0.35 + 0.5 * rnd()), cz * 0.7 * r0, dx, dy, dz, r0 * (1.6 + 1.2 * rnd()), 0.42 * r0, 0.06 * r0, 4, 2, 1, 0.14, false, rnd() < 0.5 ? 0 : -1, -1, 0);
  }

  // ---- root crystals: obsidian shards round the foot, each on the lattice point it stands over, leaning outwards ----
  const shards = Math.round((monumental ? 8 : 3 + Math.floor(rnd() * 3)) * detail.crystals);
  for (let i = 0; i < shards; i++) {
    const a = 2 * Math.PI * rnd(), ca = Math.cos(a), sa = Math.sin(a), rr = r0 * (1.4 + 2.4 * rnd());
    const x = ca * rr, z = sa * rr, dJ = Math.round(x / cell), dR = Math.round(-z / cell);
    const h = r0 * (0.5 + Math.pow(rnd(), 1.5) * 2.2), width = h * 0.13 + 0.05;
    if (!shard(x - dJ * cell, z + dR * cell, dJ, dR, h, width, ca * 0.3, sa * 0.3)) break;
    extent(x, h, z);
  }

  // ---- limbs: two or three from the top of the trunk, then branches breadth first ----
  let head = 0, tail = 0;
  const push = (px: number, py: number, pz: number, dx: number, dy: number, dz: number, length: number, radius: number, depth: number): void => {
    if (tail >= QUEUE) return;
    const o = tail * 9;
    queue[o] = px; queue[o + 1] = py; queue[o + 2] = pz; queue[o + 3] = dx; queue[o + 4] = dy; queue[o + 5] = dz;
    queue[o + 6] = length; queue[o + 7] = radius; queue[o + 8] = depth;
    tail++;
  };
  const limbs = rnd() < 0.5 ? 2 : 3, turn = 2 * Math.PI * rnd();
  for (let i = 0; i < limbs; i++) {
    const a = turn + (i / limbs) * 2 * Math.PI + (rnd() - 0.5) * 0.7, lateral = (0.5 + 0.45 * rnd()) * spread;
    let dx = tdx * 0.95 + Math.cos(a) * lateral, dy = tdy * 0.95, dz = tdz * 0.95 + Math.sin(a) * lateral;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz); dx /= dl; dy /= dl; dz /= dl;
    push(tx - tdx * 0.4 * r0, ty - tdy * 0.4 * r0, tz - tdz * 0.4 * r0, dx, dy, dz, H * (1 - split) * (0.58 + 0.2 * rnd()), 0.6 * r0 * (0.72 + 0.12 * rnd()), 1);
  }
  const sidesB = Math.min(8, detail.sides + (monumental ? 1 : 0));
  while (head < tail) {
    const o = head * 9;
    const px = queue[o], py = queue[o + 1], pz = queue[o + 2], dx = queue[o + 3], dy = queue[o + 4], dz = queue[o + 5], length = queue[o + 6], r = queue[o + 7], depth = queue[o + 8];
    head++;
    const birth = depth * SPAN;
    let ex: number, ey: number, ez: number, edx: number, edy: number, edz: number;
    if (r < thin || (detail.depth < 3 && depth >= 2)) {
      // Too thin to be a tube: a line, as a twig is.
      let bx = dx + (rnd() - 0.5) * 0.2, by = dy + 0.05, bz = dz + (rnd() - 0.5) * 0.2;
      const bl = Math.sqrt(bx * bx + by * by + bz * bz) || 1; bx /= bl; by /= bl; bz /= bl;
      ex = px + bx * length; ey = py + by * length; ez = pz + bz * length; edx = bx; edy = by; edz = bz;
      if (!line(px, py, pz, ex, ey, ez, birth)) continue;
    } else {
      const veined = depth === 1 && rnd() < 0.6 ? 0 : -1;
      if (!tube(px, py, pz, dx, dy, dz, length, r * 1.04, r * 0.6, Math.max(3, sidesB - depth), Math.max(1, BRANCH_RINGS[depth] - (detail.rings < 5 ? 1 : 0)), 1, 0.06, false, veined, -1, birth)) continue;
      ex = tip[0]; ey = tip[1]; ez = tip[2]; edx = tip[3]; edy = tip[4]; edz = tip[5];
    }
    if ((depth === 2 || (depth === detail.depth && depth < 2)) && anchors < MAX_ANCHORS) { out.anchor[anchors * 3] = ex; out.anchor[anchors * 3 + 1] = ey; out.anchor[anchors * 3 + 2] = ez; anchors++; }
    if (depth >= detail.depth) { twigsAt(ex, ey, ez, edx, edy, edz, length * 0.55); continue; }
    // A node at the junction: it lights as the tree resonates; under some forks, a crystal, once the branch has grown.
    leaf(ex, ey, ez, birth, r * 1.6, 1, NODE[Math.floor(rnd() * 3)]);
    if (rnd() < 0.12 * detail.crystals) gem(ex, ey - 0.2 - 0.4 * rnd(), ez, r * 1.2 + 0.09, 1.5, 4, FORK[Math.floor(rnd() * 3)], 0.8 + 0.3 * rnd(), ex, ey, ez, birth + SPAN);
    const n = depth === 1 ? 3 : rnd() < 0.3 + 0.4 * t.branching ? 3 : 2, a0 = 2 * Math.PI * rnd();
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * 2 * Math.PI + (rnd() - 0.5) * 0.9, lateral = (0.5 + 0.45 * rnd()) * spread * (1 - 0.3 * upright);
      let cx = edx * 0.6 + Math.cos(a) * lateral, cy = edy * 0.6 + 0.18 + 0.28 * rnd() + 0.15 * upright, cz = edz * 0.6 + Math.sin(a) * lateral;
      const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1; cx /= cl; cy /= cl; cz /= cl;
      push(ex, ey, ez, cx, cy, cz, length * (0.62 + 0.16 * rnd()), r * 0.6 * (0.88 + 0.14 * rnd()), depth + 1);
    }
  }
  // ---- a resonance crystal floating by every monumental tree (and by some others) ----
  if (monumental || rnd() < 0.4 * detail.crystals) {
    const a = 2 * Math.PI * rnd(), rr = r0 * (2 + 3 * rnd()), cx = Math.cos(a) * rr, cy = 1.5 + rnd() * H * 0.35, cz = Math.sin(a) * rr;
    gem(cx, cy, cz, (0.2 + 0.3 * rnd()) * (monumental ? 1.6 : 1), monumental ? 2.8 + 2.5 * rnd() : 1.6 + rnd(), monumental ? 6 : 4, FORK[Math.floor(rnd() * 3)], 0.8 + 0.4 * rnd(), cx, cy, cz, 3 * SPAN);
  }
  out.bark = bark; out.twigs = twigs; out.leaves = leaves; out.anchors = anchors;
  out.top = top; out.reach = reach; out.radius = r0; out.monumental = monumental;
  return out;
}

/** The floating crystals over the forest: per vertex as a tree's crystals are, and the lattice point (J, R) each floats over. */
export interface CrystalField extends GemSink { lattice: Float32Array }

/** Floating crystals per row of the lattice at full share; their heights over the ground (units), and over the flight's corridor. */
const FLOATING_PER_ROW = 1.4;
const FLOAT_LOW = 2.5;
const FLOAT_HIGH = 15.5;
const OVER_CORRIDOR = 7;

/**
 * The crystal field: crystals floating 2.5–15.5 units over the ground's vertices, over the whole period of the lattice (so
 * the field travels and repeats with the ground, and never needs sowing), across `span` units either side of the valley,
 * never lower than 7 units over the corridor the observer flies. Most are kites (four sides, on the emission E); some
 * are tall six-sided prisms (on the nodes). A pure function of the world's seed and the detail.
 */
export function crystalField(seed: number, detail: Readonly<TreeDetail>, cell: number, span: number, corridor: number): CrystalField {
  const rate = FLOATING_PER_ROW * detail.crystals;
  const count = (R: number): number => Math.floor(rate + forestHash(seed ^ 0x51ed, R));
  let vertices = 0;
  for (let R = 0; R < PERIOD; R++) for (let n = 0; n < count(R); n++) vertices += forestHash(seed ^ 0x7a11, R * 8 + n) < 0.22 ? 36 : 24;
  const field: CrystalField = { ...createGems(vertices), lattice: new Float32Array(vertices * 2) };
  for (let R = 0; R < PERIOD; R++) for (let n = 0; n < count(R); n++) {
    let salt = 0;
    const id = R * 8 + n, rnd = (): number => forestHash(seed ^ 0x2c3f, id * 64 + salt++);
    const tall = forestHash(seed ^ 0x7a11, id) < 0.22, x = (rnd() - 0.5) * 2 * span;
    let h = FLOAT_LOW + rnd() * (FLOAT_HIGH - FLOAT_LOW);
    if (Math.abs(x) < corridor + 2 && h < OVER_CORRIDOR) h = OVER_CORRIDOR + rnd() * (FLOAT_HIGH - OVER_CORRIDOR);
    const along = terrainMeander(R) + x, J = Math.round(along / cell), local = along - J * cell, from = field.count;
    crystal(field, rnd, local, h, 0, tall ? 0.22 + 0.3 * rnd() : 0.15 + 0.3 * rnd(), tall ? 2.8 + 2.5 * rnd() : 1.3 + 0.5 * rnd(), tall ? 6 : 4,
      FLOATING[Math.floor(rnd() * 5)], 0.7 + 0.5 * rnd(), tall ? SCALE_NODES : SCALE_E, local, h, 0, 0);
    for (let v = from; v < field.count; v++) { field.lattice[v * 2] = J; field.lattice[v * 2 + 1] = R; }
  }
  return field;
}

/** Another uniform number from the digits of `u` (deterministic; for draws that need not be independent of each other's order). */
const digit = (u: number, k: number): number => (u * k) % 1;

const glsl = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/**
 * GLSL ES 3.00, after `terrainLawGlsl`. Declares `uTrees`, `uTreeLean` and:
 *   forestRoot(J, R)              where the tree anchored at lattice point (J, R) stands, in the ground's space
 *   forestLean(p, slot)           a point of a tree's frame turned rigidly about its root by the tree's lean
 *   forestGrown(birth, slot)      how much of a segment born at `birth` has grown, 0..1
 * `uTrees[slot]`: growth (0 … 1, past 1 the blossoms open), lean (rad), light, decay (0..1: how far its blossoms have fallen).
 * `uTreeLean[slot]`: the lean's direction (rad about the vertical), resonance 0..1, blossom share 0..1, the tree's flush 0..1.
 */
export const forestLawGlsl = /* glsl */ `
uniform vec4 uTrees[${SLOTS}];
uniform vec4 uTreeLean[${SLOTS}];

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

/**
 * CPU reference: a vertex grown out of its segment's start (`base`, birth in w) towards `point`, of a tree over the ground
 * `t`, on the tree's lattice point or (dJ, dR) from it.
 */
function grownPoint(t: Readonly<TerrainValues>, tree: Readonly<TreeState>, point: Float32Array, base: Float32Array, v: number, dJ = 0, dR = 0): [number, number, number] {
  const o = v * 4, grown = forestGrown(base[o + 3], tree.growth);
  const p: [number, number, number] = [base[o] + (point[v * 3] - base[o]) * grown, base[o + 1] + (point[v * 3 + 1] - base[o + 1]) * grown, base[o + 2] + (point[v * 3 + 2] - base[o + 2]) * grown];
  const local = forestLean(p, tree.lean, tree.around), root = forestRoot(t, tree.J + dJ, tree.R + dR);
  return [root[0] + local[0], root[1] + local[1], root[2] + local[2]];
}

/** CPU reference: bark vertex `v` of a tree. */
export const barkPoint = (t: Readonly<TerrainValues>, tree: Readonly<TreeState>, shape: Readonly<TreeShape>, v: number): [number, number, number] => grownPoint(t, tree, shape.point, shape.base, v, shape.site[v * 2], shape.site[v * 2 + 1]);

/** CPU reference: vertex `v` of a tree's crystals (the same law as bark), or of the crystal field with the ground's state. */
export const gemPoint = (t: Readonly<TerrainValues>, tree: Readonly<TreeState>, gems: Readonly<GemSink>, v: number): [number, number, number] => grownPoint(t, tree, gems.point, gems.base, v);

/**
 * CPU reference: the point at `s` (0..1) of a filament from anchor `a` of tree A to anchor `b` of tree B (each in its
 * tree's frame): a catenary hanging `sag` of its span at the middle.
 */
export function linkPoint(t: Readonly<TerrainValues>, A: Readonly<TreeState>, a: readonly [number, number, number], B: Readonly<TreeState>, b: readonly [number, number, number], sag: number, s: number): [number, number, number] {
  const ra = forestRoot(t, A.J, A.R), la = forestLean(a, A.lean, A.around), rb = forestRoot(t, B.J, B.R), lb = forestLean(b, B.lean, B.around);
  const pa = [ra[0] + la[0], ra[1] + la[1], ra[2] + la[2]], pb = [rb[0] + lb[0], rb[1] + lb[1], rb[2] + lb[2]];
  const span = Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
  return [pa[0] + (pb[0] - pa[0]) * s, pa[1] + (pb[1] - pa[1]) * s - sag * span * 4 * s * (1 - s), pa[2] + (pb[2] - pa[2]) * s];
}

/** How much of a filament shows: both crowns grown past their second order (it fades in with the third, out as they retract). */
export const linkShown = (growthA: number, growthB: number): number => Math.min(1, Math.max(0, (growthA - 0.75) / 0.25)) * Math.min(1, Math.max(0, (growthB - 0.75) / 0.25));

/** CPU reference: twig vertex `v` of a tree. */
export const twigPoint = (t: Readonly<TerrainValues>, tree: Readonly<TreeState>, shape: Readonly<TreeShape>, v: number): [number, number, number] => grownPoint(t, tree, shape.twigPoint, shape.twigBase, v);

/** CPU reference: corner `c` (0..2) of leaf `l` of a tree (a node when its kind is 1). */
export function leafPoint(t: Readonly<TerrainValues>, tree: Readonly<TreeState>, shape: Readonly<TreeShape>, l: number, c: number): [number, number, number] {
  const o = l * 4, node = shape.leafLook[o + 2] > 0.5, open = node ? forestGrown(shape.leaf[o + 3], tree.growth) : Math.min(1, Math.max(0, (tree.growth - 1) * 4)) * tree.leaves;
  const size = shape.leafLook[o] * (node ? 0.45 : 1) * open, angle = shape.leafLook[o + 1] + (2 * Math.PI * c) / 3;
  const fall = node ? 0 : tree.decay * tree.decay * LEAF_DROP;
  const p: [number, number, number] = [shape.leaf[o] + Math.cos(angle) * size, shape.leaf[o + 1] + (c === 0 ? 0.5 * size : -0.2 * size) - fall, shape.leaf[o + 2] + Math.sin(angle) * size];
  const local = forestLean(p, tree.lean, tree.around), root = forestRoot(t, tree.J, tree.R);
  return [root[0] + local[0], root[1] + local[1], root[2] + local[2]];
}

/** The GLSL of a bark or twig vertex (same terms as `barkPoint` / `twigPoint`). */
export const barkGlsl = /* glsl */ `
// xyz: the segment's start, w: its birth
attribute vec4 aBase;
// x: J, y: R, z: slot
attribute vec3 aTree;
float barkGrown;
vec3 barkPoint() {
  int slot = int(aTree.z + 0.5);
  float grown = forestGrown(aBase.w, slot);
  barkGrown = grown;
  vec3 p = aBase.xyz + (position - aBase.xyz) * grown;
  return forestRoot(aTree.x, aTree.y) + forestLean(p, slot);
}
`;

/** The GLSL of a filament's point (same terms as `linkPoint` and `linkShown`). */
export const linkGlsl = /* glsl */ `
// Each end: x J, y R, z slot, w (A: the sag, a share of the span; B: the filament's light); its anchor in the tree's frame.
attribute vec4 aLinkA;
attribute vec4 aAnchorA;
attribute vec4 aLinkB;
attribute vec4 aAnchorB;
float linkShown;
vec3 linkPoint(float s) {
  int a = int(aLinkA.z + 0.5), b = int(aLinkB.z + 0.5);
  vec3 A = forestRoot(aLinkA.x, aLinkA.y) + forestLean(aAnchorA.xyz, a);
  vec3 B = forestRoot(aLinkB.x, aLinkB.y) + forestLean(aAnchorB.xyz, b);
  linkShown = clamp((uTrees[a].x - 0.75) / 0.25, 0.0, 1.0) * clamp((uTrees[b].x - 0.75) / 0.25, 0.0, 1.0);
  return mix(A, B, s) - vec3(0.0, aLinkA.w * length(B - A) * 4.0 * s * (1.0 - s), 0.0);
}
`;

/** The GLSL of a blossom or node vertex (same terms as `leafPoint`). */
export const leafGlsl = /* glsl */ `
// xyz: where, w: birth of the branch it ends
attribute vec4 aLeaf;
// x: size, y: turn, z: kind (0 blossom, 1 node), w: colour
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
