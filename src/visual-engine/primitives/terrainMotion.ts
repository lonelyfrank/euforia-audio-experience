import type { EventStream } from '../../experience/EventStream';
import { unit } from '../../experience/types';
import { seedOf } from '../../show/rng';
import { AccentGate, ARRIVED, clamp, finite, follow, HysteresisGate, RateFollower } from '../../visualizers/shared/motion';
import { Reorganization } from '../../world/Reorganization';
import { REST_WORLD } from '../../world/WorldState';
import type { WorldView } from '../../world/WorldView';
import type { GeometryState } from '../geometry/GeometryState';
import { BEHIND, createTerrain, PERIOD, terrainMeander, type TerrainValues } from './terrainLaw';

/*
 * How the ground travels and what the world does to it: the terrain's reading
 * of the shared world, as the tunnel's coordinator is the tunnel's. It decides
 * nothing musical and has no time of its own: every value is the world's (or
 * the geometry's), followed exactly over a frame, or the age of a dated event.
 *
 *   travel     the world's own distance, followed as the tunnel follows it (a kick surges, it does not jerk);
 *              the mesh slides over the lattice by whole cells, so the landscape is rigid and continuous for ever
 *   lows       the world's pressure raises the relief; its excitation the finer octave (a struck ground rings)
 *   mids       hard-edged, angular sound folds the crests sharp
 *   highs      shimmer makes the ground's surface stir (the light of the highs is the material's)
 *
 * Three scales of time, kept apart (TerrainResponse): a kick or a hat is the micro scale, and it reaches the ground
 * locally (the world's wave fronts, a plate that an accent lifts, the sparks of the material), never as the whole
 * landscape pumping; the groove — how strongly the music has been ringing and stirring for the last beats — is the
 * intermediate scale the ground's mass and surface follow; builds, drops heard and sections are the structural scale
 * (terraces, the throat, the release front and the configuration it leaves).
 *   build      stored potential gathers the heights onto terraces and draws the valley in ahead
 *   strain     potential held with disorder lifts whole plates: a gate with hysteresis, as the tunnel's wall;
 *              an event that stands out lifts them for an instant, one at a time
 *   release    a crest that runs down the valley, and another ground behind it (Reorganization)
 *
 * What a forecast that never came true leaves behind is nothing: the stored
 * potential leaks, the terraces soften and the valley opens again, at the pace
 * of the followers; only a release changes the ground's configuration.
 */

export interface TerrainParams {
  /** Seed of the landscape. */
  seed: number;
  /** Size of a cell (units), and the mesh in cells: columns across the valley, rows into the distance. */
  cell: number;
  columns: number;
  rows: number;
  /** The viewer above the valley floor (units) and how far it looks down (rad). */
  height: number;
  pitch: number;
  /** Height of the walls' relief (units), of the roughness of each vertex, and half the width of the valley floor. */
  relief: number;
  roughness: number;
  valley: number;
  /** Ground covered per unit of the world's travel (units). */
  stride: number;
  /** Fog per unit of depth, light of the lines, and the height a unit wave front lifts the ground (units). */
  fog: number;
  exposure: number;
  wave: number;
  /** How the registers and the scales of the music reach the ground (absent: DEFAULT_RESPONSE). */
  response?: Partial<TerrainResponse>;
}

/**
 * How each register reaches the ground and over which time. The registers are a configurable reading, not laws of
 * music: lows give the landscape its mass (relief, the finer octave), mids its detail (folded crests), highs its
 * surface (a stir of every point). Gains 0 … 2 (1: the law's own); times 0 … 4 s.
 */
export interface TerrainResponse {
  lows: number;
  mids: number;
  highs: number;
  /** Seconds over which the ground's mass follows the world's excitation (the groove, not each kick; 0: each kick). */
  groove: number;
  /** Seconds over which its surface follows the shimmer (the activity of the highs, not each hat; 0: each hat). */
  surface: number;
}

/** The ground as it answered before the scales were separated: each kick rang the whole landscape, each hat shook it. */
export const LEGACY_RESPONSE: Readonly<TerrainResponse> = { lows: 1, mids: 1, highs: 1, groove: 0, surface: 0 };
/** The ground's own answer: the same registers, the micro scale left to the fronts and the light. */
export const DEFAULT_RESPONSE: Readonly<TerrainResponse> = { lows: 1, mids: 1, highs: 1, groove: 0.6, surface: 0.4 };
const GAIN = [0, 2] as const;
const TIME = [0, 4] as const;
const bound = (x: unknown, [lo, hi]: readonly [number, number], fallback: number): number => typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
/** A response within its bounds, what is missing or not a number being the default's. */
export function terrainResponse(r: Partial<TerrainResponse> = {}): TerrainResponse {
  const d = DEFAULT_RESPONSE;
  return { lows: bound(r.lows, GAIN, d.lows), mids: bound(r.mids, GAIN, d.mids), highs: bound(r.highs, GAIN, d.highs), groove: bound(r.groove, TIME, d.groove), surface: bound(r.surface, TIME, d.surface) };
}

