import { forEachCue, type Cue, type CuesFrame } from '../../experience/MusicalCues';
import { REST_WORLD } from '../../world/WorldState';
import type { WorldView } from '../../world/WorldView';
import { FractureGate } from '../structural/FractureGate';
import { PULSE_LIMIT } from '../structural/SolidTypes';
import { packEmergent, SHAPE, SHAPES, type Emergent, type ShapeName } from './emergenceLaw';
import { PERIOD, terrainHeight, terrainMeander, type TerrainValues } from './terrainLaw';

/*
 * Solid emergence: what rises out of Generative Terrain and when (docs/scene-families.md). The decisions, not the
 * drawing: a fixed pool of structures, each anchored at a lattice point of the ground, living through
 *
 *   dormant → formation → emergence → active ⇄ resonance → fracture | retreat → recycle
 *
 * on the time the music lives (frozen in silence and without a clock: nothing moves by itself). The ground decides
 * where (lattice points beside the valley, as rows come into view: no travel, no new structure; the slope and the
 * terraces where it stands decide its shape and whether it is a raised cell or a solid in the ground); the music
 * decides how much, on its own scales, through the musical cues (experience/MusicalCues.ts) and the world:
 *
 *   groove       a few persistent structures (a low density, followed over seconds: never the volume, never a kick)
 *   tension      more of them, organised: in pairs across the valley, at a regular spacing
 *   prediction   new structures wait in formation for the release expected; a prediction given up sends them back
 *   release      heard (confirmed) only: what waited emerges, a burst of new ones, and the fracture gate may break some
 *   breakdown    nothing new, and what stands retreats into the ground one by one
 *   silence      nothing new, nothing moves
 *
 * The experience's own drop, an accent and a prediction never break or burst anything. A structure that broke is the
 * law's pieces (emergenceLaw.ts) as a function of the fracture's age, dated at the event's own audio time, so it
 * looks the same at any frame rate. Fixed storage: nothing is allocated after construction.
 */

export const PHASES = ['dormant', 'formation', 'emergence', 'active', 'resonance', 'fracture', 'retreat'] as const;
export type Phase = typeof PHASES[number];
const DORMANT = 0, FORMATION = 1, EMERGENCE = 2, ACTIVE = 3, RESONANCE = 4, FRACTURE = 5, RETREAT = 6;

export interface EmergenceParams {
  enabled: boolean;
  /** Structures at most, at once; of them, how many may be forming or emerging, and how many breaking. */
  capacity: number;
  emerging: number;
  fragments: number;
  /** Rows of the lattice between two rows where a structure may stand. */
  spacing: number;
  /** The density a steady groove keeps (share of the candidates that rise), and a gain on all of it. */
  density: number;
  rate: number;
  /** How much tension, anticipation and a release heard add (0: a groove's few structures only). */
  response: number;
  /** The largest uniform change of size the lows give a structure (≤ PULSE_LIMIT). */
  pulse: number;
  /** Whether a release heard may break structures. */
  fracture: boolean;
  /** Raised cells, solids standing in the ground, or both (the ground decides which where). */
  modes: 'both' | 'extrude' | 'anchored';
  /** Heights as shares of the relief. */
  low: number;
  high: number;
  /**
   * Where structures stand: beside the valley, up its walls (the terrain's own); or across its floor, a plain, outside a
   * corridor of `corridor` units on each side of the line the viewer flies (Monolith Desert).
   */
  placement: 'walls' | 'plain';
  corridor: number;
  /** The shapes solids standing in the ground take, in the plain (absent: the ground decides, as beside the valley). */
  forms: readonly ShapeName[] | null;
  /** How many of the tallest that stand a breakdown leaves standing: the landmarks of the place (0: it retires them all). */
  keep: number;
  /** Seed the first revealed plain too, at the ordinary density/budget; only once travel brings a new row. */
  initial: boolean;
}

