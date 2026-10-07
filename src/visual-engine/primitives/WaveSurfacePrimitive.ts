import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, LineSegments, Points, ShaderMaterial, Vector3, Vector4, type Object3D } from 'three';
import { unit } from '../../experience/types';
import { MODE_SHAPES, MODES, WAVES } from '../../physics/ResonantPhysics';
import { fieldHeaderGlsl } from '../../render-systems/fields/fieldLaw';
import { flowLawGlsl, TURBULENCE_SHIFT } from '../../render-systems/fields/flowLaw';
import type { PaletteColors, QualityProfile } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';
import { ModalMemory } from './ModalMemory';

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
 *
 * A membrane can keep its own past round it as shells (`shells`, off unless
 * asked for; docs/spectral-shell.md): each shell is the same membrane as it
 * rang a moment ago (its modes from a memory on the audio clock, its pulses
 * at that earlier time), larger with its age and bent into a cap round the
 * live one, alternately above and below it. A shell is left where the
 * structure was when it sounded: a turning world twists the stack, a moving
 * centre trails it. The shell law is written twice like the height law.
 */

/** A membrane's past, kept round it as shells. */
export interface ShellOptions {
  /** Shells round the live membrane (0 = none). */
  count: number;
  /** Age of the oldest shell (s of audio time). */
  span: number;
  /** Rings of a shell relative to the live membrane's. */
  detail: number;
}

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
  /** The membrane's past as shells round it (none by default). */
  shells?: ShellOptions;
}

/**
 * The resonant disc: a membrane held at its rim, drawn as the wire of its rings and spokes, lying through the body
 * along the world's axis so its height reads as height. The circular graph inside Matter Field, and Spectral
 * Shell's live membrane: one definition for both.
 */
export const RESONANT_DISC = {
  topology: 'polar', style: 'wire', plane: 'axial', size: 1.35, follow: 1, turn: true, grammar: 1, relief: 1.2, pointSize: 2, exposure: 0.6,
} as const satisfies Omit<SurfaceOptions, 'resolution'>;

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
/** How the age of shell k of n is spread over the span: the first ones follow the membrane closely, the last are its memory. */
const AGE_CURVE = 1.6;
/** Radius the oldest shell gains over the live membrane in a fully open world (× its size), and how much a release adds. */
const SHELL_SPREAD = 0.85;
const RELEASE_SPREAD = 1.2;
/** The oldest shell's bend at full closure (rad: a hemisphere), and the share of it the youngest has. */
const SHELL_BEND = 1.5707963;
const YOUNG_BEND = 0.55;
/**
 * A shell is left where the structure was. Its turn back per second of age and unit of vortex is stylised (the
 * structure itself turns a fifth as fast: the twist would not read); its lateral lag is the centre's own velocity.
 */
const SHELL_TORSION = 0.5;
const SHELL_LAG = 1.5;
/** How much more the disordered flow has torn the oldest shell than the live membrane. */
const SHELL_TEAR = 2;
/** Light the oldest shell has lost, and how much of what lies behind the structure's centre the depth takes. */
const SHELL_FADE = 0.7;
const DEPTH_FADE = 0.6;
/** Share of the span over which the shells beyond the reach fade out (also the least reach: the youngest shells always show). */
const REACH_EDGE = 0.35;
/** Height of the fine ripple a unit of shimmer raises (× the size). */
const SHIMMER_RIPPLE = 0.05;

/** Age (s) of shell `k` of `count` (k = 0 is the live membrane) and its share of the span, 0..1. */
export function shellAge(k: number, count: number, span: number): number {
  return count > 0 ? span * Math.pow(k / count, AGE_CURVE) : 0;
}

/** The modal sum written out: one sine per wave number and axis, then a product per mode (no array of mode numbers on the GPU). */
const ORDERS = Math.max(...MODE_SHAPES.flat());
const modalSum = MODE_SHAPES.map(([m, n], i) => `uModes[base + ${i}] * sx[${m - 1}] * sy[${n - 1}]`).join(' + ');

