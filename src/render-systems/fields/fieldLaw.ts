import { MAX_WAVES, type WaveField } from '../waves/WaveField';
import type { SpatialFields } from './SpatialFields';

/*
 * The field law: what the spatial fields and the wave fronts do to one element
 * of matter at point P. Written twice, side by side, and kept identical term
 * by term: `fieldLawGlsl` runs on the GPU for every particle, `fieldLaw` is
 * the CPU reference used by the tests, the debug probe and any future backend
 * (a WebGPU compute pass implements this same function).
 *
 *   acceleration = F(P) + drag · U(P)
 *
 * U is the sum of the flows (the matter relaxes to them through its drag), F
 * the sum of the forces. The symmetry axis is z. Stylised, visual units.
 *
 * An element claimed by a form (forms/formLaw.ts) arrives with an anchor and a
 * hold 0..1: a spring pulls it to the anchor, and what would shape it as free
 * matter (its shell, the squash, the rotation flows, the structure, the bonds)
 * lets go by the same amount. Disorder, grains, the world's surge and the wave
 * fronts act on held matter too: that is how a form is deformed and broken.
 */

/** Order of the packed field values (`uField[i]` in GLSL, `packFields` in TS). */
const ORDER = [
  'radius', 'stiffness', 'gather', 'surge', 'vortex', 'flatten', 'advection', 'lateral', 'drift', 'turbulence', 'turbulenceScale',
  'shimmer', 'cohesion', 'order', 'winding', 'bond', 'clumping', 'clumpScale', 'drag', 'lifetimeRate', 'form',
] as const satisfies readonly (keyof SpatialFields)[];
/** Index of each field in the packed vector. */
export const FIELD = Object.fromEntries(ORDER.map((key, i) => [key, i])) as { readonly [K in typeof ORDER[number]]: number };
/** Packed values: the fields above, then the disorder phase and the structure's rotation. */
export const FIELD_VALUES = ORDER.length + 2;
const PHASE = ORDER.length, TURN = ORDER.length + 1;
const FORM_AT = ORDER.indexOf('form');
/** Where the packed vector keeps the centre of the fields, the structure's rotation and the matter's radius (the form law reads them). */
export const LATERAL_AT = ORDER.indexOf('lateral');
export const TURN_AT = TURN;
export const RADIUS_AT = ORDER.indexOf('radius');
/** The disorder phase wraps here: a whole number of periods of every term that uses it. */
export const PHASE_PERIOD = 20 * Math.PI;
/** Structure rotation per unit of the layer's accumulated turn (rad/rad). */
const TURN_GAIN = 0.15;

/** Rest length of a strand bond and the extension beyond which it pulls no harder (units). */
export const BOND_REST = 0.03;
const BOND_REACH = 0.6;
/** Acceleration of a unit-amplitude front (units/s²). */
export const WAVE_PUSH = 9;
/** Spring (1/s²) that flattens the body at full squash, and how tightly full cohesion gathers it (< 1: sheets keep a thickness). */
const SQUASH_STIFFNESS = 8;
const TIGHTEST = 0.92;
const FULL_COHESION = 14;

export function packFields(out: Float32Array, fields: Readonly<SpatialFields>, phase: number): Float32Array {
  for (let i = 0; i < ORDER.length; i++) out[i] = fields[ORDER[i]];
  out[PHASE] = phase;
  const turn = (fields.turn * TURN_GAIN) % (2 * Math.PI);
  out[TURN] = turn;
  return out;
}

/** Packs the fronts as the law reads them: A = origin xyz + age (s), B = amplitude now, speed, width, band. */
export function packWaves(a: Float32Array, b: Float32Array, waves: WaveField, now: number): void {
  for (let i = 0; i < MAX_WAVES; i++) {
    const amplitude = waves.amplitude(i, now);
    a[i * 4] = waves.origin[i * 3]; a[i * 4 + 1] = waves.origin[i * 3 + 1]; a[i * 4 + 2] = waves.origin[i * 3 + 2];
    a[i * 4 + 3] = amplitude > 0 ? waves.age(i, now) : 0;
    b[i * 4] = amplitude; b[i * 4 + 1] = waves.speed[i]; b[i * 4 + 2] = waves.width[i]; b[i * 4 + 3] = waves.band[i];
  }
}

const defines = ORDER.map((key, i) => `#define F_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()} uField[${i}]`).join('\n');

