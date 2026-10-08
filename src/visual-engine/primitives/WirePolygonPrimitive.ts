import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedBufferGeometry, LineSegments, Mesh,
  Points, ShaderMaterial, Vector3, type Object3D,
} from 'three';
import { FIELD, layerRadius, WAVE_PUSH } from '../../render-systems/fields/fieldLaw';
import { FRONT_SHIFT, frontsAt } from '../../render-systems/fields/flowLaw';
import { deriveTopology, fieldAt } from '../../render-systems/fields/vectorField';
import type { PaletteColors, QualityProfile } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';
import { StructuralSystem } from '../structural/StructuralDynamics';
import { createStillEnvironment, createTuning, ROLE, ROLE_COUNT, unit, type StructuralEnvironment } from '../structural/StructuralTypes';

/*
 * Wire polygons: the first living structure of the structural engine. What
 * is drawn is a StructuralSystem (visual-engine/structural): elements, the
 * wires that span two of them, the joints that weld wire ends into corners,
 * and the polygons that close when a chain of wires meets itself. Nothing in
 * it is created or removed to show a figure: a polygon forms because its
 * matter settles and bonds, vibrates as its wires and corners resonate,
 * breaks where a bond can bear no more, and its pieces stay what they were
 * (they keep their pitch, ring on, drift with the field) until they find each
 * other again.
 *
 *   the world's vector field, fronts and drag      where an element goes        (the same F(P) the tracers of Vector Field follow)
 *   the multiscale resonance at its own pitch      how it answers where it is   (swing of the corners, string modes of the wires, light)
 *
 * The simulation runs on the CPU in fixed steps of the heard audio time (a
 * sparse, changing topology for a bounded number of elements); the GPU draws
 * it: instanced wires shaped as vibrating strings in the vertex shader, the
 * elements as points, closed polygons as faint faces. The law of a wire's
 * shape is written twice (GLSL and the CPU reference below).
 */

export interface StructureParams {
  /** Free elements at High quality: the matter the polygon lives in. */
  elements: number;
  /** Sides of the seeded polygon (3..6; 0: none) and its circumradius (units). */
  polygon: number;
  polygonRadius: number;
  /** Size of an element of middle matter (device-independent pixels at the rest distance). */
  pointSize: number;
}

export interface StructureQuality {
  elements: number;
  capacity: number;
}

/** Less free matter at lower quality; the polygon is the same. */
export function structureQuality(params: StructureParams, quality: QualityProfile): StructureQuality {
  const elements = Math.max(0, Math.round(params.elements * Math.min(1, Math.max(0.1, quality.density))));
  return { elements, capacity: elements + 2 * MAX_SIDES + 4 };
}

/** What the development cockpit can single out (the product always shows everything). */
export const STRUCTURE_VIEWS = ['all', 'particles', 'nodes', 'edges', 'polygon', 'surface', 'fragments'] as const;
export type StructureView = typeof STRUCTURE_VIEWS[number];
export type StructureCommand = 'seed' | 'form' | 'scatter' | 'strike';

/**
 * Development switch (the engine cockpit): overrides of the structural tuning,
 * which part of the structure to look at, the polygon to seed and one-shot
 * commands. Read in development builds only and only while `active`; nothing
 * in the product sets it and nothing of it is persisted.
 */
export const structuralLab: { active: boolean; tuning: ReturnType<typeof createTuning>; view: StructureView; sides: number; command: StructureCommand | null } = {
  active: false, tuning: createTuning(), view: 'all', sides: 4, command: null,
};

const MAX_SIDES = 6;
/** Segments a wire is drawn with. */
export const WIRE_SEGMENTS = 16;
/** How far a corner swings with its resonance (units, for middle matter), and a wire's first mode (share of its length). */
const SWING = 0.055;
const STRING = 0.06;
/**
 * The free population: a broad spread of middle and fine matter through the body of the world (radii, flattening).
 * The polygon is lower, structural matter: the two answer the same sound differently and do not weld to each other.
 */
