import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Group, LineSegments, Mesh, Points, ShaderMaterial, Vector3, type Object3D } from 'three';
import type { PaletteColors } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';
import { BRACE, BROKEN, DEFAULT_SOLID_BUDGET, INTACT, SOLID_KINDS, solidLab, type SolidBudget, type SolidKind, type SolidView } from '../structural/SolidTypes';
import { StructuralSystem } from '../structural/StructuralDynamics';
import { unit, type StructuralEnvironment } from '../structural/StructuralTypes';
import { createWorldEnvironment, readWorld } from '../structural/WorldEnvironment';
import { EXPOSURE, flatFragment, nodeFragment, nodeVertex } from './WirePolygonPrimitive';

/*
 * Solids: volumetric bodies of the structural engine, as they are. What is
 * drawn is a StructuralSystem holding bodies (visual-engine/structural/Solid*):
 * the elements that are their vertices as points, their links as straight
 * segments from vertex to vertex, the surface triangles that hold as faces.
 *
 * Every position sent to the GPU is a position of the simulation, carried to
 * this frame's time by its own velocity and nothing else: no shader moves a
 * vertex, so what deforms on screen deformed in the physics, and a face that
 * is not drawn is a face that no longer holds. Buffers are allocated once at
 * the size of the pools; a frame rewrites the part in use.
 */

export interface SolidParams {
  /** Which solid is seeded: an index into SOLID_KINDS. */
  solid: number;
  /** Its circumradius (units). */
  solidRadius: number;
  /** Size of a vertex of middle matter (device-independent pixels at the rest distance). */
  pointSize: number;
}

export { resetSolidLab, SOLID_VIEWS, solidLab, type SolidCommand, type SolidView } from '../structural/SolidTypes';

/** Pools of the laboratory's system: the default budget, and elements for as many bodies of the largest kind. */
export const SOLID_LAB_BUDGET: Readonly<SolidBudget> = DEFAULT_SOLID_BUDGET;
export const SOLID_LAB_ELEMENTS = 48;
/** Draw calls of the primitive: faces, links, vertices. */
export const SOLID_DRAW_CALLS = 3;
/** Strengths of the laboratory's tools (velocity given, units/s per unit mass at the point of the blow; rad/s at the ends for the torsion). */
const IMPULSE = 5;
const TWIST = 3;
const BREAK = 11;
/** How a body is first posed (rad), and how far apart its matter is seeded when it is left to form (share of its size). */
const POSE = { tilt: 0.5, turn: 0.4 };
const SCATTER = 0.25;
/** A laboratory shows its subject without sound too: the least light the body is drawn with while the switch is on. */
const LAMP = 0.55;

/** How much of each part a view shows: vertices, edges, braces, remembered links, faces. */
const SHOWN: Record<SolidView, readonly [nodes: number, edges: number, braces: number, remembered: number, faces: number]> = {
  vertices: [1, 0, 0, 0, 0], edges: [0, 1, 0, 0, 0], faces: [0, 0, 0, 0, 1], wireframe: [0.5, 1, 0, 0, 1],
  constraints: [0.6, 0.45, 1, 1, 0], fragments: [1, 1, 0, 0.6, 1], all: [1, 1, 0.35, 0.5, 1],
};

const lineVertex = /* glsl */ `
// x: light, y: palette blend, z: heat (stress, damage, a remembered link)
attribute vec3 aLine;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
varying vec3 vColor;

void main() {
  vColor = mix(mix(uColorA, uColorB, aLine.y), uColorC, aLine.z) * (aLine.x * ${EXPOSURE});
  gl_Position = aLine.x > 0.002 ? projectionMatrix * modelViewMatrix * vec4(position, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const faceVertex = /* glsl */ `
attribute vec3 aFace;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
varying vec3 vColor;
varying vec3 vView;

