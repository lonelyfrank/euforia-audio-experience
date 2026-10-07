import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, LineSegments, Points, ShaderMaterial, Vector4, type Object3D } from 'three';
import { MODE_SHAPES, MODES, WAVES } from '../../physics/ResonantPhysics';
import { fieldHeaderGlsl } from '../../render-systems/fields/fieldLaw';
import { flowLawGlsl, TURBULENCE_SHIFT } from '../../render-systems/fields/flowLaw';
import type { PaletteColors, QualityProfile } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';

/*
 * A wave surface: a membrane that the sound deforms. Its height is physics
 * the audio engine already advances on the audio clock (ResonantPhysics, in
 * every snapshot): the modes of a membrane held at its edge, driven by what
 * sustains, and causal pulses that start on an event, travel and reflect.
 * Around that the geometry shapes it: sustained pressure bows it, roughness
 * and noise ripple it (long ripples for low sound, fine ones for bright),
 * a stepped voice cuts it into terraces, a leaning one tilts its crests; the
 * world's fronts cross it as rings and the disordered flow tears at it. It
 * sits in the world like any other part of the body: scaled by the matter's
 * radius, turned with the structure, centred where the forces come from.
 *
 * Two topologies (a square grid held at its four sides, a disc held at its
 * rim) and two ways of showing (points, or the wire of its lines).
 * Stateless except for the ripple's phase. The height law is written twice
 * (GLSL and the CPU reference below).
 */

export interface SurfaceOptions {
  topology: 'grid' | 'polar';
  style: 'points' | 'wire';
  /** Grid: cells per side. Polar: rings (sectors follow). */
  resolution: number;
  /** Half extent of the surface (units). */
  size: number;
  /** 0..1: how far its size follows the radius the fields hold the matter at. */
  follow: number;
  /** Whether it turns with the world's structure. */
  turn: boolean;
  /**
   * Where it lies in the world: across the axis (the plane the matter flattens into, seen face-on in a tilted world),
   * or along it (a membrane through the body seen at a slant, so its height reads as height).
   */
  plane: 'equator' | 'axial';
  /** 0 = the membrane as its physics gives it … 1 = fully shaped by the geometry (bow, ripple, terraces, lean, tear). */
  grammar: number;
  /** Height of a unit of modal displacement, relative to the size. */
  relief: number;
  /** Point size (device-independent pixels at the rest distance); points only. */
  pointSize: number;
  /** Light of one element (the picture is additive). */
  exposure: number;
}

/** Cells per side / rings at a quality: fewer vertices, the same surface. */
export function surfaceResolution(resolution: number, quality: QualityProfile): number {
  return Math.max(12, Math.round(resolution * Math.sqrt(Math.min(1, Math.max(0.1, quality.density)))));
}

/** Height of a unit pulse relative to a unit of modal displacement (Resonant Field's proportions). */
const PULSE = 0.28;
/** Terraces per unit of height (relative to the size) when the surface is stepped. */
const TERRACES = 14;
/** Spokes of the polar wire, and sectors per ring. */
const SPOKES = 24;
const SECTORS = 4;
/** Where the disc's rim is held: the height falls to zero between this radius and 1. */
const RIM = 0.82;
/** How far a unit front lifts the membrane where it crosses it (× its size). */
const FRONT_LIFT = 0.06;

/** The modal sum written out: one sine per wave number and axis, then a product per mode (no array of mode numbers on the GPU). */
const ORDERS = Math.max(...MODE_SHAPES.flat());
const modalSum = MODE_SHAPES.map(([m, n], i) => `uModes[${i}] * sx[${m - 1}] * sy[${n - 1}]`).join(' + ');

