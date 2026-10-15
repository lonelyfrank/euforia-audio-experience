import { forEachCue, type Cue, type CuesFrame } from '../../experience/MusicalCues';
import { REST_WORLD } from '../../world/WorldState';
import type { WorldView } from '../../world/WorldView';
import type { GeometryState } from '../geometry/GeometryState';
import { createShape, forestHash, growTree, MAX_FILAMENTS, MAX_TREES, type TreeShape, type TreeTraits } from './forestLaw';
import { PERIOD, terrainMeander, type TerrainValues } from './terrainLaw';

/*
 * The life of Resonant Forest (docs/generative-worlds.md): what grows, where, when, and what it remembers. The
 * decisions, not the drawing: a fixed pool of trees, each anchored at a lattice point of the ground, living through
 *
 *   dormant → seed → growth → mature ⇄ resonance → decay → recycle
 *
 * on the time the music lives (frozen in silence and without a clock). The ground decides where (lattice points beside
 * the flight corridor, as rows come into view: no travel, no new tree), the music how much and what shape:
 *
 *   groove        a density of the slow state (never the level, never a kick); trees grow as fast as the groove is
 *                 steady (the cognition's clock stability) and strong
 *   shape         fixed at seeding from the music heard then (the geometry's branching, curvature, density; the
 *                 tension draws branches up), quantized so a frame's difference never changes a tree
 *   memory        each tree keeps the signature of the music it grew in (six slow traits of the geometry); when the
 *                 cognition hears the music repeat and the signature comes back, those trees resonate again — a typed
 *                 memory of configurations, never the identity of a song nor a forecast of it
 *   prediction    a release expected makes mature trees bud (their nodes glow); given up, they stop
 *   release       heard (confirmed) only: mature trees flush with light and open all their leaves, seeds fill the next rows
 *   breakdown     nothing new, and the weakest trees decay one by one (leaves fall, branches retract tip first)
 *   silence       nothing grows, nothing moves
 *
 * Trees also age: past their span of lived music they decay and their place is recycled. Fixed storage: nothing is
 * allocated after construction (a tree's shape is grown into its slot's arrays).
 */

export const TREE_PHASES = ['dormant', 'seed', 'growth', 'mature', 'resonance', 'decay'] as const;
export type TreePhase = typeof TREE_PHASES[number];
const DORMANT = 0, SEED = 1, GROWTH = 2, MATURE = 3, RESONANCE = 4, DECAY = 5;

export interface ForestParams {
  enabled: boolean;
  /** Trees at most at once, and how many may be seeds or growing at once. */
  capacity: number;
  growing: number;
  /** Rows of the lattice between two rows where a tree may be seeded. */
  spacing: number;
  /** The density a steady groove keeps, and a gain on all of it; how much tension and anticipation add. */
  density: number;
  rate: number;
  response: number;
  /** Units kept clear on each side of the line the viewer flies (crowns included), and how far beyond trees may stand. */
  corridor: number;
  reach: number;
  /** Heights of trees (units). */
  low: number;
  high: number;
  /** Seconds of lived music a tree takes to grow at a full, steady groove, and how long it lives before it decays. */
  grow: number;
  span: number;
  /** How strongly a remembered configuration makes its trees resonate (0: memory off). */
  memory: number;
  /** The most a tree leans with the world's wind (rad), rigidly about its root. */
  lean: number;
}

export const DEFAULT_FOREST: Readonly<ForestParams> = {
  enabled: true, capacity: 40, growing: 8, spacing: 3, density: 0.55, rate: 1, response: 1, corridor: 7, reach: 16, low: 6, high: 13,
  grow: 8, span: 90, memory: 1, lean: 0.06,
};
export type ForestSettings = Partial<ForestParams>;
const within = (x: unknown, lo: number, hi: number, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback);

