import { FIELD, TURN_AT, WAVE_PUSH } from '../fields/fieldLaw';
import { fieldAt, FIELD_SPAN } from '../fields/vectorField';
import { MAX_WAVES } from '../waves/WaveField';
import { BIRTH_RATE, BORN, ENERGY_TAU, MAX_VELOCITY, WAVE_GLOW } from './matterLaw';

/*
 * What moves a tracer of the Field scene: nothing of its own. A tracer has no
 * shell to return to, no neighbour and no form; it is carried by the vector
 * field (fields/vectorField.ts) through the same drag as the matter, kicked by
 * the wave fronts that pass, and stirred by the fine micro-flow when it leans
 * to the bright end:
 *
 *   acceleration = fronts(P) + drag · (F(P) + shimmer(P))
 *
 * It integrates as the matter does (particles/matterLaw.ts: the exact
 * response to an acceleration held over the step, the energy the fronts
 * leave, ageing), with the same constants; only where it re-forms differs: a
 * tracer belongs to the space of the field, not to a layer of a body. When
 * the field stops, a tracer coasts for about 1 / drag seconds and stays where
 * it is. GLSL and CPU reference side by side, as in fields/fieldLaw.ts.
 */

/** Beyond this distance from the origin (units) a tracer has left the field and re-forms. */
const BOUND = 5.5;

/** GLSL ES 3.00. Needs the field header, the flow law, the wells and the vector field before it. `home.w` = band affinity, `phase` = the tracer's seed. */
export const tracerLawGlsl = /* glsl */ `
// xyz: acceleration; w: energy the fronts give this tracer (per second).
vec4 tracerLaw(vec3 P, vec4 home, float phase) {
  float affinity = home.w;
  vec3 U = fieldAt(P);
  vec3 p = P - vec3(F_LATERAL, 0.0, 0.0);
  U += abc(p * 9.0 + F_PHASE * 7.0 + phase * 6.2831853) * (F_SHIMMER * affinity * affinity);
  vec3 F = vec3(0.0);
  float gain = 0.0;
  for (int i = 0; i < ${MAX_WAVES}; i++) {
    vec4 A = uWaveA[i];
    vec4 B = uWaveB[i];
    if (B.x <= 0.0) continue;
    vec3 d = P - A.xyz;
    float len = max(length(d), 1e-4);
    float x = (len - B.y * A.w) / B.z;
    float away = (affinity - B.w) / 0.35;
    float match = B.w < 0.0 ? 1.0 : 0.35 + 0.65 * exp(-away * away);
    float k = B.x * exp(-x * x) * match;
    F += d * (${WAVE_PUSH}.0 * k / len);
    gain += k;
  }
  return vec4(F + F_DRAG * U, gain);
}
`;

/** GLSL ES 3.00. Needs the F_* defines of the field header. `law` = acceleration xyz + energy gain; texel layouts as the matter's. */
export const tracerStepGlsl = /* glsl */ `
void tracerSpawn(inout vec4 pos, inout vec4 vel, vec4 home, float age) {
  pos = vec4(home.xyz * (F_RADIUS * ${FIELD_SPAN}) + vec3(F_LATERAL, 0.0, 0.0), 0.0);
  vel = vec4(0.0, 0.0, 0.0, age);
}

void tracerStep(inout vec4 pos, inout vec4 vel, vec4 home, vec4 trait, vec4 law, float h, bool reset) {
  if (reset) {
    tracerSpawn(pos, vel, home, 0.1 + 0.7 * trait.y);
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
  if (age >= 1.0 || !(dot(P, P) < ${BOUND * BOUND}) || !(dot(V, V) < 1e4) || !(energy >= 0.0)) {
    tracerSpawn(pos, vel, home, 0.0);
    return;
  }
  pos = vec4(P, energy);
  vel = vec4(V, age);
}
`;

/** Result of the CPU reference: acceleration xyz and the fronts' energy gain (per second). Reused. */
export const tracerOut = new Float64Array(4);

const PHASE_AT = TURN_AT - 1;