const law = (layers: number) => /* glsl */ `
#define DETAIL 0
#define LAYERS ${layers}
${fieldHeaderGlsl}
${flowLawGlsl}
uniform float uModes[${MODES * layers}];
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
// \`layer\` picks whose modes (0 = the live membrane), \`delay\` how long ago its pulses are read (s).
vec2 surfaceHeight(vec2 p, int layer, float delay) {
  int base = layer * ${MODES};
  vec2 q = (p + 1.0) * 1.5707963;
  float sx[${ORDERS}];
  float sy[${ORDERS}];
  for (int k = 0; k < ${ORDERS}; k++) { sx[k] = sin(float(k + 1) * q.x); sy[k] = sin(float(k + 1) * q.y); }
  float modal = ${modalSum};
  float wave = 0.0;
  for (int i = 0; i < ${WAVES}; i++) {
    vec4 w = uPulses[i];
    if (w.w <= 0.0) continue;
    float age = uTime - delay - w.z;
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

#if LAYERS > 1
// x: age (s), y: share of the span 0..1, z: side (+1 above the membrane, −1 below), per layer; layer 0 is the live membrane.
uniform vec3 uLayer[LAYERS];
// x: radius the oldest shell gains (× the size), y: its bend (rad), z: turn back per second of age and unit of vortex, w: lateral lag per second of age and unit of drift
uniform vec4 uShell;

// A shell: the disc bent into the cap of a sphere through its rim. The rim (radius \`a\`) stays in the membrane's plane,
// the pole rises a·tan(bend / 2) off it on its \`side\`; the height \`h\` displaces along the cap's own normal.
vec3 shellPoint(vec2 at, float h, float a, float bend, float side) {
  float r = length(at);
  vec2 dir = r > 1e-6 ? at / r : vec2(0.0);
  float b = max(bend, 1e-3), sb = sin(b), sn = sin(r * b), cs = cos(r * b);
  return vec3(dir * (a * sn / sb + sn * h), side * (a * (cs - cos(b)) / sb + cs * h));
}
#endif
`;