export const DEFAULT_EMERGENCE: Readonly<EmergenceParams> = {
  enabled: true, capacity: 28, emerging: 6, fragments: 4, spacing: 6, density: 0.12, rate: 1, response: 1, pulse: PULSE_LIMIT, fracture: true,
  modes: 'both', low: 0.3, high: 0.7, placement: 'walls', corridor: 6, forms: null, keep: 0, initial: false,
};
/** No pool is larger than this, whatever a preset or a tool asks. */
export const MAX_STRUCTURES = 64;

/** What a preset may say (plain JSON: `modes`, `placement` and the forms are any strings there). */
export type EmergenceSettings = Partial<Omit<EmergenceParams, 'modes' | 'placement' | 'forms'>> & { modes?: string; placement?: string; forms?: readonly string[] | null };
const MODES = ['both', 'extrude', 'anchored'] as const;
const PLACEMENTS = ['walls', 'plain'] as const;
const SHAPE_NAMES: readonly string[] = SHAPES.map((shape) => shape.name);
const within = (x: unknown, lo: number, hi: number, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback);

/** Settings within their bounds; what is missing or wrong is the default's. */
export function emergenceParams(s: EmergenceSettings = {}): EmergenceParams {
  const d = DEFAULT_EMERGENCE, low = within(s.low, 0.05, 3, d.low);
  const forms = Array.isArray(s.forms) ? s.forms.filter((f): f is ShapeName => SHAPE_NAMES.includes(f)) : [];
  return {
    enabled: s.enabled ?? d.enabled, capacity: Math.round(within(s.capacity, 0, MAX_STRUCTURES, d.capacity)), emerging: Math.round(within(s.emerging, 0, MAX_STRUCTURES, d.emerging)),
    fragments: Math.round(within(s.fragments, 0, MAX_STRUCTURES, d.fragments)), spacing: Math.round(within(s.spacing, 2, 64, d.spacing)),
    density: within(s.density, 0, 1, d.density), rate: within(s.rate, 0, 4, d.rate), response: within(s.response, 0, 4, d.response),
    pulse: within(s.pulse, 0, PULSE_LIMIT, d.pulse), fracture: s.fracture ?? d.fracture,
    modes: (MODES as readonly string[]).includes(s.modes ?? '') ? s.modes as EmergenceParams['modes'] : d.modes,
    low, high: within(s.high, low, 4, Math.max(low, d.high)),
    placement: (PLACEMENTS as readonly string[]).includes(s.placement ?? '') ? s.placement as EmergenceParams['placement'] : d.placement,
    corridor: within(s.corridor, 0, 200, d.corridor), forms: forms.length ? forms : null, keep: Math.round(within(s.keep, 0, MAX_STRUCTURES, d.keep)),
    initial: s.initial ?? d.initial,
  };
}

/** Lived seconds a phase takes: the least a formation lasts, emerging, breaking, retreating; how long a formation may wait for a release. */
const FORMATION_TIME = 0.8;
const EMERGENCE_TIME = 1.6;
const PREPARED_TIME = 0.9;
const FRACTURE_TIME = 3;
const RETREAT_TIME = 1.8;
const WAIT = 12;
/** Mesh rows from the far end where rows come into view (in the horizon's fade), and from the viewer where structures leave. */
const AHEAD = 10;
const BEHIND_ROWS = 1.5;
/** Mesh columns kept clear of the mesh's sides. */
const SIDE = 3;
/** Units beside the valley's floor a structure stands at least, and how far up its walls it may stand. */
const CLEAR = 2;
const UP = 11;
/** The density follows its target over this long (s); below the least it is nothing. */
const DENSITY_TAU = 2;
const LEAST = 0.02;
/** Candidate rows a release heard fills on both sides, and how much taller its structures are. */
const BURST = 3;
const BURST_HEIGHT = 1.35;
/** The groove a structure resonates from, and below which it rests again (the terrain's followed excitation); its envelope (s). */
const RING_ON = 0.6;
const RING_OFF = 0.45;
const RING_TAU = 0.3;
/** In a breakdown one structure retreats every this long (s). */
const RETIRE_EVERY = 1.2;
/** An accent's light on the structure it reaches (s). */
const ACCENT_TAU = 0.35;
/** Footprint radius of a solid standing in the ground (cells). */
const WIDTH = [0.55, 0.85] as const;
/** Slope (relief per cell) above which a solid in the ground is a crystal; terraces above which a cell is raised. */
const STEEP = 0.9;
const TERRACED = 0.4;