/** CPU reference of `tracerLaw`. `f` is the packed field vector, `topology` the packed topology, `waveA`/`waveB` the packed fronts. */
export function tracerLaw(
  px: number, py: number, pz: number, affinity: number, phase: number,
  f: Float32Array, topology: ArrayLike<number>, waveA: Float32Array, waveB: Float32Array, detail: boolean,
): Float64Array {
  const U = fieldAt(px, py, pz, f, topology, detail);
  const x = px - f[FIELD.lateral], sp = f[PHASE_AT] * 7 + phase * 6.2831853;
  const sx = x * 9 + sp, sy = py * 9 + sp, sz = pz * 9 + sp, shimmer = f[FIELD.shimmer] * affinity * affinity;
  const Ux = U[0] + (Math.sin(sz) + Math.cos(sy)) * shimmer, Uy = U[1] + (Math.sin(sx) + Math.cos(sz)) * shimmer, Uz = U[2] + (Math.sin(sy) + Math.cos(sx)) * shimmer;
  let Fx = 0, Fy = 0, Fz = 0, gain = 0;
  for (let i = 0; i < MAX_WAVES; i++) {
    const amplitude = waveB[i * 4];
    if (!(amplitude > 0)) continue;
    const dx = px - waveA[i * 4], dy = py - waveA[i * 4 + 1], dz = pz - waveA[i * 4 + 2];
    const len = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-4);
    const u = (len - waveB[i * 4 + 1] * waveA[i * 4 + 3]) / waveB[i * 4 + 2];
    const band = waveB[i * 4 + 3], away = (affinity - band) / 0.35;
    const w = amplitude * Math.exp(-u * u) * (band < 0 ? 1 : 0.35 + 0.65 * Math.exp(-away * away));
    const k = WAVE_PUSH * w / len;
    Fx += dx * k; Fy += dy * k; Fz += dz * k;
    gain += w;
  }
  const drag = f[FIELD.drag];
  tracerOut[0] = Fx + drag * Ux; tracerOut[1] = Fy + drag * Uy; tracerOut[2] = Fz + drag * Uz; tracerOut[3] = gain;
  return tracerOut;
}

/** CPU reference of `tracerStep` for tracer `i` (stride 4). `law` is the tracer law's output for it, `f` the packed fields. */
export function tracerStep(
  i: number, position: Float32Array, velocity: Float32Array, nextPosition: Float32Array, nextVelocity: Float32Array,
  home: Float32Array, trait: Float32Array, law: ArrayLike<number>, f: Float32Array, h: number, reset: boolean,
): void {
  const at = i * 4, drag = f[FIELD.drag];
  if (!reset) {
    const k = Math.exp(-drag * h), g = (1 - k) / drag;
    let vx = velocity[at] * k + law[0] * g, vy = velocity[at + 1] * k + law[1] * g, vz = velocity[at + 2] * k + law[2] * g;
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (speed > MAX_VELOCITY) { const s = MAX_VELOCITY / speed; vx *= s; vy *= s; vz *= s; }
    const px = position[at] + vx * h, py = position[at + 1] + vy * h, pz = position[at + 2] + vz * h;
    const energy = Math.min(2, position[at + 3] * Math.exp(-h / ENERGY_TAU) + law[3] * h * WAVE_GLOW);
    let rate = f[FIELD.lifetimeRate] * (0.6 + 0.8 * trait[at + 1]);
    if (velocity[at + 3] < BORN) rate = Math.max(rate, BIRTH_RATE);
    const age = velocity[at + 3] + rate * h;
    if (age < 1 && px * px + py * py + pz * pz < BOUND * BOUND && vx * vx + vy * vy + vz * vz < 1e4 && energy >= 0) {
      nextPosition[at] = px; nextPosition[at + 1] = py; nextPosition[at + 2] = pz; nextPosition[at + 3] = energy;
      nextVelocity[at] = vx; nextVelocity[at + 1] = vy; nextVelocity[at + 2] = vz; nextVelocity[at + 3] = age;
      return;
    }
  }
  const scale = f[FIELD.radius] * FIELD_SPAN;
  nextPosition[at] = home[at] * scale + f[FIELD.lateral]; nextPosition[at + 1] = home[at + 1] * scale; nextPosition[at + 2] = home[at + 2] * scale;
  nextPosition[at + 3] = 0;
  nextVelocity[at] = nextVelocity[at + 1] = nextVelocity[at + 2] = 0;
  nextVelocity[at + 3] = reset ? 0.1 + 0.7 * trait[at + 1] : 0;
}
