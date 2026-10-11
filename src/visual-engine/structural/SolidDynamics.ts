import { BOND_COST, BREAK_HEAT, fade, loadOf, MEMORY_RANGE, tire } from './BondSystem';
import { SolidState } from './SolidState';
import { solidMesh } from './SolidTopology';
import {
  BRACE, BROKEN, createSolidTuning, DEFAULT_SOLID_BUDGET, EDGE, FORMS, INTACT, LOST, MAX_CELL_VERTICES, MAX_ITERATIONS, SOLID_LIMITS, within,
  type SolidBudget, type SolidForm, type SolidKind,
} from './SolidTypes';
import type { Population } from './StructuralIdentity';
import type { StructuralState } from './StructuralState';
import { finite, R_MAX, unit, V_MAX, type StructuralEnvironment, type StructuralTuning } from './StructuralTypes';

/*
 * Solid dynamics: the constraints that make elements of the structural system
 * a volumetric body, solved inside that system's own fixed step.
 *
 *   StructuralSystem.step        the medium, the fronts, the world's potential, wires, memory   → a predicted motion
 *   SolidSystem.solve            links and cells projected on it (XPBD), velocities corrected   → the motion it is held to
 *                                load, fatigue, fracture; remembered links forming again
 *
 * The solver is extended position-based dynamics: each constraint has a
 * compliance α (the inverse of a stiffness, independent of the step), used as
 * α / h², and a multiplier λ accumulated over the iterations of one step and
 * forgotten at the next. A link holds a length, a cell a volume: the signed
 * volume enclosed by its triangles, so the same law keeps a tetrahedron from
 * collapsing, turns an inverted one back the right way out, and holds the
 * volume of a whole shell. Iterations are a constant of the budget.
 *
 * Nothing the sound does writes a position. The multiscale resonance changes
 * what a link and a cell tend to (their rest length and volume, by what their
 * own matter takes of it), and the body follows through its own inertia:
 *
 *   macro   a slow mode per link, and one for the volume of each cell     the body breathes and leans
 *   meso    the signed swing of the two ends at their own pitch            links and faces vibrate, unlike ends strain
 *   micro   the fine excitation they take, as a small dilation             short, local, small
 *
 * All of it is internal (pairs and cells), so a body and each of its fragments
 * keep their momentum; without sound none of it is there and what moves only
 * loses energy.
 */

/** Stiffness of an edge and of a brace (force per unit length, for matter of unit mass) and bulk stiffness of a cell (energy per unit volume). */
const K_EDGE = 140;
const K_BRACE = 100;
/** Bending stiffness of the surface across a link, as the stiffness of the hinge between the two far corners. */
const K_HINGE = 45;
const BULK = 500;
/** Damping ratio of a cell's volume. */
const ZETA_VOLUME = 0.3;
/** Strength of an edge and of a brace (× the resistance of their matter), and how much a unit of strain loads a link. */
const EDGE_STRENGTH = 1.6;
const BRACE_STRENGTH = 1.3;
const S_LINK = 6;
/** A link's load is followed over this time (s). */
const FOLLOW = 0.05;
/** How far the resonance moves a link's rest length (shares of it: macro, meso, micro, and in all) and a cell's rest volume. */
const DRIVE_MACRO = 0.14;
const DRIVE_MESO = 0.05;
const DRIVE_MICRO = 0.02;
const DRIVE_MAX = 0.3;
const SWELL = 0.25;
const SWELL_MAX = 0.4;
/** One projection moves an element no further than this share of the link's length, or of a cell's size. */
const SHIFT_MAX = 0.25;
/**
 * The memory of a broken link, as a spring towards its length: its stiffness with the memory whole in ordered, cold
 * matter (for matter of unit mass: about a quarter of the link it was), and the most it ever pulls. Firmer than the
 * memory of a wire: the world's own potential holds the pieces of a body open, and a shape is only found again if
 * what remembers it can answer that.
 */
const K_RECALL = 40;
const RECALL_MAX = 6;
/** Remembered links are looked at every so many steps (the cadence of the elements' own neighbourhoods). */
const REFORM_EVERY = 6;
/** A link forms again between ends this near its length (share of it) and this slow against each other (units/s). */
const REFORM_NEAR = 0.15;
const REFORM_SPEED = 0.6;
/** … and only where the cells it bounds are the right way out: at least this share of their volume. */
const UPRIGHT = 0.25;
/** A link that has formed again, and a cell that holds again, come to their own length and volume over this time (s): slower than a wire, so the rest of the body can follow. */
const REST = 2.5;
/** What a break leaves in a link that forms again: it is not new. */
const SCAR = 0.25;
/** The matter of a body: low, structural, narrow enough to ring together and wide enough for its vertices to differ. */
const MATTER = { centre: 0.36, spread: 0.08 };

export interface SolidOptions {
  x?: number;
  y?: number;
  z?: number;
  /** Rotation about the world's axis, after a tilt about x (rad). */
  turn?: number;
  tilt?: number;
  /** Made whole at once (default), or only seeded: its elements in place, every link remembered, none holding. */
  bonded?: boolean;
  /** Seeded this much further from its centre than its links are long (a share): what has to come together before it forms. */
  scatter?: number;
  population?: Population;
}

export interface SolidStats {
  bodies: number;
  /** Links holding, broken but remembered, and forgotten. */
  intact: number;
  broken: number;
  lost: number;
  /** Surface triangles and cells holding. */
  faces: number;
  cells: number;
  /** Pieces of bodies that are no longer whole. */
  fragments: number;
  /** Mean and highest load of the links holding (a share of what they bear). */
  stress: number;
  peak: number;
  /** Kinetic energy of the bodies' elements, and elastic energy stored in links and cells (estimated from their compliance). */
  kinetic: number;
  elastic: number;
  /** Links broken and formed again, bodies refused for want of room, states repaired, since the last clear. */
  fractures: number;
  reforms: number;
  refused: number;
  repairs: number;
  /** Cells found inside out in the last step. */
  inverted: number;
  iterations: number;
  /** CPU time per frame, smoothed (ms): the whole solid pass, and its topology part. Frames over the budget. Only while profiling. */
  solveMs: number;
  bookMs: number;
  peakMs: number;
  over: number;
}