const unit = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (x: number): number => { const t = unit(x); return t * t * (3 - 2 * t); };
/** How well a structure at `depth` (share of the mesh's rows) can be looked at: not as it passes out of the picture, not lost in the haze. */
const visible = (depth: number): number => smooth((depth - 0.05) / 0.1) * (1 - smooth((depth - 0.6) / 0.25));
/** A number 0..1 for two integers and a seed, the same everywhere; no allocation. */
function hash(a: number, b: number, seed: number): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be59b, 0xc2b2ae35) ^ seed;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface EmergenceStats {
  /** Structures by phase now. */
  phases: Uint16Array;
  spawned: number;
  /** Recycled, of which: passed behind the viewer, retreated into the ground, done breaking. */
  recycled: number;
  passed: number;
  retreated: number;
  fractured: number;
  /** Candidates refused because a budget was full. */
  refused: number;
  bursts: number;
  /** Cues acted on: releases heard, predictions prepared for and withdrawn, accents. Experience drops never are (not cues). */
  releases: number;
  prepares: number;
  withdraws: number;
  accents: number;
  /** The density now (0..1) and its target. */
  density: number;
  target: number;
}

export class EmergenceField {
  readonly params: EmergenceParams;
  readonly gate = new FractureGate();
  readonly stats: EmergenceStats = {
    phases: new Uint16Array(PHASES.length), spawned: 0, recycled: 0, passed: 0, retreated: 0, fractured: 0, refused: 0, bursts: 0,
    releases: 0, prepares: 0, withdraws: 0, accents: 0, density: 0, target: 0,
  };
  /** Instance attributes of the structures to draw (the first `count`), rewritten each frame. */
  readonly anchor = new Float32Array(MAX_STRUCTURES * 4);
  readonly body = new Float32Array(MAX_STRUCTURES * 4);
  readonly brk = new Float32Array(MAX_STRUCTURES * 4);
  count = 0;
  // ---- the pool ----
  private readonly phase = new Uint8Array(MAX_STRUCTURES);
  private readonly progress = new Float32Array(MAX_STRUCTURES);
  /** Lived seconds the current phase takes. */
  private readonly span = new Float32Array(MAX_STRUCTURES).fill(1);
  private readonly J = new Int32Array(MAX_STRUCTURES);
  private readonly R = new Int32Array(MAX_STRUCTURES);
  private readonly mode = new Uint8Array(MAX_STRUCTURES);
  private readonly shape = new Uint8Array(MAX_STRUCTURES);
  private readonly height = new Float32Array(MAX_STRUCTURES);
  private readonly width = new Float32Array(MAX_STRUCTURES);
  private readonly seed = new Float32Array(MAX_STRUCTURES);
  private readonly turn = new Float32Array(MAX_STRUCTURES);
  /** Audio time it began to break (the event's), when an accent last reached it; seconds it has stood; its resonance envelope. */
  private readonly brokeAt = new Float64Array(MAX_STRUCTURES);
  private readonly accentAt = new Float64Array(MAX_STRUCTURES).fill(-Infinity);
  private readonly age = new Float32Array(MAX_STRUCTURES);
  private readonly ring = new Float32Array(MAX_STRUCTURES);
  /** The prediction a formation waits for (0: none). */
  private readonly waiting = new Float64Array(MAX_STRUCTURES);
  private readonly emergent: Emergent = { J: 0, R: 0, mode: 0, shape: 0, height: 0, width: 0, rise: 0, pulse: 0, age: -1, seed: 0, light: 0, turn: 0 };
  // ---- the music, as followed ----
  private density = 0;
  private cursor = -1;
  /** Rows come into view so far (unwrapped), the last whole one evaluated. */
  private travelled = 0;
  private lastPosition = NaN;
  private evaluated = -Infinity;
  private burst = 0;
  private prepared = 0;
  private sinceRetire = 0;
  private now = 0;
  /** The ground's row at the last step (what `focus` measures depths from), and the structure the viewer watches (−1: none). */
  private lastRow = 0;
  private watched = -1;
  private sown = false;
  private planting = false;
  private readonly take = (cue: Readonly<Cue>): void => this.cue(cue);

