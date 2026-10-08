import type { StructuralState } from './StructuralState';
import { LIFECYCLE, MEMORY_SLOTS, ROLE, ROLE_COUNT, unit, type StructuralEnvironment, type StructuralTuning } from './StructuralTypes';

/*
 * Regimes, roles and lifecycle: the continuous variables an element's
 * behaviour follows from. There is no state machine: order and temperature
 * are followed quantities, cohesion is integrated, roles are weights, and the
 * lifecycle is only a name read off them for the development tools.
 *
 *   order        how far the neighbourhood holds together: the world's
 *                coherence and harmony, neighbours moving the same way and
 *                resonating alike, less what agitates it
 *   temperature  local activity: velocity against the flow and against the
 *                neighbours, turbulence, a release, a fresh fracture
 *
 *   hot  + disordered   a chaotic cloud, debris
 *   cold + disordered   an amorphous cluster
 *   cold + ordered      stable structure: bonds form and hold
 *   hot  + ordered      coherent flow: matter moves together without settling
 *
 * None of these is a branch. Order strengthens bonds and lets cohesion grow,
 * temperature loads bonds and holds cohesion back, and what forms or breaks
 * follows from that.
 */

/** Speeds (units/s): a typical agitated element, and the drift against the flow below which an element is settled. */
export const V_REF = 0.6;
const V_STABLE = 0.5;
/** Order builds over about a second and is lost faster; activity is felt at once and cools slowly (s). */
const ORDER_RISE = 1;
const ORDER_FALL = 0.35;
const HEAT_RISE = 0.12;
const HEAT_FALL = 1;
/** Cohesion: readiness below which nothing settles, how fast full readiness settles an element (1/s) and how fast it is lost. */
const READY = 0.15;
const SETTLING = 1.6;
const UNSETTLING = 0.6;
export const COHESION_MAX = 1.5;
/** Roles follow their conditions over these times (s), and the leading role changes only past this margin. */
const ROLE_RISE = 0.35;
const ROLE_FALL = 0.7;
const ROLE_MARGIN = 0.08;

const tendency = new Float64Array(ROLE_COUNT);

/** How settled an element is in the medium: 1 at rest in the flow, falling as it drifts against it. */
export const stabilityOf = (peculiar: number): number => 1 / (1 + (peculiar / V_STABLE) * (peculiar / V_STABLE));

/**
 * Order and temperature of element `i` over `dt`: `peculiar` is its speed
 * against the medium, `spread` the RMS speed of its neighbours against it.
 */
export function stepRegime(s: StructuralState, i: number, env: Readonly<StructuralEnvironment>, tuning: Readonly<StructuralTuning>, dt: number, peculiar: number, spread: number): void {
  const agitation = unit(0.6 * spread / V_REF + 0.3 * peculiar / V_REF);
  const heat = tuning.temperature === null
    ? unit(agitation + 0.5 * unit(env.turbulence) + 0.6 * unit(env.release) + 0.35 * s.shock[i])
    : unit(tuning.temperature);
  const t = s.temperature[i];
  s.temperature[i] = heat + (t - heat) * Math.exp(-dt / (heat > t ? HEAT_RISE : HEAT_FALL));
  // What the world offers (coherence, the more so the more harmonic the sound) and what the neighbourhood makes of it.
  const offered = unit(tuning.coherence === null ? env.coherence : tuning.coherence) * (0.6 + 0.4 * unit(env.harmony));
  const local = 0.4 + 0.3 * s.alignment[i] + 0.3 * s.agreement[i];
  const order = unit(1.25 * offered * local * (1 - 0.8 * s.temperature[i]));
  const o = s.order[i];
  s.order[i] = order + (o - order) * Math.exp(-dt / (order > o ? ORDER_RISE : ORDER_FALL));
}

/**
 * Cohesion of element `i`: it settles while it is ordered, cold, at rest in
 * the medium and of matter that binds, and only in a living world (silence
 * finishes what has settled; it settles nothing new). A fresh fragment does
 * not settle at once.
 */