/** The travel's speed, the lean and the bank follow the world over these times (s). */
const TRAVEL_TAU = 0.2;
const LEAN_TAU = 0.4;
const BANK_TAU = 0.5;
/** What the ground reads of the world follows over these times (s). */
const TENSION_TAU = 0.3;
const DISORDER_TAU = 0.5;
const FORM_TAU = 0.6;
/** The most the viewer banks into the world's turn (rad). */
const BANK = 0.1;
/** How far the world's pressure raises the relief and its excitation the finer octave. */
const SWELL = 0.35;
const RING = 0.5;
/** Stored potential below REST is what steady music keeps; terraces and the throat come with what is above it. */
const TERRACE = [0.2, 0.7] as const;
const THROAT = [0.15, 0.75] as const;
/** Plates lift once the strain passes OPEN and settle again only below CLOSE; it takes this long each way (s). */
const OPEN = 0.3;
const CLOSE = 0.12;
const OPEN_TIME = 0.8;
const CLOSE_TIME = 1.8;
/** An event lifts the plates only if it stands out this far, not sooner than this after the last one (s); it lasts this long (s). */
const ACCENT_AT = 0.7;
const ACCENT_EVERY = 2;
const ACCENT_TIME = 0.6;
/** How far plates lift, and how high the crest of a full release is (× the relief). */
const LIFT = 0.12;
const BULGE = 0.35;
/** Speed of a release front down the valley (units/s) and how long its pressure lasts (s). */
export const FRONT_SPEED = 60;
const RELEASE_TIME = 1.6;
const FAR = 1e4;
/** How high a unit of shimmer makes the ground tremble (× the roughness). */
const QUAKE = 0.6;
/** How much of the crests' fold gives way while plates are lifted. */
const YIELD = 0.4;

/** The grounds a release can leave behind: cells to a plate, terraces to the relief. The first is the canonical one. */
export const CONFIGURATIONS: readonly (readonly [plate: number, steps: number])[] = [[8, 6], [16, 4], [4, 8], [8, 9], [16, 7], [4, 5]];

/** How strained the ground is by what it holds and by disorder. */
export const strainOf = (tension: number, disorder: number): number => unit(1.3 * tension * tension + 0.8 * disorder - 0.2);
const ramp = (x: number, [lo, hi]: readonly [number, number]): number => unit((x - lo) / (hi - lo));

export class TerrainMotion {
  /** What the law reads this frame. */
  readonly values: TerrainValues = createTerrain();
  /** Roll of the ground about the viewer (rad): it banks into the world's turn. */
  bank = 0;
  /** Ground speed shown (units/s), how far plates are allowed to lift (0..1) and the accent held (0..1): the tools read them. */
  speed = 0;
  aperture = 0;
  accent = 0;
  /** What the ground reads of the world, as it is followed. */
  tension = 0;
  disorder = 0;
  /** The groove the ground's mass follows (the world's excitation over its time) and the activity its surface follows (the shimmer). */
  ring = 0;
  stir = 0;
  /** How the registers and the scales reach the ground; the tools may change it while it plays (DEV). */
  readonly response: TerrainResponse;
  /**
   * Share of the world's travel the ground goes by (1: all of it). A scene whose observer hovers holds it back
   * (Monolith Desert: CameraRig.hold); Generative Terrain leaves it at 1, where its motion is the one it always had.
   */
  pace = 1;
  /** Ground travelled, as rows (kept within a period: the landscape repeats there). */
  private position = 0;
  private fresh = true;
  private spin = 0;
  private lean = 0;
  private ridge = 0;
  private lastTime = -Infinity;
  private readonly travel = new RateFollower();
  private readonly gate = new HysteresisGate(OPEN, CLOSE, OPEN_TIME, CLOSE_TIME);
  private readonly events = new AccentGate(ACCENT_AT, ACCENT_EVERY);
  private readonly structure = new Reorganization(CONFIGURATIONS.length, 0x746572);

  constructor(private readonly params: TerrainParams) {
    this.response = terrainResponse(params.response);
    const v = this.values, seed = seedOf(params.seed, 0x746572);
    v.cell = params.cell; v.relief = params.relief; v.rough = params.roughness; v.valley = params.valley;
    v.seedX = seed % 61; v.seedY = (seed >>> 8) % 127;
  }

  get accents(): number { return this.events.taken; }
  get refused(): number { return this.events.refused; }

