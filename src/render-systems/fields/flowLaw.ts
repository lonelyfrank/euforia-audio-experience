import { MAX_WAVES } from '../waves/WaveField';
import { FIELD, layerRadius, TURN_AT } from './fieldLaw';

/*
 * What the fields do to things that are not simulated matter. The field law
 * (fieldLaw.ts) gives an element of matter an acceleration, and the matter
 * integrates it; a line, a surface or a node of a structure has no state to
 * integrate, so it reads the same fields as three stateless answers:
 *
 *   flowAt    the velocity free matter is carried with at P (the field law's flows);
 *   settle    where a point that belongs to the world's body rests right now
 *             (its shell, the squash of rotation, the structure's turn, the
 *             stereo centre, displaced by the disordered flow);
 *   frontsAt  how far the wave fronts passing through P push it aside.
 *
 * They use the packed uniforms of the field header, so one vortex carries the
 * particles, bends the filaments, tears the structure and tilts the surface.
 * Written twice like the field law: GLSL for the GPU, a CPU reference for the
 * tests (flowAt is checked against the field law's own flows).
 */

/** Seconds a held point is carried by the disordered flow: its displacement per unit of turbulence. */
export const TURBULENCE_SHIFT = 0.16;
/** Displacement of a held point by a unit-amplitude front (units). */
export const FRONT_SHIFT = 0.14;
/** Share of its height a held point loses at full squash. */
const SQUASH = 0.85;

/**
 * GLSL ES 3.00. Needs `fieldHeaderGlsl` before it and `DETAIL` defined.
 * `home` = seeded direction × layer (xyz) + band affinity (w), as for the matter.
 */
export const flowLawGlsl = /* glsl */ `
// The flows of the field law alone, for matter no form holds and of middle affinity (units/s).
vec3 flowAt(vec3 P) {
  vec3 p = P - vec3(F_LATERAL, 0.0, 0.0);
  float r = max(length(p), 1e-4);
  float rho = max(length(p.xy), 1e-4);
  vec2 th = vec2(-p.y, p.x) / rho;
  vec3 U = F_SURGE * min(r / F_RADIUS, 1.5) * (p / r);
  U.xy += th * (F_VORTEX * 1.25 * rho / (0.25 + rho * rho));
  float d = max(length(p.yz), 1e-4);
  U.yz += vec2(-p.z, p.y) * (F_ADVECTION * 1.25 / (0.25 + d * d));
  U.x += F_DRIFT;
  vec3 q = p * F_TURBULENCE_SCALE + vec3(F_PHASE, F_PHASE * 0.7 + 1.3, F_PHASE * 1.3 + 2.1);
  vec3 T = abc(q) * 0.6;
#if DETAIL
  T += abc(q * 2.0 + 4.1) * 0.4;
#endif
  return U + T * F_TURBULENCE;
}

// Where a point of the world's body rests: \`spread\` scales its radius (1 = where the matter of its layer is held).
vec3 settle(vec4 home, float spread) {
  float layer = max(length(home.xyz), 1e-4);
  vec3 p = home.xyz * (layerRadius(layer) / layer * spread);
  p.z *= 1.0 - ${SQUASH} * F_FLATTEN;
  float c = cos(F_TURN), s = sin(F_TURN);
  p = vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
  vec3 q = p * F_TURBULENCE_SCALE + vec3(F_PHASE, F_PHASE * 0.7 + 1.3, F_PHASE * 1.3 + 2.1);
  p += abc(q) * (0.6 * F_TURBULENCE * ${TURBULENCE_SHIFT});
  return p + vec3(F_LATERAL, 0.0, 0.0);
}

// xyz: how far the fronts push a held point at P aside; w: how much of them is passing (their light).
vec4 frontsAt(vec3 P, float affinity) {
  vec4 sum = vec4(0.0);
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
    sum += vec4(d * (${FRONT_SHIFT} * k / len), k);
  }
  return sum;
}
`;

/** Results of the CPU references below. Reused. */
export const flowOut = new Float64Array(3);
export const settleOut = new Float64Array(3);
export const frontsOut = new Float64Array(4);

const PHASE_AT = TURN_AT - 1;

