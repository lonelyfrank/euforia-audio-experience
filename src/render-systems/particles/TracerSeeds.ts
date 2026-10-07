import { Rng, seedOf } from '../../show/rng';
import type { MatterLayout } from './MatterSeeds';

/**
 * What each tracer is born with (it never changes). RGBA texel layouts, as
 * for the matter:
 *   home  = where it re-forms, as a point of the unit ball (xyz; × the field's span and the matter's radius),
 *           band affinity 0 (low) … 1 (high)
 *   trait = phase 0..1, ageing phase 0..1, density rank 0..1, unused
 */
export interface TracerSeeds {
  layout: MatterLayout;
  home: Float32Array;
  trait: Float32Array;
}

/** Deterministic: the same layout and seed give the same tracers. More of them near the centre, where the field has its structure. */
export function seedTracers(layout: MatterLayout, seed: number): TracerSeeds {
  const rng = new Rng(seedOf(seed, 0x74726163));
  const home = new Float32Array(layout.count * 4), trait = new Float32Array(layout.count * 4);
  for (let i = 0; i < layout.count; i++) {
    const at = i * 4;
    const z = 2 * rng.next() - 1, angle = 2 * Math.PI * rng.next(), s = Math.sqrt(1 - z * z);
    // Radius ∝ u^0.45: a little denser inside than a uniform ball (1/3).
    const layer = 0.04 + 0.96 * rng.next() ** 0.45;
    home[at] = s * Math.cos(angle) * layer; home[at + 1] = s * Math.sin(angle) * layer; home[at + 2] = z * layer;
    home[at + 3] = Math.min(1, Math.max(0, 0.8 * rng.next() + 0.2 * (1 - layer)));
    trait[at] = rng.next(); trait[at + 1] = rng.next(); trait[at + 2] = rng.next();
  }
  return { layout, home, trait };
}
