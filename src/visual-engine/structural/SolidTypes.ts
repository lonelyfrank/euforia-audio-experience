import { createTuning, type StructuralTuning } from './StructuralTypes';

/*
 * Solid dynamics: volumetric bodies of the structural engine.
 *
 * A solid is not an object that is drawn and animated. It is what a set of
 * links, faces and cells holds together between elements of the structural
 * system (the same elements as the free matter and the wires: same identity,
 * same integrator, same environment), for as long as they hold.
 *
 *   element   a vertex: an element of the StructuralState, nothing of its own
 *   link      what ties two elements: a geometric edge of the figure, or a brace
 *             (an internal link the simulation needs, never an edge of the figure)
 *   face      a triangle of the surface, held by its three links; the triangles of
 *             one geometric face share a group
 *   cell      a volume: a closed, outward-oriented set of triangles (a tetrahedron,
 *             or the whole shell of a body) with a rest volume
 *   body      the elements, links, faces and cells seeded together
 *   fragment  a connected component of a body once links have broken: the same
 *             elements, where they were, moving as they were
 *
 * Nothing here is created or removed to show a fracture: a link changes state,
 * and what it held (a face, a cell, a component) follows from that.
 */

export const SOLID_KINDS = ['tetrahedron', 'cube', 'icosahedron'] as const;
export type SolidKind = typeof SOLID_KINDS[number];

/** Kinds of link. They differ in their numbers and in whether the figure shows them, never in their law. */
export const EDGE = 0;
export const BRACE = 1;

/** What a link is now: holding; broken but remembered by its two ends (it may form again); or forgotten. */
export const LOST = 0;
export const INTACT = 1;
export const BROKEN = 2;

/**
 * What a connected component of a body is, by the highest structure it holds. Topological facts, not a judgement:
 * a group of polygons is not a solid, and a closed shell is one only once its volume has been verified.
 */
export const FORMS = ['free', 'chain', 'polygon', 'surface', 'shell', 'volume'] as const;
export type SolidForm = typeof FORMS[number];
export const FORM = Object.fromEntries(FORMS.map((form, i) => [form, i])) as { readonly [K in SolidForm]: number };

/**
 * Explicit budgets of the volumetric bodies of one structural system. Pools are allocated once at these sizes and
 * never grow: what does not fit is refused (and counted), never squeezed in. The elements come out of the system's
 * own capacity. Quality settings may change how a body is drawn; they never change these or the topology.
 */
export interface SolidBudget {
  /** Bodies seeded at once. */
  bodies: number;
  /** Links (edges and braces), intact or remembered. */
  links: number;
  /** Surface triangles. */
  faces: number;
  /** Volumetric cells. */
  cells: number;
  /** Solver iterations per fixed step: a constant, never raised to chase an error (1..8). */
  iterations: number;
  /** CPU time of the solid pass per frame above which the frame is counted as over budget (ms). Diagnostic only. */
  frameMs: number;
}

/** Four bodies of the largest kind (an icosahedron: 12 elements, 30 links, 20 triangles), or four cubes (5 cells each). */
export const DEFAULT_SOLID_BUDGET: Readonly<SolidBudget> = { bodies: 4, links: 128, faces: 96, cells: 24, iterations: 4, frameMs: 0.5 };
export const MAX_ITERATIONS = 8;
/** Vertices one cell may have (the shell of an icosahedron has twelve). */
export const MAX_CELL_VERTICES = 32;

/**
 * Development overrides of the solid material (the Solid Dynamics laboratory), all factors on the product's values.
 * Fracture strength, coherence, temperature, resonance and environment coupling are the structural tuning's own.
 * Never persisted.
 */
export interface SolidTuning {
  /** × the mass of a body's elements. */
  mass: number;
  /** × the stiffness of the links (1 / compliance). */
  stiffness: number;
  /** × their damping ratio. */
  damping: number;
  /** × the compliance of the cells: how readily a body gives up volume. */
  volumeCompliance: number;
}

export const createSolidTuning = (): SolidTuning => ({ mass: 1, stiffness: 1, damping: 1, volumeCompliance: 1 });

/** Bounds every override is held to, whatever a tool writes: outside them the step would stop being a simulation. */
export const SOLID_LIMITS: { readonly [K in keyof SolidTuning]: readonly [min: number, max: number] } = {
  mass: [0.25, 4], stiffness: [0.1, 4], damping: [0, 4], volumeCompliance: [0.05, 20],
};

export const within = (x: number, [min, max]: readonly [number, number]): number => (Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : 1);

/** What the Solid Dynamics laboratory can single out of a body. */
export const SOLID_VIEWS = ['vertices', 'edges', 'faces', 'wireframe', 'constraints', 'fragments', 'all'] as const;
export type SolidView = typeof SOLID_VIEWS[number];
/**
 * One-shot commands of the laboratory: the body whole again; only seeded (its matter apart, every link remembered,
 * none holding); a blow from outside; a torsion; a blow from inside strong enough to break it.
 */
export type SolidCommand = 'reset' | 'seed' | 'impulse' | 'twist' | 'fracture';

/**
 * Development switch (the Solid Dynamics laboratory): overrides of the structural tuning and of the solid material,
 * the view, the solid and one-shot commands. Read in development builds only and only while `active`; nothing in the
 * product sets it and nothing of it is persisted.
 */
export const solidLab: {
  active: boolean; tuning: StructuralTuning; material: SolidTuning; view: SolidView; kind: SolidKind; command: SolidCommand | null;
} = { active: false, tuning: createTuning(), material: createSolidTuning(), view: 'wireframe', kind: 'tetrahedron', command: null };

export const resetSolidLab = (): void => {
  Object.assign(solidLab, { active: false, tuning: createTuning(), material: createSolidTuning(), view: 'wireframe', kind: 'tetrahedron', command: null });
};