const MATTER = { id: 1, centre: 0.68, spread: 0.2 };
const FIGURE = { id: 2, centre: 0.36, spread: 0.03 };
const SHELL = [0.25, 1.25, 0.55] as const;
/** Share of the matter's radial spring that structural elements feel: held in the body, free to deform within it. */
const HOLD = 0.35;
const EXPOSURE = 0.85;

const wireLaw = /* glsl */ `
// A point of a wire from A to B at s (0..1), bent by its first three string modes (signed shares of its length):
// held at both ends, in two polarisations a quarter of a cycle apart.
vec3 wirePoint(vec3 A, vec3 B, float s, vec3 modes) {
  vec3 d = B - A;
  float len = max(length(d), 1e-5);
  vec3 t = d / len;
  vec3 n = cross(t, vec3(0.0, 0.0, 1.0));
  float nl = length(n);
  n = nl > 1e-3 ? n / nl : vec3(1.0, 0.0, 0.0);
  vec3 b = cross(t, n);
  float a1 = sin(3.14159265 * s), a2 = sin(6.2831853 * s), a3 = sin(9.42477796 * s);
  float across = modes.x * a1 + modes.y * a2 + modes.z * a3;
  float out2 = 0.5 * (modes.y * a1 - modes.x * a2);
  return A + d * s + (n * across + b * out2) * len;
}
`;

const wireVertex = /* glsl */ `
${wireLaw}
attribute float aAlong;
attribute vec3 aA;
attribute vec3 aB;
attribute vec3 aModes;
// x: light, y: palette blend, z: heat (stress, fracture)
attribute vec3 aWire;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
varying vec3 vColor;

void main() {
  vec3 P = wirePoint(aA, aB, aAlong, aModes);
  vColor = mix(mix(uColorA, uColorB, aWire.y), uColorC, aWire.z) * (aWire.x * ${EXPOSURE});
  gl_Position = aWire.x > 0.002 ? projectionMatrix * modelViewMatrix * vec4(P, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const nodeVertex = /* glsl */ `
// x: size, y: light, z: palette blend, w: heat
attribute vec4 aNode;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
// x: point size (device-independent pixels at the rest distance), y: pixel ratio
uniform vec3 uPoint;
varying vec3 vColor;

void main() {
  vColor = mix(mix(uColorA, uColorB, aNode.z), uColorC, aNode.w) * (aNode.y * ${EXPOSURE});
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(uPoint.x * aNode.x * uPoint.y * (4.0 / max(-mv.z, 0.5)), 1.0, 14.0 * uPoint.y);
  gl_Position = aNode.y > 0.002 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const faceVertex = /* glsl */ `
attribute float aFill;
uniform vec3 uColorA;
uniform vec3 uColorB;
varying vec3 vColor;

void main() {
  vColor = mix(uColorA, uColorB, 0.5) * (aFill * ${EXPOSURE});
  gl_Position = aFill > 0.002 ? projectionMatrix * modelViewMatrix * vec4(position, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const flatFragment = /* glsl */ `
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

/** Result of the CPU reference. Reused. */
export const wireOut = new Float64Array(3);

/** CPU reference of the GLSL `wirePoint`. */
export function wirePoint(ax: number, ay: number, az: number, bx: number, by: number, bz: number, s: number, m0: number, m1: number, m2: number): Float64Array {
  const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-5);
  const tx = dx / len, ty = dy / len, tz = dz / len;
  // t × ẑ, or x̂ when the wire points along z.
  let nx = ty, ny = -tx;
  const nz = 0;
  const nl = Math.sqrt(nx * nx + ny * ny);
  if (nl > 1e-3) { nx /= nl; ny /= nl; } else { nx = 1; ny = 0; }
  const cx = ty * nz - tz * ny, cy = tz * nx - tx * nz, cz = tx * ny - ty * nx;
  const a1 = Math.sin(Math.PI * s), a2 = Math.sin(2 * Math.PI * s), a3 = Math.sin(3 * Math.PI * s);
  const across = (m0 * a1 + m1 * a2 + m2 * a3) * len, out = 0.5 * (m1 * a1 - m0 * a2) * len;
  wireOut[0] = ax + dx * s + nx * across + cx * out; wireOut[1] = ay + dy * s + ny * across + cy * out; wireOut[2] = az + dz * s + nz * across + cz * out;
  return wireOut;
}