const law = /* glsl */ `
#define DETAIL 0
${fieldHeaderGlsl}
${flowLawGlsl}
uniform float uModes[${MODES}];
uniform vec4 uPulses[${WAVES}];
uniform float uTime;
// x: modal gain, y: pulse gain, z: bow, w: held rim (1 = a disc held at its rim, 0 = a grid held at its sides)
uniform vec4 uRelief;
// x: ripple height, y: ripple frequency, z: ripple phase, w: how terraced
uniform vec4 uTexture;

// A causal pulse of the membrane: nothing before the event, nothing ahead of its front.
float pulse(vec2 p, vec2 origin, float age) {
  float d = distance(p, origin), behind = age * 1.4 - d;
  if (age < 0.0 || behind < 0.0) return 0.0;
  return sin(behind * 18.0) * exp(-behind * 5.0 - age * 1.3) / sqrt(1.0 + d * 4.0);
}

// x: height at p (−1..1 on both axes), relative to the size; y: the modal part alone (the nodal lines are where it is zero).
vec2 surfaceHeight(vec2 p) {
  vec2 q = (p + 1.0) * 1.5707963;
  float sx[${ORDERS}];
  float sy[${ORDERS}];
  for (int k = 0; k < ${ORDERS}; k++) { sx[k] = sin(float(k + 1) * q.x); sy[k] = sin(float(k + 1) * q.y); }
  float modal = ${modalSum};
  float wave = 0.0;
  for (int i = 0; i < ${WAVES}; i++) {
    vec4 w = uPulses[i];
    if (w.w <= 0.0) continue;
    float age = uTime - w.z;
    // First image sources implement the reflection at the fixed edge; every pulse stays causal.
    wave += w.w * (pulse(p, w.xy, age)
      - 0.55 * pulse(p, vec2(2.0 - w.x, w.y), age) - 0.55 * pulse(p, vec2(-2.0 - w.x, w.y), age)
      - 0.55 * pulse(p, vec2(w.x, 2.0 - w.y), age) - 0.55 * pulse(p, vec2(w.x, -2.0 - w.y), age));
  }
  float r2 = dot(p, p);
  float h = modal * uRelief.x + wave * uRelief.y;
  h += uTexture.x * sin(p.x * uTexture.y + uTexture.z) * sin(p.y * uTexture.y * 1.31 - uTexture.z * 0.7);
  h += uRelief.z * max(0.0, 1.0 - r2);
  h = mix(h, floor(h * ${TERRACES}.0 + 0.5) / ${TERRACES}.0, uTexture.w);
  // A disc is held at its rim.
  return vec2(h, modal) * mix(1.0, 1.0 - smoothstep(${RIM}, 1.0, sqrt(r2)), uRelief.w);
}
`;

const vertexShader = (points: boolean) => /* glsl */ `
${law}
// x: half extent (units), y: how far it follows the matter's radius, z: whether it turns with the structure, w: how far the disordered flow tears it
uniform vec4 uPlace;
// x: lean of the crests, y: stereo stretch, z: lateral tilt, w: how much the world's fronts lift it
uniform vec4 uShape;
// x: light, y: sharpness of the nodal lines, z: point size, w: pixel ratio
uniform vec4 uShow;
uniform float uWave;
uniform float uAxial;
// How unevenly the surface is lit (rough, noisy sound): each point keeps its own share.
uniform float uGrain;
varying float vHeight;
varying float vNode;
varying float vLight;

void main() {
  vec2 uv = position.xy;
  vec2 height = surfaceHeight(uv);
  float size = uPlace.x * mix(1.0, F_RADIUS, uPlace.y);
  // A leaning cycle tilts the crests along the surface.
  vec2 at = uv * (1.0 + uShape.x * height.x);
  vec3 P = vec3(at.x * size * (1.0 + uShape.y), at.y * size, (height.x + uShape.z * uv.x) * size);
  float turn = F_TURN * uPlace.z, c = cos(turn), s = sin(turn);
  P = vec3(c * P.x - s * P.y, s * P.x + c * P.y, P.z);
  // Laid along the axis, the membrane's own normal is the world's vertical.
  vec3 normal = uAxial > 0.5 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  if (uAxial > 0.5) P = vec3(P.x, P.z, -P.y);
  P.x += F_LATERAL * uPlace.y;
  vec3 q = P * F_TURBULENCE_SCALE + vec3(F_PHASE, F_PHASE * 0.7 + 1.3, F_PHASE * 1.3 + 2.1);
  P += abc(q) * (0.6 * F_TURBULENCE * uPlace.w);
  // The world's fronts cross the membrane: they push it aside and lift it where they pass.
  vec4 fronts = frontsAt(P, 0.5);
  P += (fronts.xyz + normal * (fronts.w * ${FRONT_LIFT})) * (uShape.w * uPlace.x);

  vHeight = clamp(abs(height.x) * 3.0, 0.0, 1.0);
  vNode = exp(-abs(height.y) * 20.0) * (0.25 + 0.75 * uShow.y);
  vLight = uShow.x * (1.0 - 0.6 * uGrain * fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453)) + fronts.w * uWave * uShape.w;
  vec4 mv = modelViewMatrix * vec4(P, 1.0);
  gl_Position = vLight > 0.002 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
  ${points ? 'gl_PointSize = clamp(uShow.z * uShow.w * (9.0 / max(2.0, -mv.z)), 1.0, 5.0 * uShow.w);' : ''}
}
`;

