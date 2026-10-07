import { unit } from '../../experience/types';
import { FIELD, TURN_AT } from './fieldLaw';
import { flowAt, flowOut } from './flowLaw';
import type { SpatialFields } from './SpatialFields';
import { wellPull } from './wells';

/*
 * The vector field of the Field scene: F(P) in units/s, a function of the
 * packed spatial fields (the same `uField` every world shares) and of a small
 * topology vector. It is the flow that was already moving the free matter and
 * the filaments of Matter Field, taken on its own and completed into a field
 * with a structure:
 *
 *   flowAt     the shared flows (fields/flowLaw.ts): the world's radial
 *              velocity as a source or a sink, its spin as a vortex about the
 *              axis, its travel as a roll, the stereo drift, the disordered
 *              ABC flow;
 *   shells     the standing potential of the body (fields/wells.ts): a flow
 *              that converges on the three shells while the world is coherent
 *              or holds potential, so an ordered field is laminar sheets;
 *   eddies     up to four local vortices about seeded radial axes, of
 *              alternating sense: they wake one after the other as the world
 *              is disturbed, so disorder changes the field's topology (new
 *              centres appear) instead of only shaking it;
 *   wall       a soft bound far outside the body (the field itself has no edge:
 *              it fills the space round the body and fades with distance).
 *
 * Nothing in it advances with time: the only phase is the disorder phase of
 * the shared fields, which stands still when the world does. At rest (no
 * flows, no topology) F is zero everywhere inside the wall.
 *
 * Written twice like the field law: GLSL for the GPU, a CPU reference for the
 * tests. Tracers integrate it (particles/tracerLaw.ts), field lines follow it
 * without state (visual-engine/primitives/FieldLinePrimitive.ts).
 */

/** Local vortices the field can hold. */
export const EDDIES = 4;
/** Where an eddy sits (× the matter's radius), its core radius and how far it reaches (units). */
const EDDY_AT = 0.6;
const EDDY_CORE = 0.18;
const EDDY_REACH = 0.75;
/** The shells of the body (× the matter's radius), as `layerRadius` gathers matter onto them. */
const SHELL_FIRST = 0.55;
const SHELL_STEP = 0.3;
/**
 * The field is a space, not a body: it reaches this far beyond the matter's radius (× that radius). Tracers are
 * seeded through all of it; the body, with its shells and eddies, is its centre.
 */
export const FIELD_SPAN = 2.4;
/** The wall: where it starts (× the matter's radius) and how firmly it pushes back (1/s). */
const WALL_AT = 2.6;
const WALL = 2.5;

/** Packed topology (`uTopology`): x = speed of the eddies (units/s), y = how many are awake (0..EDDIES), z = rate of the shells (1/s). */
export const TOPOLOGY_VALUES = 4;
export const TOPOLOGY = { eddy: 0, eddies: 1, well: 2 } as const;

/** What the topology is derived from: traits of the geometry a world reads each frame (structurally a GeometryState). */
export interface FieldCondition {
  disorder: number;
  coherence: number;
  fragmentation: number;
  energy: number;
}

/**
 * The topology the world asks of the field right now. Disorder that nothing
 * holds together wakes the eddies; order and stored potential set the shells,
 * but only while the world is alive: in silence the field does not organise
 * what it left behind. Finite and bounded for any input.
 */
export function deriveTopology(out: Float32Array, material: Readonly<FieldCondition>, fields: Readonly<SpatialFields>): Float32Array {
  const disorder = unit(material.disorder), loose = 1 - unit(material.coherence), broken = unit(material.fragmentation);
  out[TOPOLOGY.eddy] = Math.min(1.6, 1.3 * disorder * (0.35 + 0.65 * loose) + 0.5 * broken);
  out[TOPOLOGY.eddies] = EDDIES * unit(1.6 * disorder + 0.6 * broken - 0.1);
  out[TOPOLOGY.well] = 2.2 * unit(fields.gather) * unit(2.5 * material.energy);
  for (let i = 0; i < TOPOLOGY_VALUES; i++) if (!Number.isFinite(out[i])) out[i] = 0;
  return out;
}

