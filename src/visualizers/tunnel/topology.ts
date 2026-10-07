import { unit } from '../../experience/types';
import type { WorldView } from '../../world/WorldView';

/*
 * What the world's forces do to the tunnel's architecture. The tunnel is a
 * wall round a path; this says how far that wall has come apart, into what,
 * and where the last release is on its way down it. A pure function of the
 * world view: no state, no time of its own, so it is the same at any frame
 * rate and rests when the world does (every value 0: the plain corridor).
 */
export interface TunnelTopology {
  /** Gaps between the rings along the tunnel and between the panels round it, as a share of a cell (0 = one continuous wall). */
  gapAxial: number;
  gapAngular: number;
  /** How far panels float off the wall (× radius) and how far rings turn against each other (turns). */
  lift: number;
  shear: number;
  /** 0 = a round section … 1 = a polygon. */
  facet: number;
  /** How far stored potential narrows the tunnel ahead (share of its radius at the far end). */
  throat: number;
  /** The last release: how far down the tunnel its front is (units from the viewer) and how strong it still is (0..1). */
  front: number;
  release: number;
}

export const createTopology = (): TunnelTopology => ({ gapAxial: 0, gapAngular: 0, lift: 0, shear: 0, facet: 0, throat: 0, front: FAR, release: 0 });

/** Speed of a release front down the tunnel (units/s) and how long its pressure lasts (s). */
export const FRONT_SPEED = 42;
const RELEASE_TIME = 1.6;
/** Seconds a strong impact holds the rings apart. */
const HIT_TIME = 0.35;
/** A front that has left the tunnel (or never was): beyond every depth, and still a finite uniform. */
const FAR = 1e4;

/** The structures a release can leave behind: sides of the section, panels round the wall, length of a ring (units). The first is the canonical one. */
export const CONFIGURATIONS: readonly (readonly [sides: number, panels: number, ring: number])[] = [
  [6, 12, 8], [4, 8, 10], [5, 10, 6], [8, 8, 12], [3, 9, 7], [7, 7, 9], [6, 6, 5],
];

const decay = (age: number, time: number): number => (age >= 0 && Number.isFinite(age) ? Math.exp(-age / time) : 0);

export function tunnelTopology(out: TunnelTopology, view: Readonly<WorldView>): TunnelTopology {
  const tension = unit(view.tension), disorder = unit(view.disorder), spin = Math.min(1, Math.abs(view.spin));
  const hit = unit(view.impulseStrength) * decay(view.impulseAge, HIT_TIME);
  const release = unit(2 * view.releaseStrength) * decay(view.releaseAge, RELEASE_TIME);
  // A wall cracks under the potential it holds (slowly at first, then quickly) and under disorder; a calm world is whole.
  const crack = unit(1.2 * tension * tension + 0.9 * disorder - 0.2);
  // Rings pull apart along the tunnel with tension and with every strong impact; the long cuts need shear: disorder or torsion.
  out.gapAxial = 0.36 * unit(0.8 * crack + 0.35 * hit + 0.5 * release);
  out.gapAngular = 0.28 * unit(crack * (0.3 + 0.7 * Math.max(disorder, spin)) + 0.3 * release);
  out.lift = 0.2 * unit(0.9 * disorder + 0.5 * crack + 0.6 * release);
  out.shear = 0.08 * unit(crack + release) * (0.4 + 0.6 * spin) * (view.spin < 0 ? -1 : 1);
  // Held potential makes the architecture hard-edged and draws the far tunnel in.
  out.facet = unit(1.5 * tension + 0.8 * release);
  out.throat = 0.45 * tension;
  out.front = Number.isFinite(view.releaseAge) && view.releaseAge >= 0 ? Math.min(FAR, FRONT_SPEED * view.releaseAge) : FAR;
  out.release = release;
  for (const key of KEYS) if (!Number.isFinite(out[key])) out[key] = REST[key];
  return out;
}

const REST = createTopology();
const KEYS = Object.keys(REST) as (keyof TunnelTopology)[];