const fragmentShader = (points: boolean) => /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform float uExposure;
varying float vHeight;
varying float vNode;
varying float vLight;

void main() {
  ${points ? 'float d = length(gl_PointCoord - 0.5) * 2.0; float shape = exp(-d * d * 4.0);' : 'float shape = 1.0;'}
  float alpha = shape * (0.2 + vNode * 0.45 + vHeight * 0.35) * vLight * uExposure;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(mix(mix(uColorA, uColorB, vHeight), uColorC, vNode * 0.4), alpha);
}
`;

/** What the height law reads: the gains, the texture and the edge, as the primitive sets them each frame. */
export interface SurfaceShape {
  modal: number;
  pulse: number;
  bow: number;
  /** 1 = a disc held at its rim, 0 = a grid held at its sides. */
  rim: number;
  ripple: number;
  frequency: number;
  phase: number;
  terraces: number;
}

function pulseAt(x: number, y: number, ox: number, oy: number, age: number): number {
  const d = Math.sqrt((x - ox) * (x - ox) + (y - oy) * (y - oy)), behind = age * 1.4 - d;
  if (age < 0 || behind < 0) return 0;
  return Math.sin(behind * 18) * Math.exp(-behind * 5 - age * 1.3) / Math.sqrt(1 + d * 4);
}

/** Result of the CPU reference: the height and its modal part. Reused. */
export const heightOut = new Float64Array(2);

/**
 * CPU reference of the GLSL `surfaceHeight` at (x, y) in −1..1: `modes` and
 * `pulses` are the physics frame's, `time` the heard audio time.
 */
export function surfaceHeight(x: number, y: number, shape: Readonly<SurfaceShape>, modes: ArrayLike<number>, pulses: ArrayLike<number>, time: number): Float64Array {
  const qx = (x + 1) * 1.5707963, qy = (y + 1) * 1.5707963;
  let modal = 0;
  for (let i = 0; i < MODES; i++) modal += modes[i] * Math.sin(MODE_SHAPES[i][0] * qx) * Math.sin(MODE_SHAPES[i][1] * qy);
  let wave = 0;
  for (let i = 0; i < WAVES; i++) {
    const ox = pulses[i * 4], oy = pulses[i * 4 + 1], strength = pulses[i * 4 + 3];
    if (!(strength > 0)) continue;
    const age = time - pulses[i * 4 + 2];
    wave += strength * (pulseAt(x, y, ox, oy, age)
      - 0.55 * pulseAt(x, y, 2 - ox, oy, age) - 0.55 * pulseAt(x, y, -2 - ox, oy, age)
      - 0.55 * pulseAt(x, y, ox, 2 - oy, age) - 0.55 * pulseAt(x, y, ox, -2 - oy, age));
  }
  const r2 = x * x + y * y;
  let h = modal * shape.modal + wave * shape.pulse;
  h += shape.ripple * Math.sin(x * shape.frequency + shape.phase) * Math.sin(y * shape.frequency * 1.31 - shape.phase * 0.7);
  h += shape.bow * Math.max(0, 1 - r2);
  h += (Math.floor(h * TERRACES + 0.5) / TERRACES - h) * shape.terraces;
  const t = Math.min(1, Math.max(0, (Math.sqrt(r2) - RIM) / (1 - RIM)));
  const held = 1 + (1 - t * t * (3 - 2 * t) - 1) * shape.rim;
  heightOut[0] = h * held; heightOut[1] = modal * held;
  return heightOut;
}

/** Where the surface is sampled: xy in −1..1 per vertex (z unused), for points or for the two ends of each wire segment. */
export function surfaceVertices(options: Pick<SurfaceOptions, 'topology' | 'style'>, resolution: number): Float32Array {
  const out: number[] = [];
  const point = (u: number, v: number) => { out.push(u, v, 0); };
  if (options.topology === 'grid') {
    const at = (i: number) => 2 * i / resolution - 1;
    if (options.style === 'points') {
      for (let j = 0; j <= resolution; j++) for (let i = 0; i <= resolution; i++) point(at(i), at(j));
    } else {
      for (let j = 0; j <= resolution; j++) {
        for (let i = 0; i < resolution; i++) { point(at(i), at(j)); point(at(i + 1), at(j)); point(at(j), at(i)); point(at(j), at(i + 1)); }
      }
    }
    return new Float32Array(out);
  }
  const sectors = resolution * SECTORS;
  const polar = (ring: number, sector: number) => {
    const r = ring / resolution, angle = 2 * Math.PI * sector / sectors;
    point(r * Math.cos(angle), r * Math.sin(angle));
  };
  for (let ring = 1; ring <= resolution; ring++) {
    for (let sector = 0; sector < sectors; sector++) {
      polar(ring, sector);
      if (options.style === 'wire') polar(ring, sector + 1);
    }
  }
  if (options.style === 'wire') {
    const every = Math.max(1, Math.round(sectors / SPOKES));
    for (let sector = 0; sector < sectors; sector += every) {
      for (let ring = 1; ring < resolution; ring++) { polar(ring, sector); polar(ring + 1, sector); }
    }
  }
  return new Float32Array(out);
}

export class WaveSurfacePrimitive implements Primitive {
  readonly object: Object3D;
  readonly elements: number;
  readonly vertices: number;
  /** The height law's inputs this frame (also the CPU reference's). */
  readonly shape: SurfaceShape = { modal: 0, pulse: 0, bow: 0, rim: 0, ripple: 0, frequency: 12, phase: 0, terraces: 0 };
  readonly debug = { 'surface vertices': 0, 'surface relief': 0, terraces: 0 };
  private readonly material: ShaderMaterial;
  private readonly geometry = new BufferGeometry();
  private readonly modes = new Float32Array(MODES);
  private readonly pulses = Array.from({ length: WAVES }, () => new Vector4(0, 0, -100, 0));

  constructor(context: PrimitiveContext, private readonly options: SurfaceOptions, resolution: number) {
    const positions = surfaceVertices(options, resolution), points = options.style === 'points';
    this.geometry.setAttribute('position', new BufferAttribute(positions, 3));
    this.shape.rim = options.topology === 'polar' ? 1 : 0;
    this.material = new ShaderMaterial({
      vertexShader: vertexShader(points), fragmentShader: fragmentShader(points), transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending,
      uniforms: {
        uField: { value: context.uField }, uWaveA: { value: context.uWaveA }, uWaveB: { value: context.uWaveB },
        uModes: { value: this.modes }, uPulses: { value: this.pulses }, uTime: { value: 0 },
        uRelief: { value: new Vector4(0, 0, 0, this.shape.rim) }, uTexture: { value: new Vector4(0, 12, 0, 0) },
        uPlace: { value: new Vector4(options.size, options.follow, options.turn ? 1 : 0, 0) }, uShape: { value: new Vector4() },
        uShow: { value: new Vector4(0, 0, options.pointSize, 1) }, uWave: { value: 0 }, uExposure: { value: options.exposure }, uAxial: { value: options.plane === 'axial' ? 1 : 0 }, uGrain: { value: 0 },
        uColorA: { value: new Color() }, uColorB: { value: new Color() }, uColorC: { value: new Color() },
      },
    });
    const drawable = points ? new Points(this.geometry, this.material) : new LineSegments(this.geometry, this.material);
    drawable.frustumCulled = false;
    this.object = drawable;
    this.vertices = this.debug['surface vertices'] = positions.length / 3;
    this.elements = points ? this.vertices : this.vertices / 2;
  }

  setPalette([primary, secondary, highlight]: PaletteColors): void {
    const u = this.material.uniforms;
    (u.uColorA.value as Color).copy(primary); (u.uColorB.value as Color).copy(secondary); (u.uColorC.value as Color).copy(highlight);
  }

  update(frame: Readonly<WorldFrame>, presence: number): void {
    const { geometry: g, look, snapshot } = frame, o = this.options, u = this.material.uniforms, shape = this.shape, k = o.grammar;
    const physics = frame.timed ? snapshot?.physics : undefined;
    let ringing = 0;
    if (physics) {
      this.modes.set(physics.modes);
      for (let i = 0; i < WAVES; i++) this.pulses[i].fromArray(physics.waves, i * 4);
      u.uTime.value = frame.time;
      // The membrane keeps its light while it still rings after the sound.
      ringing = Math.min(0.6, physics.energy * 0.15) * look.gate;
    } else {
      // Without the audio clock nothing is dated: the membrane lies flat.
      this.modes.fill(0);
      for (const pulse of this.pulses) pulse.set(0, 0, -100, 0);
    }
    // An elastic world rings further; stored potential draws the membrane taut.
    const elastic = 1 + k * ((0.45 + 0.75 * g.elasticity) * (1 - 0.35 * g.tension) - 1);
    shape.modal = o.relief * elastic;
    shape.pulse = o.relief * PULSE * elastic;
    // Sustained pressure bows the surface, the rounder the smoother its lines.
    shape.bow = k * 0.22 * g.surfaceDisplacement * (0.4 + 0.6 * g.curvature);
    // Roughness and noise ripple it: long ripples for low sound, fine ones for bright; they run only while the world moves.
    shape.ripple = k * 0.05 * g.surfaceRoughness;
    shape.frequency = 22 - 15 * g.waveScale;
    shape.phase = (shape.phase + Math.min(Math.max(frame.dt, 0), 0.1) * 9 * g.waveVelocity) % (200 * Math.PI);
    shape.terraces = k * g.stepping;
    (u.uRelief.value as Vector4).set(shape.modal, shape.pulse, shape.bow, shape.rim);
    (u.uTexture.value as Vector4).set(shape.ripple, shape.frequency, shape.phase, shape.terraces);
    // A release tears the surface with the disordered flow, and its wire lets go.
    (u.uPlace.value as Vector4).w = k * TURBULENCE_SHIFT * (1 + 3 * g.fracture);
    (u.uShape.value as Vector4).set(k * 0.25 * g.skew, 0.3 * g.stereoSpread, 0.12 * g.lateralBias, k);
    const whole = o.style === 'wire' ? 1 - 0.8 * g.fracture * k : 1;
    const show = u.uShow.value as Vector4;
    show.x = presence * whole * Math.max(look.emissive, ringing, look.ember);
    show.y = g.coherence;
    u.uWave.value = presence * look.wave;
    u.uGrain.value = k * look.grain;
    if (import.meta.env.DEV) { this.debug['surface relief'] = shape.modal; this.debug.terraces = shape.terraces; }
  }

  setPixelRatio(ratio: number): void {
    (this.material.uniforms.uShow.value as Vector4).w = ratio;
  }

  reset(): void {
    this.shape.phase = 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