/** GLSL ES 3.00. Needs `fieldHeaderGlsl`, `flowLawGlsl` and `wellsGlsl` before it. */
export const vectorFieldGlsl = /* glsl */ `
uniform vec4 uTopology;

// The axes of the eddies: the four corners of a tetrahedron.
vec3 eddyAxis(int k) {
  return vec3(k < 2 ? 1.0 : -1.0, k == 0 || k == 2 ? 1.0 : -1.0, k == 0 || k == 3 ? 1.0 : -1.0) * 0.57735027;
}

// The field at P (units/s).
vec3 fieldAt(vec3 P) {
  vec3 U = flowAt(P);
  vec3 p = P - vec3(F_LATERAL, 0.0, 0.0);
  float r = max(length(p), 1e-4);
  vec3 rh = p / r;
  float x = r / F_RADIUS;
  // Shells: the standing potential of the body, only where the body is.
  float inside = smoothstep(0.3, 0.45, x) * (1.0 - smoothstep(1.25, 1.4, x));
  U += rh * (uTopology.z * inside * F_RADIUS * ${SHELL_STEP} * wellPull((x - ${SHELL_FIRST}) / ${SHELL_STEP}));
  U -= rh * (${WALL} * max(0.0, r - ${WALL_AT} * F_RADIUS));
  // Eddies: each a vortex about a radial axis through its centre, turned with the structure; they wake one by one.
  float c = cos(F_TURN), s = sin(F_TURN);
  for (int k = 0; k < ${EDDIES}; k++) {
    float awake = clamp(uTopology.y - float(k), 0.0, 1.0);
    if (awake <= 0.0) continue;
    vec3 a = eddyAxis(k);
    a = vec3(c * a.x - s * a.y, s * a.x + c * a.y, a.z);
    vec3 d = p - a * (${EDDY_AT} * F_RADIUS);
    vec3 across = d - a * dot(a, d);
    float sense = k % 2 == 0 ? 1.0 : -1.0;
    U += cross(a, d) * (uTopology.x * awake * sense * ${2 * EDDY_CORE} / (${EDDY_CORE * EDDY_CORE} + dot(across, across)) * exp(-dot(d, d) / ${EDDY_REACH * EDDY_REACH}));
  }
  return U;
}
`;

/** Result of the CPU reference. Reused. */
export const vectorOut = new Float64Array(3);

const AXES = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map((axis) => axis.map((value) => value * 0.57735027));
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** CPU reference of `fieldAt`. `f` is the packed field vector, `topology` the packed topology. Writes `vectorOut`. */
export function fieldAt(px: number, py: number, pz: number, f: Float32Array, topology: ArrayLike<number>, detail = false): Float64Array {
  flowAt(px, py, pz, f, detail);
  let Ux = flowOut[0], Uy = flowOut[1], Uz = flowOut[2];
  const radius = f[FIELD.radius], x = px - f[FIELD.lateral], y = py, z = pz;
  const r = Math.max(Math.sqrt(x * x + y * y + z * z), 1e-4), at = r / radius;
  const inside = smoothstep(0.3, 0.45, at) * (1 - smoothstep(1.25, 1.4, at));
  const k = (topology[TOPOLOGY.well] * inside * radius * SHELL_STEP * wellPull((at - SHELL_FIRST) / SHELL_STEP) - WALL * Math.max(0, r - WALL_AT * radius)) / r;
  Ux += x * k; Uy += y * k; Uz += z * k;
  const turn = f[TURN_AT], c = Math.cos(turn), s = Math.sin(turn);
  for (let e = 0; e < EDDIES; e++) {
    const awake = Math.min(1, Math.max(0, topology[TOPOLOGY.eddies] - e));
    if (!(awake > 0)) continue;
    const axis = AXES[e], ax = c * axis[0] - s * axis[1], ay = s * axis[0] + c * axis[1], az = axis[2];
    const dx = x - ax * EDDY_AT * radius, dy = y - ay * EDDY_AT * radius, dz = z - az * EDDY_AT * radius;
    const along = ax * dx + ay * dy + az * dz;
    const qx = dx - ax * along, qy = dy - ay * along, qz = dz - az * along;
    const g = topology[TOPOLOGY.eddy] * awake * (e % 2 === 0 ? 1 : -1) * 2 * EDDY_CORE / (EDDY_CORE * EDDY_CORE + qx * qx + qy * qy + qz * qz)
      * Math.exp(-(dx * dx + dy * dy + dz * dz) / (EDDY_REACH * EDDY_REACH));
    Ux += (ay * dz - az * dy) * g; Uy += (az * dx - ax * dz) * g; Uz += (ax * dy - ay * dx) * g;
  }
  vectorOut[0] = Ux; vectorOut[1] = Uy; vectorOut[2] = Uz;
  return vectorOut;
}
