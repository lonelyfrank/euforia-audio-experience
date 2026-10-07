import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, LineSegments, Points, ShaderMaterial, Vector4, type Object3D, type Texture } from 'three';
import { deriveTopology } from '../../render-systems/fields/vectorField';
import { matterLayout } from '../../render-systems/particles/MatterSeeds';
import { seedTracers } from '../../render-systems/particles/TracerSeeds';
import { TracerSimulation } from '../../render-systems/particles/TracerSimulation';
import type { PaletteColors, QualityProfile } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';

/*
 * Tracers: what makes a vector field visible. They are not the field and they
 * carry no shape of their own: each one is a point of no size carried by
 * F(P) (render-systems/fields/vectorField.ts) with a little inertia, and what
 * is drawn of it is its motion, a streak from where it is back along its own
 * velocity. A tracer at rest draws next to nothing, so a quiet field is an
 * almost empty picture and a strong one is written in streamlines: circles
 * round the axis when the world turns, rays when it breathes, sheets when it
 * is ordered, knots where an eddy has woken, a ring of light where a front
 * passes. The state is the simulation's (GPU, ping-pong); the light is the
 * world's material.
 */

export interface TracerParams {
  /** Tracers at High quality. */
  tracers: number;
  /** Seconds of its own motion a tracer draws as a streak (longer when the sound leaves long traces). */
  streak: number;
  /** Size of a tracer's head (device-independent pixels at the rest distance). */
  pointSize: number;
  /** Light of one tracer at High quality (the picture is additive). */
  exposure: number;
}

export interface TracerQuality {
  count: number;
  /** Fewer tracers each carry more light. */
  exposure: number;
  /** Second turbulence octave. */
  detail: boolean;
  /** Visual memory: half resolution, or none. */
  feedback: 'half' | 'off';
}

/** Fewer tracers at lower quality, the same field; Low drops the second turbulence octave and the memory pass. */
export function tracerQuality(params: TracerParams, quality: QualityProfile): TracerQuality {
  const density = Math.min(1, Math.max(0.1, quality.density));
  return {
    count: Math.round(params.tracers * density), exposure: params.exposure / Math.sqrt(density),
    detail: density >= 0.6, feedback: density >= 0.6 ? 'half' : 'off',
  };
}

/** Light of a tracer that does not move, relative to one at full speed: the dust the field is seeded with. */
const DUST = 0.1;
/** Speed (units/s) at which a streak has half its light, and the longest a streak is drawn (units). */
const HALF_SPEED = 0.35;
const LONGEST = 0.45;

const common = /* glsl */ `
  uniform sampler2D tPosition;
  uniform sampler2D tVelocity;
  uniform sampler2D tHome;
  uniform sampler2D tTrait;
  uniform int uWidth;
  // x: light of motion, y: light of a tracer at rest, z: seconds of motion a streak shows, w: share of the tracers shown
  uniform vec4 uShow;
  // x: light of the energy the fronts left, y: sparks, z: a clock for the sparks, w: how far the palette leans to its second hue
  uniform vec4 uGlow;
  uniform float uExposure;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  varying vec3 vColor;

  ivec2 texel(int index) { return ivec2(index % uWidth, index / uWidth); }
  // A newly formed tracer fades in; one about to re-form fades out.
  float life(float age) { return smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.85, 1.0, age)); }
  vec3 hue(float affinity, float lit) {
    return mix(mix(uColorA, uColorB, clamp(affinity + uGlow.w, 0.0, 1.0)), uColorC, clamp(lit, 0.0, 1.0));
  }
`;

const streakVertex = /* glsl */ `
  ${common}
  void main() {
    ivec2 ref = texel(gl_VertexID / 2);
    float tail = float(gl_VertexID % 2);
    vec4 pos = texelFetch(tPosition, ref, 0);
    vec4 vel = texelFetch(tVelocity, ref, 0);
    vec4 home = texelFetch(tHome, ref, 0);
    vec4 trait = texelFetch(tTrait, ref, 0);
    float speed = length(vel.xyz);
    float energy = min(pos.w, 2.0);
    float alive = life(vel.w) * step(trait.z, uShow.w);
    // As long as the tracer has just moved, as bright as it is fast, fading towards where it came from.
    float heat = speed / (speed + ${HALF_SPEED});
    float amount = (uShow.x * heat + uGlow.x * energy * 0.12) * alive * (1.0 - 0.9 * tail) * smoothstep(0.0, 0.03, speed);
    vColor = hue(home.w, energy * 0.5 * uGlow.x) * (amount * uExposure);
    vec3 P = pos.xyz - vel.xyz * (min(uShow.z, ${LONGEST} / max(speed, 1e-4)) * tail);
    gl_Position = amount > 0.002 ? projectionMatrix * modelViewMatrix * vec4(P, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const streakFragment = /* glsl */ `
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

