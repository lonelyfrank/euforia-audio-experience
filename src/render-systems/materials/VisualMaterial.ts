import { unit, type ExperienceSnapshot } from '../../experience/types';
import type { WorldView } from '../../world/WorldView';

/**
 * What kind of matter could stand for what is being heard: the step between
 * the sound (SoundMorphology: which properties does it have?) and the world
 * (WorldState: what is happening to the matter?). Continuous properties, never
 * a table from sounds to shapes: a clear repeating tone makes continuous
 * matter, stacked partials connect it, sharp rich spectra give it edges, noise
 * grinds it into grains. They belong to the render layer: none of them is a
 * field of the WorldState (see docs/matter-engine.md). All 0..1.
 */
export interface VisualMaterial {
  /** Disorder that is not held together: turbulence × (1 − coherence) × complexity. */
  fragmentation: number;
  /** Ordered, repeating structure: coherence × harmonicity. */
  symmetry: number;
  /** Fineness of the grain: complexity, shimmer, spectral entropy and noise. */
  granularity: number;
  /** How freely the matter flows: harmonic flow and resonance, less what fragments it. */
  fluidity: number;
  /** How firmly the structure holds its shape: coherence and stored potential. */
  rigidity: number;
  /** The matter can hold an unbroken line or surface: one steady repeating cycle. Its share that takes the signal's own form. */
  continuity: number;
  /** Edges and facets: a bright spectrum stacked with partials (the corners of a sawtooth or a square), sharp attacks. */
  angularity: number;
  /** The matter links into a network: several clear partials that belong together. Its share that takes the harmonic form. */
  connectivity: number;
}

export const createMaterial = (): VisualMaterial => ({
  fragmentation: 0, symmetry: 0, granularity: 0, fluidity: 0, rigidity: 0, continuity: 0, angularity: 0, connectivity: 0,
});

export const MATERIAL_KEYS = Object.keys(createMaterial()) as (keyof VisualMaterial)[];

/** Without an experience snapshot (hosts without the rig) the musical terms are neutral: loose, formless matter. */
export function deriveMaterial(out: VisualMaterial, view: Readonly<WorldView>, snapshot?: ExperienceSnapshot): VisualMaterial {
  const s = snapshot?.state, a = snapshot?.acoustic, m = snapshot?.morphology;
  const presence = a ? (a.silent ? 0 : a.presence) : 0;
  const complexity = s ? s.complexity : 0;
  // Complexity scales the break-up but a turbulent, incoherent world fragments even when the mix is simple.
  out.fragmentation = unit(2.5 * view.disorder * (1 - view.coherence) * (0.3 + 0.7 * complexity));
  out.symmetry = unit(view.coherence * (a ? a.harmonicity : 0) * presence);
  out.granularity = unit(0.4 * complexity + 0.35 * view.shimmer + 0.25 * (a ? a.entropy * presence : 0) + (m ? 0.3 * m.noisiness : 0));
  out.fluidity = unit((s ? s.flow + s.resonance : 0) - out.fragmentation);
  out.rigidity = unit(0.55 * view.coherence + 0.6 * view.tension);
  // Sound → matter. What fragments the world also breaks the forms the sound would give it.
  const whole = 1 - out.fragmentation;
  out.continuity = m ? unit(m.periodicity * (0.4 + 0.6 * m.stability) * whole) : 0;
  out.angularity = m ? unit(1.2 * Math.sqrt(unit(m.sharpness) * unit(m.richness)) + 0.4 * m.transientness * m.sharpness) : 0;
  out.connectivity = m ? unit(1.4 * m.harmonicity * m.richness * whole) : 0;
  for (const key of MATERIAL_KEYS) if (!Number.isFinite(out[key])) out[key] = 0;
  return out;
}
