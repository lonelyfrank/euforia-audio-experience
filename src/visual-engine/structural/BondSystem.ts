import type { StructuralState } from './StructuralState';
import { JOINT, MAX_JOINTS, MEMORY_SLOTS, SPAN, unit, type StructuralConfig, type StructuralEnvironment, type StructuralTuning } from './StructuralTypes';

/*
 * Bonds: what holds a structure together, and how it lets go.
 *
 * A bond is a damped spring between two elements with a rest length, a
 * stiffness, a strength, an age, a load and an accumulated damage. Two kinds
 * differ only in their numbers: a span has a length (a wire), a joint has
 * almost none (the weld between the ends of two wires). Where two wires meet
 * in a joint, a brace between their far ends keeps the angle of the polygon
 * that matter tends to; with it a chain curls and closes by itself.
 *
 * Bonds form between compatible elements only (near enough, of like pitch,
 * moving together, settled, with room for one more bond) and break when their
 * load passes their strength or their damage is complete. Breaking frees the
 * bond, never the matter: both ends keep their position, their velocity,
 * their resonance and a memory of each other that fades, and that memory is
 * what lets a structure find itself again.
 *
 * All forces are central and pairwise, so a structure and each of its
 * fragments keep their linear and angular momentum.
 */

/** A joint at rest holds its two ends this far apart, and can be made between ends this near (units). */
export const JOINT_REST = 0.02;
export const JOINT_RANGE = 0.14;
/** A joint pulled this far beyond its rest bears its whole strength (units). */
const JOINT_SCALE = 0.16;
/** Spring constants (per unit mass, 1/s²) of wires, joints and braces. */
const K_SPAN = 260;
const K_JOINT = 320;
const K_BRACE = 110;
/** A joint takes this long to stiffen into a corner (s), and a brace answers no more than this much bending (units). */
const BRACE_SET = 1.5;
const BRACE_REACH = 0.12;
/** A bond is made at the length it is found at and settles to its own over this time (s). */
const SETTLE = 1;
/** Share of its length a wire breathes with the macro mode it follows. */
const BREATH = 0.06;

/** How much each cause loads a bond (1 = the strength of a joint of middle matter in an ordered world). */
const S_SPAN = 3;
const S_RATE = 0.5;
const V_BREAK = 1.5;
const S_MISMATCH = 0.6;
const S_VIBRATION = 0.25;
const S_TENSION = 0.35;
const S_HEAT = 0.3;
const S_RELEASE = 0.5;
/** Strength of a wire and of a joint (× the resistance of their matter). */
export const SPAN_STRENGTH = 1.7;
export const JOINT_STRENGTH = 1;
/** Above this share of its strength a bond tires (damage per second at full load); well below it, an ordered, cold world heals it. */
const FATIGUE = 0.55;
const DAMAGE_RATE = 1.2;
const HEALING = 0.08;
/** What a fracture leaves in the two ends: activity. */
const BREAK_HEAT = 0.3;

/** Elements of like pitch bond: width of the match on the frequency axis. Elements moving apart do not: units/s. */
const PITCH_MATCH = 0.12;
const SPEED_MATCH = 0.6;
/** Matter seeded as one structure prefers its own kind. */
const KINSHIP = 1.25;

/** Structural memory: how long a cold element remembers (s), how firmly it is drawn back (1/s² per unit) and from how far (units). */
export const MEMORY_TAU = 25;
const MEMORY_PULL = 5;
const MEMORY_MAX = 2;
const MEMORY_RANGE = 4;

/** What the bond pass reports. Reused. */
export interface BondEvents {
  /** Bonds broken in this step, and in all. */
  broken: number;
  fractures: number;
}

/** Stiffness the explicit step can carry for a pair of this reduced mass. */
const stable = (k: number, reduced: number, h: number): number => Math.min(k, 0.2 * reduced / (h * h));

