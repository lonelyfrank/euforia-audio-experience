import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, LineSegments, Points, ShaderMaterial, Vector3, Vector4, type Object3D } from 'three';
import { fieldHeaderGlsl, FIELD } from '../../render-systems/fields/fieldLaw';
import { flowLawGlsl, frontsAt, settle } from '../../render-systems/fields/flowLaw';
import { Rng, seedOf } from '../../show/rng';
import type { PaletteColors, QualityProfile } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';

/*
 * A connection graph: nodes of the world's body and the joints between them.
 * The nodes are spread evenly over two shells (a lattice when the sound is
 * ordered, scattered off it when it is not) and rest where the fields hold
 * that part of the body, so they turn, flatten, tighten and drift with the
 * matter. Two nodes are joined while they are closer than the geometry's
 * connection radius: ordered, related sound closes a cage of polygons round
 * the matter; turbulence carries the nodes apart and the joints let go;
 * a passing front or a release tears the cage open, and it closes again by
 * itself as the world settles. Nothing connects or disconnects by decision:
 * a joint shows for as long as it holds. Stateless, like the filaments.
 *
 * The law is written twice (GLSL and the CPU reference below).
 */

export interface GraphParams {
  /** Nodes at High quality. */
  nodes: number;
}

export function graphNodes(params: GraphParams, quality: QualityProfile): number {
  return Math.max(16, Math.round(params.nodes * Math.min(1, Math.max(0.1, quality.density))));
}

/** Share of the nodes on the outer shell, the layers of the two shells and how far outside the matter the cage sits. */
const OUTER_SHARE = 0.62;
const OUTER_LAYER = 0.95;
const INNER_LAYER = 0.5;
export const CAGE = 1.08;
/** Joints kept as candidates: up to this many times the typical distance between neighbours. */
const REACH = 1.8;
const MAX_EDGES = 1200;
/** Connection radius 0 joins nothing (below the nearest neighbours); 1 reaches the second neighbours. */
const CLOSED = 0.3;
/** How far a node of a disordered world sits off the lattice (× radius), and how far a release throws it (× its own share). */
const SCATTER = 0.16;
const BURST = 0.5;
const EXPOSURE = 0.3;
/** A joint longer than this share of the reach carries the same light over more length. */
const THIN = 0.45;

const law = /* glsl */ `
#define DETAIL 0
${fieldHeaderGlsl}
${flowLawGlsl}
// x: order (1 = on the lattice), y: fracture, z: connection radius (units), w: light
uniform vec4 uGraph;

// A unit-ish direction from a node's own number: where it sits off the lattice.
vec3 scatter(float seed) {
  return vec3(sin(seed * 91.7), sin(seed * 57.3 + 1.9), sin(seed * 33.1 + 4.2));
}

// xyz: where a node is; w: how much of the fronts is passing through it.
vec4 nodePoint(vec4 home, float seed) {
  vec3 P = settle(home, ${CAGE} * (1.0 + ${BURST} * uGraph.y * seed));
  P += scatter(seed) * (${SCATTER} * F_RADIUS * (1.0 - uGraph.x));
  vec4 fronts = frontsAt(P, home.w);
  return vec4(P + fronts.xyz, fronts.w);
}
`;

const edgeVertex = /* glsl */ `
${law}
attribute vec4 aNode;
attribute vec4 aMate;
attribute vec2 aSeed;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform float uWave;
// How far the palette leans to its second hue (bright sound) or its first (low sound), about 0.
uniform float uBlend;
varying vec3 vColor;

void main() {
  vec4 P = nodePoint(aNode, aSeed.x);
  vec4 M = nodePoint(aMate, aSeed.y);
  // A joint shows while it holds: it lets go as its two nodes move apart.
  float len = distance(P.xyz, M.xyz);
  float held = (1.0 - smoothstep(0.82 * uGraph.z, uGraph.z, len)) * min(1.0, ${THIN} * uGraph.z / max(len, 1e-4));
  float amount = uGraph.w * held;
  vColor = (mix(uColorA, uColorB, clamp(aNode.w + uBlend, 0.0, 1.0)) * amount + uColorC * (P.w * uWave * held)) * ${EXPOSURE};
  gl_Position = amount > 0.002 ? projectionMatrix * modelViewMatrix * vec4(P.xyz, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const nodeVertex = /* glsl */ `
${law}
attribute vec4 aNode;
attribute vec2 aSeed;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform float uWave;
// x: point size (device-independent pixels at the rest distance), y: pixel ratio, z: the world's last impact
uniform vec3 uNode;
varying vec3 vColor;