const fronts = WAVE_PUSH / FRONT_SHIFT;

export class WirePolygonPrimitive implements Primitive {
  readonly object: Object3D = new Group();
  readonly system: StructuralSystem;
  readonly elements: number;
  readonly vertices: number;
  readonly debug: Record<string, number> = { elements: 0, bonds: 0, polygons: 0, 'free %': 0, order: 0, temperature: 0, 'bond stress': 0, 'struct ms': 0, 'book ms': 0 };
  /** The environment the structure samples: the frame's own fields, fronts and resonance, nothing of its own. */
  readonly environment: StructuralEnvironment;
  /** Where each element is shown: its position carried to this frame's time, swung by its resonance. */
  readonly shown: Float32Array;
  private readonly nodes: ShaderMaterial;
  private readonly wires: ShaderMaterial;
  private readonly faces: ShaderMaterial;
  private readonly nodeGeometry = new BufferGeometry();
  private readonly wireGeometry = new InstancedBufferGeometry();
  private readonly faceGeometry = new BufferGeometry();
  private readonly nodeLook: Float32Array;
  private readonly wireA: Float32Array;
  private readonly wireB: Float32Array;
  private readonly wireModes: Float32Array;
  private readonly wireLook: Float32Array;
  private readonly facePosition: Float32Array;
  private readonly faceFill: Float32Array;
  private sides: number;