export function stepCohesion(s: StructuralState, i: number, env: Readonly<StructuralEnvironment>, dt: number, stability: number): void {
  const ready = s.order[i] * (1 - s.temperature[i]) * stability * (0.4 + 0.6 * s.bondAffinity[i]) * (1 - 0.8 * s.shock[i]);
  const rate = ready > READY ? SETTLING * (ready - READY) / (1 - READY) * unit(3 * env.energy) : -UNSETTLING * (READY - ready) / READY;
  s.cohesion[i] = Math.min(COHESION_MAX, Math.max(0, s.cohesion[i] + rate * dt));
}

/** Role weights of element `i` over `dt` (`speed`: its own, units/s), and its leading role with hysteresis. */
export function stepRoles(s: StructuralState, i: number, dt: number, stability: number, speed: number): void {
  const hasSpan = s.span[i] >= 0, hasJoint = s.joints[i] > 0, bonded = hasSpan || hasJoint;
  const order = s.order[i], shock = s.shock[i];
  const w = tendency;
  // Stable, ordered matter is a node in waiting; a weld makes it one.
  w[ROLE.node] = (hasJoint ? 1 : 0.25) * order * stability * (0.4 + 0.6 * s.density[i]);
  w[ROLE.edge] = hasSpan ? (0.35 + 0.65 * (1 - unit(s.stress[i]))) * (hasJoint ? 0.6 : 1) : 0;
  w[ROLE.surface] = s.loop[i] > 0 && s.loopOf[i] >= 0 ? order * (1 - s.temperature[i]) * s.loopPlanarity[s.loopOf[i]] : 0;
  w[ROLE.anchor] = unit((s.mass[i] - 1.2) / 1.6) * stability * (0.3 + 0.7 * order);
  w[ROLE.fragment] = shock;
  w[ROLE.tracer] = bonded ? 0 : s.coupling[i] * unit(speed / V_REF) * (1 - order);
  w[ROLE.free] = bonded ? 0.02 : (1 - shock) * (0.25 + 0.75 * (1 - order));
  let total = 0;
  for (let r = 0; r < ROLE_COUNT; r++) total += w[r];
  const at = i * ROLE_COUNT, up = 1 - Math.exp(-dt / ROLE_RISE), down = 1 - Math.exp(-dt / ROLE_FALL);
  let sum = 0;
  for (let r = 0; r < ROLE_COUNT; r++) {
    const target = total > 1e-6 ? w[r] / total : r === ROLE.free ? 1 : 0, held = s.roles[at + r];
    sum += s.roles[at + r] = held + (target - held) * (target > held ? up : down);
  }
  let lead = s.role[i], best = lead;
  for (let r = 0; r < ROLE_COUNT; r++) {
    s.roles[at + r] = sum > 1e-6 ? s.roles[at + r] / sum : r === ROLE.free ? 1 : 0;
    if (s.roles[at + r] > s.roles[at + best]) best = r;
  }
  // Another role takes the lead only once it is clearly ahead: roles do not flicker.
  if (best !== lead && s.roles[at + best] > s.roles[at + lead] + ROLE_MARGIN) lead = best;
  s.role[i] = lead;
}

/** The lifecycle of element `i` as its continuous state reads now; each threshold is lower on the way out than on the way in. */
export function readLifecycle(s: StructuralState, i: number, speed: number): number {
  const was = s.lifecycle[i];
  if (s.span[i] >= 0 || s.joints[i] > 0) return s.stress[i] > (was === LIFECYCLE.stressed ? 0.45 : 0.6) ? LIFECYCLE.stressed : LIFECYCLE.bound;
  if (s.shock[i] > (was === LIFECYCLE.fractured ? 0.3 : 0.5)) return LIFECYCLE.fractured;
  let memory = 0;
  for (let slot = 0; slot < MEMORY_SLOTS; slot++) memory = Math.max(memory, s.memStrength[i * MEMORY_SLOTS + slot]);
  if (memory > 0.2 && s.cohesion[i] > (was === LIFECYCLE.reforming ? 0.15 : 0.3)) return LIFECYCLE.reforming;
  if (s.cohesion[i] > (was === LIFECYCLE.cohering ? 0.15 : 0.3)) return LIFECYCLE.cohering;
  if (s.excitation[i] > (was === LIFECYCLE.excited ? 0.06 : 0.14)) return LIFECYCLE.excited;
  if (speed > (was === LIFECYCLE.free ? 0.04 : 0.1)) return LIFECYCLE.free;
  return LIFECYCLE.dormant;
}