void main() {
  vec4 P = nodePoint(aNode, aSeed.x);
  float lit = P.w * uWave + uNode.z;
  vColor = mix(uColorB, uColorC, clamp(lit, 0.0, 1.0)) * (uGraph.w * (0.7 + lit)) * ${EXPOSURE};
  vec4 mv = modelViewMatrix * vec4(P.xyz, 1.0);
  gl_PointSize = clamp(uNode.x * (1.0 + 0.8 * lit) * uNode.y * (4.0 / max(-mv.z, 0.5)), 1.0, 12.0 * uNode.y);
  gl_Position = uGraph.w > 0.002 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const edgeFragment = /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;

const nodeFragment = /* glsl */ `
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  float glow = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vColor * glow * glow, 1.0);
}
`;

/** The lattice: nodes (xyz = direction × layer, w = band affinity), each one's own number, and the candidate joints. */
export interface GraphSeeds {
  count: number;
  home: Float32Array;
  seed: Float32Array;
  /** Pairs of node indices, shortest first. */
  edges: Uint16Array;
  /** Longest candidate joint at rest (units at radius 1): the connection radius is a share of it. */
  reach: number;
}

/** Deterministic: the same count and seed give the same lattice. */
export function seedGraph(count: number, seed: number): GraphSeeds {
  const rng = new Rng(seedOf(seed, 0x67726170));
  const home = new Float32Array(count * 4), own = new Float32Array(count);
  const outer = Math.max(4, Math.round(count * OUTER_SHARE)), golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    // An even spiral over each shell (the inner one turned against the outer).
    const onOuter = i < outer, n = onOuter ? outer : count - outer, k = onOuter ? i : i - outer;
    const z = 1 - 2 * (k + 0.5) / n, s = Math.sqrt(1 - z * z), angle = k * golden + (onOuter ? 0 : 1.7);
    const layer = onOuter ? OUTER_LAYER : INNER_LAYER;
    home[i * 4] = s * Math.cos(angle) * layer; home[i * 4 + 1] = s * Math.sin(angle) * layer; home[i * 4 + 2] = z * layer;
    home[i * 4 + 3] = onOuter ? 0.35 + 0.3 * rng.next() : 0.65 + 0.3 * rng.next();
    own[i] = rng.next();
  }
  // Rest positions as the fields hold loose matter at radius 1 (see layerRadius): candidates are the near pairs.
  const rest = (i: number, c: number): number => home[i * 4 + c] / (i < outer ? OUTER_LAYER : INNER_LAYER) * (0.3 + 0.95 * (i < outer ? OUTER_LAYER : INNER_LAYER));
  const reach = REACH * (0.3 + 0.95 * OUTER_LAYER) * Math.sqrt(4 * Math.PI / outer);
  const pairs: [number, number, number][] = [];
  for (let a = 0; a < count; a++) {
    for (let b = a + 1; b < count; b++) {
      const d = Math.hypot(rest(a, 0) - rest(b, 0), rest(a, 1) - rest(b, 1), rest(a, 2) - rest(b, 2));
      if (d < reach) pairs.push([d, a, b]);
    }
  }
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  const kept = Math.min(pairs.length, MAX_EDGES), edges = new Uint16Array(kept * 2);
  for (let e = 0; e < kept; e++) { edges[e * 2] = pairs[e][1]; edges[e * 2 + 1] = pairs[e][2]; }
  return { count, home, seed: own, edges, reach };
}

/** Result of the CPU reference: the node xyz and the fronts passing through it. Reused. */
export const nodeOut = new Float64Array(4);

/** CPU reference of the GLSL `nodePoint` for node `i`: `order` and `fracture` as the primitive sets them. */
export function nodePoint(seeds: GraphSeeds, i: number, order: number, fracture: number, f: Float32Array, waveA: Float32Array, waveB: Float32Array): Float64Array {
  const at = i * 4, own = seeds.seed[i];
  const p = settle(seeds.home[at], seeds.home[at + 1], seeds.home[at + 2], CAGE * (1 + BURST * fracture * own), f);
  const off = SCATTER * f[FIELD.radius] * (1 - order);
  const x = p[0] + Math.sin(own * 91.7) * off, y = p[1] + Math.sin(own * 57.3 + 1.9) * off, z = p[2] + Math.sin(own * 33.1 + 4.2) * off;
  const fronts = frontsAt(x, y, z, seeds.home[at + 3], waveA, waveB);
  nodeOut[0] = x + fronts[0]; nodeOut[1] = y + fronts[1]; nodeOut[2] = z + fronts[2]; nodeOut[3] = fronts[3];
  return nodeOut;
}

/** How long a joint may be and still hold (units), for a connection radius 0..1. */
export function jointReach(seeds: GraphSeeds, connectionRadius: number, radius: number): number {
  return seeds.reach * CAGE * radius * (CLOSED + (1 - CLOSED) * connectionRadius);
}

