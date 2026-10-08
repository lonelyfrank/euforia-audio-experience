import { mesoAxis, microAxis, type ResonanceFrame } from '../../physics/MultiscaleResonance';

/*
 * How an element with a natural frequency answers the sound. The multiscale
 * resonance (physics/MultiscaleResonance.ts) is a state along one frequency
 * axis; an element is a resonator at f0 with a selectivity q, and takes of
 * that state what lies inside its own response curve:
 *
 *   response(u) = 1 / (1 + ((u − f0) / bandwidth(q))²)        a Lorentzian on the log-frequency axis
 *
 * A full oscillator per element would be the same physics at many times the
 * cost; this is the banded lookup instead. Once per frame the answers of all
 * (f0, q) are written into a small table, and elements read it by their
 * identity: two elements in the same place answer the same sound differently
 * because they are different matter. The table is laid out as an RGBA float
 * texture (rows = q, columns = f0), so a GPU population reads the same numbers.
 *
 *   r  signed displacement: the swing of the groups near f0 (elements of like pitch move in phase)
 *   g  amplitude of that swing, ≥ 0 (its excitation)
 *   b  micro excitation it takes: fine, high matter most
 *   a  unused
 */

export const FIELD_F0 = 64;
export const FIELD_Q = 4;
/** Bandwidth on the axis at q = 0 (answers about two octaves) and at q = 1 (about a third of one). */
const BROADEST = 0.22;
const NARROWEST = 0.035;
/** Width of the micro uptake on the axis. */
const MICRO_WIDTH = 0.18;
/** A tone at the element's own pitch drives a selective element to about its level; nothing answers beyond LIMIT. */
const GAIN = 1.5;
const LIMIT = 1.25;
/** Macro modes kept for what breathes with them. */
const MACRO_KEPT = 16;

export const bandwidthOf = (q: number): number => BROADEST * Math.pow(NARROWEST / BROADEST, q > 0 ? (q < 1 ? q : 1) : 0);
/** The response curve itself: how much an element at `f0` with selectivity `q` takes of what rings at `u`. */
export const responseAt = (u: number, f0: number, q: number): number => {
  const x = (u - f0) / bandwidthOf(q);
  return 1 / (1 + x * x);
};

const soft = (x: number): number => LIMIT * Math.tanh(x / LIMIT);

/** Result of `ResonanceField.at`: displacement, amplitude, micro. Reused. */
export const resonanceOut = new Float64Array(3);

export class ResonanceField {
  /** FIELD_Q rows × FIELD_F0 columns × RGBA. */
  readonly data = new Float32Array(FIELD_F0 * FIELD_Q * 4);
  /** The macro modes as last heard (signed). */
  readonly macro = new Float32Array(MACRO_KEPT);
  macros = 0;
  /** Whether anything rings at all: an empty field is skipped by its readers. */
  live = false;
  private weights = new Float32Array(0);
  private microWeights = new Float32Array(0);
  private meso = 0;
  private micro = 0;

  /** The table for what is heard now; without a frame (no synchronized clock) nothing rings. */
  update(frame: Readonly<ResonanceFrame> | undefined): void {
    if (!frame) { if (this.live) this.reset(); return; }
    if (frame.meso.length !== this.meso || frame.micro.length !== this.micro) this.build(frame.meso.length, frame.micro.length);
    const data = this.data, w = this.weights, mw = this.microWeights, K = this.meso, J = this.micro;
    let any = 0;
    for (let qi = 0; qi < FIELD_Q; qi++) {
      for (let fi = 0; fi < FIELD_F0; fi++) {
        const cell = qi * FIELD_F0 + fi, at = cell * K;
        let x = 0, level = 0;
        for (let k = 0; k < K; k++) { x += w[at + k] * frame.meso[k]; level += w[at + k] * frame.mesoLevel[k]; }
        let fine = 0;
        for (let j = 0; j < J; j++) fine += mw[fi * J + j] * frame.micro[j];
        data[cell * 4] = Number.isFinite(x) ? soft(x) : 0;
        data[cell * 4 + 1] = Number.isFinite(level) ? soft(level) : 0;
        data[cell * 4 + 2] = Number.isFinite(fine) ? Math.min(1, fine) : 0;
        any += data[cell * 4 + 1] + data[cell * 4 + 2];
      }
    }
    this.macros = Math.min(MACRO_KEPT, frame.macro.length);
    for (let m = 0; m < MACRO_KEPT; m++) this.macro[m] = m < this.macros && Number.isFinite(frame.macro[m]) ? frame.macro[m] : 0;
    this.live = any > 1e-4;
  }