const headVertex = /* glsl */ `
  ${common}
  uniform float uSize;
  uniform float uPixelRatio;
  void main() {
    ivec2 ref = texel(gl_VertexID);
    vec4 pos = texelFetch(tPosition, ref, 0);
    vec4 vel = texelFetch(tVelocity, ref, 0);
    vec4 home = texelFetch(tHome, ref, 0);
    vec4 trait = texelFetch(tTrait, ref, 0);
    float affinity = home.w;
    float speed = length(vel.xyz);
    float energy = min(pos.w, 2.0);
    float alive = life(vel.w) * step(trait.z, uShow.w);
    // Sparks: a changing subset of the bright-leaning tracers, only while the shimmer field is excited.
    float flicker = step(0.8, fract(sin(trait.x * 91.7 + floor(uGlow.z) * 12.9898) * 43758.5453));
    float spark = uGlow.y * affinity * affinity * flicker;
    float wave = uGlow.x * energy * 0.3;
    float body = uShow.y * (0.4 + 0.6 * affinity) + uShow.x * 0.4 * speed / (speed + ${HALF_SPEED});
    vColor = hue(affinity, spark * 2.0 + wave * 0.5) * ((body + spark + wave) * alive * uExposure);
    vec4 mv = modelViewMatrix * vec4(pos.xyz, 1.0);
    float size = uSize * (0.8 + 0.5 * (1.0 - affinity)) * (1.0 + 0.7 * min(energy, 1.5));
    gl_PointSize = clamp(size * uPixelRatio * (4.0 / max(-mv.z, 0.5)), 1.0, 8.0 * uPixelRatio);
    gl_Position = (body + spark + wave) * alive > 0.002 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const headFragment = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float glow = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vColor * glow * glow, 1.0);
  }
`;

export class FieldTracerPrimitive implements Primitive {
  readonly object: Object3D = new Group();
  readonly simulation: TracerSimulation;
  readonly elements: number;
  readonly vertices: number;
  /** Tracers, the field's topology as packed this frame, sub-steps. */
  readonly debug = { tracers: 0, eddies: 0, eddy: 0, shells: 0, 'tracer steps': 0 };
  /** What the shaders read this frame: light of motion, of rest, of the fronts; streak seconds. */
  readonly state = { motion: 0, rest: 0, fronts: 0, streak: 0 };
  private readonly streaks: ShaderMaterial;
  private readonly heads: ShaderMaterial;
  private readonly geometries: BufferGeometry[] = [];

  /** `topology`: the packed topology of the world's vector field; this primitive derives it each frame, everything else of the scene reads it. */
  constructor(context: PrimitiveContext, quality: TracerQuality, private readonly params: TracerParams, private readonly topology: Float32Array) {
    const seeds = seedTracers(matterLayout(quality.count), context.seed);
    this.simulation = new TracerSimulation(context.renderer, seeds, quality.detail, { uField: context.uField, uWaveA: context.uWaveA, uWaveB: context.uWaveB, topology });
    const s = this.simulation, count = seeds.layout.count;
    const shared = {
      tPosition: { value: null as Texture | null }, tVelocity: { value: null as Texture | null }, tHome: { value: s.homes }, tTrait: { value: s.traits },
      uWidth: { value: seeds.layout.width }, uShow: { value: new Vector4(0, 0, 0, 1) }, uGlow: { value: new Vector4() }, uExposure: { value: quality.exposure },
      uColorA: { value: new Color() }, uColorB: { value: new Color() }, uColorC: { value: new Color() },
    };
    const options = { transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending };
    this.streaks = new ShaderMaterial({ ...options, vertexShader: streakVertex, fragmentShader: streakFragment, uniforms: shared });
    this.heads = new ShaderMaterial({ ...options, vertexShader: headVertex, fragmentShader: headFragment, uniforms: { ...shared, uSize: { value: params.pointSize }, uPixelRatio: { value: 1 } } });
    this.object.add(this.drawable(new LineSegments(this.counted(count * 2), this.streaks)), this.drawable(new Points(this.counted(count), this.heads)));
    this.elements = this.debug.tracers = count;
    this.vertices = count * 3;
  }

  setPalette([primary, secondary, highlight]: PaletteColors): void {
    const u = this.streaks.uniforms;
    (u.uColorA.value as Color).copy(primary); (u.uColorB.value as Color).copy(secondary); (u.uColorC.value as Color).copy(highlight);
  }

  update(frame: Readonly<WorldFrame>, presence: number): void {
    const { geometry: g, fields, look } = frame, topology = deriveTopology(this.topology, g, fields);
    const steps = this.simulation.step(frame.dt);
    // Shared uniform objects: the heads see what the streaks see.
    const u = this.streaks.uniforms, state = this.state;
    u.tPosition.value = this.simulation.positions; u.tVelocity.value = this.simulation.velocities;
    // The world's light shows the field, it does not move it; what cools down keeps an ember.
    state.motion = presence * Math.max(look.emissive, look.ember);
    state.rest = presence * DUST * look.emissive;
    state.fronts = presence * look.wave;
    state.streak = this.params.streak * (0.5 + g.trailPersistence);
    (u.uShow.value as Vector4).set(state.motion, state.rest, state.streak, look.opacity);
    (u.uGlow.value as Vector4).set(state.fronts, presence * look.spark, frame.time * 14, 0.6 * (look.blend - 0.5));
    if (import.meta.env.DEV) {
      const d = this.debug;
      d.eddy = topology[0]; d.eddies = topology[1]; d.shells = topology[2]; d['tracer steps'] = steps;
    }
  }

  setPixelRatio(ratio: number): void {
    this.heads.uniforms.uPixelRatio.value = ratio;
  }

  /** The tracers stay where the last session left them: they are carried on by whatever field the new one makes. */
  reset(): void {}

  dispose(): void {
    this.simulation.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    this.streaks.dispose();
    this.heads.dispose();
    this.object.clear();
  }

  /** A geometry that only sets how many vertices are drawn (positions come from the simulation). */
  private counted(vertices: number): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices * 3), 3));
    this.geometries.push(geometry);
    return geometry;
  }

  private drawable<T extends Points | LineSegments>(object: T): T {
    object.frustumCulled = false;
    return object;
  }
}
