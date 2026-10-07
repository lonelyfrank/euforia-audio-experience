import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, LineSegments, ShaderMaterial, Vector2, Vector4, type Object3D } from 'three';
import { fieldHeaderGlsl, FIELD, TURN_AT } from '../../render-systems/fields/fieldLaw';
import { flowAt, flowLawGlsl, settle } from '../../render-systems/fields/flowLaw';
import { Rng, seedOf } from '../../show/rng';
import type { PaletteColors, QualityProfile } from '../../types/visualizer';
import { voiceCycleGlsl, type VoiceCycles } from '../geometry/VoiceCycles';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';

/*
 * Filaments: lines that show how the world moves. A filament starts where a
 * point of the body rests and is carried, step by step, by its own heading
 * and by the same flow that carries the matter (vortex, travel, surge,
 * turbulence): in a turning world they wind, in a turbulent one they tangle,
 * in a still, silent one they have no length at all. Curved geometry keeps
 * them on their shells as arcs; angular geometry lets them leave straight.
 * Each one vibrates like a string in the real shape of a voice (a sawtooth
 * bass gives jagged lines, a sine smooth ones, a square stepped ones), and
 * branches where the sound forks. Stateless: every vertex is a function of
 * the frame, so nothing has to be reset, rebuilt or kept in step.
 *
 * The law is written twice (GLSL and the CPU reference below), like the field law.
 */

export interface FilamentParams {
  /** Trunks at High quality, and segments along each. */
  filaments: number;
  segments: number;
}

export interface FilamentQuality {
  trunks: number;
  segments: number;
}

/** Fewer and shorter-stepped lines at lower quality; the same length and the same behaviour. */
export function filamentQuality(params: FilamentParams, quality: QualityProfile): FilamentQuality {
  const density = Math.min(1, Math.max(0.1, quality.density));
  return { trunks: Math.max(8, Math.round(params.filaments * density)), segments: Math.max(6, Math.round(params.segments * (0.5 + 0.5 * density))) };
}

/** Branches per trunk, and how far along the trunk a branch may leave it (share of its segments). */
export const BRANCHES = 2;
const BRANCH_SPAN = 0.6;
/** Length of a filament from its heading alone (units), and seconds of the world's flow along it. */
const LENGTH = 0.8;
const REACH = 0.5;
/** Sideways swing of a string at full voice (units, × the matter's radius). */
const SWING = 0.1;
/** Lobes of a voice along a string: 2 at 55 Hz, one more per octave. */
const LOBES_MIN = 2;
const LOBES_MAX = 8;
/** Steps a voice's cycle is held on when the geometry is fully stepped. */
const HOLD = 16;
/** Light of one line (the picture is additive). */
const EXPOSURE = 0.42;

const law = /* glsl */ `
#define DETAIL 0
${fieldHeaderGlsl}
${flowLawGlsl}
${voiceCycleGlsl}
// x: length of a step along the heading, y: seconds of flow per step, z: how far lines keep to their shell, w: steps in a filament
uniform vec4 uFilament;

vec3 turned(vec3 v) {
  float c = cos(F_TURN), s = sin(F_TURN);
  return vec3(c * v.x - s * v.y, s * v.x + c * v.y, v.z);
}

// Where the filament is after \`steps\` steps, and the last step it took.
vec3 filamentPoint(vec4 home, vec3 trunk, float branchAt, vec3 heading, float steps, out vec3 along) {
  vec3 centre = vec3(F_LATERAL, 0.0, 0.0);
  vec3 P = settle(home, 1.0);
  vec3 h0 = turned(trunk), h1 = turned(heading);
  along = vec3(0.0);
  for (int i = 0; i < MAX_STEPS; i++) {
    if (float(i) >= steps) break;
    vec3 h = float(i) < branchAt ? h0 : h1;
    vec3 r = P - centre;
    float R = max(length(r), 1e-4);
    // Curved geometry keeps the line on its shell (an arc); angular geometry lets it leave straight.
    vec3 Q = P + (h - r * (dot(h, r) / (R * R) * uFilament.z)) * uFilament.x;
    vec3 q = Q - centre;
    Q = centre + q * mix(1.0, R / max(length(q), 1e-4), uFilament.z);
    Q += flowAt(Q) * uFilament.y;
    along = Q - P;
    P = Q;
  }
  return P;
}
`;