/** Settings within their bounds; what is missing or wrong is the default's. */
export function forestParams(s: ForestSettings = {}): ForestParams {
  const d = DEFAULT_FOREST, low = within(s.low, 1, 30, d.low);
  return {
    enabled: s.enabled ?? d.enabled, capacity: Math.round(within(s.capacity, 0, MAX_TREES, d.capacity)), growing: Math.round(within(s.growing, 0, MAX_TREES, d.growing)),
    spacing: Math.round(within(s.spacing, 1, 64, d.spacing)), density: within(s.density, 0, 1, d.density), rate: within(s.rate, 0, 4, d.rate),
    response: within(s.response, 0, 4, d.response), corridor: within(s.corridor, 0, 100, d.corridor), reach: within(s.reach, 0, 200, d.reach),
    low, high: within(s.high, low, 40, Math.max(low, d.high)), grow: within(s.grow, 1, 120, d.grow), span: within(s.span, 5, 1200, d.span),
    memory: within(s.memory, 0, 2, d.memory), lean: within(s.lean, 0, 0.15, d.lean),
  };
}

/** Lived seconds a seed shows before it grows, a tree's decay takes, and leaves take to fall. */
const SEED_TIME = 1.2;
const DECAY_TIME = 4;
/** Mesh rows from the far end where rows come into view, from the viewer where the first sowing starts, and where trees leave. */
const AHEAD = 8;
const NEAR = 6;
const BEHIND_ROWS = 1.5;
/** Mesh columns kept clear of the mesh's sides. */
const SIDE = 3;
/** The density follows its target over this long (s); below the least it is nothing. */
const DENSITY_TAU = 3;
const LEAST = 0.02;
/** Candidate rows a release heard fills with seeds. */
const BURST = 2;
/** Resonance: the drive it starts at and the one it rests below; its envelope (s). */
const RING_ON = 0.6;
const RING_OFF = 0.45;
const RING_TAU = 0.6;
/** How close a signature must come to be the same music (per trait), and how slowly the present one is followed (s). */
const SIGMA = 0.16;
const SIGNATURE_TAU = 3;
export const TRAITS = 6;
/** In a breakdown one tree decays every this long (s). */
const RETIRE_EVERY = 1.5;
/** Light of a flush (a release heard) and of an accent, over these times (s). */
const FLUSH_TAU = 1.8;
const ACCENT_TAU = 0.5;
/** Filaments join trees resonating with the same music within this many lattice cells of each other. */
const LINK_CELLS = 26;
const LINK_SIGNATURE = 0.12;

const unit = (x: number): number => Math.min(1, Math.max(0, x));
const quantize = (x: number): number => Math.round(unit(x) * 4) / 4;

export interface ForestStats {
  phases: Uint16Array;
  spawned: number;
  recycled: number;
  passed: number;
  decayed: number;
  aged: number;
  refused: number;
  bursts: number;
  releases: number;
  prepares: number;
  withdraws: number;
  accents: number;
  /** Trees resonating now because their remembered music came back (not only the groove), and the strongest match. */
  remembering: number;
  match: number;
  density: number;
  target: number;
}

export class ForestField {
  readonly params: ForestParams;
  readonly stats: ForestStats = {
    phases: new Uint16Array(TREE_PHASES.length), spawned: 0, recycled: 0, passed: 0, decayed: 0, aged: 0, refused: 0, bursts: 0,
    releases: 0, prepares: 0, withdraws: 0, accents: 0, remembering: 0, match: 0, density: 0, target: 0,
  };
  /** Each slot's shape (grown at seeding) and which slots were reseeded since the drawing last read them. */
  readonly shapes: TreeShape[] = Array.from({ length: MAX_TREES }, createShape);
  readonly dirty = new Uint8Array(MAX_TREES);
  /** What the GPU reads per tree: (growth, lean, light, decay) and (lean direction, resonance, leaf share, flush). */
  readonly trees = new Float32Array(MAX_TREES * 4);
  readonly treeLean = new Float32Array(MAX_TREES * 4);
  /** The filaments to draw (the first `links`): two trees each, as their slots. */
  readonly linkA = new Int16Array(MAX_FILAMENTS);
  readonly linkB = new Int16Array(MAX_FILAMENTS);
  links = 0;
  readonly J = new Int32Array(MAX_TREES);
  readonly R = new Int32Array(MAX_TREES);
  readonly phase = new Uint8Array(MAX_TREES);
  readonly growth = new Float32Array(MAX_TREES);
  readonly resonance = new Float32Array(MAX_TREES);
  /** The signature of the music each tree grew in (TRAITS per tree), and the present one as followed. */
  readonly memory = new Float32Array(MAX_TREES * TRAITS);
  readonly present = new Float32Array(TRAITS);
  private readonly age = new Float32Array(MAX_TREES);
  private readonly progress = new Float32Array(MAX_TREES);
  private readonly decay = new Float32Array(MAX_TREES);
  private readonly leaves = new Float32Array(MAX_TREES);
  private readonly sway = new Float32Array(MAX_TREES);
  private readonly match = new Float32Array(MAX_TREES);
  private readonly flushAt = new Float64Array(MAX_TREES).fill(-Infinity);
  private readonly accentAt = new Float64Array(MAX_TREES).fill(-Infinity);
  private readonly traits: TreeTraits = { branching: 0, spread: 0, upright: 0, height: 0, foliage: 0 };
  private density = 0;
  private cursor = -1;
  private travelled = 0;
  private lastPosition = NaN;
  private evaluated = -Infinity;
  private burst = 0;
  private budding = false;
  /** Whether the ground in view has been sown (the first live moment), and whether that sowing is under way. */
  private sown = false;
  private planting = false;
  private sinceRetire = 0;
  private wind = 0;
  private now = 0;
  private fresh = true;
  private readonly take = (cue: Readonly<Cue>): void => this.cue(cue);

