import { unit } from '../../experience/types';
import { seedOf } from '../../show/rng';
import { clamp, finite, follow, RateFollower } from '../../visualizers/shared/motion';
import { Reorganization } from '../../world/Reorganization';
import { REST_WORLD } from '../../world/WorldState';
import type { WorldView } from '../../world/WorldView';
import type { GeometryState } from '../geometry/GeometryState';
import { createOcean, GRAIN_PERIOD, GROOVES, SWELLS, WAVES, type OceanValues } from './oceanLaw';

/*
 * How the sea moves and what the world does to it: Pulse Ocean's reading of the shared world, as TerrainMotion is the
 * terrain's. It decides nothing musical and has no time of its own: every value is the world's, followed exactly over a
 * frame, or the age of a dated release; the waves' own time is what the music has lived (an exact integral of how
 * alive the world is, zero at rest), so in silence the sea slows, flattens and stands still.
 *
 *   swell     the persistent energy and the structure: openness, pressure, stored potential, excitation, over seconds
 *   groove    the lows' groove (the world's excitation over `groove` s): the middle waves; hard-edged mids peak them
 *   ripple    the highs' activity (the shimmer over `surface` s): the short waves on the surface
 *   release   a front running away from the viewer, and a new configuration of the sea behind it (which waves lead)
 *
 * The three scales are kept apart and bounded (their heights are the scene's), the waves of each scale travel at
 * their own speed (shorter ones faster, as on water), and their directions are fixed: a release changes how much each
 * one counts (CONFIGURATIONS), crossfaded over seconds of its own age, never their direction (a turned sea would sweep).
 */

export interface OceanParams {
  seed: number;
  /** Size of a cell (units), and the mesh in cells: columns across, rows into the distance. */
  cell: number;
  columns: number;
  rows: number;
  /** The viewer above the still sea (units) and how far it looks down (rad). */
  height: number;
  pitch: number;
  /** Heights of the three scales at full drive (units), and how far a unit wave front lifts the sea. */
  swell: number;
  groove: number;
  ripple: number;
  wave: number;
  /** Fog per unit of depth and light of the lines. */
  fog: number;
  exposure: number;
  /** How the registers reach the sea: gains (0 … 2) and the times the groove and the surface are followed over (s). */
  response?: Partial<OceanResponse>;
}

export interface OceanResponse { lows: number; mids: number; highs: number; groove: number; surface: number }
export const DEFAULT_OCEAN_RESPONSE: Readonly<OceanResponse> = { lows: 1, mids: 1, highs: 1, groove: 0.6, surface: 0.25 };
const bound = (x: unknown, lo: number, hi: number, fallback: number): number => typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
export function oceanResponse(r: Partial<OceanResponse> = {}): OceanResponse {
  const d = DEFAULT_OCEAN_RESPONSE;
  return { lows: bound(r.lows, 0, 2, d.lows), mids: bound(r.mids, 0, 2, d.mids), highs: bound(r.highs, 0, 2, d.highs), groove: bound(r.groove, 0, 4, d.groove), surface: bound(r.surface, 0, 4, d.surface) };
}

/** The waves: length (cells) and direction (rad from straight towards the viewer), swell first, then groove, then ripple. */
export const WAVE_SHAPES: readonly (readonly [length: number, angle: number])[] = [
  [48, -0.35], [34, 0.45],
  [14, -0.2], [10, 0.55], [8, 0.1],
  [4, -0.8], [3, 0.9],
];
/** How fast waves travel: ω = √(G k) per unit of lived time (k in radians per cell), as deep water does. */
const G = 4.7;
/** What each release may leave: how much each wave counts. The first is the canonical sea. */
export const CONFIGURATIONS: readonly (readonly number[])[] = [
  [1, 0.4, 1, 0.6, 0.4, 1, 0.6],
  [0.4, 1, 0.5, 1, 0.6, 0.6, 1],
  [0.8, 0.8, 0.7, 0.4, 1, 1, 1],
  [1, 0.2, 0.4, 1, 0.8, 0.8, 0.5],
  [0.3, 1, 1, 0.8, 0.3, 0.5, 1],
];
/** Seconds of a release's age over which the sea goes from one configuration to the next. */
const BLEND = 3;
/** Follow times (s) of the swell's drive and of the peaking of the crests; of the sea's liveliness. */
const SWELL_TAU = 3;
const CHOP_TAU = 0.6;
const LIFE_TAU = 1.5;
/** Speed of a release front (units/s), how long it presses (s), and how high it is (× the swell's height). */
export const FRONT_SPEED = 45;
const RELEASE_TIME = 2.2;
const BULGE = 1.6;

const smooth = (x: number): number => { const t = unit(x); return t * t * (3 - 2 * t); };

export class OceanMotion {
  readonly values: OceanValues = createOcean();
  /** The waves as the shader binds them: (kx, kz, phase at the mesh's origin, amplitude) each. */
  readonly swell = new Float32Array(WAVES * 4);
  readonly response: OceanResponse;
  /** The three levels as followed (0..1), and how alive the sea is (0..1). */
  drive = 0;
  ring = 0;
  stir = 0;
  life = 0;
  /** The sea travelled (rows, unwrapped) and across (columns); the waves' lived time per scale. */
  position = 0;
  across = 0;
  private readonly lived = [new RateFollower(), new RateFollower(), new RateFollower()];
  private readonly time = new Float64Array(3);
  private readonly k = new Float64Array(WAVES * 2);
  private readonly omega = new Float64Array(WAVES);
  private readonly offset = new Float64Array(WAVES);
  private readonly structure = new Reorganization(CONFIGURATIONS.length, 0x6f6365);
  private fresh = true;
  private lastTime = -Infinity;

