import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, LineSegments, ShaderMaterial, Vector4, type Object3D } from 'three';
import { fieldHeaderGlsl } from '../../render-systems/fields/fieldLaw';
import { flowLawGlsl, settle } from '../../render-systems/fields/flowLaw';
import { deriveTopology, fieldAt, vectorFieldGlsl } from '../../render-systems/fields/vectorField';
import { wellsGlsl } from '../../render-systems/fields/wells';
import { Rng, seedOf } from '../../show/rng';
import type { PaletteColors, QualityProfile } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';

/*
 * Field lines: the vector field drawn as it is at this instant. A line starts
 * where a point of the body rests and follows F(P)
 * (render-systems/fields/vectorField.ts) downstream, step by step; each step
 * is as long as the field is strong there, up to a longest step, so a weak
 * field is a scatter of short dashes that show a direction and a strong one
 * is long curves: closed rounds in a vortex, spokes in a surge, spirals round
 * an eddy, lines that bend onto the shells when the field is ordered. Where
 * the field is zero a line has no length and is not drawn. Stateless: every
 * vertex is a function of the frame.
 *
 * The law is written twice (GLSL and the CPU reference below).
 */

export interface FieldLineParams {
  /** Lines at High quality, and segments along each. */
  lines: number;
  lineSegments: number;
}

export interface FieldLineQuality {
  lines: number;
  segments: number;
}

/** Fewer and coarser lines at lower quality; the same length and the same field. */
export function fieldLineQuality(params: FieldLineParams, quality: QualityProfile): FieldLineQuality {
  const density = Math.min(1, Math.max(0.1, quality.density));
  return { lines: Math.max(12, Math.round(params.lines * density)), segments: Math.max(8, Math.round(params.lineSegments * (0.5 + 0.5 * density))) };
}

/** Seconds of the field's flow along a whole line, and the longest a whole line gets (units). */
const REACH = 1.2;
const LENGTH = 2.6;
/** How far out the lines are seeded, relative to where the matter of their layer would rest: through the body and round it. */
export const LINE_SPREAD = 1.7;
/** Light of one line (the picture is additive). */
const EXPOSURE = 0.5;

const law = /* glsl */ `
#define DETAIL 0
${fieldHeaderGlsl}
${flowLawGlsl}
${wellsGlsl}
${vectorFieldGlsl}
// x: seconds of flow per step, y: longest step (units), w: steps in a line
uniform vec4 uLine;

// Where the line is after \`steps\` steps, and the last step it took.
vec3 fieldLinePoint(vec4 home, float steps, out vec3 along) {
  vec3 P = settle(home, ${LINE_SPREAD});
  along = vec3(0.0);
  for (int i = 0; i < MAX_STEPS; i++) {
    if (float(i) >= steps) break;
    vec3 U = fieldAt(P);
    // As far as the field carries in a step, never further than the longest step.
    along = U * (uLine.x / (1.0 + length(U) * uLine.x / uLine.y));
    P += along;
  }
  return P;
}
`;

