import type { SpatialFields } from '../render-systems/fields/SpatialFields';
import type { GeometryState } from './geometry/GeometryState';
import type { Primitive, PrimitiveContext } from './Primitive';

/** One primitive system a world can show, and what it takes to be there. */
export interface PrimitiveSlot {
  id: string;
  create(context: PrimitiveContext): Primitive;
  /** The world's body: present whenever the world is, outside the structural budget. */
  base?: boolean;
  /**
   * Share of the structural budget it takes (default 1). The budget fills the
   * slots in the recipe's order, so the first ones appear with little
   * complexity and the last only when the picture can carry everything.
   */
  cost?: number;
  /** 0..1: how much the sound has for it to show (default 1). A continuous function of the geometry, never a branch. */
  affinity?(geometry: Readonly<GeometryState>): number;
  /** Seconds it takes to form and to dissolve (defaults 1.4 and 2.6): structures evolve, they do not switch. */
  attack?: number;
  release?: number;
}

/**
 * What a visual world is made of and what it can do: a configuration, not a
 * sequence. A recipe lists the primitive systems (in the order complexity
 * brings them in), how the world looks at them and what it remembers; when
 * each shows, how it moves and what it becomes is decided every frame by the
 * sound and the world, through the geometry and the fields they all share.
 */
export interface WorldRecipe {
  id: string;
  /** The same seed is the same world. */
  seed: number;
  /** Tilt of the world's axis away from the viewer (rad), and how the world is turned about that axis at rest (rad, default 0). */
  tilt: number;
  roll?: number;
  /** Visual memory (the feedback pass): full resolution, half, or none. */
  memory: 'full' | 'half' | 'off';
  slots: PrimitiveSlot[];
  /**
   * Which of the shared fields this world uses and with what scale: called
   * after the fields are derived, before anything reads them. Must not allocate.
   */
  tune?(fields: SpatialFields, geometry: Readonly<GeometryState>): void;
  /** 0..1: how much the visual memory's length follows the geometry's trail instead of the Director's persistence alone (default 0). */
  trail?: number;
  /** 0..1: how much the observer's depth follows the geometry's spatial depth instead of the Director's alone (default 0). */
  spatial?: number;
  /** Whether the observer moves the camera (default true): a world may keep a fixed view. */
  observer?: boolean;
  /**
   * Whether this world's matter answers the multiscale resonance by its own natural frequency (default false): the
   * world then keeps a ResonanceField of what is heard (`frame.resonance`) for its primitives to look up.
   */
  resonance?: boolean;
}

/** Default time constants of a structure's presence (s). */
export const FORM_TIME = 1.4;
export const DISSOLVE_TIME = 2.6;