export class ConnectionGraphPrimitive implements Primitive {
  readonly object: Object3D = new Group();
  readonly seeds: GraphSeeds;
  readonly elements: number;
  readonly vertices: number;
  /** Order, fracture and reach as the law reads them this frame. */
  readonly state = { order: 0, fracture: 0, reach: 0 };
  readonly debug = { nodes: 0, joints: 0, 'joint reach': 0 };
  private readonly edges: ShaderMaterial;
  private readonly nodes: ShaderMaterial;
  private readonly geometries: BufferGeometry[] = [];

  constructor(context: PrimitiveContext, count: number, pointSize: number) {
    const seeds = this.seeds = seedGraph(count, context.seed);
    const joints = seeds.edges.length / 2;
    const node = new Float32Array(joints * 8), mate = new Float32Array(joints * 8), pair = new Float32Array(joints * 4);
    for (let e = 0; e < joints; e++) {
      for (let end = 0; end < 2; end++) {
        const self = seeds.edges[e * 2 + end], other = seeds.edges[e * 2 + 1 - end], to = (e * 2 + end) * 4;
        for (let k = 0; k < 4; k++) { node[to + k] = seeds.home[self * 4 + k]; mate[to + k] = seeds.home[other * 4 + k]; }
        pair[to / 2] = seeds.seed[self]; pair[to / 2 + 1] = seeds.seed[other];
      }
    }
    const shared = {
      uField: { value: context.uField }, uWaveA: { value: context.uWaveA }, uWaveB: { value: context.uWaveB },
      uGraph: { value: new Vector4() }, uWave: { value: 0 }, uBlend: { value: 0 }, uColorA: { value: new Color() }, uColorB: { value: new Color() }, uColorC: { value: new Color() },
    };
    const edgeGeometry = new BufferGeometry();
    edgeGeometry.setAttribute('position', new BufferAttribute(new Float32Array(joints * 6), 3));
    edgeGeometry.setAttribute('aNode', new BufferAttribute(node, 4));
    edgeGeometry.setAttribute('aMate', new BufferAttribute(mate, 4));
    edgeGeometry.setAttribute('aSeed', new BufferAttribute(pair, 2));
    this.edges = new ShaderMaterial({ vertexShader: edgeVertex, fragmentShader: edgeFragment, transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, uniforms: { ...shared } });
    const own = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) own[i * 2] = seeds.seed[i];
    const nodeGeometry = new BufferGeometry();
    nodeGeometry.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    nodeGeometry.setAttribute('aNode', new BufferAttribute(seeds.home, 4));
    nodeGeometry.setAttribute('aSeed', new BufferAttribute(own, 2));
    this.nodes = new ShaderMaterial({
      vertexShader: nodeVertex, fragmentShader: nodeFragment, transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending,
      uniforms: { ...shared, uNode: { value: new Vector3(pointSize, 1, 0) } },
    });
    this.geometries.push(edgeGeometry, nodeGeometry);
    for (const drawable of [new LineSegments(edgeGeometry, this.edges), new Points(nodeGeometry, this.nodes)]) {
      drawable.frustumCulled = false;
      this.object.add(drawable);
    }
    this.elements = this.debug.nodes = count;
    this.debug.joints = joints;
    this.vertices = joints * 2 + count;
  }

  setPalette([primary, secondary, highlight]: PaletteColors): void {
    // Shared uniform objects: the nodes see the same colours.
    const u = this.edges.uniforms;
    (u.uColorA.value as Color).copy(primary); (u.uColorB.value as Color).copy(secondary); (u.uColorC.value as Color).copy(highlight);
  }

  update(frame: Readonly<WorldFrame>, presence: number): void {
    const { geometry: g, look, fields } = frame, s = this.state;
    // Ordered sound puts the nodes on the lattice; what the world lacks in coherence scatters them off it.
    s.order = Math.max(g.symmetry, g.coherence * g.connectionRadius);
    s.fracture = g.fracture;
    s.reach = jointReach(this.seeds, g.connectionRadius, fields.radius);
    (this.edges.uniforms.uGraph.value as Vector4).set(s.order, s.fracture, s.reach, presence * Math.max(look.emissive * (0.4 + 0.6 * look.edge), look.ember));
    this.edges.uniforms.uWave.value = presence * look.wave;
    this.edges.uniforms.uBlend.value = 0.6 * (look.blend - 0.5);
    (this.nodes.uniforms.uNode.value as Vector3).z = g.impulse * look.wave;
    if (import.meta.env.DEV) this.debug['joint reach'] = s.reach;
  }

  setPixelRatio(ratio: number): void {
    (this.nodes.uniforms.uNode.value as Vector3).y = ratio;
  }

  reset(): void {}

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    this.edges.dispose();
    this.nodes.dispose();
    (this.object as Group).clear();
  }
}