  constructor(params: ForestSettings = {}, private readonly worldSeed = 0) {
    this.params = forestParams(params);
    for (let s = 0; s < MAX_TREES; s++) this.trees[s * 4] = -1;
  }

  in(phase: TreePhase): number { return this.stats.phases[TREE_PHASES.indexOf(phase)]; }

  /**
   * One frame. `t`: the ground's values this frame; `view`: the world; `geometry`: what the sound asks of geometry (the
   * traits a tree is seeded with and the signature it remembers); `position`: the ground travelled (rows); `rows`,
   * `columns`: the mesh; `cues`: the snapshot's musical cues (none without a clock); `now`: the audio time heard.
   */
  step(dt: number, t: Readonly<TerrainValues>, view: Readonly<WorldView>, geometry: Readonly<GeometryState>, position: number, rows: number, columns: number, cues: Readonly<CuesFrame> | undefined, now: number): void {
    const p = this.params, h = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.25) : 0;
    const timed = view.world !== REST_WORLD && !!cues;
    const live = timed && !cues!.silent ? h : 0;
    this.now = now;
    if (cues) this.cursor = this.cursor < 0 ? cues.seq : forEachCue(cues, this.cursor, this.take);
    const capacity = Math.min(MAX_TREES, Math.max(0, p.capacity));

    // ---- the present music's signature, followed slowly (what a tree seeded now remembers, and what wakes the others) ----
    const sig = this.present, k = 1 - Math.exp(-live / SIGNATURE_TAU);
    for (let i = 0; i < TRAITS; i++) { const x = trait(geometry, i); sig[i] = this.fresh ? x : sig[i] + (x - sig[i]) * k; }
    this.fresh = false;

    // ---- how much: the groove's steady state, never the level ----
    const phase = timed ? cues!.phase : 'silence', groove = timed ? cues!.groove : 0, steady = timed ? cues!.stability : 0;
    const target = !timed || phase === 'silence' || phase === 'breakdown' ? 0
      : unit((p.density * (0.4 + 0.6 * groove) + p.response * (0.25 * cues!.tension + 0.15 * cues!.anticipation)) * p.rate);
    this.density += (target - this.density) * (1 - Math.exp(-live / DENSITY_TAU));
    this.stats.target = target; this.stats.density = this.density;

    // ---- where: rows coming into view beside the corridor ----
    const far = rows - AHEAD;
    if (Number.isNaN(this.lastPosition)) this.lastPosition = position;
    this.travelled += ((position - this.lastPosition) % PERIOD + PERIOD * 1.5) % PERIOD - PERIOD * 0.5;
    this.lastPosition = position;
    const reached = Math.floor(this.travelled + far);
    if (this.evaluated === -Infinity) this.evaluated = reached;
    // The first moment the music lives, the whole ground in view is sown (seeds: they grow with what follows); after
    // that only the rows coming into view, a few a frame at most.
    const from = this.sown ? Math.max(this.evaluated + 1, reached - 4 * p.spacing) : Math.floor(this.travelled + NEAR);
    if (live > 0) {
      this.planting = !this.sown;
      for (let row = from; row <= reached; row++) if (row % p.spacing === 0) this.candidates(row, t, capacity, columns, cues!);
      this.planting = false; this.sown = true;
    }
    this.evaluated = Math.max(this.evaluated, reached);