const vertexShader = (maxSteps: number) => /* glsl */ `
#define MAX_STEPS ${maxSteps}
${law}
attribute vec4 aHome;
attribute vec4 aTrunk;
attribute vec4 aHeading;
attribute vec2 aAlong;
// x: swing of a string (units), y: how stepped the voice is held, z / w: lobes of the low / high voice
uniform vec4 uString;
uniform vec2 uLevels;
// x: light, y: share of the filaments shown, z: share of the branches shown, w: light of passing fronts
uniform vec4 uShow;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
// How far the palette leans to its second hue (bright sound) or its first (low sound), about 0.
uniform float uBlend;
varying vec3 vColor;

void main() {
  float affinity = aHome.w;
  float branchAt = aTrunk.w;
  float s = aAlong.x / uFilament.w;
  vec3 along;
  vec3 P = filamentPoint(aHome, aTrunk.xyz, branchAt, aHeading.xyz, branchAt + aAlong.x, along);
  float moved = length(along);

  // The string: the voice's own cycle across the line, fixed at both ends.
  int voice = affinity >= 0.5 ? 1 : 0;
  float cycles = s * (voice == 1 ? uString.w : uString.z);
  cycles = mix(cycles, floor(cycles * ${HOLD}.0) / ${HOLD}.0, uString.y);
  vec3 radial = P - vec3(F_LATERAL, 0.0, 0.0);
  vec3 side = cross(along, radial);
  float sideLength = length(side);
  float ends = sin(3.14159265 * s);
  if (sideLength > 1e-7) P += side * (uString.x * (voice == 1 ? uLevels.y : uLevels.x) * voiceCycle(voice, cycles) * ends / sideLength);

  vec4 fronts = frontsAt(P, affinity);
  P += fronts.xyz;

  // A filament with no extent shows nothing; branches show as far as the sound forks.
  float shown = 1.0 - smoothstep(uShow.y - 0.06, uShow.y, aHeading.w);
  float forked = branchAt > 0.0 ? 1.0 - smoothstep(uShow.z - 0.12, uShow.z, aAlong.y) : 1.0;
  float amount = uShow.x * shown * forked * pow(ends, 0.6) * smoothstep(0.0004, 0.004, moved);
  vColor = (mix(uColorA, uColorB, clamp(affinity + uBlend, 0.0, 1.0)) * amount + uColorC * (fronts.w * uShow.w * shown * forked)) * ${EXPOSURE};
  gl_Position = amount + fronts.w * uShow.w > 0.002 ? projectionMatrix * modelViewMatrix * vec4(P, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;

/** Seeds of the filaments, one row per filament (trunks first, then their branches). */
export interface FilamentSeeds {
  count: number;
  /** xyz = direction × layer, w = band affinity. */
  home: Float32Array;
  /** xyz = the trunk's heading (unit, tangent to its shell), w = step at which a branch leaves it (0 for a trunk). */
  trunk: Float32Array;
  /** xyz = the filament's own heading, w = density rank 0..1. */
  heading: Float32Array;
  /** Branch rank 0..1 (0 for a trunk): which branches show first. */
  rank: Float32Array;
}

/** Deterministic: the same count, segments and seed give the same filaments. */
export function seedFilaments(trunks: number, segments: number, seed: number): FilamentSeeds {
  const rng = new Rng(seedOf(seed, 0x66696c61));
  const count = trunks * (1 + BRANCHES);
  const home = new Float32Array(count * 4), trunk = new Float32Array(count * 4), heading = new Float32Array(count * 4), rank = new Float32Array(count);
  for (let t = 0; t < trunks; t++) {
    const z = 2 * rng.next() - 1, angle = 2 * Math.PI * rng.next(), s = Math.sqrt(1 - z * z);
    const dx = s * Math.cos(angle), dy = s * Math.sin(angle), dz = z;
    // Two unit vectors orthogonal to the direction, and a heading among them.
    const ux = -Math.sin(angle), uy = Math.cos(angle);
    const vx = -dz * uy, vy = dz * ux, vz = dx * uy - dy * ux;
    const layer = 0.3 + 0.7 * rng.next() ** 0.7, affinity = Math.min(1, Math.max(0, 0.75 * rng.next() + 0.25 * layer)), density = rng.next();
    const twist = 2 * Math.PI * rng.next();
    for (let b = 0; b <= BRANCHES; b++) {
      const at = (b === 0 ? t : trunks + t * BRANCHES + b - 1) * 4;
      // A branch leaves its trunk somewhere along it, turned away by a good part of a right angle.
      const turn = b === 0 ? twist : twist + (rng.next() < 0.5 ? -1 : 1) * (0.5 + 0.8 * rng.next());
      home[at] = dx * layer; home[at + 1] = dy * layer; home[at + 2] = dz * layer; home[at + 3] = affinity;
      trunk[at] = Math.cos(twist) * ux + Math.sin(twist) * vx; trunk[at + 1] = Math.cos(twist) * uy + Math.sin(twist) * vy; trunk[at + 2] = Math.sin(twist) * vz;
      trunk[at + 3] = b === 0 ? 0 : 2 + Math.floor(rng.next() * Math.max(1, segments * BRANCH_SPAN - 2));
      heading[at] = Math.cos(turn) * ux + Math.sin(turn) * vx; heading[at + 1] = Math.cos(turn) * uy + Math.sin(turn) * vy; heading[at + 2] = Math.sin(turn) * vz;
      heading[at + 3] = density;
      rank[at / 4] = b === 0 ? 0 : rng.next();
    }
  }
  return { count, home, trunk, heading, rank };
}

/** What `filamentPoint` reads beside the packed fields: step length, seconds of flow per step, curvature. */
export interface FilamentShape {
  step: number;
  reach: number;
  curvature: number;
}

/** Result of the CPU reference: the point xyz and the last step taken xyz. Reused. */
export const filamentOut = new Float64Array(6);

/** CPU reference of the GLSL `filamentPoint` for filament `i` of `seeds`, `steps` steps along (after its branch point). */
export function filamentPoint(seeds: FilamentSeeds, i: number, steps: number, shape: FilamentShape, f: Float32Array): Float64Array {
  const at = i * 4, turn = f[TURN_AT], c = Math.cos(turn), s = Math.sin(turn), centre = f[FIELD.lateral];
  const p = settle(seeds.home[at], seeds.home[at + 1], seeds.home[at + 2], 1, f);
  let px = p[0], py = p[1], pz = p[2], ax = 0, ay = 0, az = 0;
  const branchAt = seeds.trunk[at + 3], total = branchAt + steps;
  for (let k = 0; k < total; k++) {
    const from = k < branchAt ? seeds.trunk : seeds.heading;
    const hx = c * from[at] - s * from[at + 1], hy = s * from[at] + c * from[at + 1], hz = from[at + 2];
    const rx = px - centre, R = Math.max(Math.sqrt(rx * rx + py * py + pz * pz), 1e-4);
    const along = (hx * rx + hy * py + hz * pz) / (R * R) * shape.curvature;
    let qx = px + (hx - rx * along) * shape.step, qy = py + (hy - py * along) * shape.step, qz = pz + (hz - pz * along) * shape.step;
    const ox = qx - centre, keep = 1 + (R / Math.max(Math.sqrt(ox * ox + qy * qy + qz * qz), 1e-4) - 1) * shape.curvature;
    qx = centre + ox * keep; qy *= keep; qz *= keep;
    const flow = flowAt(qx, qy, qz, f, false);
    qx += flow[0] * shape.reach; qy += flow[1] * shape.reach; qz += flow[2] * shape.reach;
    ax = qx - px; ay = qy - py; az = qz - pz;
    px = qx; py = qy; pz = qz;
  }
  filamentOut[0] = px; filamentOut[1] = py; filamentOut[2] = pz; filamentOut[3] = ax; filamentOut[4] = ay; filamentOut[5] = az;
  return filamentOut;
}

/** Lobes of a voice of `hz` along a string. */
export function stringLobes(hz: number): number {
  if (!(hz > 0) || !Number.isFinite(hz)) return LOBES_MIN;
  return Math.min(LOBES_MAX, Math.max(LOBES_MIN, LOBES_MIN + Math.log2(hz / 55)));
}

export class FilamentPrimitive implements Primitive {
  readonly object: Object3D;
  readonly seeds: FilamentSeeds;
  readonly elements: number;
  readonly vertices: number;
  /** What the law reads this frame (also the CPU reference's input). */
  readonly shape: FilamentShape = { step: 0, reach: 0, curvature: 0 };
  readonly debug = { filaments: 0, 'filament length': 0, branches: 0 };
  private readonly material: ShaderMaterial;
  private readonly geometry: BufferGeometry;
  private readonly voices: VoiceCycles;

  constructor(context: PrimitiveContext, private readonly quality: FilamentQuality) {
    const { trunks, segments } = quality;
    this.voices = context.voices;
    const seeds = this.seeds = seedFilaments(trunks, segments, context.seed);
    const perFilament = segments * 2, vertices = seeds.count * perFilament;
    const home = new Float32Array(vertices * 4), trunk = new Float32Array(vertices * 4), heading = new Float32Array(vertices * 4), along = new Float32Array(vertices * 2);
    for (let i = 0; i < seeds.count; i++) {
      for (let v = 0; v < perFilament; v++) {
        const to = (i * perFilament + v) * 4, from = i * 4;
        for (let k = 0; k < 4; k++) { home[to + k] = seeds.home[from + k]; trunk[to + k] = seeds.trunk[from + k]; heading[to + k] = seeds.heading[from + k]; }
        // Segment v / 2 joins steps v / 2 and v / 2 + 1.
        along[to / 2] = (v >> 1) + (v & 1); along[to / 2 + 1] = seeds.rank[i];
      }
    }
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices * 3), 3));
    this.geometry.setAttribute('aHome', new BufferAttribute(home, 4));
    this.geometry.setAttribute('aTrunk', new BufferAttribute(trunk, 4));
    this.geometry.setAttribute('aHeading', new BufferAttribute(heading, 4));
    this.geometry.setAttribute('aAlong', new BufferAttribute(along, 2));
    this.material = new ShaderMaterial({
      vertexShader: vertexShader(Math.ceil(segments * (1 + BRANCH_SPAN)) + 1), fragmentShader,
      transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending,
      uniforms: {
        uField: { value: context.uField }, uWaveA: { value: context.uWaveA }, uWaveB: { value: context.uWaveB }, tVoices: { value: context.voices.texture },
        uFilament: { value: new Vector4(0, 0, 0, segments) }, uString: { value: new Vector4(0, 0, LOBES_MIN, LOBES_MIN) }, uLevels: { value: new Vector2() },
        uShow: { value: new Vector4() }, uBlend: { value: 0 }, uColorA: { value: new Color() }, uColorB: { value: new Color() }, uColorC: { value: new Color() },
      },
    });
    const lines = new LineSegments(this.geometry, this.material);
    lines.frustumCulled = false;
    this.object = lines;
    this.elements = this.debug.filaments = seeds.count;
    this.vertices = vertices;
  }

  setPalette([primary, secondary, highlight]: PaletteColors): void {
    const u = this.material.uniforms;
    (u.uColorA.value as Color).copy(primary); (u.uColorB.value as Color).copy(secondary); (u.uColorC.value as Color).copy(highlight);
  }

  update(frame: Readonly<WorldFrame>, presence: number): void {
    const { geometry: g, look, fields } = frame, u = this.material.uniforms, shape = this.shape, segments = this.quality.segments;
    // A line needs something continuous to be made of: a voice with a shape, or matter that holds a line.
    const body = Math.max(g.continuity, g.tonalShape);
    shape.step = LENGTH / segments * (0.15 * g.energy + 0.85 * body);
    // Viscous matter leaves short trails; steady sound long ones.
    shape.reach = REACH / segments * (1 - 0.6 * g.viscosity) * (0.5 + 0.5 * g.trailPersistence);
    shape.curvature = g.curvature;
    (u.uFilament.value as Vector4).set(shape.step, shape.reach, shape.curvature, segments);
    const voices = this.voices;
    // Stored potential draws the strings taut.
    (u.uString.value as Vector4).set(SWING * fields.radius * (0.3 + 0.7 * g.tonalShape) * (1 - 0.4 * g.tension), g.stepping, stringLobes(voices.pitch[0]), stringLobes(voices.pitch[1]));
    (u.uLevels.value as Vector2).set(voices.level[0], voices.level[1]);
    (u.uShow.value as Vector4).set(presence * Math.max(look.emissive, look.ember), 0.35 + 0.65 * g.density, g.branching, presence * look.wave);
    u.uBlend.value = 0.6 * (look.blend - 0.5);
    if (import.meta.env.DEV) {
      this.debug['filament length'] = shape.step * segments;
      this.debug.branches = g.branching;
    }
  }

  reset(): void {}

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