/**
 * GLSL ES 3.00: what every reader of the fields shares — the packed uniforms (`uField`, `uWaveA`, `uWaveB`, declared
 * here), their names (`F_*`), the disordered flow and the radius a layer is held at. The field law below and the laws
 * of what is not simulated matter (fields/flowLaw.ts) both start from it, so they read the same world.
 */
export const fieldHeaderGlsl = /* glsl */ `
uniform float uField[${FIELD_VALUES}];
uniform vec4 uWaveA[${MAX_WAVES}];
uniform vec4 uWaveB[${MAX_WAVES}];
${defines}
#define F_PHASE uField[${PHASE}]
#define F_TURN uField[${TURN}]

vec3 abc(vec3 q) {
  return vec3(sin(q.z) + cos(q.y), sin(q.x) + cos(q.z), sin(q.y) + cos(q.x));
}

// Radius an element of a layer (0..1) is held at: loose in the volume, or gathered onto one of three shells.
float layerRadius(float layer) {
  float shell = 0.55 + 0.3 * min(floor(layer * 3.0), 2.0);
  return F_RADIUS * mix(0.3 + 0.95 * layer, shell, F_GATHER);
}
`;

/**
 * GLSL ES 3.00. Needs `DETAIL` defined to 1 for the second turbulence octave.
 * `home` = seeded direction × layer (xyz) + band affinity (w); `phase` = the particle's seed 0..1.
 * `prev`/`next` are the strand neighbours' positions, `links` whether each exists.
 * `anchor` = where the element's form wants it (xyz) and how firmly (w, 0 = free matter).
 */
