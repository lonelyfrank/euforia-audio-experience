import { Rng, seedOf } from '../../show/rng';
import { NODES } from '../forms/HarmonicForm';

/** Elements per strand: neighbours along a strand are bonded (see the field law). */
export const STRAND = 8;

/** The particles as a grid of texels; a strand occupies STRAND consecutive texels of a row. */
export interface MatterLayout {
  width: number;
  height: number;
  count: number;
}

/** The grid closest to `target` particles whose rows hold whole strands. */
export function matterLayout(target: number): MatterLayout {
  const wanted = Math.max(STRAND, Number.isFinite(target) ? target : STRAND);
  const width = Math.max(STRAND, Math.round(Math.sqrt(wanted) / STRAND) * STRAND);
  const height = Math.max(1, Math.round(wanted / width));
  return { width, height, count: width * height };
}

/**
 * What each element is born with (it never changes): where it re-forms, which
 * part of the spectrum it leans to, and a phase. RGBA texel layouts:
 *   home  = direction × layer (xyz; layer 0..1 = depth in the body), band affinity 0 (low) … 1 (high)
 *   trait = phase 0..1, strand phase 0..1 (shared by a strand: it ages together), density rank 0..1, unused
 *   form  = what the strand does when the matter takes a form (shared by a strand; see forms/formLaw.ts):
 *           place along the signal's curve 0..1, partition key 0..1 (which form claims it first),
 *           three distinct harmonic nodes a + NODES·b + NODES²·c, voice (0 low, 1 high) + depth in the signal's history 0..1
 */
export interface MatterSeeds {
  layout: MatterLayout;
  home: Float32Array;
  trait: Float32Array;
  form: Float32Array;
}

/**
 * Deterministic: the same layout and seed give the same matter, bit for bit.
 * Band affinity is continuous and only loosely tied to depth, so no element
 * is "the bass" or "the highs": each answers every band, some more than others.
 */
export function seedMatter(layout: MatterLayout, seed: number): MatterSeeds {
  const rng = new Rng(seed);
  // The form seeds come from a stream of their own: what a strand does on a form never changes where the matter is born.
  const forms = new Rng(seedOf(seed, 0x666f726d));
  const home = new Float32Array(layout.count * 4);
  const trait = new Float32Array(layout.count * 4);
  const form = new Float32Array(layout.count * 4);
  for (let strand = 0; strand < layout.count / STRAND; strand++) {
    // A point uniformly on the sphere and a tangent to lay the strand along.
    const z = 2 * rng.next() - 1, angle = 2 * Math.PI * rng.next(), s = Math.sqrt(1 - z * z);
    const dx = s * Math.cos(angle), dy = s * Math.sin(angle), dz = z;
    const twist = 2 * Math.PI * rng.next();
    // Two unit vectors orthogonal to the direction.
    const ux = -Math.sin(angle), uy = Math.cos(angle), uz = 0;
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
    const tx = Math.cos(twist) * ux + Math.sin(twist) * vx, ty = Math.cos(twist) * uy + Math.sin(twist) * vy, tz = Math.cos(twist) * uz + Math.sin(twist) * vz;
    // More matter outside than inside, but the body is filled.
    const layer = 0.1 + 0.9 * rng.next() ** 0.6;
    const affinity = Math.min(1, Math.max(0, 0.75 * rng.next() + 0.25 * layer));
    const strandPhase = rng.next();
    const rank = rng.next();
    // Neighbours start about one bond length apart at the layer's loose radius.
    const step = 0.03 / (0.3 + 0.95 * layer);
    for (let m = 0; m < STRAND; m++) {
      const at = (strand * STRAND + m) * 4;
      const along = (m - (STRAND - 1) / 2) * step;
      const x = dx + tx * along, y = dy + ty * along, zz = dz + tz * along;
      const scale = Math.min(1, layer + (rng.next() - 0.5) * 0.01) / Math.hypot(x, y, zz);
      home[at] = x * scale; home[at + 1] = y * scale; home[at + 2] = zz * scale;
      home[at + 3] = Math.min(1, Math.max(0, affinity + (rng.next() - 0.5) * 0.08));
      trait[at] = rng.next(); trait[at + 1] = strandPhase; trait[at + 2] = rank;
    }
    // Low-leaning strands follow the low voice, the others the high one; the three nodes are distinct.
    const along = forms.next(), key = forms.next(), depth = Math.min(forms.next(), 0.999);
    const a = Math.floor(forms.next() * NODES), b = (a + 1 + Math.floor(forms.next() * (NODES - 1))) % NODES;
    let c = Math.floor(forms.next() * (NODES - 2));
    for (const taken of a < b ? [a, b] : [b, a]) if (c >= taken) c++;
    for (let m = 0; m < STRAND; m++) {
      const at = (strand * STRAND + m) * 4;
      form[at] = along; form[at + 1] = key; form[at + 2] = a + NODES * b + NODES * NODES * c; form[at + 3] = (affinity >= 0.5 ? 1 : 0) + depth;
    }
  }
  return { layout, home, trait, form };
}