  /** What an element of this identity takes right now, interpolated in the table. Writes `resonanceOut`. */
  at(f0: number, q: number): Float64Array {
    const out = resonanceOut;
    if (!this.live) { out[0] = out[1] = out[2] = 0; return out; }
    const fx = (f0 > 0 ? (f0 < 1 ? f0 : 1) : 0) * (FIELD_F0 - 1), qx = (q > 0 ? (q < 1 ? q : 1) : 0) * (FIELD_Q - 1);
    const f = Math.min(FIELD_F0 - 2, Math.floor(fx)), r = Math.min(FIELD_Q - 2, Math.floor(qx)), tf = fx - f, tq = qx - r;
    const a = (r * FIELD_F0 + f) * 4, b = a + 4, c = a + FIELD_F0 * 4, d = c + 4, data = this.data;
    for (let k = 0; k < 3; k++) {
      const low = data[a + k] + (data[b + k] - data[a + k]) * tf, high = data[c + k] + (data[d + k] - data[c + k]) * tf;
      out[k] = low + (high - low) * tq;
    }
    return out;
  }

  /** The macro mode an element of this seed breathes with (signed, bounded). */
  breath(seed: number): number {
    if (this.macros === 0) return 0;
    const value = this.macro[Math.min(this.macros - 1, Math.floor(seed * this.macros))];
    return value > 1.5 ? 1.5 : value < -1.5 ? -1.5 : value;
  }

  reset(): void {
    this.data.fill(0); this.macro.fill(0);
    this.live = false;
  }

  /** The response curves of every table cell for this many groups: computed once, when the resonator counts are known. */
  private build(meso: number, micro: number): void {
    this.meso = meso; this.micro = micro;
    this.weights = new Float32Array(FIELD_F0 * FIELD_Q * meso);
    this.microWeights = new Float32Array(FIELD_F0 * micro);
    for (let qi = 0; qi < FIELD_Q; qi++) {
      const q = qi / (FIELD_Q - 1);
      for (let fi = 0; fi < FIELD_F0; fi++) {
        const f0 = fi / (FIELD_F0 - 1), at = (qi * FIELD_F0 + fi) * meso;
        let sum = 0;
        for (let k = 0; k < meso; k++) sum += this.weights[at + k] = responseAt(mesoAxis(k, meso), f0, q);
        // A selective element takes a tone whole and little of what is spread; a broad one the reverse.
        const norm = GAIN / Math.pow(Math.max(sum, 1e-6), 0.75);
        for (let k = 0; k < meso; k++) this.weights[at + k] *= norm;
      }
    }
    let top = 0;
    for (let j = 0; j < micro; j++) { const x = (microAxis(j, micro) - 1) / MICRO_WIDTH; top += 1 / (1 + x * x); }
    for (let fi = 0; fi < FIELD_F0; fi++) {
      const f0 = fi / (FIELD_F0 - 1);
      for (let j = 0; j < micro; j++) { const x = (microAxis(j, micro) - f0) / MICRO_WIDTH; this.microWeights[fi * micro + j] = 1 / ((1 + x * x) * Math.max(top, 1e-6)); }
    }
  }
}
