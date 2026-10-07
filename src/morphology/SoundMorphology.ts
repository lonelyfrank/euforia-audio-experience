import type { AnalysisFrame } from '../audio/features/decode';

/*
 * The instantaneous morphology of the sound: what kind of thing is being heard,
 * as continuous properties rather than a class. It names no instrument, genre
 * or waveform ("this is a saw"): it measures what makes such signals differ —
 * whether the sound repeats, how its partials are stacked, how much of it is
 * noise, how sharp, dense, sudden and steady it is. A sine, a sawtooth, a
 * chord, a snare and a noise wash land in different corners of this space, and
 * everything in between is a point in it.
 *
 * It measures nothing itself: every term is a measurement the Rust DSP already
 * exports (docs/acoustic-model.md), combined, weighted by presence and smoothed
 * on the audio clock. Advanced per analysis hop by the ExperienceEngine and
 * carried by its snapshots, so what a frame shows depends on the heard time
 * only. Deterministic and allocation-free.
 */
export interface SoundMorphology {
  /** One repeating cycle (a note, a held tone, a sawtooth) rather than several periods (a chord) or none. */
  periodicity: number;
  /** The sound is made of clear, steady partials, the more so the better they fit one harmonic series. */
  harmonicity: number;
  /** How much of the sound is noise: a flat spectrum whose phase cannot be predicted. */
  noisiness: number;
  /** Beating between close partials (sensory roughness). */
  roughness: number;
  /** Weight of the top of the spectrum (bright, cutting) against a dull, round sound. */
  sharpness: number;
  /** How many partials carry the sound beside its strongest one: a sine 0, a stacked spectrum 1. */
  richness: number;
  /** How much of the spectrum is occupied at once. */
  density: number;
  /** Sudden, short events against sustained sound. */
  transientness: number;
  /** How steady the spectrum is from one instant to the next (1 in silence: nothing changes). */
  stability: number;
  /** Width of the stereo image, as far as the stereo can be trusted. */
  spatialWidth: number;
  /** How far the reading can be used: the presence of sound above the learned floor. */
  confidence: number;
}

export const createMorphology = (): SoundMorphology => ({
  periodicity: 0, harmonicity: 0, noisiness: 0, roughness: 0, sharpness: 0, richness: 0, density: 0, transientness: 0,
  stability: 1, spatialWidth: 0, confidence: 0,
});

export const MORPHOLOGY_KEYS = Object.keys(createMorphology()) as (keyof SoundMorphology)[];

export function copyMorphology(to: SoundMorphology, from: Readonly<SoundMorphology>): void {
  for (const key of MORPHOLOGY_KEYS) to[key] = from[key];
}

/** Time constants (s): the character of a sound is read in about a tenth of a second and forgotten a little slower. */
const RISE = 0.08;
const FALL = 0.22;
/** A transient is seen at once and remembered for the length of a short hit. */
const TRANSIENT_FALL = 0.3;
const STABILITY_TAU = 0.35;

const unit = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);

/** Owns the smoothed morphology of one audio session. */
export class MorphologyEngine {
  readonly state = createMorphology();

  /** One analysis hop: `dt` seconds on the capture clock. */
  update(a: AnalysisFrame, dt: number): void {
    if (!(dt > 0)) return;
    const s = this.state;
    const presence = a.silent || a.presence < 0.06 ? 0 : unit(a.presence);
    // Partials beside the strongest: their levels already fade with noise and silence (Rust scales them by tonality).
    let others = 0, strongest = 0;
    for (let i = 0; i < a.partialLevel.length; i++) {
      const level = a.partialLevel[i];
      if (!(level > 0)) continue;
      others += level;
      if (level > strongest) strongest = level;
    }
    others -= strongest;
    // Steady partials keep their phase from one hop to the next; noise does not (its coherence sits near 0.5).
    const steady = unit((a.phaseCoherence - 0.5) * 2.5);
    const fit = unit(a.harmonicity);
    this.follow('periodicity', fit * steady, dt);
    this.follow('harmonicity', steady * (0.35 + 0.65 * fit) * presence, dt);
    // A flat spectrum alone is not noise (a kick leaves the mid band empty and flat): its phase must be unpredictable too.
    this.follow('noisiness', Math.sqrt(unit(a.flatness) * unit(2 * a.phaseDeviation)) * presence, dt);
    this.follow('roughness', unit(a.roughness), dt);
    this.follow('sharpness', unit(a.sharpness * 2.2) * presence, dt);
    this.follow('richness', unit(others / 2.2) * steady, dt);
    let occupied = 0;
    for (let b = 0; b < a.bandLevel.length; b++) occupied += a.bandLevel[b];
    this.follow('density', unit(0.6 * a.entropy + 0.4 * occupied / a.bandLevel.length) * presence, dt);
    // A hit is a rise in several bands within one hop (noise only flickers): taken at once and let go slowly,
    // so its trace outlives it; a busy rhythm keeps a floor between its hits.
    let rise = 0;
    for (let b = 0; b < a.bandTransient.length; b++) rise += a.bandTransient[b];
    const hit = Math.max(unit((rise - 0.5) / 1.5), 0.5 * unit(a.onsetDensity / 8)) * presence;
    s.transientness = hit > s.transientness ? hit : hit + (s.transientness - hit) * Math.exp(-dt / TRANSIENT_FALL);
    // Frame-to-frame change of the complex spectrum; silence is perfectly steady.
    const change = unit(1.6 * a.complexChange + 0.8 * a.phaseDeviation) * presence;
    s.stability += (1 - change - s.stability) * (1 - Math.exp(-dt / STABILITY_TAU));
    this.follow('spatialWidth', unit(a.width * a.stereoConfidence), dt);
    this.follow('confidence', presence * unit(a.timbreConfidence), dt);
  }

  reset(): void {
    Object.assign(this.state, createMorphology());
  }

  private follow(key: Exclude<keyof SoundMorphology, 'transientness' | 'stability'>, target: number, dt: number): void {
    const s = this.state;
    const value = Number.isFinite(target) ? target : 0;
    s[key] += (value - s[key]) * (1 - Math.exp(-dt / (value > s[key] ? RISE : FALL)));
  }
}
