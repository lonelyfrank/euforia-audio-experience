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
 * The material of the bodies of one system: factors on the product's values, and what makes a body hold its shape.
 * Fracture strength, coherence, temperature, resonance and environment coupling are the structural tuning's own.
 * As created it is the material the bodies have always had (`legacy`): no shape retention, no pulse. The other
 * profiles are set by the Solid Dynamics laboratory only. Never persisted.
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
  /**
   * Perceptual rigidity of a body's shape, 0 … 0.98: the share of the deformation a blow leaves in a body held by
   * its links alone that this one does not show (SolidDynamics.shapeRate turns it into a stiffness). 0: no shape is
   * held beyond what links, hinges and cells hold, and the sound drives each link by itself as it always did.
   */
  shapeRetention: number;
  /** The largest uniform change of size the sound gives a body, as a share of its reference scale (linear, 0 … PULSE_LIMIT). */
  maxPulse: number;
  /** × how much fatigue a link takes before it has tired: damage builds 1 / toughness as fast. */
  toughness: number;
  /** × how fast a body comes back: a link or a cell that holds again, a piece that has just joined another. */
  recovery: number;
  /** How far a piece of a broken body keeps the shape retention of the whole: 0 (its links alone) … 1. */
  fragmentIntegrity: number;
}

/** No sound moves the reference scale of a body further than this, whatever a tool writes (linear: ±6%). */
export const PULSE_LIMIT = 0.06;

export const createSolidTuning = (): SolidTuning => ({
  mass: 1, stiffness: 1, damping: 1, volumeCompliance: 1, shapeRetention: 0, maxPulse: 0, toughness: 1, recovery: 1, fragmentIntegrity: 1,
});

/** Bounds every override is held to, whatever a tool writes: outside them the step would stop being a simulation. */
export const SOLID_LIMITS: { readonly [K in keyof SolidTuning]: readonly [min: number, max: number] } = {
  mass: [0.25, 4], stiffness: [0.1, 4], damping: [0, 4], volumeCompliance: [0.05, 20],
  shapeRetention: [0, 0.98], maxPulse: [0, PULSE_LIMIT], toughness: [0.25, 8], recovery: [0.25, 4], fragmentIntegrity: [0, 1],
};

/** `x` within its bounds; what is not a number is the value the product has (`fallback`), never a bound. */
export const within = (x: number, [min, max]: readonly [number, number], fallback = 1): number => Math.min(max, Math.max(min, Number.isFinite(x) ? x : fallback));

/**
 * The materials a body can be given in the laboratory. `rigid`: the body keeps its shape and answers the sound as one
 * thing (a uniform pulse, a little vibration); `elastic`: it visibly deforms and comes back; `legacy`: the links alone.
 */
export const SOLID_PROFILES = ['rigid', 'elastic', 'legacy'] as const;
export type SolidProfile = typeof SOLID_PROFILES[number];

export const solidProfile = (profile: SolidProfile): SolidTuning => ({
  ...createSolidTuning(),
  ...(profile === 'rigid' ? { shapeRetention: 0.9, maxPulse: PULSE_LIMIT, toughness: 2 }
    : profile === 'elastic' ? { shapeRetention: 0.5, maxPulse: PULSE_LIMIT, toughness: 1.5, recovery: 1.5 } : {}),
});

/**
 * How a body may break by itself. `load`: whenever a link bears more than it can (the law it always had). `events`:
 * only when a musical event significant enough passes the fracture gate (FractureGate); the load on every link is
 * still measured, and it decides which links give way, but it breaks nothing between events.
 */
export const FRACTURE_MODES = ['load', 'events'] as const;
export type FractureMode = typeof FRACTURE_MODES[number];

export interface FractureTuning {
  mode: FractureMode;
  /** The least confidence an event needs (0..1). */
  confidence: number;
  /** How far an event has to stand out of the track's recent ones (0..1: its significance). */
  threshold: number;
  /** The least time between two fractures by events (s, on the simulation's clock). */
  cooldown: number;
}

export const createFractureTuning = (): FractureTuning => ({ mode: 'load', confidence: 0.5, threshold: 0.7, cooldown: 4 });
export const FRACTURE_LIMITS = { confidence: [0, 1], threshold: [0.2, 1], cooldown: [0.5, 30] } as const;

/** What the Solid Dynamics laboratory can single out of a body. */
export const SOLID_VIEWS = ['vertices', 'edges', 'faces', 'wireframe', 'constraints', 'fragments', 'all'] as const;
export type SolidView = typeof SOLID_VIEWS[number];
/**
 * One-shot commands of the laboratory: the body whole again; only seeded (its matter apart, every link remembered,
 * none holding); a blow from outside; a torsion; a blow from inside strong enough to break it; a musical event that
 * stands out, offered to the fracture gate as the session's own would be (it passes or not as any other).
 */
export type SolidCommand = 'reset' | 'seed' | 'impulse' | 'twist' | 'fracture' | 'event';

/**
 * Development switch (the Solid Dynamics laboratory): overrides of the structural tuning, the material of the body
 * and how it may break, the view, the solid and one-shot commands. Read in development builds only and only while
 * `active`; nothing in the product sets it and nothing of it is persisted. The laboratory opens on the rigid body
 * that breaks on musical events; `legacy` is the body as it was, for comparison.
 */
export interface SolidLab {
  active: boolean;
  tuning: StructuralTuning;
  profile: SolidProfile;
  material: SolidTuning;
  fracture: FractureTuning;
  view: SolidView;
  kind: SolidKind;
  command: SolidCommand | null;
}

const createLab = (): SolidLab => ({
  active: false, tuning: createTuning(), profile: 'rigid', material: solidProfile('rigid'), fracture: { ...createFractureTuning(), mode: 'events' },
  view: 'wireframe', kind: 'tetrahedron', command: null,
});

export const solidLab: SolidLab = createLab();

export const resetSolidLab = (): void => {
  Object.assign(solidLab, createLab());
};

/** Gives the laboratory's body another material: its profile's values, and the way of breaking that goes with it. */
export const setSolidProfile = (profile: SolidProfile): void => {
  solidLab.profile = profile; solidLab.material = solidProfile(profile);
  solidLab.fracture = { ...createFractureTuning(), mode: profile === 'legacy' ? 'load' : 'events' };
};
