import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Group, LineSegments, Mesh, Points, ShaderMaterial, Vector3, type Object3D } from 'three';
import type { AudioEvent, EventCursor } from '../../experience/EventStream';
import { forEachCue, type Cue } from '../../experience/MusicalCues';
import type { PaletteColors } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';
import { createReadout, type BodyReadout } from '../structural/SolidDynamics';
import { solidMesh } from '../structural/SolidTopology';
import {
  BRACE, BROKEN, createFractureTuning, DEFAULT_SOLID_BUDGET, INTACT, SOLID_KINDS, solidLab, solidProfile, type SolidBudget, type SolidKind, type SolidProfile, type SolidView,
} from '../structural/SolidTypes';
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
 *
 * It detects nothing: the dated events of the session (SceneClock.events, read
 * with its own cursor up to the heard time) are handed to the system's
 * fracture gate, which decides at the fixed step that reaches each of them.
 */

export interface SolidParams {
  /** Which solid is seeded: an index into SOLID_KINDS. */
  solid: number;
  /** Its circumradius (units). */
  solidRadius: number;
  /** Size of a vertex of middle matter (device-independent pixels at the rest distance). */
  pointSize: number;
}

export { resetSolidLab, setSolidProfile, SOLID_VIEWS, solidLab, type SolidCommand, type SolidView } from '../structural/SolidTypes';

/** Where one body of a population is seeded (world units, rad). */
export interface SolidPlacement { kind: SolidKind; radius: number; x: number; y: number; z: number; turn: number; tilt: number }

/**
 * Bodies a scene holds among its other matter (an entity of the scene, not the laboratory's subject), and which steps
 * of the cycle free matter → aggregate → form → solid → fracture → fragments → reorganisation it uses:
 *
 *   start      'free': seeded apart, every link remembered and none holding, the body forms when the world lets it;
 *              'solid': whole from the first frame (the first steps skipped)
 *   fracture   what may break the bodies: nothing; a release heard (the default: a structural event that is
 *              reliable); or that and the accents that stand out too (a transient is an observation, not a change of
 *              form: on a steady groove it breaks bodies the music gives no reason to break). Only the musical cues
 *              (MusicalCues) are offered to the fracture gate, never the experience's own drop, never a prediction
 *   profile    the material (rigid: shape retention 0.9, a pulse of at most PULSE_LIMIT)
 *
 * Recomposition is the structural engine's own: a broken link forms again only where the physics allows it.
 */
export interface SolidPopulation {
  bodies: readonly SolidPlacement[];
  start: 'free' | 'solid';
  fracture: 'none' | 'release' | 'accent';
  profile: SolidProfile;
}

/** Where a body is in the cycle, read from its links (SolidSystem.read), for the tools: what the physics made of it. */
export const SOLID_STAGES = ['free', 'aggregate', 'form', 'solid', 'fragments'] as const;
export type SolidStage = typeof SOLID_STAGES[number];
export function stageOf(r: Readonly<BodyReadout>, wasSolid: boolean): SolidStage {
  if (r.edgesIntact === 0) return 'free';
  if (wasSolid && r.pieces > 1) return 'fragments';
  if (r.form === 'volume' && r.sealed && r.pieces === 1) return 'solid';
  return r.form === 'surface' || r.form === 'shell' || r.form === 'volume' ? 'form' : 'aggregate';
}

/** Elements a population needs (the vertices of its bodies), and the pools that hold it. */
export const populationElements = (p: Readonly<SolidPopulation>): number => p.bodies.reduce((n, b) => n + solidMesh(b.kind).vertices.length / 3, 0);
const populationBudget = (p: Readonly<SolidPopulation>): SolidBudget => ({ ...DEFAULT_SOLID_BUDGET, bodies: Math.max(1, Math.min(DEFAULT_SOLID_BUDGET.bodies, p.bodies.length)) });
/** How often (frames) the tools' reading of the stages is refreshed: a readout is not a per-frame cost. */
const STAGE_EVERY = 12;