/** A damped spring between `a` and `b`; `limit` bounds the extension it answers (a brace bends a chain, it does not snap it). */
function spring(s: StructuralState, acc: Float64Array, a: number, b: number, rest: number, k: number, zeta: number, h: number, limit = Infinity): void {
  const p = s.position, v = s.velocity;
  const dx = p[b * 3] - p[a * 3], dy = p[b * 3 + 1] - p[a * 3 + 1], dz = p[b * 3 + 2] - p[a * 3 + 2];
  const len = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-6);
  const ma = s.mass[a], mb = s.mass[b], reduced = ma * mb / (ma + mb), stiffness = stable(k, reduced, h);
  const along = ((v[b * 3] - v[a * 3]) * dx + (v[b * 3 + 1] - v[a * 3 + 1]) * dy + (v[b * 3 + 2] - v[a * 3 + 2]) * dz) / len;
  const stretch = len - rest, held = stretch > limit ? limit : stretch < -limit ? -limit : stretch;
  const f = (stiffness * held + 2 * zeta * Math.sqrt(stiffness * reduced) * along) / len;
  acc[a * 3] += dx * f / ma; acc[a * 3 + 1] += dy * f / ma; acc[a * 3 + 2] += dz * f / ma;
  acc[b * 3] -= dx * f / mb; acc[b * 3 + 1] -= dy * f / mb; acc[b * 3 + 2] -= dz * f / mb;
}

/**
 * One step of every bond: its force on its two ends (into `acc`,
 * accelerations), the brace of the angle where two wires meet, its load, its
 * damage, and its fracture when it can bear no more.
 */
export function stepBonds(s: StructuralState, acc: Float64Array, env: Readonly<StructuralEnvironment>, tuning: Readonly<StructuralTuning>, h: number, events: BondEvents): void {
  const p = s.position, v = s.velocity, resonance = env.resonance;
  const settle = 1 - Math.exp(-h / SETTLE), follow = 1 - Math.exp(-h / 0.05);
  const tension = unit(env.tension), release = unit(env.release), bear = Math.max(0.05, tuning.bondStrength * tuning.fractureThreshold);
  events.broken = 0;
  for (let i = 0; i < s.count; i++) s.stress[i] = 0;
  for (let at = 0; at < s.bondCapacity; at++) {
    if (!s.bondAlive[at]) continue;
    const a = s.bondA[at], b = s.bondB[at], span = s.bondSpan[at] === 1;
    s.bondRest[at] += (s.bondTarget[at] - s.bondRest[at]) * settle;
    s.bondAge[at] += h;
    const coupling = s.bondCoupling[at] * tuning.resonanceCoupling;
    // A wire breathes with one of the slow modes of the world: the large, global deformation of a structure.
    const rest = span && resonance ? s.bondRest[at] * (1 + BREATH * coupling * resonance.breath(s.phase[a])) : s.bondRest[at];
    spring(s, acc, a, b, rest, s.bondStiffness[at], s.bondDamping[at], h);
    const order = 0.5 * (s.order[a] + s.order[b]);
    if (!span) {
      // The two wires that meet in this joint hold the angle of the polygon their matter tends to.
      const wa = s.spanPartner(a), wb = s.spanPartner(b);
      if (wa >= 0 && wb >= 0 && wa !== wb) {
        const n = s.loop[a] > 0 ? s.loop[a] : 0.5 * (s.sides[a] + s.sides[b]), la = s.bondRest[s.span[a]], lb = s.bondRest[s.span[b]];
        const across = Math.sqrt(Math.max(0, la * la + lb * lb + 2 * la * lb * Math.cos(2 * Math.PI / Math.max(n, 3))));
        // A fresh joint is a hinge; it stiffens into a corner as it ages.
        const set = Math.min(1, s.bondAge[at] / BRACE_SET);
        spring(s, acc, wa, wb, across, K_BRACE * (0.25 + 0.75 * order) * set * set, 0.6, h, BRACE_REACH);
      }
    }

    const dx = p[b * 3] - p[a * 3], dy = p[b * 3 + 1] - p[a * 3 + 1], dz = p[b * 3 + 2] - p[a * 3 + 2];
    const len = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-6);
    const closing = ((v[b * 3] - v[a * 3]) * dx + (v[b * 3 + 1] - v[a * 3 + 1]) * dy + (v[b * 3 + 2] - v[a * 3 + 2]) * dz) / len;
    const strain = span ? S_SPAN * Math.abs(len - rest) / Math.max(rest, 0.05) : Math.max(0, len - rest) / JOINT_SCALE;
    // Ends that swing together load nothing; ends of unlike pitch pull against each other.
    const mismatch = Math.abs(s.vibration[a] - s.vibration[b]), swing = 0.5 * (s.excitation[a] + s.excitation[b]);
    const load = strain + S_RATE * Math.abs(closing) / V_BREAK + coupling * (S_MISMATCH * mismatch + S_VIBRATION * swing)
      + S_TENSION * tension + S_HEAT * 0.5 * (s.temperature[a] + s.temperature[b]) + S_RELEASE * release;
    const strength = s.bondStrength[at] * bear * (0.55 + 0.45 * order) * (1 - 0.5 * s.bondDamage[at]);
    const ratio = Number.isFinite(load) ? load / Math.max(strength, 1e-3) : 2;
    s.bondStress[at] += (Math.min(ratio, 2) - s.bondStress[at]) * follow;
    if (ratio > FATIGUE) {
      const over = (Math.min(ratio, 1) - FATIGUE) / (1 - FATIGUE);
      s.bondDamage[at] = Math.min(1, s.bondDamage[at] + DAMAGE_RATE * over * over * h);
    } else if (ratio < 0.4) s.bondDamage[at] = Math.max(0, s.bondDamage[at] - HEALING * order * (1 - 0.5 * (s.temperature[a] + s.temperature[b])) * h);
    if (ratio >= 1 || s.bondDamage[at] >= 1) {
      s.release(at);
      for (let end = 0; end < 2; end++) {
        const i = end === 0 ? a : b;
        s.shock[i] = 1; s.cohesion[i] = 0;
        s.temperature[i] = Math.min(1, s.temperature[i] + BREAK_HEAT);
      }
      events.broken++; events.fractures++;
      continue;
    }
    const shown = s.bondStress[at];
    if (shown > s.stress[a]) s.stress[a] = shown;
    if (shown > s.stress[b]) s.stress[b] = shown;
  }
}