export const fieldLawGlsl = /* glsl */ `${fieldHeaderGlsl}
vec3 bondPull(vec3 P, vec3 neighbour) {
  vec3 d = neighbour - P;
  float len = length(d);
  return len > ${BOND_REST} ? d * (min(len - ${BOND_REST}, ${BOND_REACH}) / len) : vec3(0.0);
}

// xyz: acceleration; w: energy the fronts give this element (per second).
vec4 fieldLaw(vec3 P, vec4 home, float phase, vec3 prev, vec3 next, vec2 links, vec4 anchor) {
  float affinity = home.w;
  float unheld = 1.0 - anchor.w;
  float layer = length(home.xyz);
  vec3 p = P - vec3(F_LATERAL, 0.0, 0.0);
  float r = max(length(p), 1e-4);
  vec3 rh = p / r;
  float rho = max(length(p.xy), 1e-4);
  vec2 rhoHat = p.xy / rho;
  vec2 th = vec2(-rhoHat.y, rhoHat.x);
  vec3 F = vec3(0.0);
  vec3 U = vec3(0.0);

  // Radial: a spring to the element's layer, gathered onto shells; the world's radial velocity is a flow.
  float target = layerRadius(layer);
  F -= (F_STIFFNESS * unheld) * (r - target) * rh;
  U += F_SURGE * min(r / F_RADIUS, 1.5) * rh;

  // Vortex about z (faster inside: differential rotation). Rotation squashes each element's height towards
  // the plane, by a share: a disc or rings with a thickness, never a collapse.
  U.xy += th * (F_VORTEX * unheld * 1.25 * rho / (0.25 + rho * rho));
  F.z -= ${SQUASH_STIFFNESS}.0 * F_FLATTEN * unheld * (p.z - home.z / max(layer, 1e-4) * target * (1.0 - F_FLATTEN));

  // Advection: the body rolls forward about the lateral axis (its top comes towards the viewer). A rotation,
  // like the vortex: matter held on a shell is carried around it, never piled up at one end.
  float d = max(length(p.yz), 1e-4);
  U.yz += vec2(-p.z, p.y) * (F_ADVECTION * unheld * 1.25 / (0.25 + d * d));
  U.x += F_DRIFT;

  // Turbulence: a divergence-free (ABC) flow whose phase advances only with the world's activity.
  vec3 q = p * F_TURBULENCE_SCALE + vec3(F_PHASE, F_PHASE * 0.7 + 1.3, F_PHASE * 1.3 + 2.1);
  vec3 T = abc(q) * 0.6;
#if DETAIL
  T += abc(q * 2.0 + 4.1) * 0.4;
#endif
  U += T * (F_TURBULENCE * (0.7 + 0.6 * affinity));
  // Shimmer: fine micro-motion, taken by the high-affinity matter.
  U += abc(p * 9.0 + F_PHASE * 7.0 + phase * 6.2831853) * (F_SHIMMER * affinity * affinity);

  // Structure: attraction onto the sheets of an n-fold spiral pattern (two neighbouring orders, blended).
  // Each element aims beside the sheet by its own share, which closes as cohesion grows: amorphous → structured.
  float aside = (phase - 0.5) * 3.14159265 * (1.0 - ${TIGHTEST} * min(F_COHESION / ${FULL_COHESION}.0, 1.0));
  float phi = atan(p.y, p.x) - F_TURN;
  float n0 = floor(F_ORDER);
  float blend = F_ORDER - n0;
  for (int k = 0; k < 2; k++) {
    float n = n0 + float(k);
    float weight = k == 0 ? 1.0 - blend : blend;
    float theta = n * phi - F_WINDING * rho + aside;
    // Fades out on the axis, where every sheet meets: matter crosses the poles freely instead of knotting there.
    vec2 grad = (n * th - F_WINDING * rho * rhoHat) * (rho / (rho * rho + 0.25));
    F.xy -= grad * (F_COHESION * unheld * weight * 0.5 * sin(2.0 * theta) / n);
  }
  // Grains: attraction into the cells of a lattice.
  F -= sin(p * F_CLUMP_SCALE) * (F_CLUMPING / F_CLUMP_SCALE);
  // Bonds: neighbours along a strand pull back together when stretched.
  F += (bondPull(P, prev) * links.x + bondPull(P, next) * links.y) * (F_BOND * unheld);
  // Form: the spring to the element's anchor.
  F += (anchor.xyz - P) * (F_FORM * anchor.w);

  // Wave fronts: an outward push where the front is now, by how much the element belongs to its band.
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

/** Result of `fieldLaw`: acceleration xyz and the fronts' energy gain (per second). Reused. */
export const lawOut = new Float64Array(4);

/** CPU reference of `layerRadius`. */
export function layerRadius(layer: number, radius: number, gather: number): number {
  const loose = 0.3 + 0.95 * layer, shell = 0.55 + 0.3 * Math.min(Math.floor(layer * 3), 2);
  return radius * (loose + (shell - loose) * gather);
}

/** The element is free matter: no form holds it (the `anchor` argument of `fieldLaw`). */
export const NO_ANCHOR: ArrayLike<number> = new Float64Array(4);

function bond(px: number, py: number, pz: number, n: ArrayLike<number>, at: number, scale: number): void {
  const dx = n[at] - px, dy = n[at + 1] - py, dz = n[at + 2] - pz;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > BOND_REST)) return;
  const k = scale * Math.min(len - BOND_REST, BOND_REACH) / len;
  lawOut[0] += dx * k; lawOut[1] += dy * k; lawOut[2] += dz * k;
}

/**
 * CPU reference of `fieldLawGlsl` (same terms, same order). `f` is the
 * packed field vector, `waveA`/`waveB` the packed fronts; `positions` holds
 * xyz at stride 4, `prev`/`next` are neighbour indices in it or -1; `anchor`
 * is the form law's result for the element (NO_ANCHOR for free matter).
 * Writes `lawOut`.
 */
export function fieldLaw(
  px: number, py: number, pz: number, hx: number, hy: number, hz: number, affinity: number, phase: number,
  positions: ArrayLike<number>, prev: number, next: number,
  f: Float32Array, waveA: Float32Array, waveB: Float32Array, detail: boolean, anchor: ArrayLike<number> = NO_ANCHOR,
): Float64Array {
  const hold = anchor[3], free = 1 - hold, form = f[FORM_AT];
  const radius = f[0], stiffness = f[1], gather = f[2], surge = f[3], vortex = f[4], flatten = f[5], advection = f[6], lateral = f[7],
    drift = f[8], turbulence = f[9], turbulenceScale = f[10], shimmer = f[11], cohesion = f[12], order = f[13], winding = f[14],
    bondK = f[15], clumping = f[16], clumpScale = f[17], drag = f[18], fieldPhase = f[PHASE], turn = f[TURN];
  const layer = Math.sqrt(hx * hx + hy * hy + hz * hz);
  const x = px - lateral, y = py, z = pz;
  // Plain square roots: Math.hypot is several times slower and this runs per element.
  const r = Math.max(Math.sqrt(x * x + y * y + z * z), 1e-4);
  const rho = Math.max(Math.sqrt(x * x + y * y), 1e-4);
  const rx = x / rho, ry = y / rho;
  const tx = -ry, ty = rx;
  let Fx = 0, Fy = 0, Fz = 0, Ux = 0, Uy = 0, Uz = 0;

  const target = layerRadius(layer, radius, gather);
  let k = -stiffness * free * (r - target) / r;
  Fx += k * x; Fy += k * y; Fz += k * z;
  k = surge * Math.min(r / radius, 1.5) / r;
  Ux += k * x; Uy += k * y; Uz += k * z;

  k = vortex * free * 1.25 * rho / (0.25 + rho * rho);
  Ux += tx * k; Uy += ty * k;
  Fz -= SQUASH_STIFFNESS * flatten * free * (z - hz / Math.max(layer, 1e-4) * target * (1 - flatten));

  const d = Math.max(Math.sqrt(y * y + z * z), 1e-4);
  k = advection * free * 1.25 / (0.25 + d * d);
  Uy -= z * k; Uz += y * k;
  Ux += drift;

  const qx = x * turbulenceScale + fieldPhase, qy = y * turbulenceScale + fieldPhase * 0.7 + 1.3, qz = z * turbulenceScale + fieldPhase * 1.3 + 2.1;
  let Tx = (Math.sin(qz) + Math.cos(qy)) * 0.6, Ty = (Math.sin(qx) + Math.cos(qz)) * 0.6, Tz = (Math.sin(qy) + Math.cos(qx)) * 0.6;
  if (detail) {
    const ox = qx * 2 + 4.1, oy = qy * 2 + 4.1, oz = qz * 2 + 4.1;
    Tx += (Math.sin(oz) + Math.cos(oy)) * 0.4; Ty += (Math.sin(ox) + Math.cos(oz)) * 0.4; Tz += (Math.sin(oy) + Math.cos(ox)) * 0.4;
  }
  k = turbulence * (0.7 + 0.6 * affinity);
  Ux += Tx * k; Uy += Ty * k; Uz += Tz * k;
  const sp = fieldPhase * 7 + phase * 6.2831853;
  const sx = x * 9 + sp, sy = y * 9 + sp, sz = z * 9 + sp;
  k = shimmer * affinity * affinity;
  Ux += (Math.sin(sz) + Math.cos(sy)) * k; Uy += (Math.sin(sx) + Math.cos(sz)) * k; Uz += (Math.sin(sy) + Math.cos(sx)) * k;

  const aside = (phase - 0.5) * 3.14159265 * (1 - TIGHTEST * Math.min(cohesion / FULL_COHESION, 1));
  const phi = Math.atan2(y, x) - turn;
  const n0 = Math.floor(order), blend = order - n0;
  for (let i = 0; i < 2; i++) {
    const n = n0 + i, weight = i === 0 ? 1 - blend : blend;
    const theta = n * phi - winding * rho + aside;
    k = cohesion * free * weight * 0.5 * Math.sin(2 * theta) / n * (rho / (rho * rho + 0.25));
    Fx -= (n * tx - winding * rho * rx) * k; Fy -= (n * ty - winding * rho * ry) * k;
  }
  k = clumping / clumpScale;
  Fx -= Math.sin(x * clumpScale) * k; Fy -= Math.sin(y * clumpScale) * k; Fz -= Math.sin(z * clumpScale) * k;

  let gain = 0;
  for (let i = 0; i < MAX_WAVES; i++) {
    const amplitude = waveB[i * 4];
    if (!(amplitude > 0)) continue;
    const dx = px - waveA[i * 4], dy = py - waveA[i * 4 + 1], dz = pz - waveA[i * 4 + 2];
    const len = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-4);
    const u = (len - waveB[i * 4 + 1] * waveA[i * 4 + 3]) / waveB[i * 4 + 2];
    const band = waveB[i * 4 + 3], away = (affinity - band) / 0.35;
    const match = band < 0 ? 1 : 0.35 + 0.65 * Math.exp(-away * away);
    const w = amplitude * Math.exp(-u * u) * match;
    k = WAVE_PUSH * w / len;
    Fx += dx * k; Fy += dy * k; Fz += dz * k;
    gain += w;
  }
  k = form * hold;
  Fx += (anchor[0] - px) * k; Fy += (anchor[1] - py) * k; Fz += (anchor[2] - pz) * k;
  lawOut[0] = Fx + drag * Ux; lawOut[1] = Fy + drag * Uy; lawOut[2] = Fz + drag * Uz; lawOut[3] = gain;
  if (prev >= 0) bond(px, py, pz, positions, prev * 4, bondK * free);
  if (next >= 0) bond(px, py, pz, positions, next * 4, bondK * free);
  return lawOut;
}