    // ---- every tree through its life ----
    const memory = p.memory * (timed ? cues!.repetition : 0);
    const retire = phase === 'breakdown' && timed;
    this.sinceRetire = retire ? this.sinceRetire + live : 0;
    let weakest = -1, remembering = 0, strongest = 0;
    const growRate = live * (0.5 + 0.5 * groove) * (0.5 + 0.5 * steady) / p.grow;
    for (let s = 0; s < MAX_TREES; s++) {
      const ph = this.phase[s];
      if (ph === DORMANT) continue;
      const kk = ((this.R[s] - t.row) % PERIOD + PERIOD) % PERIOD, i = this.J[s] - t.col;
      if (kk < BEHIND_ROWS || kk > rows || Math.abs(i) > columns / 2 - 1) { this.recycle(s); this.stats.passed++; continue; }
      this.age[s] += live;
      if (ph === SEED) {
        this.progress[s] += live / SEED_TIME;
        this.growth[s] = 0.03 * Math.min(1, this.progress[s]);
        if (this.progress[s] >= 1) this.phase[s] = GROWTH;
      } else if (ph === GROWTH) {
        this.growth[s] = Math.min(1.25, this.growth[s] + growRate);
        if (this.growth[s] >= 1.25) this.phase[s] = MATURE;
      } else if (ph === MATURE || ph === RESONANCE) {
        // What it remembers: the music it grew in, against the present, as far as the music is heard to repeat.
        let d2 = 0;
        for (let q = 0; q < TRAITS; q++) { const e = this.memory[s * TRAITS + q] - sig[q]; d2 += e * e; }
        const m = Math.exp(-d2 / (2 * SIGMA * SIGMA)) * memory;
        this.match[s] = m;
        const drive = Math.max(m, groove * 0.9 * unit(1 - this.age[s] / (2 * p.span)));
        const ringing = ph === RESONANCE ? drive > RING_OFF : drive > RING_ON;
        this.phase[s] = ringing ? RESONANCE : MATURE;
        this.resonance[s] += ((ringing ? 1 : 0) - this.resonance[s]) * (1 - Math.exp(-live / RING_TAU));
        if (ringing && m >= RING_OFF) remembering++;
        strongest = Math.max(strongest, m);
        if (this.age[s] > p.span) { this.phase[s] = DECAY; this.progress[s] = 0; this.stats.aged++; }
        else if (weakest < 0 || this.resonance[s] + 0.1 * this.growth[s] < this.resonance[weakest] + 0.1 * this.growth[weakest]) weakest = s;
      } else if (ph === DECAY) {
        // Leaves fall first; then the branches retract, tips first (growth runs back through the depths).
        this.decay[s] = Math.min(1, this.decay[s] + live / (0.4 * DECAY_TIME));
        this.growth[s] = Math.max(0, this.growth[s] - (this.decay[s] >= 1 ? live * 1.25 / (0.6 * DECAY_TIME) : 0));
        this.resonance[s] *= Math.exp(-live / RING_TAU);
        if (this.growth[s] <= 0) { this.recycle(s); this.stats.decayed++; }
      }
    }
    if (retire && this.sinceRetire >= RETIRE_EVERY && weakest >= 0) { this.phase[weakest] = DECAY; this.progress[weakest] = 0; this.sinceRetire = 0; }
    this.stats.remembering = remembering; this.stats.match = strongest;