/** Result of `walk`: wires along the chain from an end, and the element at its far end. Reused. */
const walked = { wires: 0, end: -1 };

/** Follows a chain from its end `i` (an element with a wire and a free joint): wire, joint, wire … */
function walk(s: StructuralState, i: number, limit: number): typeof walked {
  let e = s.spanPartner(i), wires = 1;
  while (e >= 0 && wires <= limit) {
    let through = -1;
    for (let k = 0; k < MAX_JOINTS && through < 0; k++) through = s.joint[e * MAX_JOINTS + k];
    if (through < 0) break;
    const next = s.other(through, e), far = s.spanPartner(next);
    if (far < 0) { e = next; break; }
    e = far; wires++;
  }
  walked.wires = wires; walked.end = e;
  return walked;
}

/**
 * Whether the ends `i` and `j` of two wires may be welded: both carry a wire
 * and have room for a joint, they are not the two ends of one wire, and the
 * result is a figure this matter can be (a closed polygon of at least three
 * sides, or a chain no longer than the largest one).
 */
export function canJoin(s: StructuralState, i: number, j: number, config: Readonly<StructuralConfig>): boolean {
  if (i === j || s.span[i] < 0 || s.span[j] < 0) return false;
  const most = Math.min(MAX_JOINTS, Math.max(1, config.maxJoints));
  if (s.joints[i] >= most || s.joints[j] >= most) return false;
  const pi = s.spanPartner(i), pj = s.spanPartner(j);
  if (pi === j || s.jointed(i, j) || s.jointed(pi, pj)) return false;
  if (most > 1) return true;
  const limit = Math.max(3, config.maxSides), mine = walk(s, i, limit), wires = mine.wires;
  if (mine.end === j) return wires >= 3 && wires <= limit;
  return wires + walk(s, j, limit).wires <= limit;
}

/** Whether `i` and `j` may be spanned by a wire: neither carries one yet. */
export const canSpan = (s: StructuralState, i: number, j: number): boolean => i !== j && s.span[i] < 0 && s.span[j] < 0;

/**
 * How well two elements suit each other for a bond of ideal length `ideal`,
 * 0..1 and a little above: near that length, of like pitch, moving together,
 * of matter that binds. Everything is continuous; nothing here decides alone.
 */
export function compatibility(s: StructuralState, i: number, j: number, distance: number, ideal: number, range: number): number {
  const v = s.velocity, away = (distance - ideal) / range, pitch = (s.f0[i] - s.f0[j]) / PITCH_MATCH;
  const dx = v[i * 3] - v[j * 3], dy = v[i * 3 + 1] - v[j * 3 + 1], dz = v[i * 3 + 2] - v[j * 3 + 2];
  const apart = (dx * dx + dy * dy + dz * dz) / (SPEED_MATCH * SPEED_MATCH);
  const kin = s.kin[i] >= 0 && s.kin[i] === s.kin[j] ? KINSHIP : 1;
  return Math.exp(-away * away - pitch * pitch) / (1 + apart) * Math.sqrt(s.bondAffinity[i] * s.bondAffinity[j]) * kin;
}