/** What one body is now, for the tools. Filled on request, never per step. */
export interface BodyReadout {
  kind: SolidKind;
  vertices: number;
  edges: number;
  edgesIntact: number;
  braces: number;
  bracesIntact: number;
  /** Geometric faces, and those whose every triangle holds. */
  faces: number;
  facesHolding: number;
  triangles: number;
  cells: number;
  cellsHolding: number;
  mass: number;
  /** Share of its links holding, each counted less by its damage. */
  integrity: number;
  stress: number;
  peak: number;
  kinetic: number;
  elastic: number;
  /** Volume of the cells holding now, what they tend to, and the volume the body was made with. */
  volume: number;
  volumeRest: number;
  volumeReference: number;
  broken: number;
  lost: number;
  pieces: number;
  form: SolidForm;
  sealed: boolean;
  /** What it takes of the sound: the macro modes its links follow (mean, signed), and the means over its elements of the amplitude at their own pitch (meso) and of the micro excitation. */
  macro: number;
  meso: number;
  micro: number;
  /** Its answer: how far its links are from the length they were made with (RMS, a share of it), and their elastic strain against what they tend to now (RMS). */
  response: number;
  strain: number;
}

export const createReadout = (): BodyReadout => ({
  kind: 'tetrahedron', vertices: 0, edges: 0, edgesIntact: 0, braces: 0, bracesIntact: 0, faces: 0, facesHolding: 0, triangles: 0, cells: 0, cellsHolding: 0,
  mass: 0, integrity: 0, stress: 0, peak: 0, kinetic: 0, elastic: 0, volume: 0, volumeRest: 0, volumeReference: 0, broken: 0, lost: 0, pieces: 0,
  form: 'free', sealed: false, macro: 0, meso: 0, micro: 0, response: 0, strain: 0,
});

export class SolidSystem {
  readonly budget: SolidBudget;
  readonly state: SolidState;
  /** Development overrides of the material; the product leaves them as created. */
  readonly tuning = createSolidTuning();
  readonly stats: SolidStats = {
    bodies: 0, intact: 0, broken: 0, lost: 0, faces: 0, cells: 0, fragments: 0, stress: 0, peak: 0, kinetic: 0, elastic: 0,
    fractures: 0, reforms: 0, refused: 0, repairs: 0, inverted: 0, iterations: 0, solveMs: 0, bookMs: 0, peakMs: 0, over: 0,
  };
  /** Measure CPU time (development). */
  profile = false;
  /** Working positions of the step, the positions before it, and inverse masses: double precision, the bodies' elements only. */
  private readonly x: Float64Array;
  private readonly prev: Float64Array;
  private readonly w: Float64Array;
  /** What each link and cell tends to in this step (rest driven by the resonance) and its multiplier. */
  private readonly target: Float64Array;
  private readonly lambda: Float64Array;
  private readonly cellTarget: Float64Array;
  private readonly cellLambda: Float64Array;
  private readonly hingeLambda: Float64Array;
  /** How far the cells each link bounds are the right way out (1: wholly), as last looked at. */
  private readonly right: Float32Array;
  private readonly gradient = new Float64Array(MAX_CELL_VERTICES * 3);
  private readonly held: Int32Array;
  private readonly centre = new Float64Array(3);
  private readonly axis = new Float64Array(3);
  private stepIndex = 0;
  private frameTime = 0;
  private bookTime = 0;

  constructor(private readonly matter: StructuralState, budget: Partial<SolidBudget> = {}) {
    const b = this.budget = { ...DEFAULT_SOLID_BUDGET, ...budget };
    b.iterations = Math.min(MAX_ITERATIONS, Math.max(1, Math.floor(finite(b.iterations, DEFAULT_SOLID_BUDGET.iterations))));
    b.frameMs = Math.max(0.01, finite(b.frameMs, DEFAULT_SOLID_BUDGET.frameMs));
    const state = this.state = new SolidState(matter, b), n = matter.capacity;
    this.x = new Float64Array(n * 3); this.prev = new Float64Array(n * 3); this.w = new Float64Array(n);
    this.target = new Float64Array(state.linkCapacity); this.lambda = new Float64Array(state.linkCapacity); this.right = new Float32Array(state.linkCapacity).fill(1); this.hingeLambda = new Float64Array(state.linkCapacity);
    this.cellTarget = new Float64Array(state.cellCapacity); this.cellLambda = new Float64Array(state.cellCapacity);
    this.held = new Int32Array(state.faceCapacity);
    this.stats.iterations = b.iterations;
  }

