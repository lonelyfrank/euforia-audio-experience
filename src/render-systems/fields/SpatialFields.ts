import { INTENT, unit, type VisualIntent } from '../../experience/types';
import type { WorldView } from '../../world/WorldView';
import type { VisualMaterial } from '../materials/VisualMaterial';

/*
 * WorldState → spatial fields. The world stays small (four bodies, seven
 * fields); this is where it becomes forces in space. Two kinds, in visual
 * units (1 = the rest radius of the matter):
 *   - flows: velocities the matter relaxes to through its drag (vortex,
 *     circulation, turbulence, surge, shimmer);
 *   - forces: accelerations (radial spring, structure, clumping, waves).
 * The music never writes a position: it changes these numbers, and the matter
 * integrates them (fields/fieldLaw.ts). A pure function of the world view, the
 * material character and the intents, so it is the same at any frame rate.
 */
export interface SpatialFields {
  /** Radius the matter is held at (rest 1): the world's pressure, drawn in by stored potential. */
  radius: number;
  /** Radial spring (1/s²): how firmly the matter keeps that radius. */
  stiffness: number;
  /** 0..1: loose volume (0) → layers gathered onto shells (1). */
  gather: number;
  /** Radial flow (units/s, + outwards): the world's radial velocity (a release arrives here as motion). */
  surge: number;
  /** Tangential flow about the axis (units/s, signed). */
  vortex: number;
  /** 0..0.9: how far rotation squashes the body towards its plane (a spinning cloud becomes a disc or rings). */
  flatten: number;
  /** Forward roll about the lateral axis (units/s): the world's travel carries the matter around, towards the viewer. */
  advection: number;
  /** Centre of the fields along x (the stereo origin of the world's forces) and lateral flow (units/s). */
  lateral: number;
  drift: number;
  /** Disordered, divergence-free flow (units/s) and its spatial frequency. */
  turbulence: number;
  turbulenceScale: number;
  /** Fine, fast micro-flow (units/s), taken mostly by high-affinity matter. */
  shimmer: number;
  /** Attraction onto the symmetric structure (1/s²), its angular order (continuous) and spiral winding. */
  cohesion: number;
  order: number;
  winding: number;
  /** Pull between neighbours along a strand (1/s²): what keeps filaments connected. */
  bond: number;
  /** Attraction into grains (1/s²) and the grains' spatial frequency. */
  clumping: number;
  clumpScale: number;
  /** Drag (1/s): the viscosity the flows act through and motion dies with. */
  drag: number;
  /** Ageing (1/s): matter dissolves and re-forms; 0 = it lasts. */
  lifetimeRate: number;
  /** Rate (1/s) the disordered fields evolve at; 0 in silence, so nothing drifts on its own. */
  phaseRate: number;
  /** Rotation of the structure (rad): the world's accumulated angle as this layer sees it. */
  turn: number;
  /** Spring (1/s²) onto the form an element is claimed by (forms/formLaw.ts): how firmly matter keeps a shape it takes. */
  form: number;
}

export const createFields = (): SpatialFields => ({
  radius: 1, stiffness: 0, gather: 0, surge: 0, vortex: 0, flatten: 0, advection: 0, lateral: 0, drift: 0,
  turbulence: 0, turbulenceScale: 1, shimmer: 0, cohesion: 0, order: 2, winding: 0, bond: 0, clumping: 0, clumpScale: 4,
  drag: 2, lifetimeRate: 0, phaseRate: 0, turn: 0, form: 20,
});

const weight = (intents: readonly VisualIntent[] | undefined, index: number): number =>
  intents ? intents[index].strength * intents[index].confidence : 0;
const clamp = (x: number, lo: number, hi: number): number => (x > hi ? hi : x > lo ? x : lo);

/**
 * The fields the world asks for right now. Intents are force components
 * weighted by strength × confidence, never branches. Every output is finite
 * and bounded for any input (non-finite inputs fall to the nearest bound).
 */
export function deriveFields(out: SpatialFields, view: Readonly<WorldView>, material: Readonly<VisualMaterial>, intents?: readonly VisualIntent[]): SpatialFields {
  const expand = weight(intents, INTENT.expand) - weight(intents, INTENT.contract);
  const rotate = weight(intents, INTENT.rotate);
  const accelerate = weight(intents, INTENT.accelerate);
  const decelerate = weight(intents, INTENT.decelerate);
  const fragment = weight(intents, INTENT.fragment);
  const cohere = weight(intents, INTENT.cohere);
  const suspend = weight(intents, INTENT.suspend);
  const dissolve = weight(intents, INTENT.dissolve);
  const tension = unit(view.tension), coherence = unit(view.coherence), disorder = unit(view.disorder);
  const spin = clamp(view.spin, -1, 1), speed = unit(view.speed);
  const held = 1 - 0.6 * suspend;

  // Pressure opens the matter, stored potential draws it in (the world's radius already carries both; the
  // direct term makes the accumulation legible before the slow radial body has moved).
  out.radius = clamp(1 + 0.45 * view.pressure + 0.1 * unit(view.openness) - 0.22 * tension + 0.12 * expand, 0.45, 1.7);
  out.stiffness = 3 + 26 * material.rigidity * material.rigidity;
  out.gather = unit(0.9 * tension + 0.8 * Math.max(0, coherence - 0.5) + 0.3 * cohere - 0.6 * material.fragmentation);
  out.surge = clamp(view.surge, -2.5, 2.5) * 0.5 * held;
  out.vortex = spin * 1.6 * (1 + 0.5 * rotate) * held;
  out.flatten = Math.min(0.9, 2.5 * Math.abs(spin) * (1 - material.fragmentation));
  out.advection = speed * 1.1 * (1 + 0.6 * accelerate) * held;
  out.lateral = clamp(view.lateral, -1, 1) * 0.45;
  out.drift = clamp(view.world.biasVelocity, -2, 2) * 0.3 * held;
  // A held state of potential conserves energy: less dispersion while it charges.
  out.turbulence = Math.min(1.2, (disorder * (0.25 + 0.9 * (1 - 0.6 * tension)) + 0.3 * fragment) * held);
  out.turbulenceScale = 1.3 + 2.2 * material.granularity;
  out.shimmer = unit(view.shimmer) * 0.5;
  const together = coherence * (1 - material.fragmentation) * (1 - 0.6 * fragment);
  // No symmetry, no structure to gather on: in silence the matter is left where it is, it does not organise itself.
  out.cohesion = Math.min(14, material.symmetry * together * 12 + 4 * cohere);
  out.order = 2 + 3 * unit(view.openness);
  out.winding = 2.5 * spin + 1.5 * tension;
  out.bond = 30 * together * (0.4 + 0.6 * material.rigidity);
  out.clumping = 9 * material.fragmentation + 3 * fragment;
  out.clumpScale = 3 + 5 * material.granularity;
  out.drag = clamp(2.4 - 1.2 * material.fluidity + 1.5 * tension + 2.5 * decelerate + 3 * suspend, 0.9, 8);
  out.lifetimeRate = Math.min(1, 0.05 * disorder + 0.5 * dissolve);
  out.phaseRate = 0.35 * speed + 0.25 * disorder + 0.2 * unit(view.excitation);
  out.turn = Number.isFinite(view.turn) ? view.turn : 0;
  // A rigid material snaps onto its form and rings there; a loose one drifts to it.
  out.form = 16 + 44 * material.rigidity;
  for (const key of KEYS) if (!Number.isFinite(out[key])) out[key] = REST[key];
  return out;
}

const REST = createFields();
const KEYS = Object.keys(REST) as (keyof SpatialFields)[];