  /** `topology`: the packed topology of the world's vector field, shared with whatever else in the world shows that field. */
  constructor(context: PrimitiveContext, private readonly quality: StructureQuality, private readonly params: StructureParams, readonly topology: Float32Array) {
    const system = this.system = new StructuralSystem({ capacity: quality.capacity, seed: context.seed, maxSides: MAX_SIDES });
    const state = system.state, n = state.capacity, bonds = state.bondCapacity, corners = state.loopCapacity * state.maxSides;
    const { uField, uWaveA, uWaveB } = context;
    this.environment = {
      ...createStillEnvironment(),
      flow: (x, y, z, out) => { const F = fieldAt(x, y, z, uField, topology); out[0] = F[0]; out[1] = F[1]; out[2] = F[2]; },
      push: (x, y, z, affinity, out) => { const F = frontsAt(x, y, z, affinity, uWaveA, uWaveB); out[0] = F[0] * fronts; out[1] = F[1] * fronts; out[2] = F[2] * fronts; },
      // The radial spring of the field law, as the matter of that layer feels it: the world's pressure moves the radius it rests at.
      hold: (x, y, z, home, out) => {
        const px = x - uField[FIELD.lateral], r = Math.max(Math.sqrt(px * px + y * y + z * z), 1e-4);
        const k = -HOLD * uField[FIELD.stiffness] * (r - layerRadius(home, uField[FIELD.radius], uField[FIELD.gather])) / r;
        out[0] = px * k; out[1] = y * k; out[2] = z * k;
      },
    };
    this.sides = params.polygon;
    this.seed(false);

    const shared = { uColorA: { value: new Color() }, uColorB: { value: new Color() }, uColorC: { value: new Color() } };
    const material = (vertexShader: string, fragmentShader: string, uniforms = {}): ShaderMaterial => new ShaderMaterial({
      vertexShader, fragmentShader, transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, side: DoubleSide, uniforms: { ...shared, ...uniforms },
    });
    const dynamic = <T extends BufferAttribute>(attribute: T): T => { attribute.setUsage(DynamicDrawUsage); return attribute; };

    this.shown = new Float32Array(n * 3); this.nodeLook = new Float32Array(n * 4);
    this.nodeGeometry.setAttribute('position', dynamic(new BufferAttribute(this.shown, 3)));
    this.nodeGeometry.setAttribute('aNode', dynamic(new BufferAttribute(this.nodeLook, 4)));
    this.nodes = material(nodeVertex, nodeFragment, { uPoint: { value: new Vector3(params.pointSize, 1, 0) } });

    const along = new Float32Array(WIRE_SEGMENTS * 2);
    for (let k = 0; k < WIRE_SEGMENTS; k++) { along[k * 2] = k / WIRE_SEGMENTS; along[k * 2 + 1] = (k + 1) / WIRE_SEGMENTS; }
    this.wireA = new Float32Array(bonds * 3); this.wireB = new Float32Array(bonds * 3); this.wireModes = new Float32Array(bonds * 3); this.wireLook = new Float32Array(bonds * 3);
    this.wireGeometry.setAttribute('position', new BufferAttribute(new Float32Array(WIRE_SEGMENTS * 6), 3));
    this.wireGeometry.setAttribute('aAlong', new BufferAttribute(along, 1));
    this.wireGeometry.setAttribute('aA', dynamic(new InstancedBufferAttribute(this.wireA, 3)));
    this.wireGeometry.setAttribute('aB', dynamic(new InstancedBufferAttribute(this.wireB, 3)));
    this.wireGeometry.setAttribute('aModes', dynamic(new InstancedBufferAttribute(this.wireModes, 3)));
    this.wireGeometry.setAttribute('aWire', dynamic(new InstancedBufferAttribute(this.wireLook, 3)));
    this.wireGeometry.instanceCount = 0;
    this.wires = material(wireVertex, flatFragment);

    this.facePosition = new Float32Array(corners * 9); this.faceFill = new Float32Array(corners * 3);
    this.faceGeometry.setAttribute('position', dynamic(new BufferAttribute(this.facePosition, 3)));
    this.faceGeometry.setAttribute('aFill', dynamic(new BufferAttribute(this.faceFill, 1)));
    this.faceGeometry.setDrawRange(0, 0);
    this.faces = material(faceVertex, flatFragment);

    for (const drawable of [new Mesh(this.faceGeometry, this.faces), new LineSegments(this.wireGeometry, this.wires), new Points(this.nodeGeometry, this.nodes)]) {
      drawable.frustumCulled = false;
      this.object.add(drawable);
    }
    this.elements = n;
    this.vertices = n + bonds * WIRE_SEGMENTS * 2 + corners * 3;
  }

  setPalette([primary, secondary, highlight]: PaletteColors): void {
    // Shared uniform objects: wires and faces see the same colours.
    const u = this.nodes.uniforms;
    (u.uColorA.value as Color).copy(primary); (u.uColorB.value as Color).copy(secondary); (u.uColorC.value as Color).copy(highlight);
  }

  update(frame: Readonly<WorldFrame>, presence: number): void {
    const { geometry: g, fields, look } = frame, env = this.environment, system = this.system;
    // The same field the world's tracers and lines follow (derived here too, so nothing depends on who was updated first).
    deriveTopology(this.topology, g, fields);
    env.coherence = g.coherence; env.harmony = g.symmetry; env.turbulence = g.disorder; env.tension = g.tension;
    env.energy = g.energy; env.release = g.fracture; env.drag = fields.drag;
    env.resonance = frame.resonance ?? null;
    let view: StructureView = 'all';
    if (import.meta.env.DEV) {
      system.profile = true;
      if (structuralLab.active) view = this.lab();
    }
    system.advance(frame.time, env);
    // What a structure shows of itself: the world's light, and the ember it cools down with.
    this.draw(view, presence * Math.max(look.emissive, look.ember), presence * look.wave * g.impulse, look.blend - 0.5, look.fill);

    if (import.meta.env.DEV) {
      const d = this.debug, stats = system.stats;
      d.elements = stats.elements; d.bonds = stats.bonds; d.polygons = stats.loops; d['free %'] = stats.free * 100;
      d.order = stats.order; d.temperature = stats.temperature; d['bond stress'] = stats.stress;
      d['struct ms'] = stats.stepMs; d['book ms'] = stats.bookMs;
    }
  }

