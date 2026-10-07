import { unit } from '../../experience/types';
import { WELL_DEPTH } from '../../render-systems/fields/wells';
import type { WorldView } from '../../world/WorldView';

/*
 * How the particles of Particle Field organise themselves. They are not
 * steered one by one: they float in one standing potential with wells across
 * the axis (shells), round it (spokes) and along it (planes), and gather
 * where it is deep (render-systems/fields/wells.ts). Which wells are deep is
 * the world's doing, so the same particles are a cloud, shells, filaments
 * (shells × spokes, drawn out by the flight), helices (filaments wound by the
 * spin), sheets (planes), a lattice (all three) and everything between; a
 * release melts the potential and lets it set again with other orders.
 *
 * A pure function of the world view: no state and no time of its own, the
 * same at any frame rate. At rest the shells hold and every other well is
 * flat: the field as it always was.
 */
export interface ParticleRegimes {
  /** 0..1: how firmly the shells hold (0 = a loose cloud). */
  shell: number;
  /** Depth of the wells round the axis and along it (0 = none … WELL_DEPTH). */
  spokes: number;
  planes: number;
  /** Share of its radius stored potential draws the whole field in by. */
  collapse: number;
  /** Turns the core leads the rim by: the vortex winds what the spokes gathered. */
  wind: number;
  /** 0..1: how far the last release has melted the structure (it sets again as this falls). */
  melt: number;
  /** 0 = the particles are still where the structure before the last release had them … 1 = where the one after it has them. */
  reform: number;
  /** The world's last impact as a front travelling into the field: its place (0..1 of the depth) and its strength (0..1). */
  front: number;
  pulse: number;
}

export const createRegimes = (): ParticleRegimes => ({ shell: 1, spokes: 0, planes: 0, collapse: 0, wind: 0, melt: 0, reform: 1, front: 1, pulse: 0 });

/** The orders a release can leave behind: spokes round the axis, planes along the field's depth. The first is the canonical one. */
export const ORDERS: readonly (readonly [spokes: number, planes: number])[] = [[6, 14], [3, 10], [8, 18], [5, 8], [12, 22], [4, 16], [7, 12]];

/** A release melts the structure in about a tenth of a second and lets it set again over a couple of seconds. */
const MELT_ATTACK = 0.12;
const MELT_TIME = 1.8;
/** The particles take about a second to find the wells of the new structure, starting once the old one has let go. */
const REFORM_FROM = 0.15;
const REFORM_TO = 1.3;
/** Speed of an impact's front into the field (units/s) and how long it lasts (s). */
export const FRONT_SPEED = 70;
const FRONT_TIME = 0.9;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const elapsed = (age: number): boolean => age >= 0 && Number.isFinite(age);

/** `depth`: the depth of the field (units), for the impact front. */
export function particleRegimes(out: ParticleRegimes, view: Readonly<WorldView>, depth: number): ParticleRegimes {
  const coherence = unit(view.coherence), disorder = unit(view.disorder), tension = unit(view.tension), excitation = unit(view.excitation);
  const spin = Math.max(-1, Math.min(1, view.spin));
  const age = view.releaseAge;
  const melt = elapsed(age) ? unit(2 * view.releaseStrength) * (1 - Math.exp(-age / MELT_ATTACK)) * Math.exp(-age / MELT_TIME) : 0;
  // Order is the world holding together; disorder flattens every well.
  const order = smoothstep(0.3, 0.85, coherence) * (1 - 0.75 * disorder) * (1 - melt);
  out.shell = order;
  // Spokes need something to line the particles up: held potential, rotation or a struck, ringing world.
  out.spokes = WELL_DEPTH * order * unit(tension + 0.8 * Math.abs(spin) + 0.5 * excitation);
  // Planes stand where the world rings: excitation, and potential that stiffens it.
  out.planes = WELL_DEPTH * order * unit(1.2 * excitation + 0.5 * tension);
  out.collapse = 0.25 * tension;
  out.wind = 0.27 * spin;
  out.melt = melt;
  out.reform = elapsed(age) ? smoothstep(REFORM_FROM, REFORM_TO, age) : 1;
  const hit = view.impulseAge;
  out.front = elapsed(hit) && depth > 0 ? Math.min(1, FRONT_SPEED * hit / depth) : 1;
  out.pulse = elapsed(hit) ? unit(view.impulseStrength) * Math.exp(-hit / FRONT_TIME) : 0;
  for (const key of KEYS) if (!Number.isFinite(out[key])) out[key] = REST[key];
  return out;
}

const REST = createRegimes();
const KEYS = Object.keys(REST) as (keyof ParticleRegimes)[];