  constructor(params: EmergenceSettings = {}, private readonly worldSeed = 0) {
    this.params = emergenceParams(params);
    this.gate.tuning.mode = 'events';
  }

  /** Structures in a phase now. */
  in(phase: Phase): number { return this.stats.phases[PHASES.indexOf(phase)]; }

  /**
   * One frame. `t`: what the terrain law reads this frame (the ground's own values); `view`: the world; `position`: the
   * ground travelled as rows (TerrainMotion); `ring`: the groove the terrain follows; `tension`: the stored potential as
   * the terrain follows it; `cues`: the snapshot's musical cues (none without a clock); `now`: the audio time heard.
   */
  step(dt: number, t: Readonly<TerrainValues>, view: Readonly<WorldView>, position: number, rows: number, columns: number, ring: number, tension: number, cues: Readonly<CuesFrame> | undefined, now: number): void {
    const p = this.params, h = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.25) : 0;
    const timed = view.world !== REST_WORLD && !!cues;
    this.lastRow = t.row;
    // The music's time: nothing lives in silence or without a clock.
    const live = timed && !cues!.silent ? h : 0;
    this.now = now;
    if (cues) this.cursor = this.cursor < 0 ? cues.seq : forEachCue(cues, this.cursor, this.take);
    const capacity = Math.min(MAX_STRUCTURES, Math.max(0, Math.round(p.capacity)));

    // ---- how much: a density of the slow state of the music, never of the level ----
    const phase = timed ? cues!.phase : 'silence';
    const organised = unit((tension - 0.25) / 0.45), response = Math.max(0, p.response);
    const target = !timed || phase === 'silence' || phase === 'breakdown' ? 0
      : unit((p.density + response * (0.3 * organised + 0.25 * cues!.anticipation)) * Math.max(0, p.rate));
    this.density += (target - this.density) * (1 - Math.exp(-live / DENSITY_TAU));
    this.stats.target = target; this.stats.density = this.density;

    // ---- where: rows coming into view beside the valley ----
    const far = rows - AHEAD;
    if (Number.isNaN(this.lastPosition)) this.lastPosition = position;
    this.travelled += ((position - this.lastPosition) % PERIOD + PERIOD * 1.5) % PERIOD - PERIOD * 0.5;
    this.lastPosition = position;
    const reached = Math.floor(this.travelled + far);
    if (this.evaluated === -Infinity) this.evaluated = reached;
    // Within a frame at most a few rows come in; more than that (a jump) are not evaluated: they are already near.
    // Nothing rises on the time the music does not live (silence, no clock): those rows pass as they are.
    if (live > 0) {
      this.planting = p.initial && !this.sown && target >= LEAST && reached > this.evaluated;
      const from = this.planting ? Math.floor(this.travelled + AHEAD) : Math.max(this.evaluated + 1, reached - 4 * p.spacing);
      for (let row = from; row <= reached; row++) {
        const spacing = Math.max(1, Math.round(p.spacing));
        if (row % spacing === 0) this.candidates(row, t, capacity, organised, columns);
      }
      if (this.planting) this.sown = true;
      this.planting = false;
    }
    this.evaluated = Math.max(this.evaluated, reached);

    // ---- a release heard: what waited emerges; the gate may break what stands ----
    const fragments = this.count_(FRACTURE), standing = this.count_(ACTIVE) + this.count_(RESONANCE);
    const amount = this.gate.take(now, now, p.fracture && standing > 0 && fragments < p.fragments);
    if (amount > 0) this.fracture(amount, fragments);