/** How strongly `i` remembers `j` in a slot (0 when it does not). */
export function remembered(s: StructuralState, i: number, j: number, slot: number): number {
  return s.memPartner[i * MEMORY_SLOTS + slot] === j ? s.memStrength[i * MEMORY_SLOTS + slot] : 0;
}

/**
 * Makes the bond between two compatible elements: a wire when `span`, a joint
 * otherwise. It starts at the length they are apart (nothing jumps) and
 * settles to its own: the length they remember, or the one their matter
 * prefers. Returns the bond, or −1.
 */
export function makeBond(s: StructuralState, i: number, j: number, span: boolean, distance: number): number {
  const slot = span ? SPAN : JOINT, memory = Math.max(remembered(s, i, j, slot), remembered(s, j, i, slot));
  const own = span ? 0.5 * (s.reach[i] + s.reach[j]) : JOINT_REST;
  const kept = remembered(s, i, j, slot) > 0 ? s.memRest[i * MEMORY_SLOTS + slot] : s.memRest[j * MEMORY_SLOTS + slot];
  const target = memory > 0.05 && kept > 0 ? kept : own;
  const resistance = 0.5 * (s.resistance[i] + s.resistance[j]);
  const at = s.bond(i, j, span, Math.max(distance, JOINT_REST), target, span ? K_SPAN : K_JOINT, 0.5 * (s.damping[i] + s.damping[j]),
    (span ? SPAN_STRENGTH : JOINT_STRENGTH) * resistance, Math.sqrt(s.coupling[i] * s.coupling[j]));
  if (at < 0) return -1;
  // What it remembered is what it has again.
  for (let end = 0; end < 2; end++) {
    const e = end === 0 ? i : j;
    s.memPartner[e * MEMORY_SLOTS + slot] = -1; s.memStrength[e * MEMORY_SLOTS + slot] = 0;
  }
  return at;
}

/**
 * Structural memory, one step: it fades (hot matter forgets fast, cold matter
 * keeps its shape for a long time), and while the world is alive it draws an
 * element back towards the partner it lost, the more so the more ordered and
 * the colder it is. In silence it pulls nothing.
 */
export function stepMemory(s: StructuralState, acc: Float64Array, env: Readonly<StructuralEnvironment>, config: Readonly<StructuralConfig>, h: number): void {
  const p = s.position, alive = unit(3 * env.energy), most = Math.min(MAX_JOINTS, Math.max(1, config.maxJoints));
  for (let i = 0; i < s.count; i++) {
    for (let slot = 0; slot < MEMORY_SLOTS; slot++) {
      const at = i * MEMORY_SLOTS + slot, j = s.memPartner[at];
      if (j < 0) continue;
      const strength = s.memStrength[at] * Math.exp(-h * (0.2 + 3 * s.temperature[i]) / (MEMORY_TAU * Math.max(0.1, s.persistence[i])));
      if (strength < 0.01) { s.memPartner[at] = -1; s.memStrength[at] = 0; continue; }
      s.memStrength[at] = strength;
      if (alive <= 0) continue;
      const open = slot === SPAN ? s.span[i] < 0 && s.span[j] < 0 : s.joints[i] < most && s.joints[j] < most && !s.jointed(i, j);
      if (!open) continue;
      const dx = p[j * 3] - p[i * 3], dy = p[j * 3 + 1] - p[i * 3 + 1], dz = p[j * 3 + 2] - p[i * 3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz), stretch = d - s.memRest[at];
      if (!(d > 1e-4) || d > MEMORY_RANGE || stretch <= 0) continue;
      // Felt less from far away: it finds a partner that is near, it does not fetch one from across the world.
      const reach = 1 - (d / MEMORY_RANGE) * (d / MEMORY_RANGE);
      const f = Math.min(MEMORY_PULL * stretch, MEMORY_MAX) * reach * strength * s.order[i] * (1 - s.temperature[i]) * alive / d;
      acc[i * 3] += dx * f / s.mass[i]; acc[i * 3 + 1] += dy * f / s.mass[i]; acc[i * 3 + 2] += dz * f / s.mass[i];
      acc[j * 3] -= dx * f / s.mass[j]; acc[j * 3 + 1] -= dy * f / s.mass[j]; acc[j * 3 + 2] -= dz * f / s.mass[j];
    }
  }
}