  setPixelRatio(ratio: number): void {
    (this.nodes.uniforms.uPoint.value as Vector3).y = ratio;
  }

  /** A new audio session: the matter stays as it is; only the simulation's clock is forgotten. */
  reset(): void {
    this.system.reset();
  }

  dispose(): void {
    this.nodeGeometry.dispose(); this.wireGeometry.dispose(); this.faceGeometry.dispose();
    this.nodes.dispose(); this.wires.dispose(); this.faces.dispose();
    (this.object as Group).clear();
  }

  /** The matter of this world: a polygon's worth of wires that tend to that figure, in a population of free elements. */
  private seed(bonded: boolean): void {
    const system = this.system;
    system.clear();
    if (this.sides >= 3) system.seedPolygon(this.sides, this.params.polygonRadius, { turn: Math.PI / 2 - Math.PI / this.sides, bonded, population: FIGURE });
    system.addPopulation(this.quality.elements, MATTER, SHELL[0], SHELL[1], SHELL[2]);
  }

  /** Development cockpit: its overrides, its commands, the part it singles out. */
  private lab(): StructureView {
    const system = this.system, lab = structuralLab;
    Object.assign(system.tuning, lab.tuning);
    const sides = Math.min(MAX_SIDES, Math.max(3, Math.round(lab.sides)));
    if (lab.command === 'seed' || lab.command === 'form' || sides !== this.sides) {
      this.sides = sides;
      this.seed(lab.command === 'form');
    } else if (lab.command === 'scatter') system.strike(0, 0, 0, 2.2, 1.2);
    else if (lab.command === 'strike') system.strike(-0.9, 0.2, 0, 1.6, 0.8);
    lab.command = null;
    return lab.view;
  }

