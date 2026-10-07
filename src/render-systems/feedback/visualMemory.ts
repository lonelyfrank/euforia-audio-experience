import { unit } from '../../experience/types';
import type { WorldView } from '../../world/WorldView';

/*
 * Visual memory: what the picture keeps of what it has just shown. One law
 * per pixel and channel, the same in the shader (FeedbackPass) and here:
 *
 *   kept    = history × decay^(1 + 3 × irregularity × grain)         (what survives)
 *   memory' = min(max(fresh × imprint, kept + (1 + accumulate) × (1 − decay) × fresh), CEILING)
 *   shown   = max(fresh, memory')
 *
 * A trail, not a sum: a steady image settles at (1 + accumulate) × itself at
 * most, whatever the decay and the frame rate, so brightness cannot run away;
 * the ceiling bounds the rest. `accumulate` is the light gathered where
 * matter stays on its own trace. `decay` is exp(−dt / persistence): the
 * memory fades the same at any frame rate.
 */

/** Hard bound of the stored memory (linear light; the layer target is half float). */
export const MEMORY_CEILING = 4;

export interface VisualMemory {
  /** Time constant of the trail (s). */
  persistence: number;
  /** 0..1: how unevenly the memory fades and how much it is displaced (a broken, irregular memory). */
  irregularity: number;
  /** ≥ 1: how strongly a fresh image is written (a brief, strong afterimage of an admitted light event). */
  imprint: number;
  /** 0..1: extra light gathered where the image stays on its own trace. */
  accumulate: number;
}

export const createMemory = (): VisualMemory => ({ persistence: 0.3, irregularity: 0, imprint: 1, accumulate: 0 });

/** Longest and shortest trail (s): the memory always dissolves, also in silence. */
export const MAX_PERSISTENCE = 1.6;
const MIN_PERSISTENCE = 0.05;

/**
 * The memory the world asks for. `persistence` 0..1 is the Director's
 * (mood and experience); `light` 0..1 is a light event already admitted by
 * the FlashGuard. Coherence keeps the memory long and clean, turbulence
 * breaks it up, shimmer keeps it short and fine, an admitted impact leaves a
 * brief, strong afterimage. Nothing here depends on the frame rate.
 */
export function deriveMemory(out: VisualMemory, view: Readonly<WorldView>, persistence: number, light: number): VisualMemory {
  const coherence = unit(view.coherence), disorder = unit(view.disorder), shimmer = unit(view.shimmer), hit = unit(light);
  const base = 0.12 + 1.5 * coherence * (0.25 + 0.75 * unit(persistence));
  const tau = base * (1 - 0.55 * shimmer) * (1 - 0.5 * disorder) * (1 - 0.4 * hit);
  out.persistence = Number.isFinite(tau) ? Math.min(MAX_PERSISTENCE, Math.max(MIN_PERSISTENCE, tau)) : MIN_PERSISTENCE;
  out.irregularity = unit(disorder * (1 - 0.5 * coherence) * 1.4) || 0;
  out.imprint = 1 + 0.5 * hit || 1;
  out.accumulate = 0.6 * coherence * unit(view.excitation) || 0;
  return out;
}

/** Share of the memory that survives `dt` seconds. */
export function memoryDecay(persistence: number, dt: number): number {
  return dt > 0 ? Math.exp(-dt / Math.max(persistence, MIN_PERSISTENCE)) : 1;
}

/** The per-pixel law (see above). `grain` 0..1 is the pixel's share of the irregularity. */
export function remember(history: number, fresh: number, decay: number, memory: Readonly<VisualMemory>, grain = 0): number {
  const kept = history * decay ** (1 + memory.irregularity * grain * 3);
  return Math.min(Math.max(fresh * memory.imprint, kept + (1 + memory.accumulate) * (1 - decay) * fresh), MEMORY_CEILING);
}
