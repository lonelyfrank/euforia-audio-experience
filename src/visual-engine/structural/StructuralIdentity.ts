import { unit } from './StructuralTypes';

/*
 * The stable physical identity of an element. It is not stored: it is a pure
 * function of the world's seed, the element's number and its population, so
 * ten elements or a million have one without a buffer, and the same seed is
 * always the same matter. Every property is a continuous function of the
 * element's place on the frequency axis (its natural resonance) and of a few
 * independent draws: there are no kinds of particle, only a distribution.
 *
 *   low resonance    heavy, slow, hard to break, weakly carried by the flow
 *   middle           selective, binds readily: structural matter
 *   high             light, fast, carried by every eddy
 *   very high        short-lived detail that takes the micro excitation
 */

/** A population: where on the frequency axis its matter sits and how widely it is spread. */
export interface Population {
  /** Number of the population (mixed into every draw). */
  id: number;
  /** Centre of its natural resonance on the axis (0 = 20 Hz … 1 = 20 kHz) and half-width of the spread. */
  centre: number;
  spread: number;
}

export interface Identity {
  /** Natural resonance on the frequency axis, 0..1. */
  f0: number;
  /** Selectivity 0 (answers a broad range) … 1 (a narrow one): the Q of its resonance. */
  q: number;
  /** Inertia (1 = middle matter). */
  mass: number;
  /** Internal friction: the damping ratio of the bonds it takes part in. */
  damping: number;
  /** How far the medium carries it, 0..1. */
  coupling: number;
  /** How readily it bonds, 0..1. */
  bondAffinity: number;
  /** How much stress its bonds bear (1 = middle matter). */
  resistance: number;
  /** How ordered a structure it tends to: 0 a triangle … 1 a hexagon. */
  structuralAffinity: number;
  /** How long it keeps what happened to it, 0..1 (very fine matter forgets fast). */
  persistence: number;
  /** Its own number 0..1 (phases, placement). */
  seed: number;
}

export const createIdentity = (): Identity => ({ f0: 0.5, q: 0.5, mass: 1, damping: 0.25, coupling: 0.7, bondAffinity: 0.5, resistance: 1, structuralAffinity: 0.5, persistence: 1, seed: 0 });

/** Masses at the two ends of the axis: a factor of about nine between the heaviest and the finest matter. */
export const MASS_LOW = 3.2;
export const MASS_HIGH = 0.35;

/** A well-mixed 32-bit hash of three integers (lowbias32 finaliser): exact in integer arithmetic, so a shader computes the same bits. */
export function hash32(seed: number, id: number, channel: number): number {
  let h = (seed ^ Math.imul(id, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca77)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** A draw in [0, 1) from the top 24 bits: exactly representable in a float32. */
export const draw = (seed: number, id: number, channel: number): number => (hash32(seed, id, channel) >>> 8) / 16777216;

const bell = (x: number, centre: number, width: number): number => Math.exp(-((x - centre) / width) * ((x - centre) / width));
const smoothstep = (a: number, b: number, x: number): number => {
  const t = unit((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** The identity of element `id` of a population in a world of this seed. Writes and returns `out`. */
export function identityOf(seed: number, id: number, population: Readonly<Population>, out: Identity): Identity {
  const s = (seed ^ Math.imul(population.id + 1, 0x632be5ab)) >>> 0;
  // Two draws make a triangular spread about the centre: most of a population is near its pitch, some of it far.
  const f0 = unit(population.centre + population.spread * (draw(s, id, 0) + draw(s, id, 1) - 1));
  out.f0 = f0;
  out.mass = MASS_LOW * Math.pow(MASS_HIGH / MASS_LOW, f0) * (0.85 + 0.3 * draw(s, id, 2));
  out.q = unit(0.2 + 0.65 * bell(f0, 0.45, 0.35) + 0.3 * (draw(s, id, 3) - 0.5));
  out.coupling = unit((0.3 + 0.7 * Math.pow(f0, 0.7)) * (0.85 + 0.3 * draw(s, id, 4)));
  out.bondAffinity = unit((0.2 + 0.8 * bell(f0, 0.45, 0.3)) * (0.8 + 0.2 * draw(s, id, 5)));
  out.resistance = (1.25 - 0.75 * f0) * (0.8 + 0.4 * draw(s, id, 6));
  out.structuralAffinity = unit(bell(f0, 0.4, 0.35) * (0.7 + 0.6 * draw(s, id, 7)));
  out.damping = 0.15 + 0.25 * f0 + 0.1 * (draw(s, id, 8) - 0.5);
  out.persistence = 1 - 0.8 * smoothstep(0.78, 1, f0);
  out.seed = draw(s, id, 9);
  return out;
}