void main() {
  vColor = mix(mix(uColorA, uColorB, aFace.y), uColorC, aFace.z) * (aFace.x * ${EXPOSURE});
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  gl_Position = aFace.x > 0.002 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const faceFragment = /* glsl */ `
varying vec3 vColor;
varying vec3 vView;
void main() {
  // The face as it stands in the simulation: its own flat normal, dim seen face on and brighter towards its edge.
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
  float facing = abs(dot(n, normalize(vView)));
  gl_FragColor = vec4(vColor * (0.3 + 0.7 * (1.0 - facing) * (1.0 - facing)), 1.0);
}
`;

/** A number 0..1 for a piece, by the element that names it: pieces of one body take colours apart from each other. */
const hue = (component: number): number => { const x = (component + 1) * 0.6180339887; return x - Math.floor(x); };

export class SolidPrimitive implements Primitive {
  readonly object: Object3D = new Group();
  readonly system: StructuralSystem;
  readonly elements: number;
  readonly vertices: number;
  readonly debug: Record<string, number> = { vertices: 0, links: 0, faces: 0, cells: 0, pieces: 0, stress: 0, 'solid ms': 0, 'topology ms': 0, 'buffer ms': 0 };
  /** The environment the bodies sample: the frame's own fields, fronts and resonance. */
  readonly environment: StructuralEnvironment;
  /** Where each element is shown: its position carried to this frame's time by its own velocity. */
  readonly shown: Float32Array;
  /** What the last frame drew: vertices, link segments, triangles. */
  readonly drawn = { points: 0, lines: 0, triangles: 0 };
  private readonly nodes: ShaderMaterial;
  private readonly lines: ShaderMaterial;
  private readonly faces: ShaderMaterial;
  private readonly nodeGeometry = new BufferGeometry();
  private readonly lineGeometry = new BufferGeometry();
  private readonly faceGeometry = new BufferGeometry();
  private readonly nodeLook: Float32Array;
  private readonly linePosition: Float32Array;
  private readonly lineLook: Float32Array;
  private readonly facePosition: Float32Array;
  private readonly faceLook: Float32Array;
  private kind: SolidKind;

  /** `topology`: the packed topology of the world's vector field, shared with whatever else in the world shows that field. */
  constructor(context: PrimitiveContext, private readonly params: SolidParams, readonly topology: Float32Array, budget: Readonly<SolidBudget> = SOLID_LAB_BUDGET) {
    const system = this.system = new StructuralSystem({ capacity: SOLID_LAB_ELEMENTS, seed: context.seed, solids: budget });
    const n = system.state.capacity, solids = system.solids!.state, links = solids.linkCapacity, triangles = solids.faceCapacity;
    this.environment = createWorldEnvironment(context, topology);
    this.kind = SOLID_KINDS[Math.min(SOLID_KINDS.length - 1, Math.max(0, Math.round(params.solid)))] ?? 'tetrahedron';
    this.seed(true);

    const shared = { uColorA: { value: new Color() }, uColorB: { value: new Color() }, uColorC: { value: new Color() } };
    const material = (vertexShader: string, fragmentShader: string, uniforms = {}): ShaderMaterial => new ShaderMaterial({
      vertexShader, fragmentShader, transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, side: DoubleSide, uniforms: { ...shared, ...uniforms },
    });
    const dynamic = (array: Float32Array, size: number): BufferAttribute => new BufferAttribute(array, size).setUsage(DynamicDrawUsage);

    this.shown = new Float32Array(n * 3); this.nodeLook = new Float32Array(n * 4);
    this.nodeGeometry.setAttribute('position', dynamic(this.shown, 3));
    this.nodeGeometry.setAttribute('aNode', dynamic(this.nodeLook, 4));
    this.nodes = material(nodeVertex, nodeFragment, { uPoint: { value: new Vector3(params.pointSize, 1, 0) } });

    this.linePosition = new Float32Array(links * 6); this.lineLook = new Float32Array(links * 6);
    this.lineGeometry.setAttribute('position', dynamic(this.linePosition, 3));
    this.lineGeometry.setAttribute('aLine', dynamic(this.lineLook, 3));
    this.lines = material(lineVertex, flatFragment);

    this.facePosition = new Float32Array(triangles * 9); this.faceLook = new Float32Array(triangles * 9);
    this.faceGeometry.setAttribute('position', dynamic(this.facePosition, 3));
    this.faceGeometry.setAttribute('aFace', dynamic(this.faceLook, 3));
    this.faces = material(faceVertex, faceFragment);

    for (const [drawable, geometry] of [[new Mesh(this.faceGeometry, this.faces), this.faceGeometry], [new LineSegments(this.lineGeometry, this.lines), this.lineGeometry],
      [new Points(this.nodeGeometry, this.nodes), this.nodeGeometry]] as const) {
      geometry.setDrawRange(0, 0);
      drawable.frustumCulled = false;
      this.object.add(drawable);
    }
    this.elements = n;
    this.vertices = n + links * 2 + triangles * 3;
  }

  setPalette([primary, secondary, highlight]: PaletteColors): void {
    // Shared uniform objects: vertices, links and faces see the same colours.
    const u = this.nodes.uniforms;
    (u.uColorA.value as Color).copy(primary); (u.uColorB.value as Color).copy(secondary); (u.uColorC.value as Color).copy(highlight);
  }

  update(frame: Readonly<WorldFrame>, presence: number): void {
    const { geometry: g, look } = frame, env = this.environment, system = this.system, solids = system.solids!;
    readWorld(env, frame, this.topology);
    let view: SolidView = 'wireframe', lamp = 0;
    if (import.meta.env.DEV) {
      system.profile = true;
      if (solidLab.active) { view = this.lab(); lamp = LAMP; }
    }
    system.advance(frame.time, env);
    const started = import.meta.env.DEV ? performance.now() : 0;
    // What a body shows of itself: the world's light, and the ember it cools down with.
    this.draw(view, Math.max(presence * Math.max(look.emissive, look.ember), lamp), presence * look.wave * g.impulse, look.blend - 0.5, Math.max(look.fill, lamp));

    if (import.meta.env.DEV) {
      const d = this.debug, stats = solids.stats;
      d.vertices = this.drawn.points; d.links = stats.intact; d.faces = stats.faces; d.cells = stats.cells; d.pieces = solids.state.bodies ? solids.state.bodyPieces[0] : 0;
      d.stress = stats.stress; d['solid ms'] = stats.solveMs; d['topology ms'] = stats.bookMs;
      d['buffer ms'] += (performance.now() - started - d['buffer ms']) * 0.05;
    }
  }

  setPixelRatio(ratio: number): void {
    (this.nodes.uniforms.uPoint.value as Vector3).y = ratio;
  }

  /** A new audio session: the bodies stay as they are; only the simulation's clock is forgotten. */
  reset(): void {
    this.system.reset();
  }

  dispose(): void {
    this.nodeGeometry.dispose(); this.lineGeometry.dispose(); this.faceGeometry.dispose();
    this.nodes.dispose(); this.lines.dispose(); this.faces.dispose();
    (this.object as Group).clear();
  }

  /** The matter of this world: one solid, whole or only seeded. The pools are emptied and reused; nothing is reallocated. */
  private seed(bonded: boolean): void {
    this.system.clear();
    this.system.seedSolid(this.kind, this.params.solidRadius, { ...POSE, bonded, scatter: bonded ? 0 : SCATTER });
  }

  /** The laboratory: its overrides, its commands, the view it asks for. */
  private lab(): SolidView {
    const system = this.system, solids = system.solids!, lab = solidLab, command = lab.command;
    Object.assign(system.tuning, lab.tuning); Object.assign(solids.tuning, lab.material);
    lab.command = null;
    if (command === 'reset' || command === 'seed' || lab.kind !== this.kind) {
      this.kind = lab.kind;
      this.seed(command !== 'seed');
    } else if (command && solids.state.bodies > 0) {
      // Blows are aimed at the body where it is now: beside its first vertex, from outside or from within.
      const c = solids.centroid(0), p = system.state.position, first = solids.state.bodyFirst[0] * 3, size = this.params.solidRadius;
      const dx = p[first] - c[0], dy = p[first + 1] - c[1], dz = p[first + 2] - c[2];
      if (command === 'twist') solids.twist(0, TWIST);
      else {
        const at = command === 'impulse' ? 1.4 : 0.5;
        system.strike(c[0] + dx * at, c[1] + dy * at, c[2] + dz * at, command === 'impulse' ? IMPULSE : BREAK, size);
      }
    }
    return lab.view;
  }

  /** Fills the GPU buffers from the simulation's state. Must not allocate. */
  private draw(view: SolidView, light: number, flash: number, lean: number, fill: number): void {
    const system = this.system, m = system.state, s = system.solids!.state, p = m.position, v = m.velocity, alpha = system.alpha, shown = this.shown;
    const [nodes, edges, braces, remembered, faces] = SHOWN[view], pieces = view === 'fragments';
    const look = this.nodeLook;
    for (let i = 0; i < m.count; i++) {
      const at = i * 3;
      shown[at] = p[at] + v[at] * alpha; shown[at + 1] = p[at + 1] + v[at + 1] * alpha; shown[at + 2] = p[at + 2] + v[at + 2] * alpha;
      look[i * 4] = (0.9 + 0.5 * Math.sqrt(m.mass[i])) * (1 + 0.6 * m.micro[i]);
      look[i * 4 + 1] = nodes * (light * (0.5 + 0.9 * m.excitation[i] + 0.5 * m.micro[i]) + flash * 0.5);
      look[i * 4 + 2] = pieces && s.component[i] >= 0 ? hue(s.component[i]) : unit((m.f0[i] - 0.2) / 0.6 + lean);
      look[i * 4 + 3] = unit(Math.max(m.stress[i] - 0.4, m.shock[i]));
    }
    this.fill(this.nodeGeometry, 'position', m.count, m.count * 3); this.fill(this.nodeGeometry, 'aNode', m.count, m.count * 4);

    const line = this.linePosition, lineLook = this.lineLook;
    let segments = 0;
    for (let l = 0; l < s.links; l++) {
      const state = s.linkState[l], a = s.linkA[l], b = s.linkB[l];
      const part = state === INTACT ? (s.linkKind[l] === BRACE ? braces : edges) : state === BROKEN ? remembered * s.linkMemory[l] : 0;
      if (part <= 0) continue;
      const at = segments * 6, held = state === INTACT;
      line[at] = shown[a * 3]; line[at + 1] = shown[a * 3 + 1]; line[at + 2] = shown[a * 3 + 2];
      line[at + 3] = shown[b * 3]; line[at + 4] = shown[b * 3 + 1]; line[at + 5] = shown[b * 3 + 2];
      // A remembered link is drawn faint and in the colour of what is hot: it is a tendency, not a tie.
      const value = held ? part * (light * (0.6 + 0.8 * 0.5 * (m.excitation[a] + m.excitation[b])) + flash * 0.3) : part * light * 0.3;
      const blend = pieces ? hue(s.component[a]) : unit((0.5 * (m.f0[a] + m.f0[b]) - 0.2) / 0.6 + lean), heat = held ? unit(1.6 * (s.linkStress[l] - 0.4) + s.linkDamage[l]) : 1;
      lineLook[at] = lineLook[at + 3] = value; lineLook[at + 1] = lineLook[at + 4] = blend; lineLook[at + 2] = lineLook[at + 5] = heat;
      segments++;
    }
    this.fill(this.lineGeometry, 'position', segments * 2, segments * 6); this.fill(this.lineGeometry, 'aLine', segments * 2, segments * 6);

    const face = this.facePosition, faceLook = this.faceLook;
    let triangles = 0;
    if (faces > 0) {
      for (let f = 0; f < s.faces; f++) {
        if (!s.faceHolds[f]) continue;
        const at = triangles * 9;
        let excitation = 0, pitch = 0, stress = 0;
        for (let k = 0; k < 3; k++) {
          const e = s.faceCorners[f * 3 + k];
          face[at + k * 3] = shown[e * 3]; face[at + k * 3 + 1] = shown[e * 3 + 1]; face[at + k * 3 + 2] = shown[e * 3 + 2];
          excitation += m.excitation[e] / 3; pitch += m.f0[e] / 3; stress += m.stress[e] / 3;
        }
        const value = faces * fill * 0.42 * (light * (0.45 + 0.9 * excitation) + flash * 0.2);
        const blend = pieces ? hue(s.component[s.faceCorners[f * 3]]) : unit((pitch - 0.2) / 0.6 + lean), heat = unit(1.4 * (stress - 0.45));
        for (let k = 0; k < 3; k++) { faceLook[at + k * 3] = value; faceLook[at + k * 3 + 1] = blend; faceLook[at + k * 3 + 2] = heat; }
        triangles++;
      }
    }
    this.fill(this.faceGeometry, 'position', triangles * 3, triangles * 9); this.fill(this.faceGeometry, 'aFace', triangles * 3, triangles * 9);
    this.drawn.points = nodes > 0 ? m.count : 0; this.drawn.lines = segments; this.drawn.triangles = triangles;
  }

  /** Marks the part of a buffer in use for drawing and for upload: the rest of the pool is neither sent nor drawn. */
  private fill(geometry: BufferGeometry, name: string, count: number, values: number): void {
    const attribute = geometry.attributes[name] as BufferAttribute;
    geometry.setDrawRange(0, count);
    attribute.clearUpdateRanges();
    if (values > 0) { attribute.addUpdateRange(0, values); attribute.needsUpdate = true; }
  }
}