  /**
   * Seeds a solid of circumradius `radius`: its vertices as elements of the system, its links, faces and cells over
   * them. The figure is the initial condition; from here on the body is what the physics makes of it. Returns the
   * body, or −1 when the pools have no room for it (counted, nothing is squeezed in).
   */
  seed(kind: SolidKind, radius: number, seed: number, reach: number, options: SolidOptions = {}): number {
    const state = this.state, matter = this.matter, mesh = solidMesh(kind);
    const vertices = mesh.vertices.length / 3, links = (mesh.edges.length + mesh.braces.length) / 2, triangles = mesh.triangles.length / 3;
    let cellTriangles = 0, cellVertices = 0;
    for (const cell of mesh.cells) { cellTriangles += cell.length / 3; cellVertices += new Set(cell).size; }
    const size = finite(radius, 0);
    if (!(size > 1e-3) || matter.count + vertices > matter.capacity || !state.fits(links, triangles, mesh.cells.length, cellTriangles, cellVertices)) { this.stats.refused++; return -1; }
    const { x = 0, y = 0, z = 0, turn = 0, tilt = 0, bonded = true } = options, scatter = Math.max(0, finite(options.scatter ?? 0, 0));
    const population = options.population ?? { id: 300 + state.bodies, ...MATTER };
    const first = matter.count, ct = Math.cos(tilt), st = Math.sin(tilt), ca = Math.cos(turn), sa = Math.sin(turn), out = size * (1 + scatter);
    for (let k = 0; k < vertices; k++) {
      const vx = mesh.vertices[k * 3], vy = mesh.vertices[k * 3 + 1] * ct - mesh.vertices[k * 3 + 2] * st, vz = mesh.vertices[k * 3 + 1] * st + mesh.vertices[k * 3 + 2] * ct;
      matter.add(seed, population, x + (vx * ca - vy * sa) * out, y + (vx * sa + vy * ca) * out, z + vz * out, reach);
    }
    const body = state.addBody(kind, first, vertices, mesh.faces.length / mesh.faceSize);
    for (let kindOf = EDGE; kindOf <= BRACE; kindOf++) {
      const pairs = kindOf === EDGE ? mesh.edges : mesh.braces;
      for (let k = 0; k < pairs.length; k += 2) {
        const a = first + pairs[k], b = first + pairs[k + 1], reduced = matter.mass[a] * matter.mass[b] / (matter.mass[a] + matter.mass[b]);
        // Stiffness follows the matter it ties (heavier ends, a stiffer link), so every link of a body rings in the same range.
        const stiffness = (kindOf === EDGE ? K_EDGE : K_BRACE) * 2 * reduced;
        // Seeded apart, a link still remembers the length of the figure, not the distance it was dropped at.
        const length = scatter > 0 ? size * Math.hypot(mesh.vertices[pairs[k] * 3] - mesh.vertices[pairs[k + 1] * 3], mesh.vertices[pairs[k] * 3 + 1] - mesh.vertices[pairs[k + 1] * 3 + 1], mesh.vertices[pairs[k] * 3 + 2] - mesh.vertices[pairs[k + 1] * 3 + 2]) : NaN;
        state.addLink(body, a, b, kindOf, 1 / stiffness, 0.5 * (matter.damping[a] + matter.damping[b]),
          (kindOf === EDGE ? EDGE_STRENGTH : BRACE_STRENGTH) * 0.5 * (matter.resistance[a] + matter.resistance[b]), Math.sqrt(matter.coupling[a] * matter.coupling[b]), bonded, length);
      }
    }
    // Until the first step, what a link tends to is the length it has.
    for (let l = state.bodyLinkStart[body], end = l + state.bodyLinkCount[body]; l < end; l++) this.target[l] = state.linkRest[l];
    for (let t = 0; t < triangles; t++) state.addFace(body, first + mesh.triangles[t * 3], first + mesh.triangles[t * 3 + 1], first + mesh.triangles[t * 3 + 2], mesh.triangleFace[t]);
    state.addHinges(body, 1 / (1 + scatter));
    const shrink = 1 / ((1 + scatter) * (1 + scatter) * (1 + scatter));
    for (const cell of mesh.cells) {
      const c = state.addCell(body, Int32Array.from(cell, (v) => first + v));
      if (c < 0) continue;
      if (scatter > 0) state.cellRest[c] = state.cellRest0[c] = state.cellVolume[c] * shrink;
      state.cellHolds[c] = bonded ? 1 : 0; this.cellTarget[c] = state.cellRest[c];
    }
    if (bonded) for (let i = first; i < first + vertices; i++) { matter.cohesion[i] = 1; matter.order[i] = 0.8; }
    this.book();
    this.count();
    return body;
  }

  /** Where the bodies' elements are before the step moves them. */
  begin(): void {
    const state = this.state, p = this.matter.position, prev = this.prev;
    for (let b = 0; b < state.bodies; b++) {
      for (let i = state.bodyFirst[b] * 3, end = i + state.bodyCount[b] * 3; i < end; i++) prev[i] = p[i];
    }
  }