    // ---- every structure through its life ----
    const retire = phase === 'breakdown' && timed;
    this.sinceRetire = retire ? this.sinceRetire + live : 0;
    // The landmarks a breakdown leaves standing: the `keep` tallest that stand (none unless asked).
    const landmark = retire && p.keep > 0 ? this.landmark(p.keep) : Infinity;
    let oldest = -1;
    for (let s = 0; s < MAX_STRUCTURES; s++) {
      const ph = this.phase[s];
      if (ph === DORMANT) continue;
      const k = ((this.R[s] - t.row) % PERIOD + PERIOD) % PERIOD, i = this.J[s] - t.col;
      // Passed under and behind the viewer, or out at the mesh's sides: its resources go back to the pool.
      if (k < BEHIND_ROWS || k > rows || Math.abs(i) > columns / 2 - 1) { this.recycle(s); this.stats.passed++; continue; }
      this.age[s] += live;
      this.progress[s] += live / this.span[s];
      if (ph === FORMATION) {
        if (this.waiting[s] && this.age[s] > WAIT) this.retreat(s);
        else if (!this.waiting[s] && this.progress[s] >= 1) this.enter(s, EMERGENCE, EMERGENCE_TIME);
      } else if (ph === EMERGENCE) {
        if (this.progress[s] >= 1) this.enter(s, ACTIVE, 1);
      } else if (ph === ACTIVE || ph === RESONANCE) {
        // Resonance: the groove rings it (with hysteresis); its envelope follows over a moment.
        const ringing = ph === RESONANCE ? ring > RING_OFF : ring > RING_ON;
        this.phase[s] = ringing ? RESONANCE : ACTIVE;
        this.ring[s] += ((ringing ? 1 : 0) - this.ring[s]) * (1 - Math.exp(-live / RING_TAU));
        if (this.height[s] < landmark && (oldest < 0 || this.age[s] > this.age[oldest])) oldest = s;
      } else if (ph === FRACTURE) {
        if (now - this.brokeAt[s] >= FRACTURE_TIME) { this.recycle(s); this.stats.fractured++; }
      } else if (ph === RETREAT) {
        if (this.progress[s] >= 1) { this.recycle(s); this.stats.retreated++; }
      }
    }
    if (retire && this.sinceRetire >= RETIRE_EVERY && oldest >= 0) { this.retreat(oldest); this.sinceRetire = 0; }
    this.pack(view);
  }

  /**
   * What the viewer may look at: the structure the place is showing now, as a lattice point, its height above its
   * anchor and how much it asks to be looked at (0..1), or −1 when nothing does. A structure rising asks the most, then
   * the tallest that stands in the middle distance; the one looked at keeps the eye until another clearly asks more
   * (a reframe is a decision, not a flicker). A reading only: nothing in the field changes.
   */
  focus(rows: number, out: { J: number; R: number; height: number; weight: number }): number {
    const t = this.lastRow;
    let best = -1, most = 0, held = 0;
    for (let s = 0; s < MAX_STRUCTURES; s++) {
      const ph = this.phase[s];
      if (ph !== EMERGENCE && ph !== ACTIVE && ph !== RESONANCE) continue;
      const k = ((this.R[s] - t) % PERIOD + PERIOD) % PERIOD, depth = k / Math.max(1, rows);
      // Too close (it passes out of the picture) or too far (lost in the haze) asks for nothing.
      const seen = visible(depth);
      const ask = seen * this.height[s] * (ph === EMERGENCE ? 2 : 1) * (1 + this.ring[s] * 0.3);
      if (s === this.watched) held = ask;
      if (ask > most) { most = ask; best = s; }
    }
    // The eye stays on what it watches unless another asks half as much again.
    if (this.watched >= 0 && held > 0 && most < 1.5 * held) best = this.watched;
    this.watched = best;
    if (best < 0) { out.weight = 0; return -1; }
    const k = ((this.R[best] - t) % PERIOD + PERIOD) % PERIOD, depth = k / Math.max(1, rows);
    out.J = this.J[best]; out.R = this.R[best]; out.height = this.height[best] * this.rise(best);
    out.weight = visible(depth) * (this.phase[best] === EMERGENCE ? 1 : 0.6);
    return best;
  }

  /** A cue of the session, or one a tool offers through the same path. */
  cue(cue: Readonly<Cue>): void {
    const s = this.stats;
    if (cue.kind === 'release' && cue.status === 'confirmed') {
      s.releases++;
      // What waited for it emerges now, and the next rows fill on both sides.
      for (let k = 0; k < MAX_STRUCTURES; k++) if (this.phase[k] === FORMATION && this.waiting[k]) { this.waiting[k] = 0; this.enter(k, EMERGENCE, PREPARED_TIME); }
      this.prepared = 0;
      this.burst = BURST; s.bursts++;
      if (this.params.fracture) this.gate.offer({ type: 'drop', audioTime: cue.time, strength: cue.strength, confidence: cue.confidence, band: -1, structuralWeight: 0.7, duration: 0, significance: cue.strength, seq: cue.seq });
    } else if (cue.kind === 'prepare' && cue.status === 'predicted') {
      s.prepares++; this.prepared = cue.ref || -1;
    } else if (cue.kind === 'withdraw') {
      s.withdraws++;
      for (let k = 0; k < MAX_STRUCTURES; k++) if (this.phase[k] === FORMATION && this.waiting[k]) this.retreat(k);
      this.prepared = 0;
    } else if (cue.kind === 'accent' && cue.status === 'observed') {
      // An accent lights the structure nearest the viewer that stands: a moment of light, nothing more.
      let best = -1;
      for (let k = 0; k < MAX_STRUCTURES; k++) if ((this.phase[k] === ACTIVE || this.phase[k] === RESONANCE) && (best < 0 || this.age[k] > this.age[best])) best = k;
      if (best >= 0) { this.accentAt[best] = cue.time; s.accents++; }
    }
  }

  /** A new audio session: what was read of the last one is forgotten; what waited for its release goes back into the ground. */
  reset(): void {
    this.cursor = -1; this.gate.reset(); this.prepared = 0; this.burst = 0; this.density = 0;
    for (let k = 0; k < MAX_STRUCTURES; k++) if (this.phase[k] === FORMATION) this.retreat(k);
  }

  /** Every structure back to the pool and every count to zero (a tool's reset). */
  clear(): void {
    this.phase.fill(DORMANT); this.waiting.fill(0); this.accentAt.fill(-Infinity); this.watched = -1;
    this.gate.clear(); this.cursor = -1; this.prepared = 0; this.burst = 0; this.density = 0; this.count = 0;
    this.lastPosition = NaN; this.evaluated = -Infinity; this.travelled = 0; this.sown = false;
    const s = this.stats;
    s.phases.fill(0);
    s.spawned = s.recycled = s.passed = s.retreated = s.fractured = s.refused = s.bursts = s.releases = s.prepares = s.withdraws = s.accents = 0;
  }

  // ---- decisions ----

  /** The candidates of one row of the lattice: one on each side of the valley; the density (or a burst) decides which rise. */
  private candidates(row: number, t: Readonly<TerrainValues>, capacity: number, organised: number, columns: number): void {
    const p = this.params, R = ((row % PERIOD) + PERIOD) % PERIOD, burst = this.burst > 0;
    if (burst) this.burst--;
    // A breakdown or a silence asks for nothing new at once; the density only says how much while something is asked.
    const density = this.planting ? this.stats.target : this.density;
    if (!burst && (density < LEAST || this.stats.target === 0)) return;
    // Organised: a pair across the valley at one distance; else each side by its own number.
    const pair = organised > 0.5 || burst, shared = hash(row, 0, this.worldSeed);
    for (let side = -1; side <= 1; side += 2) {
      const chance = hash(row, side + 7, this.worldSeed);
      if (!burst && (pair ? shared : chance) >= density) continue;
      if (this.live_() >= capacity || (this.count_(FORMATION) + this.count_(EMERGENCE) >= p.emerging && !burst)) { this.stats.refused++; continue; }
      const out = pair ? 0.35 + 0.1 * shared : hash(row, side + 31, this.worldSeed);
      // Beside the valley, up its walls; or across its floor (a plain), outside the corridor the viewer flies along.
      const off = p.placement === 'plain' ? p.corridor + out * Math.max(0, t.valley + CLEAR - p.corridor) : t.valley + CLEAR + out * UP;
      const across = terrainMeander(R) + side * off, J = Math.round(across / t.cell);
      const i = J - t.col;
      if (Math.abs(i) > columns / 2 - SIDE || this.near(J, R)) { this.stats.refused++; continue; }
      this.spawn(J, R, row, side, t, burst, chance);
    }
  }

  private spawn(J: number, R: number, row: number, side: number, t: Readonly<TerrainValues>, burst: boolean, chance: number): void {
    const p = this.params;
    let s = 0;
    while (s < MAX_STRUCTURES && this.phase[s] !== DORMANT) s++;
    if (s === MAX_STRUCTURES) { this.stats.refused++; return; }
    // The ground where it stands decides what it is: a terraced ground raises its cells, a steep one grows crystals.
    const i = J - t.col, k = ((R - t.row) % PERIOD + PERIOD) % PERIOD;
    const slope = Math.abs(terrainHeight(t, i + 1, k) - terrainHeight(t, i - 1, k)) * 0.5 / t.cell;
    const extrude = p.modes === 'extrude' || (p.modes === 'both' && (t.terrace > TERRACED || hash(row, side + 53, this.worldSeed) < 0.3));
    this.mode[s] = extrude ? 0 : 1;
    const forms = p.forms;
    this.shape[s] = extrude ? SHAPE.block : forms ? SHAPE[forms[Math.floor(hash(row, side + 151, this.worldSeed) * forms.length)]]
      : slope > STEEP ? SHAPE.crystal : chance < 0.5 * this.density ? SHAPE.prism : SHAPE.pillar;
    const tall = p.low + (p.high - p.low) * hash(row, side + 97, this.worldSeed);
    this.height[s] = Math.abs(t.relief) * tall * (burst ? BURST_HEIGHT : 1) * (this.shape[s] === SHAPE.crystal ? 1.3 : 1);
    this.width[s] = WIDTH[0] + (WIDTH[1] - WIDTH[0]) * hash(row, side + 71, this.worldSeed);
    this.seed[s] = hash(row, side + 113, this.worldSeed); this.turn[s] = 6.2831853 * hash(row, side + 131, this.worldSeed);
    this.J[s] = J; this.R[s] = R; this.age[s] = 0; this.ring[s] = 0; this.accentAt[s] = -Infinity; this.brokeAt[s] = 0;
    // While a release is predicted, what forms waits for it in formation; heard, a burst emerges at once.
    this.waiting[s] = !burst && this.prepared !== 0 ? 1 : 0;
    if (burst) this.enter(s, EMERGENCE, EMERGENCE_TIME);
    else this.enter(s, FORMATION, FORMATION_TIME);
    this.stats.spawned++;
  }

  private fracture(amount: number, breaking: number): void {
    const p = this.params;
    // The most loaded first: the tallest that ring the most; never more than the budget lets break at once.
    let wanted = Math.max(1, Math.round(amount * (this.count_(ACTIVE) + this.count_(RESONANCE))));
    while (wanted-- > 0 && breaking < p.fragments) {
      let best = -1, load = -1;
      for (let s = 0; s < MAX_STRUCTURES; s++) {
        if (this.phase[s] !== ACTIVE && this.phase[s] !== RESONANCE) continue;
        const l = this.height[s] * (0.5 + this.ring[s]);
        if (l > load) { load = l; best = s; }
      }
      if (best < 0) return;
      this.phase[best] = FRACTURE; this.brokeAt[best] = this.gate.time; this.progress[best] = 0; this.span[best] = FRACTURE_TIME;
      breaking++;
    }
  }

  private enter(s: number, phase: number, span: number): void {
    this.phase[s] = phase; this.progress[s] = 0; this.span[s] = span;
  }

  private retreat(s: number): void {
    // From wherever it has risen to: the retreat starts at its rise now.
    const rise = this.rise(s);
    this.phase[s] = RETREAT; this.span[s] = RETREAT_TIME; this.waiting[s] = 0;
    // Smoothstep is symmetric: the progress whose retreat stands where the structure is now.
    this.progress[s] = 1 - this.inverse(rise);
  }

  private recycle(s: number): void {
    this.phase[s] = DORMANT; this.waiting[s] = 0; this.stats.recycled++;
  }

  /** The height of the `n`-th tallest that stands: what reaches it is a landmark. */
  private landmark(n: number): number {
    let bar = Infinity;
    for (let m = 0; m < n; m++) {
      let next = -Infinity;
      for (let s = 0; s < MAX_STRUCTURES; s++) {
        const ph = this.phase[s];
        if ((ph === ACTIVE || ph === RESONANCE) && this.height[s] < bar && this.height[s] > next) next = this.height[s];
      }
      if (next === -Infinity) return -Infinity;
      bar = next;
    }
    return bar;
  }

  private near(J: number, R: number): boolean {
    for (let s = 0; s < MAX_STRUCTURES; s++) {
      if (this.phase[s] === DORMANT) continue;
      const dr = Math.abs(((this.R[s] - R) % PERIOD + PERIOD * 1.5) % PERIOD - PERIOD * 0.5);
      if (Math.abs(this.J[s] - J) < 3 && dr < 3) return true;
    }
    return false;
  }

  private count_(phase: number): number {
    let n = 0;
    for (let s = 0; s < MAX_STRUCTURES; s++) if (this.phase[s] === phase) n++;
    return n;
  }

  private live_(): number {
    let n = 0;
    for (let s = 0; s < MAX_STRUCTURES; s++) if (this.phase[s] !== DORMANT) n++;
    return n;
  }

  /** The progress at which an emergence stands at `rise` (the inverse of the smoothstep). */
  private inverse(rise: number): number {
    const r = unit(rise);
    return 0.5 - Math.sin(Math.asin(1 - 2 * r) / 3);
  }

  /** How far a structure has come out of the ground, 0..1. */
  private rise(s: number): number {
    const ph = this.phase[s], q = unit(this.progress[s]);
    return ph === FORMATION ? 0 : ph === EMERGENCE ? smooth(q) : ph === RETREAT ? 1 - smooth(q) : 1;
  }

  /** The structures to draw, as the law reads them. */
  private pack(view: Readonly<WorldView>): void {
    const p = this.params, e = this.emergent, phases = this.stats.phases, pulse = Math.min(PULSE_LIMIT, Math.max(0, p.pulse));
    phases.fill(0);
    let n = 0;
    for (let s = 0; s < MAX_STRUCTURES; s++) {
      const ph = this.phase[s];
      phases[ph]++;
      if (ph === DORMANT) continue;
      const rise = this.rise(s), accent = Math.exp(-Math.max(0, this.now - this.accentAt[s]) / ACCENT_TAU);
      e.J = this.J[s]; e.R = this.R[s]; e.mode = this.mode[s]; e.shape = this.shape[s];
      e.height = this.height[s]; e.width = this.width[s]; e.rise = ph === FORMATION ? 0.02 : rise;
      // Rigid: the lows give it one uniform change of scale, as far as it rings, never more than the limit.
      e.pulse = pulse * this.ring[s] * Math.max(-1, Math.min(1, view.pressure / 0.6));
      e.age = ph === FRACTURE ? Math.max(0, this.now - this.brokeAt[s]) : -1;
      e.seed = this.seed[s]; e.turn = this.turn[s];
      // Formation glows at the ground; a structure carries the world's light; a broken one fades.
      e.light = ph === FORMATION ? 0.35 + 0.25 * unit(this.progress[s])
        : ph === FRACTURE ? Math.exp(-e.age / 1.2)
        : (0.45 + 0.55 * rise) * (0.6 + 0.25 * this.ring[s] + 0.15 * unit(view.light)) + 0.6 * accent;
      packEmergent(e, this.anchor, this.body, this.brk, n++);
    }
    this.count = n;
  }
}