const vertexShader = (points: boolean, layers: number) => /* glsl */ `
${law(layers)}
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
#if LAYERS > 1
// x: light the oldest shell has lost, y: how far back the shells show in full (share of the span; they fade out beyond), z: fine ripple per unit of shimmer, w: how much depth dims
uniform vec4 uEcho;
#endif
varying float vHeight;
varying float vNode;
varying float vLight;

void main() {
  vec2 uv = position.xy;
#if LAYERS > 1
  int layer = int(position.z + 0.5);
  vec3 echo = uLayer[layer];
  vec2 height = surfaceHeight(uv, layer, echo.x);
  // Shimmer is fine detail on the whole structure; its phase advances only with the world's activity.
  float held = 1.0 - smoothstep(${RIM}, 1.0, length(uv));
  height.x += uEcho.z * F_SHIMMER * held * sin(uv.x * 47.0 + F_PHASE * 7.0) * sin(uv.y * 53.0 - F_PHASE * 5.0);
#else
  vec2 height = surfaceHeight(uv, 0, 0.0);
#endif
  float size = uPlace.x * mix(1.0, F_RADIUS, uPlace.y);
  // A leaning cycle tilts the crests along the surface.
  vec2 at = uv * (1.0 + uShape.x * height.x);
  vec3 P = vec3(at.x * size * (1.0 + uShape.y), at.y * size, (height.x + uShape.z * uv.x) * size);
  float turn = F_TURN * uPlace.z, tear = uPlace.w;
#if LAYERS > 1
  if (layer > 0) {
    P = shellPoint(at, (height.x + uShape.z * uv.x) * size, size * (1.0 + uShell.x * echo.y), uShell.y * mix(${YOUNG_BEND}, 1.0, echo.y), echo.z);
    P.x *= 1.0 + uShape.y;
    // Left where the structure was when it sounded: turned back, and the longer in the disordered flow the more torn.
    turn -= uShell.z * F_VORTEX * echo.x;
    tear *= 1.0 + ${SHELL_TEAR}.0 * echo.y;
  }
#endif
  float c = cos(turn), s = sin(turn);
  P = vec3(c * P.x - s * P.y, s * P.x + c * P.y, P.z);
  // Laid along the axis, the membrane's own normal is the world's vertical.
  vec3 normal = uAxial > 0.5 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  if (uAxial > 0.5) P = vec3(P.x, P.z, -P.y);
  P.x += F_LATERAL * uPlace.y;
#if LAYERS > 1
  P.x -= uShell.w * F_DRIFT * echo.x * uPlace.y;
#endif
  vec3 q = P * F_TURBULENCE_SCALE + vec3(F_PHASE, F_PHASE * 0.7 + 1.3, F_PHASE * 1.3 + 2.1);
  P += abc(q) * (0.6 * F_TURBULENCE * tear);
  // The world's fronts cross the membrane: they push it aside and lift it where they pass.
  vec4 fronts = frontsAt(P, 0.5);
  P += (fronts.xyz + normal * (fronts.w * ${FRONT_LIFT})) * (uShape.w * uPlace.x);

  vHeight = clamp(abs(height.x) * 3.0, 0.0, 1.0);
  vNode = exp(-abs(height.y) * 20.0) * (0.25 + 0.75 * uShow.y);
  vLight = uShow.x * (1.0 - 0.6 * uGrain * fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453)) + fronts.w * uWave * uShape.w;
  vec4 mv = modelViewMatrix * vec4(P, 1.0);
#if LAYERS > 1
  // Older shells are fainter and the oldest show only while the sound leaves long traces; what lies behind the centre is dimmer.
  vLight *= (1.0 - uEcho.x * echo.y) * (1.0 - smoothstep(uEcho.y, uEcho.y + ${REACH_EDGE}, echo.y));
  float centre = -(modelViewMatrix * vec4(F_LATERAL * uPlace.y, 0.0, 0.0, 1.0)).z;
  vLight *= 1.0 - uEcho.w * smoothstep(-0.2, 1.0, (-mv.z - centre) / (size * (1.0 + uShell.x)));
#endif
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

/** Result of the CPU reference of the shell law: a point in the membrane's own frame (xy its plane, z its normal). Reused. */
export const shellOut = new Float64Array(3);

/**
 * CPU reference of the GLSL `shellPoint`: the point (x, y) of the disc on a shell of rim radius `a`, bent by `bend`
 * (rad) to its `side` (±1) of the membrane, displaced by the height `h` (units) along the cap's normal.
 */
export function shellPoint(x: number, y: number, h: number, a: number, bend: number, side: number): Float64Array {
  const r = Math.sqrt(x * x + y * y), dx = r > 1e-6 ? x / r : 0, dy = r > 1e-6 ? y / r : 0;
  const b = Math.max(bend, 1e-3), sb = Math.sin(b), sn = Math.sin(r * b), cs = Math.cos(r * b);
  const lateral = a * sn / sb + sn * h;
  shellOut[0] = dx * lateral; shellOut[1] = dy * lateral; shellOut[2] = side * (a * (cs - Math.cos(b)) / sb + cs * h);
  return shellOut;
}

/** How the shells stand round the membrane this frame, as the primitive sets it (also the CPU reference's input). */
export interface ShellShape {
  /** Radius the oldest shell gains over the live membrane (× its size). */
  spread: number;
  /** Bend of the oldest shell (rad). */
  bend: number;
  /** How far back the shells show in full, as a share of the span (beyond it they fade out). */
  reach: number;
}

/** Rim radius (× the membrane's size) and bend (rad) of the shell at `share` of the span. */
export function shellRadius(shape: Readonly<ShellShape>, share: number): number {
  return 1 + shape.spread * share;
}
export function shellBend(shape: Readonly<ShellShape>, share: number): number {
  return shape.bend * (YOUNG_BEND + (1 - YOUNG_BEND) * share);
}

/**
 * Where the surface is sampled: xy in −1..1 per vertex, for points or for the two ends of each wire segment;
 * z is the layer the vertex belongs to (0 = the membrane itself).
 */
export function surfaceVertices(options: Pick<SurfaceOptions, 'topology' | 'style'>, resolution: number, layer = 0, out: number[] = []): Float32Array {
  const point = (u: number, v: number) => { out.push(u, v, layer); };
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
  /** How the shells stand this frame (zero without shells). */
  readonly shells: ShellShape = { spread: 0, bend: 0, reach: 0 };
  /** Layers drawn: the membrane and its shells. */
  readonly layers: number;
  readonly debug: Record<string, number> = { 'surface vertices': 0, 'surface relief': 0, terraces: 0 };
  private readonly material: ShaderMaterial;
  private readonly geometry = new BufferGeometry();
  /** The modes of every layer: the live ones, then each shell's as the memory gives them. */
  private readonly modes: Float32Array;
  private readonly pulses = Array.from({ length: WAVES }, () => new Vector4(0, 0, -100, 0));
  private readonly memory: ModalMemory | null = null;
  private readonly ages: Float32Array;

  constructor(context: PrimitiveContext, private readonly options: SurfaceOptions, resolution: number) {
    const points = options.style === 'points', shells = Math.max(0, Math.round(options.shells?.count ?? 0)), layers = this.layers = 1 + shells;
    const vertices: number[] = [];
    surfaceVertices(options, resolution, 0, vertices);
    const layer = Array.from({ length: layers }, () => new Vector3(0, 0, 1));
    this.ages = new Float32Array(layers);
    if (options.shells && shells > 0) {
      const { span, detail } = options.shells, coarse = Math.max(8, Math.round(resolution * detail));
      this.memory = new ModalMemory(span);
      for (let k = 1; k <= shells; k++) {
        surfaceVertices(options, coarse, k, vertices);
        // Shells alternate above and below the membrane, so its past closes round it.
        layer[k].set(this.ages[k] = shellAge(k, shells, span), k / shells, k % 2 === 1 ? 1 : -1);
      }
    }
    const positions = new Float32Array(vertices);
    this.modes = new Float32Array(MODES * layers);
    this.geometry.setAttribute('position', new BufferAttribute(positions, 3));
    this.shape.rim = options.topology === 'polar' ? 1 : 0;
    this.material = new ShaderMaterial({
      vertexShader: vertexShader(points, layers), fragmentShader: fragmentShader(points), transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending,
      uniforms: {
        uLayer: { value: layer }, uShell: { value: new Vector4() }, uEcho: { value: new Vector4() },
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
    const physics = frame.timed ? snapshot?.physics : undefined, memory = this.memory;
    let ringing = 0;
    if (physics) {
      this.modes.set(physics.modes);
      if (memory) {
        // Each shell is the membrane as it rang its age ago: the pulses are dated, the modes are remembered.
        memory.record(frame.time, physics.modes);
        for (let k = 1; k < this.layers; k++) memory.read(this.ages[k], this.modes, k * MODES);
      }
      for (let i = 0; i < WAVES; i++) this.pulses[i].fromArray(physics.waves, i * 4);
      u.uTime.value = frame.time;
      // The membrane keeps its light while it still rings after the sound.
      ringing = Math.min(0.6, physics.energy * 0.15) * look.gate;
    } else {
      // Without the audio clock nothing is dated: the membrane lies flat.
      this.modes.fill(0);
      memory?.clear();
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
    if (memory) {
      const shells = this.shells;
      // An open, wide world holds its past further out and stored potential draws it in; a release throws the shells apart.
      shells.spread = SHELL_SPREAD * (0.4 + 0.6 * g.particleSpread) * (1 - 0.4 * g.tension) * (1 + RELEASE_SPREAD * g.fracture);
      // Round sound and stored potential close the shells round the membrane; a release lays them open.
      shells.bend = SHELL_BEND * unit(0.3 + 0.3 * g.curvature + 0.45 * g.tension - 0.4 * g.fracture);
      // Steady, coherent sound leaves long traces: its oldest shells still show.
      shells.reach = REACH_EDGE + 0.9 * g.trailPersistence;
      (u.uShell.value as Vector4).set(shells.spread, shells.bend, SHELL_TORSION, SHELL_LAG);
      (u.uEcho.value as Vector4).set(SHELL_FADE, shells.reach, SHIMMER_RIPPLE, DEPTH_FADE * look.depthFade);
    }
    if (import.meta.env.DEV) {
      this.debug['surface relief'] = shape.modal; this.debug.terraces = shape.terraces;
      if (memory) { this.debug['shell spread'] = this.shells.spread; this.debug['shell bend'] = this.shells.bend; this.debug['shell reach'] = this.shells.reach; }
    }
  }

  setPixelRatio(ratio: number): void {
    (this.material.uniforms.uShow.value as Vector4).w = ratio;
  }

  reset(): void {
    this.shape.phase = 0;
    this.memory?.clear();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
