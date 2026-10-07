import { FIELD, layerRadius } from '../fields/fieldLaw';

/*
 * How one element of matter moves under the field law's acceleration: the
 * exact response of a unit mass with linear drag to an acceleration held over
 * the step (so damping does not depend on the step length), a soft energy
 * channel fed by the wave fronts, ageing and re-forming. GLSL and CPU
 * reference side by side, as in fields/fieldLaw.ts.
 *
 * Texel layouts: position = xyz + energy (0..2), velocity = xyz + age (0..1).
 */

/** Longest simulation step (s): a longer frame is cut into equal sub-steps. */
export const MAX_STEP = 1 / 50;
/** Sub-steps per frame at most; a longer stall slows the matter instead of destabilising it. */
export const MAX_SUBSTEPS = 4;
/** Fastest an element moves (units/s) and the distance beyond which it re-forms. */
export const MAX_VELOCITY = 6;
const BOUND = 4;
/** Decay of the energy channel (s) and how fast a unit front charges it (1/s). */
export const ENERGY_TAU = 0.6;
export const WAVE_GLOW = 6;
/** A newly formed element matures at least this fast (1/s) until it is visible, then ages with the fields. */
export const BIRTH_RATE = 0.35;
export const BORN = 0.1;

/** Sub-steps for a frame of `dt` seconds, the same rule for every backend. */
export function substeps(dt: number): number {
  return dt > 0 ? Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / MAX_STEP - 1e-6))) : 0;
}

/** Needs `layerRadius` and the F_* defines of the field law. `law` = acceleration xyz + energy gain. */
export const matterStepGlsl = /* glsl */ `
void spawn(inout vec4 pos, inout vec4 vel, vec4 home, float age) {
  float layer = max(length(home.xyz), 1e-4);
  // Matter forms where the fields would hold it: it does not rush into place.
  pos = vec4(home.xyz * (layerRadius(layer) / layer) + vec3(F_LATERAL, 0.0, 0.0), 0.0);
  vel = vec4(0.0, 0.0, 0.0, age);
}

void matterStep(inout vec4 pos, inout vec4 vel, vec4 home, vec4 trait, vec4 law, float h, bool reset) {
  if (reset) {
    spawn(pos, vel, home, 0.1 + 0.7 * trait.y);
    return;
  }
  float k = exp(-F_DRAG * h);
  vec3 V = vel.xyz * k + law.xyz * ((1.0 - k) / F_DRAG);
  float speed = length(V);
  if (speed > ${MAX_VELOCITY}.0) V *= ${MAX_VELOCITY}.0 / speed;
  vec3 P = pos.xyz + V * h;
  float energy = min(2.0, pos.w * exp(-h / ${ENERGY_TAU}) + law.w * h * ${WAVE_GLOW}.0);
  float rate = F_LIFETIME_RATE * (0.6 + 0.8 * trait.y);
  if (vel.w < ${BORN}) rate = max(rate, ${BIRTH_RATE});
  float age = vel.w + rate * h;
  // Also catches NaN and Infinity: every comparison with them is false.
  if (age >= 1.0 || !(dot(P, P) < ${BOUND * BOUND}.0) || !(dot(V, V) < 1e4) || !(energy >= 0.0)) {
    spawn(pos, vel, home, 0.0);
    return;
  }
  pos = vec4(P, energy);
  vel = vec4(V, age);
}
`;

/**
 * CPU reference of `matterStep` for element `i` (stride 4). `law` is the field
 * law's output for it, `f` the packed fields.
 */
export function matterStep(
  i: number, position: Float32Array, velocity: Float32Array, nextPosition: Float32Array, nextVelocity: Float32Array,
  home: Float32Array, trait: Float32Array, law: ArrayLike<number>, f: Float32Array, h: number, reset: boolean,
): void {
  const at = i * 4;
  const drag = f[FIELD.drag], lifetimeRate = f[FIELD.lifetimeRate];
  if (!reset) {
    const k = Math.exp(-drag * h), g = (1 - k) / drag;
    let vx = velocity[at] * k + law[0] * g, vy = velocity[at + 1] * k + law[1] * g, vz = velocity[at + 2] * k + law[2] * g;
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (speed > MAX_VELOCITY) { const s = MAX_VELOCITY / speed; vx *= s; vy *= s; vz *= s; }
    const px = position[at] + vx * h, py = position[at + 1] + vy * h, pz = position[at + 2] + vz * h;
    const energy = Math.min(2, position[at + 3] * Math.exp(-h / ENERGY_TAU) + law[3] * h * WAVE_GLOW);
    let rate = lifetimeRate * (0.6 + 0.8 * trait[at + 1]);
    if (velocity[at + 3] < BORN) rate = Math.max(rate, BIRTH_RATE);
    const age = velocity[at + 3] + rate * h;
    if (age < 1 && px * px + py * py + pz * pz < BOUND * BOUND && vx * vx + vy * vy + vz * vz < 1e4 && energy >= 0) {
      nextPosition[at] = px; nextPosition[at + 1] = py; nextPosition[at + 2] = pz; nextPosition[at + 3] = energy;
      nextVelocity[at] = vx; nextVelocity[at + 1] = vy; nextVelocity[at + 2] = vz; nextVelocity[at + 3] = age;
      return;
    }
  }
  const layer = Math.max(Math.sqrt(home[at] * home[at] + home[at + 1] * home[at + 1] + home[at + 2] * home[at + 2]), 1e-4);
  const scale = layerRadius(layer, f[FIELD.radius], f[FIELD.gather]) / layer;
  nextPosition[at] = home[at] * scale + f[FIELD.lateral]; nextPosition[at + 1] = home[at + 1] * scale; nextPosition[at + 2] = home[at + 2] * scale;
  nextPosition[at + 3] = 0;
  nextVelocity[at] = nextVelocity[at + 1] = nextVelocity[at + 2] = 0;
  nextVelocity[at + 3] = reset ? 0.1 + 0.7 * trait[at + 1] : 0;
}