    // ---- the wind: the world's stereo side, followed slowly; each tree leans with it, rigidly, as far as it rings ----
    const lateral = Math.max(-1, Math.min(1, Number.isFinite(view.lateral) ? view.lateral : 0));
    this.wind += (lateral - this.wind) * (1 - Math.exp(-live / 2));
    this.pack();
  }

  /** A cue of the session, or one a tool offers through the same path. */
  cue(cue: Readonly<Cue>): void {
    const s = this.stats;
    if (cue.kind === 'release' && cue.status === 'confirmed') {
      s.releases++; s.bursts++; this.burst = BURST; this.budding = false;
      // Every mature tree flushes, dated at the release; its leaves open all at once.
      for (let k = 0; k < MAX_TREES; k++) if (this.phase[k] === MATURE || this.phase[k] === RESONANCE) { this.flushAt[k] = cue.time; this.leaves[k] = 1; }
    } else if (cue.kind === 'prepare' && cue.status === 'predicted') { s.prepares++; this.budding = true; }
    else if (cue.kind === 'withdraw') { s.withdraws++; this.budding = false; }
    else if (cue.kind === 'accent' && cue.status === 'observed') {
      // An accent: a moment of light on the oldest tree that stands, nothing more.
      let best = -1;
      for (let k = 0; k < MAX_TREES; k++) if ((this.phase[k] === MATURE || this.phase[k] === RESONANCE) && (best < 0 || this.age[k] > this.age[best])) best = k;
      if (best >= 0) { this.accentAt[best] = cue.time; s.accents++; }
    }
  }

  /** A new audio session: what was read of the last one is forgotten; the trees stay as they are. */
  reset(): void {
    this.cursor = -1; this.burst = 0; this.budding = false; this.density = 0; this.fresh = true;
  }

  /** Every tree back to the pool and every count to zero (a tool's reset). */
  clear(): void {
    this.phase.fill(DORMANT); this.growth.fill(0); this.flushAt.fill(-Infinity); this.accentAt.fill(-Infinity);
    for (let s = 0; s < MAX_TREES; s++) this.trees[s * 4] = -1;
    this.reset(); this.lastPosition = NaN; this.evaluated = -Infinity; this.travelled = 0; this.links = 0; this.sown = false;
    const st = this.stats;
    st.phases.fill(0);
    st.spawned = st.recycled = st.passed = st.decayed = st.aged = st.refused = st.bursts = st.releases = st.prepares = st.withdraws = st.accents = st.remembering = 0;
  }

  /** Trees in the pool now (any phase but dormant). */
  live(): number {
    let n = 0;
    for (let s = 0; s < MAX_TREES; s++) if (this.phase[s] !== DORMANT) n++;
    return n;
  }

  // ---- decisions ----

  private candidates(row: number, t: Readonly<TerrainValues>, capacity: number, columns: number, cues: Readonly<CuesFrame>): void {
    const p = this.params, R = ((row % PERIOD) + PERIOD) % PERIOD, burst = this.burst > 0;
    // The first sowing takes the density the music asks for at once (the followed one has not risen yet).
    const density = this.planting ? this.stats.target : this.density;
    if (burst) this.burst--;
    if (!burst && (density < LEAST || this.stats.target === 0)) return;
    for (let side = -1; side <= 1; side += 2) {
      const chance = forestHash(row * 2 + (side > 0 ? 1 : 0), this.worldSeed);
      if (!burst && chance >= density) continue;
      if (this.live() >= capacity || (this.count(SEED) + this.count(GROWTH) >= p.growing && !burst && !this.planting)) { this.stats.refused++; continue; }
      let s = 0;
      while (s < MAX_TREES && this.phase[s] !== DORMANT) s++;
      if (s === MAX_TREES) { this.stats.refused++; continue; }
      // The shape first (from the music heard now, quantized): where it may stand depends on how far its crown reaches.
      const seed = Math.floor(forestHash(row, side + 7 + this.worldSeed) * 0x7fffffff), tr = this.traits, sig = this.present;
      tr.branching = quantize(sig[5]); tr.spread = 0.55 + 0.45 * quantize(sig[2]); tr.upright = quantize(cues.tension); tr.foliage = quantize(sig[4]);
      tr.height = p.low + (p.high - p.low) * forestHash(seed, 3);
      const shape = growTree(seed, tr, this.shapes[s]);
      const off = p.corridor + shape.reach + forestHash(seed, 4) * p.reach;
      const J = Math.round((terrainMeander(R) + side * off) / t.cell), i = J - t.col;
      if (Math.abs(i) > columns / 2 - SIDE || this.near(J, R, shape.reach / t.cell)) { this.stats.refused++; continue; }
      this.J[s] = J; this.R[s] = R; this.phase[s] = SEED; this.progress[s] = 0; this.growth[s] = 0; this.age[s] = 0;
      this.decay[s] = 0; this.resonance[s] = 0; this.match[s] = 0; this.leaves[s] = 0.35 + 0.65 * tr.foliage;
      this.sway[s] = 0.6 + 0.4 * forestHash(seed, 5); this.flushAt[s] = this.accentAt[s] = -Infinity;
      for (let q = 0; q < TRAITS; q++) this.memory[s * TRAITS + q] = sig[q];
      this.dirty[s] = 1;
      this.stats.spawned++;
    }
  }

  private recycle(s: number): void {
    this.phase[s] = DORMANT; this.growth[s] = 0; this.trees[s * 4] = -1; this.stats.recycled++;
  }

  private near(J: number, R: number, cells: number): boolean {
    for (let s = 0; s < MAX_TREES; s++) {
      if (this.phase[s] === DORMANT) continue;
      const dr = Math.abs(((this.R[s] - R) % PERIOD + PERIOD * 1.5) % PERIOD - PERIOD * 0.5);
      if (Math.abs(this.J[s] - J) < cells + 1 && dr < cells + 1) return true;
    }
    return false;
  }

  private count(phase: number): number {
    let n = 0;
    for (let s = 0; s < MAX_TREES; s++) if (this.phase[s] === phase) n++;
    return n;
  }

  /** What the GPU reads per tree, and the filaments between trees that remember the same music. */
  private pack(): void {
    const p = this.params, phases = this.stats.phases;
    phases.fill(0);
    for (let s = 0; s < MAX_TREES; s++) {
      const ph = this.phase[s];
      phases[ph]++;
      const o = s * 4;
      if (ph === DORMANT) { this.trees[o] = -1; this.trees[o + 2] = 0; continue; }
      const flush = Math.exp(-Math.max(0, this.now - this.flushAt[s]) / FLUSH_TAU), accent = Math.exp(-Math.max(0, this.now - this.accentAt[s]) / ACCENT_TAU);
      const bud = this.budding && (ph === MATURE || ph === RESONANCE) ? 0.5 : 0;
      this.trees[o] = this.growth[s];
      this.trees[o + 1] = -p.lean * this.wind * this.sway[s] * (0.5 + 0.5 * this.resonance[s]);
      this.trees[o + 2] = (0.45 + 0.35 * Math.min(1, this.growth[s]) + 0.5 * this.resonance[s]) * (1 - 0.6 * this.decay[s]) + 0.8 * flush + 0.5 * accent;
      this.trees[o + 3] = this.decay[s];
      this.treeLean[o] = Math.PI / 2; this.treeLean[o + 1] = Math.max(this.resonance[s], bud); this.treeLean[o + 2] = this.leaves[s] * (1 - this.decay[s] * 0.5); this.treeLean[o + 3] = flush;
    }
    // Filaments: trees resonating with the same remembered music, near enough to each other.
    let n = 0;
    for (let a = 0; a < MAX_TREES && n < this.linkA.length; a++) {
      if (this.phase[a] !== RESONANCE || this.match[a] < RING_OFF) continue;
      for (let b = a + 1; b < MAX_TREES && n < this.linkA.length; b++) {
        if (this.phase[b] !== RESONANCE || this.match[b] < RING_OFF) continue;
        const dr = Math.abs(((this.R[b] - this.R[a]) % PERIOD + PERIOD * 1.5) % PERIOD - PERIOD * 0.5);
        if (Math.abs(this.J[b] - this.J[a]) + dr > LINK_CELLS) continue;
        let d2 = 0;
        for (let q = 0; q < TRAITS; q++) { const e = this.memory[a * TRAITS + q] - this.memory[b * TRAITS + q]; d2 += e * e; }
        if (d2 > LINK_SIGNATURE * LINK_SIGNATURE * TRAITS) continue;
        this.linkA[n] = a; this.linkB[n] = b; n++;
      }
    }
    this.links = n;
  }
}

/** The six slow traits of the geometry a tree remembers: tonal and noisy shape, curvature, hardness, density, branching. */
export const TRAIT_KEYS = ['tonalShape', 'noiseShape', 'curvature', 'edgeHardness', 'density', 'branching'] as const;
const trait = (g: Readonly<GeometryState>, i: number): number => { const x = g[TRAIT_KEYS[i]]; return Number.isFinite(x) ? unit(x) : 0; };