const vertexShader = (maxSteps: number) => /* glsl */ `
#define MAX_STEPS ${maxSteps}
${law}
attribute vec4 aHome;
attribute vec2 aAlong;
// x: light, y: share of the lines shown, z: light of passing fronts, w: how far the palette leans to its second hue
uniform vec4 uShow;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
varying vec3 vColor;

void main() {
  float affinity = aHome.w;
  float s = aAlong.x / uLine.w;
  vec3 along;
  vec3 P = fieldLinePoint(aHome, aAlong.x, along);
  vec4 fronts = frontsAt(P, affinity);
  P += fronts.xyz;
  // A step of full length is a strong field: the line carries the field's strength as light, and runs towards its head.
  float strength = length(along) / uLine.y;
  float shown = 1.0 - smoothstep(uShow.y - 0.06, uShow.y, aAlong.y);
  float amount = uShow.x * shown * pow(sin(3.14159265 * s), 0.6) * (0.4 + 0.6 * s) * smoothstep(0.02, 0.25, strength);
  vColor = (mix(uColorA, uColorB, clamp(affinity + uShow.w, 0.0, 1.0)) * amount + uColorC * (fronts.w * uShow.z * shown)) * ${EXPOSURE};
  gl_Position = amount + fronts.w * uShow.z * shown > 0.002 ? projectionMatrix * modelViewMatrix * vec4(P, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;

/** Seeds of the lines, one row per line. */
export interface FieldLineSeeds {
  count: number;
  /** xyz = direction × layer, w = band affinity. */
  home: Float32Array;
  /** Density rank 0..1: which lines show first. */
  rank: Float32Array;
}

/** Deterministic: the same count and seed give the same lines. */
export function seedFieldLines(count: number, seed: number): FieldLineSeeds {
  const rng = new Rng(seedOf(seed, 0x6c696e65));
  const home = new Float32Array(count * 4), rank = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const z = 2 * rng.next() - 1, angle = 2 * Math.PI * rng.next(), s = Math.sqrt(1 - z * z);
    const layer = 0.2 + 0.8 * rng.next() ** 0.7;
    home[i * 4] = s * Math.cos(angle) * layer; home[i * 4 + 1] = s * Math.sin(angle) * layer; home[i * 4 + 2] = z * layer;
    home[i * 4 + 3] = Math.min(1, Math.max(0, 0.75 * rng.next() + 0.25 * layer));
    rank[i] = rng.next();
  }
  return { count, home, rank };
}

/** What `fieldLinePoint` reads beside the packed fields and topology: seconds of flow per step and the longest step (units). */
export interface FieldLineShape {
  reach: number;
  step: number;
}

/** Result of the CPU reference: the point xyz and the last step taken xyz. Reused. */
export const fieldLineOut = new Float64Array(6);

/** CPU reference of the GLSL `fieldLinePoint` for line `i` of `seeds`, `steps` steps along. */
export function fieldLinePoint(seeds: FieldLineSeeds, i: number, steps: number, shape: FieldLineShape, f: Float32Array, topology: ArrayLike<number>): Float64Array {
  const at = i * 4, p = settle(seeds.home[at], seeds.home[at + 1], seeds.home[at + 2], LINE_SPREAD, f);
  let px = p[0], py = p[1], pz = p[2], ax = 0, ay = 0, az = 0;
  for (let k = 0; k < steps; k++) {
    const U = fieldAt(px, py, pz, f, topology, false);
    const scale = shape.step > 0 ? shape.reach / (1 + Math.sqrt(U[0] * U[0] + U[1] * U[1] + U[2] * U[2]) * shape.reach / shape.step) : 0;
    ax = U[0] * scale; ay = U[1] * scale; az = U[2] * scale;
    px += ax; py += ay; pz += az;
  }
  fieldLineOut[0] = px; fieldLineOut[1] = py; fieldLineOut[2] = pz; fieldLineOut[3] = ax; fieldLineOut[4] = ay; fieldLineOut[5] = az;
  return fieldLineOut;
}

export class FieldLinePrimitive implements Primitive {
  readonly object: Object3D;
  readonly seeds: FieldLineSeeds;
  readonly elements: number;
  readonly vertices: number;
  /** What the law reads this frame (also the CPU reference's input). */
  readonly shape: FieldLineShape = { reach: 0, step: 0 };
  readonly debug = { lines: 0, 'line reach': 0 };
  private readonly material: ShaderMaterial;
  private readonly geometry = new BufferGeometry();

  /** `topology`: the packed topology of the world's vector field, shared with the tracers. */
  constructor(context: PrimitiveContext, private readonly quality: FieldLineQuality, private readonly topology: Float32Array) {
    const { lines, segments } = quality;
    const seeds = this.seeds = seedFieldLines(lines, context.seed);
    const perLine = segments * 2, vertices = lines * perLine;
    const home = new Float32Array(vertices * 4), along = new Float32Array(vertices * 2);
    for (let i = 0; i < lines; i++) {
      for (let v = 0; v < perLine; v++) {
        const to = i * perLine + v;
        for (let k = 0; k < 4; k++) home[to * 4 + k] = seeds.home[i * 4 + k];
        // Segment v / 2 joins steps v / 2 and v / 2 + 1.
        along[to * 2] = (v >> 1) + (v & 1); along[to * 2 + 1] = seeds.rank[i];
      }
    }
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices * 3), 3));
    this.geometry.setAttribute('aHome', new BufferAttribute(home, 4));
    this.geometry.setAttribute('aAlong', new BufferAttribute(along, 2));
    this.material = new ShaderMaterial({
      vertexShader: vertexShader(segments + 1), fragmentShader, transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending,
      uniforms: {
        uField: { value: context.uField }, uWaveA: { value: context.uWaveA }, uWaveB: { value: context.uWaveB }, uTopology: { value: topology },
        uLine: { value: new Vector4(0, 1, 0, segments) }, uShow: { value: new Vector4() },
        uColorA: { value: new Color() }, uColorB: { value: new Color() }, uColorC: { value: new Color() },
      },
    });
    const drawn = new LineSegments(this.geometry, this.material);
    drawn.frustumCulled = false;
    this.object = drawn;
    this.elements = this.debug.lines = lines;
    this.vertices = vertices;
  }

  setPalette([primary, secondary, highlight]: PaletteColors): void {
    const u = this.material.uniforms;
    (u.uColorA.value as Color).copy(primary); (u.uColorB.value as Color).copy(secondary); (u.uColorC.value as Color).copy(highlight);
  }

  update(frame: Readonly<WorldFrame>, presence: number): void {
    const { geometry: g, fields, look } = frame, u = this.material.uniforms, shape = this.shape, segments = this.quality.segments;
    // The same topology the tracers move in (derived again here so the lines never depend on who was updated first).
    deriveTopology(this.topology, g, fields);
    // Viscous matter keeps its lines short; steady sound draws them long.
    shape.reach = REACH / segments * (1 - 0.5 * g.viscosity) * (0.5 + 0.5 * g.trailPersistence);
    shape.step = LENGTH / segments;
    (u.uLine.value as Vector4).set(shape.reach, shape.step, 0, segments);
    (u.uShow.value as Vector4).set(presence * Math.max(look.emissive, look.ember), 0.3 + 0.7 * g.density, presence * look.wave, 0.6 * (look.blend - 0.5));
    if (import.meta.env.DEV) this.debug['line reach'] = shape.reach * segments;
  }

  reset(): void {}

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