  /**
   * The memory of broken links, one step, before the motion is predicted. It fades as the memory of a wire does. While
   * the world is alive it is a weak spring towards the length the link had, from either side (a remembered length is
   * a length: ends that fell together are parted as ends that flew apart are drawn back), the firmer the more ordered
   * and the colder the two ends are. Into `acc`, equal and opposite. In silence it moves nothing.
   */
  recall(acc: Float64Array, env: Readonly<StructuralEnvironment>, h: number): void {
    const state = this.state, matter = this.matter, p = matter.position, alive = unit(3 * env.energy), right = this.right;
    for (let l = 0; l < state.links; l++) {
      right[l] = 1;
      if (state.linkState[l] !== BROKEN) continue;
      const memory = fade(state.linkMemory[l], 0.5 * (matter.temperature[state.linkA[l]] + matter.temperature[state.linkB[l]]), 0.5 * (matter.persistence[state.linkA[l]] + matter.persistence[state.linkB[l]]), h);
      if (memory < 0.01) state.forget(l); else state.linkMemory[l] = memory;
    }
    if (alive <= 0) return;
    // Lengths alone do not tell a body from its mirror image: a piece that tumbled can sit at every remembered length
    // and be inside out. So an open cell remembers its volume as its links remember their length, as weakly: along
    // the gradient of the volume, which moves and turns nothing as a whole. And a link remembers its length only as
    // far as the cells it bounds are the right way out (wholly, from the volume at which it could form again): first
    // the right side, then the right distance.
    const g = this.gradient, verts = state.cellVertices;
    for (let c = 0; c < state.cells; c++) {
      if (state.cellHolds[c]) continue;
      let memory = 1, open = false;
      for (let k = state.cellLinkStart[c], end = k + state.cellLinkCount[c]; k < end && memory > 0; k++) {
        const l = state.cellLinks[k];
        if (state.linkState[l] === LOST) memory = 0;
        else if (state.linkState[l] === BROKEN) { open = true; if (state.linkMemory[l] < memory) memory = state.linkMemory[l]; }
      }
      if (!open || memory <= 0) continue;
      const from = state.cellVertexStart[c], n = state.cellVertexCount[c], volume = this.volumeOf(c, p), rest = state.cellRest0[c], share = unit(volume / (UPRIGHT * rest));
      for (let k = state.cellLinkStart[c], end = k + state.cellLinkCount[c]; k < end; k++) if (share < right[state.cellLinks[k]]) right[state.cellLinks[k]] = share;
      let most = 0, order = 0, heat = 0, mass = 0, span = 0;
      const o = verts[from] * 3;
      for (let k = 0; k < n; k++) {
        const e = verts[from + k], size = Math.sqrt(g[k * 3] * g[k * 3] + g[k * 3 + 1] * g[k * 3 + 1] + g[k * 3 + 2] * g[k * 3 + 2]);
        const dx = p[e * 3] - p[o], dy = p[e * 3 + 1] - p[o + 1], dz = p[e * 3 + 2] - p[o + 2], far = dx * dx + dy * dy + dz * dz;
        if (size > most) most = size;
        if (far > span) span = far;
        order += matter.order[e] / n; heat += matter.temperature[e] / n; mass += matter.mass[e] / n;
      }
      // Like a link's, this memory does not reach across the world: a cell spread wider than that is not drawn together.
      const reach = 1 - span / (MEMORY_RANGE * MEMORY_RANGE);
      if (!(most > 1e-9) || reach <= 0) continue;
      const off = (rest - volume) / rest, f = mass * RECALL_MAX * (off > 1 ? 1 : off < -1 ? -1 : off) * reach * memory * order * (1 - heat) * alive / most;
      if (!Number.isFinite(f)) continue;
      for (let k = 0; k < n; k++) {
        const e = verts[from + k], push = f / matter.mass[e];
        acc[e * 3] += g[k * 3] * push; acc[e * 3 + 1] += g[k * 3 + 1] * push; acc[e * 3 + 2] += g[k * 3 + 2] * push;
      }
    }
    for (let l = 0; l < state.links; l++) {
      if (state.linkState[l] !== BROKEN || right[l] <= 0) continue;
      const a = state.linkA[l], b = state.linkB[l];
      let dx = p[b * 3] - p[a * 3], dy = p[b * 3 + 1] - p[a * 3 + 1], dz = p[b * 3 + 2] - p[a * 3 + 2], d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > MEMORY_RANGE) continue;
      if (!(d > 1e-6)) { this.apart(a, b); dx = this.axis[0]; dy = this.axis[1]; dz = this.axis[2]; d = 1; }
      const pull = K_RECALL * (d - state.linkRest0[l]), scale = 2 * matter.mass[a] * matter.mass[b] / (matter.mass[a] + matter.mass[b]);
      // Felt less from far away: it finds a partner that is near, it does not fetch one from across the world.
      const f = scale * (pull > RECALL_MAX ? RECALL_MAX : pull < -RECALL_MAX ? -RECALL_MAX : pull) * (1 - (d / MEMORY_RANGE) * (d / MEMORY_RANGE)) * right[l]
        * state.linkMemory[l] * 0.5 * (matter.order[a] + matter.order[b]) * (1 - 0.5 * (matter.temperature[a] + matter.temperature[b])) * alive / d;
      acc[a * 3] += dx * f / matter.mass[a]; acc[a * 3 + 1] += dy * f / matter.mass[a]; acc[a * 3 + 2] += dz * f / matter.mass[a];
      acc[b * 3] -= dx * f / matter.mass[b]; acc[b * 3 + 1] -= dy * f / matter.mass[b]; acc[b * 3 + 2] -= dz * f / matter.mass[b];
    }
  }

  /**
   * One fixed step of the bodies, on the motion the structural step has just predicted: project links and cells,
   * correct the velocities, load and break what can bear no more, let what is remembered form again.
   */
  solve(env: Readonly<StructuralEnvironment>, tuning: Readonly<StructuralTuning>, h: number): void {
    const state = this.state;
    if (state.bodies === 0) return;
    const started = this.profile ? performance.now() : 0;
    // A link broken from outside the step (a tool): what it held must be gone before anything is projected.
    if (state.dirty) this.book();
    const matter = this.matter, p = matter.position, v = matter.velocity, x = this.x, prev = this.prev, w = this.w, stats = this.stats;
    const own = this.tuning, heavy = within(own.mass, SOLID_LIMITS.mass), stiff = within(own.stiffness, SOLID_LIMITS.stiffness);
    const damp = within(own.damping, SOLID_LIMITS.damping), give = within(own.volumeCompliance, SOLID_LIMITS.volumeCompliance);
    const resonance = env.resonance?.live ? env.resonance : null, hear = Math.max(0, finite(tuning.resonanceCoupling, 1));
    for (let b = 0; b < state.bodies; b++) {
      for (let i = state.bodyFirst[b], end = i + state.bodyCount[b]; i < end; i++) {
        matter.mass[i] = state.mass0[i] * heavy; w[i] = 1 / matter.mass[i];
        x[i * 3] = p[i * 3]; x[i * 3 + 1] = p[i * 3 + 1]; x[i * 3 + 2] = p[i * 3 + 2];
      }
    }
    const A = state.linkA, B = state.linkB, target = this.target, lambda = this.lambda, settle = 1 - Math.exp(-h / REST), ih2 = 1 / (h * h);
    for (let l = 0; l < state.links; l++) {
      if (state.linkState[l] !== INTACT) continue;
      const a = A[l], b = B[l], rest = state.linkRest[l] += (state.linkRest0[l] - state.linkRest[l]) * settle;
      state.linkAge[l] += h;
      let drive = 0;
      if (resonance) {
        // What the two ends take of the sound moves the length their link tends to: never the ends themselves.
        drive = state.linkCoupling[l] * (DRIVE_MACRO * hear * resonance.breath(0.5 * (matter.phase[a] + matter.phase[b]))
          + DRIVE_MESO * 0.5 * (matter.vibration[a] + matter.vibration[b]) + DRIVE_MICRO * 0.5 * (matter.micro[a] + matter.micro[b]));
        drive = drive > DRIVE_MAX ? DRIVE_MAX : drive < -DRIVE_MAX ? -DRIVE_MAX : finite(drive);
      }
      target[l] = rest * (1 + drive); lambda[l] = this.hingeLambda[l] = 0;
    }
    const cellTarget = this.cellTarget, cellLambda = this.cellLambda;
    for (let c = 0; c < state.cells; c++) {
      if (!state.cellHolds[c]) continue;
      const rest = state.cellRest[c] += (state.cellRest0[c] - state.cellRest[c]) * settle;
      let swell = 0;
      if (resonance) {
        const e = state.bodyFirst[state.cellBody[c]];
        swell = SWELL * hear * matter.coupling[e] * resonance.breath(matter.phase[e]);
        swell = swell > SWELL_MAX ? SWELL_MAX : swell < -SWELL_MAX ? -SWELL_MAX : finite(swell);
      }
      cellTarget[c] = rest * (1 + swell); cellLambda[c] = 0;
    }

    stats.inverted = 0;
    for (let iteration = 0; iteration < this.budget.iterations; iteration++) {
      for (let l = 0; l < state.links; l++) {
        if (state.linkState[l] !== INTACT) continue;
        lambda[l] += this.tie(A[l], B[l], target[l], stiff / state.linkCompliance[l], state.linkDamping[l] * damp, lambda[l], SHIFT_MAX * state.linkRest0[l], h, ih2);
        // Both triangles on this link hold: the surface resists being folded along it.
        if (state.linkFaces[l] === 2 && state.hingeA[l] >= 0) {
          const e = state.hingeA[l], f = state.hingeB[l];
          this.hingeLambda[l] += this.tie(e, f, state.hingeRest[l], stiff * K_HINGE * 2 / (w[e] + w[f]), state.linkDamping[l] * damp, this.hingeLambda[l], SHIFT_MAX * state.hingeRest[l], h, ih2);
        }
      }
      for (let c = 0; c < state.cells; c++) if (state.cellHolds[c]) this.hold(c, iteration === 0, h, ih2, give, damp);
    }

    // The velocity each element is left with is the one that takes it where the constraints put it.
    for (let b = 0; b < state.bodies; b++) {
      for (let i = state.bodyFirst[b], end = i + state.bodyCount[b]; i < end; i++) {
        const at = i * 3;
        let vx = v[at] + (x[at] - p[at]) / h, vy = v[at + 1] + (x[at + 1] - p[at + 1]) / h, vz = v[at + 2] + (x[at + 2] - p[at + 2]) / h;
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (speed > V_MAX) { vx *= V_MAX / speed; vy *= V_MAX / speed; vz *= V_MAX / speed; }
        let px = x[at], py = x[at + 1], pz = x[at + 2];
        const r = Math.sqrt(px * px + py * py + pz * pz);
        if (r > R_MAX) { px *= R_MAX / r; py *= R_MAX / r; pz *= R_MAX / r; }
        if (!Number.isFinite(px + py + pz + vx + vy + vz)) {
          // Never propagate a broken state: the element stays where the step found it, at rest.
          px = finite(prev[at]); py = finite(prev[at + 1]); pz = finite(prev[at + 2]); vx = vy = vz = 0;
          stats.repairs++;
        }
        p[at] = px; p[at + 1] = py; p[at + 2] = pz; v[at] = vx; v[at + 1] = vy; v[at + 2] = vz;
        matter.energy[i] = 0.5 * matter.mass[i] * (vx * vx + vy * vy + vz * vz) + 0.5 * matter.excitation[i] * matter.excitation[i];
      }
    }

    this.load(env, tuning, h, hear, stiff);
    if (++this.stepIndex % REFORM_EVERY === 0) this.reform(env);
    if (state.dirty) this.book();
    if (this.profile) this.frameTime += performance.now() - started;
  }

  /** The frame's steps are done: what they cost (development), against the budget. */
  frame(): void {
    if (!this.profile || this.state.bodies === 0) { this.frameTime = this.bookTime = 0; return; }
    const stats = this.stats;
    stats.solveMs += (this.frameTime - stats.solveMs) * 0.05; stats.bookMs += (this.bookTime - stats.bookMs) * 0.05;
    if (this.frameTime > stats.peakMs) stats.peakMs = this.frameTime;
    // Over budget is reported, never acted on: the topology does not follow the frame rate.
    if (this.frameTime > this.budget.frameMs) stats.over++;
    this.frameTime = this.bookTime = 0;
  }

  /**
   * A torsion about an axis through the body's centre of mass (development and tests): angular velocity proportional
   * to the height along the axis, so the two ends turn against each other and the body as a whole gains no spin.
   * An impulse, never a displacement.
   */
  twist(body: number, strength: number, ax = 0, ay = 0, az = 1): void {
    const state = this.state, matter = this.matter, p = matter.position, v = matter.velocity;
    if (!(body >= 0 && body < state.bodies)) return;
    const length = Math.sqrt(ax * ax + ay * ay + az * az);
    if (!(length > 1e-9) || !Number.isFinite(strength)) return;
    const nx = ax / length, ny = ay / length, nz = az / length, c = this.centroid(body), first = state.bodyFirst[body], last = first + state.bodyCount[body];
    let extent = 1e-6;
    for (let i = first; i < last; i++) extent = Math.max(extent, Math.abs((p[i * 3] - c[0]) * nx + (p[i * 3 + 1] - c[1]) * ny + (p[i * 3 + 2] - c[2]) * nz));
    for (let i = first; i < last; i++) {
      const rx = p[i * 3] - c[0], ry = p[i * 3 + 1] - c[1], rz = p[i * 3 + 2] - c[2], omega = strength * (rx * nx + ry * ny + rz * nz) / extent;
      v[i * 3] += omega * (ny * rz - nz * ry); v[i * 3 + 1] += omega * (nz * rx - nx * rz); v[i * 3 + 2] += omega * (nx * ry - ny * rx);
    }
  }

  /** Centre of mass of a body's elements. Writes and returns a reused array. */
  centroid(body: number): Float64Array {
    const state = this.state, matter = this.matter, p = matter.position, out = this.centre;
    let mass = 0;
    out[0] = out[1] = out[2] = 0;
    for (let i = state.bodyFirst[body], end = i + state.bodyCount[body]; i < end; i++) {
      out[0] += p[i * 3] * matter.mass[i]; out[1] += p[i * 3 + 1] * matter.mass[i]; out[2] += p[i * 3 + 2] * matter.mass[i]; mass += matter.mass[i];
    }
    if (mass > 0) { out[0] /= mass; out[1] /= mass; out[2] /= mass; }
    return out;
  }

  /** What body `b` is now: counts, health, energy, volume and what it takes of the sound. Measures of the state, nothing kept. */
  read(body: number, env: Readonly<StructuralEnvironment> | null, out: BodyReadout): BodyReadout {
    const state = this.state, matter = this.matter, v = matter.velocity, stiff = within(this.tuning.stiffness, SOLID_LIMITS.stiffness);
    const give = within(this.tuning.volumeCompliance, SOLID_LIMITS.volumeCompliance), resonance = env?.resonance?.live ? env.resonance : null;
    const first = state.bodyFirst[body], vertices = state.bodyCount[body], groups = state.bodyGroups[body], held = this.held;
    out.kind = state.bodyKind[body]; out.vertices = vertices; out.faces = groups; out.triangles = state.bodyFaceCount[body]; out.cells = state.bodyCellCount[body];
    out.edges = out.edgesIntact = out.braces = out.bracesIntact = out.broken = out.lost = 0;
    out.mass = out.kinetic = out.elastic = out.stress = out.peak = out.macro = out.meso = out.micro = out.response = out.strain = 0;
    let integrity = 0, intact = 0;
    for (let l = state.bodyLinkStart[body], end = l + state.bodyLinkCount[body]; l < end; l++) {
      const edge = state.linkKind[l] === EDGE, holds = state.linkState[l] === INTACT;
      if (edge) out.edges++; else out.braces++;
      if (!holds) { if (state.linkState[l] === LOST) out.lost++; else out.broken++; continue; }
      if (edge) out.edgesIntact++; else out.bracesIntact++;
      const stretch = state.linkStrain[l] * this.target[l];
      intact++; integrity += 1 - state.linkDamage[l];
      out.stress += state.linkStress[l]; out.peak = Math.max(out.peak, state.linkStress[l]);
      out.elastic += 0.5 * stiff / state.linkCompliance[l] * stretch * stretch; out.strain += state.linkStrain[l] * state.linkStrain[l];
      if (state.linkFaces[l] === 2 && state.hingeA[l] >= 0) out.elastic += this.folded(l, stiff);
      const deformed = (1 + state.linkStrain[l]) * this.target[l] / state.linkRest0[l] - 1;
      out.response += deformed * deformed;
      if (resonance) out.macro += resonance.breath(0.5 * (matter.phase[state.linkA[l]] + matter.phase[state.linkB[l]]));
    }
    const links = Math.max(1, state.bodyLinkCount[body]);
    out.integrity = integrity / links; out.stress = intact ? out.stress / intact : 0; out.strain = intact ? Math.sqrt(out.strain / intact) : 0; out.macro = intact ? out.macro / intact : 0;
    out.response = intact ? Math.sqrt(out.response / intact) : 0;
    for (let g = 0; g < groups; g++) held[g] = 0;
    for (let f = state.bodyFaceStart[body], end = f + state.bodyFaceCount[body]; f < end; f++) held[state.faceGroup[f]] += state.faceHolds[f] ? 0 : 1;
    out.facesHolding = 0;
    for (let g = 0; g < groups; g++) if (held[g] === 0) out.facesHolding++;
    out.cellsHolding = 0; out.volume = out.volumeRest = out.volumeReference = 0;
    for (let c = state.bodyCellStart[body], end = c + state.bodyCellCount[body]; c < end; c++) {
      out.volumeReference += state.cellRest0[c];
      if (!state.cellHolds[c]) continue;
      const off = state.cellVolume[c] - this.cellTarget[c];
      out.cellsHolding++; out.volume += state.cellVolume[c]; out.volumeRest += state.cellRest[c];
      out.elastic += 0.5 * BULK * off * off / (give * state.cellRest0[c]);
    }
    for (let i = first; i < first + vertices; i++) {
      out.mass += matter.mass[i]; out.kinetic += 0.5 * matter.mass[i] * (v[i * 3] * v[i * 3] + v[i * 3 + 1] * v[i * 3 + 1] + v[i * 3 + 2] * v[i * 3 + 2]);
      out.meso += matter.excitation[i] / vertices; out.micro += matter.micro[i] / vertices;
    }
    out.pieces = state.bodyPieces[body]; out.form = FORMS[state.bodyForm[body]]; out.sealed = state.bodySealed[body] === 1;
    return out;
  }

  /** Removes every body (the pools stay). The elements are the structural system's to clear. */
  clear(): void {
    const stats = this.stats;
    this.state.clear();
    this.stepIndex = 0;
    stats.fractures = stats.reforms = stats.refused = stats.repairs = stats.inverted = stats.over = 0; stats.peakMs = 0;
    this.count();
  }

  /**
   * One projection of a distance constraint between two elements: a length held with a stiffness (compliance
   * 1 / stiffness, used as α / h²) and a damping ratio, given the multiplier it has accumulated in this step. Moves
   * the two working positions and returns what to add to the multiplier.
   */
  private tie(i: number, j: number, rest: number, stiffness: number, zeta: number, lambda: number, limit: number, h: number, ih2: number): number {
    const x = this.x, prev = this.prev, w = this.w, a = i * 3, b = j * 3;
    let nx = x[b] - x[a], ny = x[b + 1] - x[a + 1], nz = x[b + 2] - x[a + 2];
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (length > 1e-9) { nx /= length; ny /= length; nz /= length; } else { this.apart(i, j); nx = this.axis[0]; ny = this.axis[1]; nz = this.axis[2]; }
    const wa = w[i], wb = w[j], sum = wa + wb, alpha = ih2 / stiffness;
    // Damping as a ratio of the pair's critical damping: γ = α · c / h with c = 2 ζ √(k μ).
    const gamma = 2 * zeta * Math.sqrt(stiffness / sum) / (stiffness * h);
    const rate = nx * (x[b] - prev[b] - x[a] + prev[a]) + ny * (x[b + 1] - prev[b + 1] - x[a + 1] + prev[a + 1]) + nz * (x[b + 2] - prev[b + 2] - x[a + 2] + prev[a + 2]);
    let step = (rest - length - alpha * lambda - gamma * rate) / ((1 + gamma) * sum + alpha);
    const shift = Math.abs(step) * (wa > wb ? wa : wb);
    if (shift > limit) step *= limit / shift;
    if (!Number.isFinite(step)) return 0;
    x[a] -= wa * step * nx; x[a + 1] -= wa * step * ny; x[a + 2] -= wa * step * nz;
    x[b] += wb * step * nx; x[b + 1] += wb * step * ny; x[b + 2] += wb * step * nz;
    return step;
  }

  /**
   * The signed volume the triangles of cell `c` enclose at `x`, and its gradient at each of its vertices (into
   * `gradient`): a third of the area of the triangles round the vertex, outward.
   */
  private volumeOf(c: number, x: ArrayLike<number>): number {
    const state = this.state, g = this.gradient, verts = state.cellVertices, corners = state.cellCorners;
    const from = state.cellVertexStart[c], n = state.cellVertexCount[c], triangles = state.cellTriangleStart[c], count = state.cellTriangleCount[c];
    const o = verts[from] * 3, ox = x[o], oy = x[o + 1], oz = x[o + 2];
    g.fill(0, 0, n * 3);
    let volume = 0;
    for (let t = 0; t < count; t++) {
      const i = corners[triangles + t * 3], j = corners[triangles + t * 3 + 1], k = corners[triangles + t * 3 + 2], a = verts[from + i] * 3, b = verts[from + j] * 3, d = verts[from + k] * 3;
      const ax = x[a] - ox, ay = x[a + 1] - oy, az = x[a + 2] - oz, bx = x[b] - ox, by = x[b + 1] - oy, bz = x[b + 2] - oz, cx = x[d] - ox, cy = x[d + 1] - oy, cz = x[d + 2] - oz;
      const ux = by * cz - bz * cy, uy = bz * cx - bx * cz, uz = bx * cy - by * cx;
      volume += ax * ux + ay * uy + az * uz;
      g[i * 3] += ux; g[i * 3 + 1] += uy; g[i * 3 + 2] += uz;
      g[j * 3] += cy * az - cz * ay; g[j * 3 + 1] += cz * ax - cx * az; g[j * 3 + 2] += cx * ay - cy * ax;
      g[k * 3] += ay * bz - az * by; g[k * 3 + 1] += az * bx - ax * bz; g[k * 3 + 2] += ax * by - ay * bx;
    }
    for (let k = 0; k < n * 3; k++) g[k] /= 6;
    return volume / 6;
  }

  /**
   * The volume constraint of cell `c`: the signed volume its triangles enclose, held to its target. A flattened cell
   * is pushed open, an inverted one turned back the right way out.
   */
  private hold(c: number, first: boolean, h: number, ih2: number, give: number, damp: number): void {
    const state = this.state, x = this.x, prev = this.prev, w = this.w, g = this.gradient, verts = state.cellVertices;
    const from = state.cellVertexStart[c], n = state.cellVertexCount[c], volume = this.volumeOf(c, x);
    if (first) { state.cellVolume[c] = volume; if (!(volume > 0)) this.stats.inverted++; }
    let sum = 0, rate = 0, most = 0;
    for (let k = 0; k < n; k++) {
      const e = verts[from + k], gx = g[k * 3], gy = g[k * 3 + 1], gz = g[k * 3 + 2], size = w[e] * Math.sqrt(gx * gx + gy * gy + gz * gz);
      sum += w[e] * (gx * gx + gy * gy + gz * gz);
      rate += gx * (x[e * 3] - prev[e * 3]) + gy * (x[e * 3 + 1] - prev[e * 3 + 1]) + gz * (x[e * 3 + 2] - prev[e * 3 + 2]);
      if (size > most) most = size;
    }
    // Collapsed to a line or a point, a cell has no direction to open in: its links have to give it one first.
    if (!(sum > 1e-12)) return;
    const rest = state.cellRest0[c], stiffness = BULK / (give * rest), alpha = ih2 / stiffness;
    const gamma = 2 * ZETA_VOLUME * damp * Math.sqrt(stiffness / sum) / (stiffness * h);
    let step = (this.cellTarget[c] - volume - alpha * this.cellLambda[c] - gamma * rate) / ((1 + gamma) * sum + alpha);
    const shift = Math.abs(step) * most, limit = SHIFT_MAX * Math.cbrt(rest);
    if (shift > limit) step *= limit / shift;
    if (!Number.isFinite(step)) return;
    this.cellLambda[c] += step;
    for (let k = 0; k < n; k++) {
      const e = verts[from + k], move = w[e] * step;
      x[e * 3] += move * g[k * 3]; x[e * 3 + 1] += move * g[k * 3 + 1]; x[e * 3 + 2] += move * g[k * 3 + 2];
    }
  }

  /** Two elements in one place have no direction between them: they part along one their own numbers give. Writes `axis`. */
  private apart(a: number, b: number): void {
    const matter = this.matter, turn = 2 * Math.PI * matter.phase[a], up = 2 * matter.phase[b] - 1, ring = Math.sqrt(Math.max(0, 1 - up * up));
    this.axis[0] = ring * Math.cos(turn); this.axis[1] = ring * Math.sin(turn); this.axis[2] = up;
  }

  /** What each link bears after the step, what that does to it, and its fracture when it can bear no more. */
  private load(env: Readonly<StructuralEnvironment>, tuning: Readonly<StructuralTuning>, h: number, hear: number, stiff: number): void {
    const state = this.state, matter = this.matter, p = matter.position, v = matter.velocity, stats = this.stats, target = this.target;
    const tension = unit(env.tension), release = unit(env.release), bear = Math.max(0.05, tuning.bondStrength * tuning.fractureThreshold), follow = 1 - Math.exp(-h / FOLLOW);
    let stress = 0, peak = 0, elastic = 0, intact = 0;
    for (let l = 0; l < state.links; l++) {
      if (state.linkState[l] !== INTACT) continue;
      const a = state.linkA[l], b = state.linkB[l];
      const dx = p[b * 3] - p[a * 3], dy = p[b * 3 + 1] - p[a * 3 + 1], dz = p[b * 3 + 2] - p[a * 3 + 2], length = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-9);
      const closing = ((v[b * 3] - v[a * 3]) * dx + (v[b * 3 + 1] - v[a * 3 + 1]) * dy + (v[b * 3 + 2] - v[a * 3 + 2]) * dz) / length;
      const stretch = length - target[l], strain = stretch / target[l], order = 0.5 * (matter.order[a] + matter.order[b]);
      state.linkStrain[l] = strain;
      const bears = loadOf(matter, a, b, S_LINK * Math.abs(strain), closing, state.linkCoupling[l] * hear, tension, release);
      const strength = state.linkStrength[l] * bear * (0.55 + 0.45 * order) * (1 - 0.5 * state.linkDamage[l]);
      const ratio = Number.isFinite(bears) ? bears / Math.max(strength, 1e-3) : 2;
      state.linkStress[l] += (Math.min(ratio, 2) - state.linkStress[l]) * follow;
      state.linkDamage[l] = tire(state.linkDamage[l], ratio, order, 0.5 * (matter.temperature[a] + matter.temperature[b]), h);
      if (ratio >= 1 || state.linkDamage[l] >= 1) { this.sever(l); continue; }
      const shown = state.linkStress[l];
      if (shown > matter.stress[a]) matter.stress[a] = shown;
      if (shown > matter.stress[b]) matter.stress[b] = shown;
      intact++; stress += shown; if (shown > peak) peak = shown;
      elastic += 0.5 * stiff / state.linkCompliance[l] * stretch * stretch;
      if (state.linkFaces[l] === 2 && state.hingeA[l] >= 0) elastic += this.folded(l, stiff);
    }
    const give = within(this.tuning.volumeCompliance, SOLID_LIMITS.volumeCompliance);
    for (let c = 0; c < state.cells; c++) {
      if (!state.cellHolds[c]) continue;
      const off = state.cellVolume[c] - this.cellTarget[c];
      elastic += 0.5 * BULK * off * off / (give * state.cellRest0[c]);
    }
    let kinetic = 0;
    for (let b = 0; b < state.bodies; b++) {
      for (let i = state.bodyFirst[b], end = i + state.bodyCount[b]; i < end; i++) kinetic += 0.5 * matter.mass[i] * (v[i * 3] * v[i * 3] + v[i * 3 + 1] * v[i * 3 + 1] + v[i * 3 + 2] * v[i * 3 + 2]);
    }
    stats.stress = intact ? stress / intact : 0; stats.peak = peak; stats.elastic = elastic; stats.kinetic = kinetic;
  }

  /** Elastic energy of the hinge across link `l`: how far the surface is folded along it. */
  private folded(l: number, stiff: number): number {
    const state = this.state, matter = this.matter, p = matter.position, e = state.hingeA[l], f = state.hingeB[l];
    const dx = p[f * 3] - p[e * 3], dy = p[f * 3 + 1] - p[e * 3 + 1], dz = p[f * 3 + 2] - p[e * 3 + 2], off = Math.sqrt(dx * dx + dy * dy + dz * dz) - state.hingeRest[l];
    return 0.5 * stiff * K_HINGE * 2 * matter.mass[e] * matter.mass[f] / (matter.mass[e] + matter.mass[f]) * off * off;
  }

  /**
   * A link gives way: the topology changes, the matter does not. Its two ends keep where they are and how they move
   * and are marked as the ends of a broken wire are (a shock, their cohesion spent, some heat). Called by the load
   * law; public so that a tool or a test breaks a link exactly as a fracture does.
   */
  sever(l: number): boolean {
    const state = this.state, matter = this.matter;
    if (!(l >= 0 && l < state.links) || !state.sever(l)) return false;
    for (let end = 0; end < 2; end++) {
      const i = end === 0 ? state.linkA[l] : state.linkB[l];
      matter.shock[i] = 1; matter.cohesion[i] = 0;
      matter.temperature[i] = Math.min(1, matter.temperature[i] + BREAK_HEAT);
    }
    this.stats.fractures++;
    return true;
  }

  /**
   * Remembered links form again where physics and topology allow: in a living world, between ends that have both
   * settled (ordered, cold, at rest in the medium, no longer fresh from a break), near the length they were held at,
   * slow against each other, and with the cells the link bounds the right way out. A cell whose shell has closed
   * again holds its volume once that volume is verified. Nothing is put back: links start at the length they are
   * found at, a cell at the volume it has, and both settle.
   */
  private reform(env: Readonly<StructuralEnvironment>): void {
    const state = this.state, matter = this.matter, p = matter.position, v = matter.velocity;
    // Silence finishes what has settled; it forms nothing new.
    if (unit(3 * env.energy) > 0) {
      for (let l = 0; l < state.links; l++) {
        if (state.linkState[l] !== BROKEN) continue;
        const a = state.linkA[l], b = state.linkB[l];
        if (matter.cohesion[a] < 1 || matter.cohesion[b] < 1) continue;
        const dx = p[b * 3] - p[a * 3], dy = p[b * 3 + 1] - p[a * 3 + 1], dz = p[b * 3 + 2] - p[a * 3 + 2], length = Math.sqrt(dx * dx + dy * dy + dz * dz), rest = state.linkRest0[l];
        if (!(Math.abs(length - rest) <= REFORM_NEAR * rest)) continue;
        const ux = v[b * 3] - v[a * 3], uy = v[b * 3 + 1] - v[a * 3 + 1], uz = v[b * 3 + 2] - v[a * 3 + 2];
        if (!(ux * ux + uy * uy + uz * uz <= REFORM_SPEED * REFORM_SPEED) || !this.upright(l)) continue;
        if (!state.restore(l, length, Math.max(SCAR, 0.6 * state.linkDamage[l]))) continue;
        this.target[l] = length; state.linkStrain[l] = 0;
        // Each link costs its two ends part of what they had settled: a body grows back one link at a time.
        matter.cohesion[a] = Math.max(0, matter.cohesion[a] - BOND_COST); matter.cohesion[b] = Math.max(0, matter.cohesion[b] - BOND_COST);
        this.stats.reforms++;
      }
      for (let c = 0; c < state.cells; c++) {
        if (state.cellHolds[c] || !state.closed(c)) continue;
        const volume = state.measure(c);
        if (!(volume > UPRIGHT * state.cellRest0[c])) continue;
        state.cellHolds[c] = 1; state.cellRest[c] = state.cellVolume[c] = volume; this.cellTarget[c] = volume;
        state.dirty = true;
      }
    }
  }

  /** Whether every cell that link `l` bounds is the right way out where its elements are now. */
  private upright(l: number): boolean {
    const state = this.state, body = state.linkBody[l];
    for (let c = state.bodyCellStart[body], end = c + state.bodyCellCount[body]; c < end; c++) {
      for (let k = state.cellLinkStart[c], last = k + state.cellLinkCount[c]; k < last; k++) {
        if (state.cellLinks[k] === l && !(state.measure(c) > UPRIGHT * state.cellRest0[c])) return false;
      }
    }
    return true;
  }

  private book(): void {
    const started = this.profile ? performance.now() : 0;
    this.state.book();
    this.count();
    if (this.profile) this.bookTime += performance.now() - started;
  }

  private count(): void {
    const state = this.state, stats = this.stats;
    stats.bodies = state.bodies; stats.fragments = state.fragments; stats.intact = stats.broken = stats.lost = stats.faces = stats.cells = 0;
    for (let l = 0; l < state.links; l++) { if (state.linkState[l] === INTACT) stats.intact++; else if (state.linkState[l] === BROKEN) stats.broken++; else stats.lost++; }
    for (let f = 0; f < state.faces; f++) stats.faces += state.faceHolds[f];
    for (let c = 0; c < state.cells; c++) stats.cells += state.cellHolds[c];
  }
}