/** Pools of the laboratory's system: the default budget, and elements for as many bodies of the largest kind. */
export const SOLID_LAB_BUDGET: Readonly<SolidBudget> = DEFAULT_SOLID_BUDGET;
export const SOLID_LAB_ELEMENTS = 48;
/** Draw calls of the primitive: faces, links, vertices. */
export const SOLID_DRAW_CALLS = 3;
/** Strengths of the laboratory's tools (velocity given, units/s per unit mass at the point of the blow; rad/s at the ends for the torsion). */
const IMPULSE = 5;
const TWIST = 3;
const BREAK = 11;
/** The size of the fracture the laboratory asks of a body that breaks on events only (0..1). */
const BREAK_EVENT = 0.85;
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
  readonly debug: Record<string, number> = { vertices: 0, links: 0, faces: 0, cells: 0, pieces: 0, stress: 0, pulse: 0, events: 0, 'solid ms': 0, 'topology ms': 0, 'buffer ms': 0 };
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
  private readonly cursor: EventCursor = { time: -Infinity, seq: 0 };
  /** The event the laboratory's own tool offers to the gate: one that stands out, dated now. */
  private readonly staged: AudioEvent = { type: 'impact', audioTime: 0, strength: 0.6, confidence: 1, band: 1, structuralWeight: 0.7, duration: 0, significance: 1, seq: 0 };
  private now = 0;
  private readonly offer = (event: AudioEvent): void => this.system.solids!.gate.offer(event);
  private kind: SolidKind;
  /** A population's reading of the musical cues (last seq read; −1: not yet in a session) and the event it offers. */
  private cueCursor = -1;
  private readonly cued: AudioEvent = { type: 'drop', audioTime: 0, strength: 0, confidence: 0, band: -1, structuralWeight: 0.7, duration: 0, significance: 0, seq: 0 };
  private readonly take = (cue: Readonly<Cue>): void => this.cue(cue);
  /** Where each body of a population is in its cycle (the tools' reading), whether it has been whole, and the cues it acted on. */
  readonly stages = new Uint8Array(DEFAULT_SOLID_BUDGET.bodies);
  readonly cuesTaken = { releases: 0, accents: 0 };
  private readonly wasSolid = new Uint8Array(DEFAULT_SOLID_BUDGET.bodies);
  private readonly readout = createReadout();
  private frames = 0;

  /**
   * `topology`: the packed topology of the world's vector field, shared with whatever else in the world shows that field.
   * `population`: the bodies of a scene (several, a material, the steps of the cycle it uses); without it, the laboratory's one body.
   */
  constructor(context: PrimitiveContext, private readonly params: SolidParams, readonly topology: Float32Array, budget: Readonly<SolidBudget> = SOLID_LAB_BUDGET,
    readonly population: Readonly<SolidPopulation> | null = null) {
    const capacity = population ? Math.max(4, populationElements(population)) : SOLID_LAB_ELEMENTS;
    const system = this.system = new StructuralSystem({ capacity, seed: context.seed, solids: population ? populationBudget(population) : budget });
    const n = system.state.capacity, solids = system.solids!.state, links = solids.linkCapacity, triangles = solids.faceCapacity;
    this.environment = createWorldEnvironment(context, topology);
    this.kind = SOLID_KINDS[Math.min(SOLID_KINDS.length - 1, Math.max(0, Math.round(params.solid)))] ?? 'tetrahedron';
    if (population) {
      Object.assign(system.solids!.tuning, solidProfile(population.profile));
      // Only the cues offered break a body; with fracture off nothing is offered, and load alone breaks nothing in this mode.
      Object.assign(system.solids!.gate.tuning, createFractureTuning(), { mode: 'events' });
    }
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
    this.now = frame.time;
    let view: SolidView = 'wireframe', lamp = 0;
    if (import.meta.env.DEV) {
      system.profile = true;
      if (solidLab.active && !this.population) { view = this.lab(); lamp = LAMP; }
    }
    // The events heard by this frame wait in the gate for the step that reaches their own time: without a clock there are none.
    const events = frame.timed && !this.population ? frame.clock?.events : undefined;
    const cues = frame.timed && this.population ? frame.snapshot?.cues : undefined;
    if (cues) {
      // A population mounted into a session that is already running starts from now; a new session's cues from its first.
      this.cueCursor = this.cueCursor < 0 ? cues.seq : forEachCue(cues, this.cueCursor, this.take);
    }
    if (events) {
      // A body mounted into a session that is already running starts from now: what was heard before it was there did not strike it.
      if (this.cursor.epoch === undefined) { this.cursor.time = frame.time; this.cursor.seq = events.seq; this.cursor.epoch = events.epoch; }
      events.forEachHeard(this.cursor, frame.time, this.offer);
    }
    system.advance(frame.time, env);
    const started = import.meta.env.DEV ? performance.now() : 0;
    // What a body shows of itself: the world's light, and the ember it cools down with.
    this.draw(view, Math.max(presence * Math.max(look.emissive, look.ember), lamp), presence * look.wave * g.impulse, look.blend - 0.5, Math.max(look.fill, lamp));

    if (this.population && this.frames++ % STAGE_EVERY === 0) this.readStages();
    if (import.meta.env.DEV) {
      const d = this.debug, stats = solids.stats;
      d.vertices = this.drawn.points; d.links = stats.intact; d.faces = stats.faces; d.cells = stats.cells; d.pieces = solids.state.bodies ? solids.state.bodyPieces[0] : 0;
      d.stress = stats.stress; d.pulse = solids.pulseOf(0); d.events = stats.events; d['solid ms'] = stats.solveMs; d['topology ms'] = stats.bookMs;
      d['buffer ms'] += (performance.now() - started - d['buffer ms']) * 0.05;
    }
  }

  setPixelRatio(ratio: number): void {
    (this.nodes.uniforms.uPoint.value as Vector3).y = ratio;
  }

  /** A new audio session: the bodies stay as they are; only the simulation's clock (and what was read of the last session's cues) is forgotten. */
  reset(): void {
    this.system.reset();
    this.cueCursor = -1;
  }

  /**
   * A musical cue of the session, or one a tool offers (the same path): a release heard or an accent that stands out goes
   * to the fracture gate as an event at its own time; it passes or not as any other. Anything else is not the gate's.
   */
  cue(cue: Readonly<Cue>): void {
    const breaks = this.population?.fracture ?? 'none', event = this.cued;
    if (breaks === 'none') return;
    if (cue.kind === 'release' && cue.status === 'confirmed') { event.type = 'drop'; this.cuesTaken.releases++; }
    else if (breaks === 'accent' && cue.kind === 'accent' && cue.status === 'observed') { event.type = 'impact'; this.cuesTaken.accents++; }
    else return;
    event.audioTime = cue.time; event.strength = cue.strength; event.confidence = cue.confidence; event.significance = cue.strength;
    this.system.solids!.gate.offer(event);
  }

  /** The population as it was seeded again, its stages forgotten (a tool's reset). The pools are reused. */
  reseed(): void {
    this.wasSolid.fill(0); this.stages.fill(0);
    this.seed(true);
  }

  /** Where each body is in the cycle, read from its links. */
  private readStages(): void {
    const solids = this.system.solids!;
    for (let b = 0; b < solids.state.bodies; b++) {
      const r = solids.read(b, null, this.readout), stage = stageOf(r, this.wasSolid[b] === 1);
      if (stage === 'solid') this.wasSolid[b] = 1;
      this.stages[b] = SOLID_STAGES.indexOf(stage);
    }
  }

  dispose(): void {
    this.nodeGeometry.dispose(); this.lineGeometry.dispose(); this.faceGeometry.dispose();
    this.nodes.dispose(); this.lines.dispose(); this.faces.dispose();
    (this.object as Group).clear();
  }

  /** The matter of this world: one solid, whole or only seeded. The pools are emptied and reused; nothing is reallocated. */
  private seed(bonded: boolean): void {
    this.system.clear();
    const population = this.population;
    if (!population) { this.system.seedSolid(this.kind, this.params.solidRadius, { ...POSE, bonded, scatter: bonded ? 0 : SCATTER }); return; }
    const whole = population.start === 'solid';
    for (const b of population.bodies) this.system.seedSolid(b.kind, b.radius, { x: b.x, y: b.y, z: b.z, turn: b.turn, tilt: b.tilt, bonded: whole, scatter: whole ? 0 : SCATTER });
    this.readStages();
  }

  /** The laboratory: its overrides, its commands, the view it asks for. */
  private lab(): SolidView {
    const system = this.system, solids = system.solids!, lab = solidLab, command = lab.command;
    Object.assign(system.tuning, lab.tuning); Object.assign(solids.tuning, lab.material); Object.assign(solids.gate.tuning, lab.fracture);
    lab.command = null;
    if (command === 'reset' || command === 'seed' || lab.kind !== this.kind) {
      this.kind = lab.kind;
      this.seed(command !== 'seed');
    } else if (command === 'event') {
      // The same path as an event of the session: the gate judges it (confidence, threshold, cooldown, budget).
      this.staged.audioTime = this.now; solids.gate.offer(this.staged);
    } else if (command && solids.state.bodies > 0) {
      // Blows are aimed at the body where it is now: beside its first vertex, from outside or from within.
      const c = solids.centroid(0), p = system.state.position, first = solids.state.bodyFirst[0] * 3, size = this.params.solidRadius;
      const dx = p[first] - c[0], dy = p[first + 1] - c[1], dz = p[first + 2] - c[2];
      if (command === 'twist') solids.twist(0, TWIST);
      else {
        const at = command === 'impulse' ? 1.4 : 0.5;
        system.strike(c[0] + dx * at, c[1] + dy * at, c[2] + dz * at, command === 'impulse' ? IMPULSE : BREAK, size);
        // A body that breaks on events only is broken by the tool as an event would break it: through the same gate.
        if (command === 'fracture' && solids.gate.tuning.mode === 'events') solids.gate.force(BREAK_EVENT);
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