  /** Fills the GPU buffers from the simulation's state. Must not allocate. */
  private draw(view: StructureView, light: number, flash: number, lean: number, fill: number): void {
    const s = this.system.state, p = s.position, v = s.velocity, alpha = this.system.alpha, shown = this.shown, look = this.nodeLook;
    const all = view === 'all';
    for (let i = 0; i < s.count; i++) {
      const at = i * 3, x = p[at] + v[at] * alpha, y = p[at + 1] + v[at + 1] * alpha, z = p[at + 2] + v[at + 2] * alpha;
      // Micro response: the element swings about where the medium put it, along its radius, by its own resonance.
      const r = Math.sqrt(x * x + y * y + z * z), swing = r > 1e-4 ? SWING * s.vibration[i] / (Math.sqrt(s.mass[i]) * r) : 0;
      shown[at] = x + x * swing; shown[at + 1] = y + y * swing; shown[at + 2] = z + z * swing;
      const roles = i * ROLE_COUNT, bonded = s.span[i] >= 0 || s.joints[i] > 0;
      let part = 1;
      if (view === 'particles') part = s.kin[i] < 0 ? 1 : 0;
      else if (view === 'polygon') part = s.kin[i] >= 0 ? 1 : 0;
      else if (view === 'nodes') part = Math.min(1, 2 * s.roles[roles + ROLE.node]);
      else if (view === 'fragments') part = Math.min(1, 2 * s.roles[roles + ROLE.fragment]);
      else if (view === 'edges' || view === 'surface') part = 0;
      look[i * 4] = (0.7 + 0.5 * Math.sqrt(s.mass[i])) * (bonded ? 1.25 : 1) * (1 + 0.6 * s.micro[i]);
      look[i * 4 + 1] = part * (light * (0.3 + 0.9 * s.excitation[i] + 0.5 * s.micro[i]) + flash * 0.5);
      look[i * 4 + 2] = unit((s.f0[i] - 0.2) / 0.6 + lean);
      look[i * 4 + 3] = unit(Math.max(s.stress[i] - 0.4, s.shock[i]));
    }
    this.nodeGeometry.setDrawRange(0, s.count);
    this.nodeGeometry.attributes.position.needsUpdate = true; this.nodeGeometry.attributes.aNode.needsUpdate = true;

    const A = this.wireA, B = this.wireB, modes = this.wireModes, wire = this.wireLook;
    let count = 0;
    for (let b = 0; b < s.bondCapacity; b++) {
      if (!s.bondAlive[b]) continue;
      const a = s.bondA[b], c = s.bondB[b], span = s.bondSpan[b] === 1;
      let part = all || view === 'edges' ? 1 : 0;
      if (view === 'particles') part = s.kin[a] < 0 && s.kin[c] < 0 ? 1 : 0;
      else if (view === 'polygon') part = s.kin[a] >= 0 && s.kin[c] >= 0 ? 1 : 0;
      else if (view === 'fragments') part = Math.min(1, s.shock[a] + s.shock[c]);
      else if (view === 'surface') part = s.loop[a] > 0 ? 0.35 : 0;
      if (part <= 0) continue;
      const at = count * 3, excitation = 0.5 * (s.excitation[a] + s.excitation[c]);
      A[at] = shown[a * 3]; A[at + 1] = shown[a * 3 + 1]; A[at + 2] = shown[a * 3 + 2];
      B[at] = shown[c * 3]; B[at + 1] = shown[c * 3 + 1]; B[at + 2] = shown[c * 3 + 2];
      // A joint is the short weld between two wire ends: it shows when it is pulled open.
      modes[at] = span ? s.bondModes[b * 3] * STRING : 0; modes[at + 1] = span ? s.bondModes[b * 3 + 1] * STRING : 0; modes[at + 2] = span ? s.bondModes[b * 3 + 2] * STRING : 0;
      wire[at] = part * light * (0.5 + 0.8 * excitation) + flash * 0.3;
      wire[at + 1] = unit((0.5 * (s.f0[a] + s.f0[c]) - 0.2) / 0.6 + lean);
      wire[at + 2] = unit(1.6 * (s.bondStress[b] - 0.4) + s.bondDamage[b]);
      count++;
    }
    this.wireGeometry.instanceCount = count;
    const wa = this.wireGeometry.attributes;
    wa.aA.needsUpdate = true; wa.aB.needsUpdate = true; wa.aModes.needsUpdate = true; wa.aWire.needsUpdate = true;

    const face = this.facePosition, amount = this.faceFill;
    let vertices = 0;
    if (all || view === 'surface' || view === 'polygon') {
      for (let L = 0; L < s.loops; L++) {
        const size = s.loopSize[L], from = L * s.maxSides;
        if (view === 'polygon' && s.kin[s.loopCorners[from]] < 0) continue;
        let cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < size; k++) { const e = s.loopCorners[from + k] * 3; cx += shown[e]; cy += shown[e + 1]; cz += shown[e + 2]; }
        cx /= size; cy /= size; cz /= size;
        // A closed polygon is a face as far as it is flat, ordered and cold: a surface in waiting.
        const value = light * fill * 0.3 * s.loopPlanarity[L] * (0.25 + 0.75 * s.loopSurface[L]);
        for (let k = 0; k < size; k++) {
          const e0 = s.loopCorners[from + k] * 3, e1 = s.loopCorners[from + (k + 1) % size] * 3, at = vertices * 3;
          face[at] = cx; face[at + 1] = cy; face[at + 2] = cz;
          face[at + 3] = shown[e0]; face[at + 4] = shown[e0 + 1]; face[at + 5] = shown[e0 + 2];
          face[at + 6] = shown[e1]; face[at + 7] = shown[e1 + 1]; face[at + 8] = shown[e1 + 2];
          amount[vertices] = value; amount[vertices + 1] = amount[vertices + 2] = value * 0.5;
          vertices += 3;
        }
      }
    }
    this.faceGeometry.setDrawRange(0, vertices);
    this.faceGeometry.attributes.position.needsUpdate = true; this.faceGeometry.attributes.aFill.needsUpdate = true;
  }
}