  constructor(private readonly params: OceanParams) {
    this.response = oceanResponse(params.response);
    const v = this.values, seed = seedOf(params.seed, 0x6f6365);
    v.cell = params.cell; v.wave = params.wave; v.seed = seed % 97;
    WAVE_SHAPES.forEach(([length, angle], n) => {
      const magnitude = (2 * Math.PI) / length;
      this.k[n * 2] = magnitude * Math.sin(angle); this.k[n * 2 + 1] = -magnitude * Math.cos(angle);
      this.omega[n] = Math.sqrt(G * magnitude);
      // Each wave starts at its own phase: the same seed is the same sea.
      this.offset[n] = 2 * Math.PI * (((seed >>> (n * 3)) % 97) / 97);
    });
  }

  /** Which scale a wave belongs to: 0 swell, 1 groove, 2 ripple. */
  static scaleOf(n: number): number { return n < SWELLS ? 0 : n < SWELLS + GROOVES ? 1 : 2; }

  /**
   * One frame. `advance`: how far the observer glided forwards this frame (units), `across` how far it stands to the
   * side (units, the sea does not slide sideways for it). Must not allocate.
   */
  step(dt: number, view: Readonly<WorldView>, geometry: Readonly<GeometryState>, advance: number): OceanValues {
    const v = this.values, p = this.params, r = this.response, world = view.world, h = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.25) : 0;
    if (world === REST_WORLD || world.time < this.lastTime - 1) this.reset();
    this.lastTime = world === REST_WORLD ? -Infinity : world.time;
    const openness = unit(finite(view.openness)), pressure = unit(1.5 * finite(view.pressure)), tension = unit(finite(view.tension));
    const excitation = unit(finite(view.excitation)), shimmer = unit(finite(view.shimmer));
    const drive = unit(0.3 * openness + 0.25 * pressure + 0.3 * tension + 0.35 * excitation);
    const chop = unit(Math.max(finite(geometry.edgeHardness), finite(geometry.angularity)) * r.mids);
    if (this.fresh) {
      this.drive = drive; this.ring = excitation; this.stir = shimmer; this.values.chop = chop;
      this.life = unit(2 * Math.max(drive, excitation, shimmer));
      for (let s = 0; s < 3; s++) this.lived[s].rate = this.life;
      this.fresh = false;
    }

    // ---- the levels of the three scales, followed over their own times ----
    this.drive = follow(this.drive, drive, Math.exp(-h / SWELL_TAU));
    this.ring = r.groove > 0 ? follow(this.ring, excitation, Math.exp(-h / r.groove)) : excitation;
    this.stir = r.surface > 0 ? follow(this.stir, shimmer, Math.exp(-h / r.surface)) : shimmer;
    v.chop = follow(v.chop, chop, Math.exp(-h / CHOP_TAU));
    // How alive the sea is: what the waves' own time runs at. Zero at rest, so a silent sea stands still.
    const alive = unit(2 * Math.max(drive, excitation, shimmer));
    for (let s = 0; s < 3; s++) this.time[s] += this.lived[s].step(h, alive, LIFE_TAU);
    this.life = this.lived[0].rate;

    // ---- the sea travelled: the mesh slides over the lattice by whole rows ----
    this.position += Math.max(0, finite(advance)) / p.cell;
    const row = Math.floor(this.position);
    v.shift = this.position - row; v.shiftX = 0; v.row = row % GRAIN_PERIOD;

    // ---- a release: its front, and the configuration it leaves (by its own audio time) ----
    this.structure.update(view);
    const after = CONFIGURATIONS[this.structure.current], before = CONFIGURATIONS[this.structure.previous];
    const mixed = Number.isFinite(this.structure.age) ? smooth(this.structure.age / BLEND) : 1;
    const release = unit(2 * finite(view.releaseStrength)) * (view.releaseAge >= 0 && Number.isFinite(view.releaseAge) ? Math.exp(-view.releaseAge / RELEASE_TIME) : 0);
    v.release = release;
    v.front = Number.isFinite(view.releaseAge) && view.releaseAge >= 0 ? Math.min(1e4, FRONT_SPEED * view.releaseAge) : 1e4;
    v.bulge = BULGE * p.swell;

    // ---- the waves: direction fixed, phase at the mesh's origin in double precision, amplitude of their scale ----
    const swell = p.swell * this.drive, groove = p.groove * this.ring * r.lows, ripple = p.ripple * this.stir * r.highs;
    const col = Math.floor(this.across);
    for (let n = 0; n < WAVES; n++) {
      const s = OceanMotion.scaleOf(n), kx = this.k[n * 2], kz = this.k[n * 2 + 1], weight = before[n] + (after[n] - before[n]) * mixed;
      const phase = kx * col + kz * row - this.omega[n] * this.time[s] + this.offset[n];
      const o = n * 4;
      this.swell[o] = kx; this.swell[o + 1] = kz; this.swell[o + 2] = phase - 2 * Math.PI * Math.floor(phase / (2 * Math.PI));
      this.swell[o + 3] = clamp((s === 0 ? swell : s === 1 ? groove : ripple) * weight, 0, 4 * Math.max(p.swell, p.groove, p.ripple));
    }
    return v;
  }

  /** A new session: the followers start over from the world as it is; the sea travelled and its waves' time are kept. */
  reset(): void {
    this.fresh = true; this.lastTime = -Infinity;
    this.drive = this.ring = this.stir = this.life = 0;
    this.structure.reset();
    for (const l of this.lived) l.reset();
  }
}