/** CPU reference of `flowAt`. `f` is the packed field vector. Writes `flowOut`. */
export function flowAt(px: number, py: number, pz: number, f: Float32Array, detail: boolean): Float64Array {
  const x = px - f[FIELD.lateral], y = py, z = pz, phase = f[PHASE_AT];
  const r = Math.max(Math.sqrt(x * x + y * y + z * z), 1e-4);
  const rho = Math.max(Math.sqrt(x * x + y * y), 1e-4);
  let k = f[FIELD.surge] * Math.min(r / f[FIELD.radius], 1.5) / r;
  let Ux = k * x, Uy = k * y, Uz = k * z;
  k = f[FIELD.vortex] * 1.25 * rho / (0.25 + rho * rho);
  Ux += -y / rho * k; Uy += x / rho * k;
  const d = Math.max(Math.sqrt(y * y + z * z), 1e-4);
  k = f[FIELD.advection] * 1.25 / (0.25 + d * d);
  Uy -= z * k; Uz += y * k;
  Ux += f[FIELD.drift];
  const scale = f[FIELD.turbulenceScale];
  const qx = x * scale + phase, qy = y * scale + phase * 0.7 + 1.3, qz = z * scale + phase * 1.3 + 2.1;
  let Tx = (Math.sin(qz) + Math.cos(qy)) * 0.6, Ty = (Math.sin(qx) + Math.cos(qz)) * 0.6, Tz = (Math.sin(qy) + Math.cos(qx)) * 0.6;
  if (detail) {
    const ox = qx * 2 + 4.1, oy = qy * 2 + 4.1, oz = qz * 2 + 4.1;
    Tx += (Math.sin(oz) + Math.cos(oy)) * 0.4; Ty += (Math.sin(ox) + Math.cos(oz)) * 0.4; Tz += (Math.sin(oy) + Math.cos(ox)) * 0.4;
  }
  k = f[FIELD.turbulence];
  flowOut[0] = Ux + Tx * k; flowOut[1] = Uy + Ty * k; flowOut[2] = Uz + Tz * k;
  return flowOut;
}

/** CPU reference of `settle`: `hx, hy, hz` = seeded direction × layer. Writes `settleOut`. */
export function settle(hx: number, hy: number, hz: number, spread: number, f: Float32Array): Float64Array {
  const layer = Math.max(Math.sqrt(hx * hx + hy * hy + hz * hz), 1e-4);
  const k = layerRadius(layer, f[FIELD.radius], f[FIELD.gather]) / layer * spread;
  const x = hx * k, y = hy * k, z = hz * k * (1 - SQUASH * f[FIELD.flatten]);
  const turn = f[TURN_AT], c = Math.cos(turn), s = Math.sin(turn), phase = f[PHASE_AT];
  const rx = c * x - s * y, ry = s * x + c * y;
  const scale = f[FIELD.turbulenceScale];
  const qx = rx * scale + phase, qy = ry * scale + phase * 0.7 + 1.3, qz = z * scale + phase * 1.3 + 2.1;
  const shift = 0.6 * f[FIELD.turbulence] * TURBULENCE_SHIFT;
  settleOut[0] = rx + (Math.sin(qz) + Math.cos(qy)) * shift + f[FIELD.lateral];
  settleOut[1] = ry + (Math.sin(qx) + Math.cos(qz)) * shift;
  settleOut[2] = z + (Math.sin(qy) + Math.cos(qx)) * shift;
  return settleOut;
}

/** CPU reference of `frontsAt`: `waveA`/`waveB` are the packed fronts (see `packWaves`). Writes `frontsOut`. */
export function frontsAt(px: number, py: number, pz: number, affinity: number, waveA: Float32Array, waveB: Float32Array): Float64Array {
  let sx = 0, sy = 0, sz = 0, gain = 0;
  for (let i = 0; i < MAX_WAVES; i++) {
    const amplitude = waveB[i * 4];
    if (!(amplitude > 0)) continue;
    const dx = px - waveA[i * 4], dy = py - waveA[i * 4 + 1], dz = pz - waveA[i * 4 + 2];
    const len = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-4);
    const u = (len - waveB[i * 4 + 1] * waveA[i * 4 + 3]) / waveB[i * 4 + 2];
    const band = waveB[i * 4 + 3], away = (affinity - band) / 0.35;
    const k = amplitude * Math.exp(-u * u) * (band < 0 ? 1 : 0.35 + 0.65 * Math.exp(-away * away));
    sx += dx * (FRONT_SHIFT * k / len); sy += dy * (FRONT_SHIFT * k / len); sz += dz * (FRONT_SHIFT * k / len);
    gain += k;
  }
  frontsOut[0] = sx; frontsOut[1] = sy; frontsOut[2] = sz; frontsOut[3] = gain;
  return frontsOut;
}