  /**
   * One frame. `view`: the layer's view of the world; `geometry`: what the sound asks of geometry; `events`: the
   * session's dated events with the audio time heard (`now`), or none without a clock. Must not allocate.
   */
  step(dt: number, view: Readonly<WorldView>, geometry: Readonly<GeometryState>, events?: EventStream, now = 0): TerrainValues {
    const v = this.values, p = this.params, world = view.world, h = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.25) : 0;
    // No clock, or another session: nothing of the last frames holds. The ground stays where it is: it is not the music's.
    if (world === REST_WORLD || world.time < this.lastTime - 1) this.reset();
    this.lastTime = world === REST_WORLD ? -Infinity : world.time;
    if (events && world !== REST_WORLD) this.events.read(events, now);
    const tension = unit(finite(view.tension)), disorder = unit(finite(view.disorder)), spin = clamp(finite(view.spin), -1, 1), lateral = clamp(finite(view.lateral), -1, 1);
    const rate = h > 0 ? finite(view.dTravel) * p.stride * this.pace / h : 0;
    const sharp = unit(Math.max(finite(geometry.edgeHardness), finite(geometry.angularity)));
    const r = this.response, excitation = unit(finite(view.excitation)), shimmer = unit(finite(view.shimmer));
    if (this.fresh) {
      // The first frame takes the world as it is: a scene that is mounted does not fade its motion in.
      this.travel.rate = rate; this.tension = tension; this.disorder = disorder; this.spin = spin; this.lean = lateral; this.ridge = sharp;
      this.ring = excitation; this.stir = shimmer;
      this.gate.prime(strainOf(tension, disorder)); this.aperture = this.gate.aperture;
      this.fresh = false;
    }

    // ---- travel: the world's distance, followed; the mesh slides over the lattice by whole rows ----
    const distance = Math.max(0, this.travel.step(h, rate, TRAVEL_TAU));
    this.speed = h > 0 ? distance / h : 0;
    this.position = (this.position + distance / p.cell) % PERIOD;
    v.row = Math.floor(this.position); v.shift = this.position - v.row;
    // The viewer follows the valley: the mesh slides sideways over the lattice too, by whole columns.
    const across = terrainMeander(this.position + BEHIND) / p.cell;
    v.col = Math.floor(across); v.shiftX = across - v.col;
    this.spin = follow(this.spin, spin, Math.exp(-h / BANK_TAU));
    this.lean = follow(this.lean, lateral, Math.exp(-h / LEAN_TAU));
    this.bank = -BANK * this.spin;
    v.lean = this.lean;

    // ---- what the ground holds: terraces, the throat, the plates ----
    this.tension = follow(this.tension, tension, Math.exp(-h / TENSION_TAU));
    this.disorder = follow(this.disorder, disorder, Math.exp(-h / DISORDER_TAU));
    const strain = strainOf(this.tension, this.disorder);
    this.aperture = this.gate.step(h, strain);
    const release = unit(2 * finite(view.releaseStrength)) * (view.releaseAge >= 0 && Number.isFinite(view.releaseAge) ? Math.exp(-view.releaseAge / RELEASE_TIME) : 0);
    // While a release is passing it is the event: an accent beside it would be a second one.
    const held = this.events.value(ACCENT_TIME) * (1 - unit(2 * release));
    // An accent that has faded is over: the plates come to rest, they do not settle for ever.
    this.accent = held < ARRIVED ? 0 : held;
    const lifted = unit(0.9 * strain * this.aperture + 0.7 * this.accent + 0.6 * release);
    v.terrace = ramp(this.tension, TERRACE);
    v.throat = ramp(this.tension, THROAT);
    v.lift = LIFT * p.relief * lifted;
    v.release = release;
    v.front = Number.isFinite(view.releaseAge) && view.releaseAge >= 0 ? Math.min(FAR, FRONT_SPEED * view.releaseAge) : FAR;
    v.bulge = BULGE * p.relief;
    this.structure.update(view);
    const after = CONFIGURATIONS[this.structure.current], before = CONFIGURATIONS[this.structure.previous];
    v.plateAfter = after[0]; v.stepsAfter = after[1]; v.plateBefore = before[0]; v.stepsBefore = before[1];

    // ---- the registers: lows raise the relief and ring the finer octave, mids fold the crests, highs stir the surface ----
    // The intermediate scale: the groove and the activity of the highs, followed over their times; a kick or a hat is not the landscape's.
    this.ring = r.groove > 0 ? follow(this.ring, excitation, Math.exp(-h / r.groove)) : excitation;
    this.stir = r.surface > 0 ? follow(this.stir, shimmer, Math.exp(-h / r.surface)) : shimmer;
    v.relief = p.relief * (1 + SWELL * r.lows * clamp(finite(view.pressure), -0.6, 0.9));
    v.crest = 1 + RING * r.lows * this.ring;
    this.ridge = follow(this.ridge, unit(sharp * r.mids * (1 - YIELD * lifted)), Math.exp(-h / FORM_TAU));
    v.ridge = this.ridge;
    v.quake = QUAKE * p.roughness * r.highs * this.stir;
    v.wave = p.wave;
    for (const key of KEYS) if (!Number.isFinite(v[key])) v[key] = REST[key];
    return v;
  }

  /** Nothing of the last frames holds: the next one starts from the world as it is. The ground travelled is kept. */
  reset(): void {
    this.fresh = true;
    this.travel.reset(); this.gate.reset(); this.events.reset(); this.structure.reset();
    this.tension = this.disorder = this.spin = this.lean = this.ridge = this.aperture = this.accent = this.speed = this.bank = this.ring = this.stir = 0;
    this.lastTime = -Infinity;
  }
}

const REST = createTerrain();
const KEYS = Object.keys(REST) as (keyof TerrainValues)[];
