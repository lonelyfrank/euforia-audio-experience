/*
 * Musical knowledge: what is true of music before any track is heard. Two levels, kept apart.
 *
 * Universal competence — pulse, metre, periodicity, repetition, contrast, tension, resolution — holds for any music and
 * works with no style at all. It is a set of priors: phrase lengths are more often 8 bars than 32, groupings more often
 * 4 than 7, a slow tempo is sometimes a fast one felt in half. Priors, never rules: evidence outweighs them within a few
 * phrases.
 *
 * Stylistic competence is a handful of profiles, each a different set of the same priors (how long phrases tend to be,
 * how long a loop may repeat before something changes, whether a build is expected to resolve on a phrase boundary).
 * There is no genre classifier: the evidence (tempo, percussive share, attack density, low end, regularity) weighs the
 * profiles by how much the music resembles each, the generic profile always keeps a share, and the priors in force are
 * the weighted mix. A regular four-on-the-floor alone resembles several profiles at once and decides none.
 */
import { STYLES, type Style } from './types';

/** Phrase lengths considered (bars). */
export const PHRASES = [4, 8, 16, 32] as const;
/** Groupings of beats the DSP can publish (its own hypotheses, native/analysis/src/meter.rs). */
export const METERS = [3, 4, 5, 7] as const;
/** How much music groups beats each way before anything is heard: a tie-breaker, never a default bar. */
export const METER_PRIOR = [0.15, 0.7, 0.05, 0.05] as const;

export interface StyleProfile {
  /** Tempo the profile lives at: centre (BPM) and width (octaves) of a log-normal. */
  tempo: readonly [number, number];
  /** Prior over the phrase lengths of PHRASES. */
  phrase: readonly [number, number, number, number];
  /** Percussive share, attacks per second, low-end activity: centre and width of a soft resemblance. */
  percussive: readonly [number, number];
  density: readonly [number, number];
  low: readonly [number, number];
  /** How regular its pulse is expected to be (0..1). */
  regularity: number;
  /** 0..1: how strongly rising tension is expected to resolve into a release on a phrase boundary. */
  buildResolves: number;
  /** Bars a pattern may repeat before a change is expected. */
  repetition: number;
  /** 0..1: prior that the pulse felt is half the tracked one (drum and bass at 174 felt at 87). */
  halfTime: number;
}

/** The universal priors: what holds with no style at all. */
export const UNIVERSAL: StyleProfile = {
  tempo: [120, 1], phrase: [0.3, 0.4, 0.2, 0.1], percussive: [0.3, 0.3], density: [3, 3], low: [0.5, 0.5],
  regularity: 0.5, buildResolves: 0.5, repetition: 8, halfTime: 0.1,
};

/** Initial profiles. Numbers are priors to be revised on a corpus, not facts about the genres. */
export const PROFILES: Readonly<Record<Style, StyleProfile>> = {
  generic: UNIVERSAL,
  techno: { tempo: [130, 0.25], phrase: [0.15, 0.35, 0.35, 0.15], percussive: [0.45, 0.2], density: [5, 2.5], low: [0.85, 0.25], regularity: 0.95, buildResolves: 0.6, repetition: 32, halfTime: 0.05 },
  house: { tempo: [124, 0.15], phrase: [0.15, 0.4, 0.35, 0.1], percussive: [0.4, 0.2], density: [4.5, 2.5], low: [0.8, 0.25], regularity: 0.9, buildResolves: 0.65, repetition: 16, halfTime: 0.05 },
  trance: { tempo: [138, 0.15], phrase: [0.1, 0.35, 0.4, 0.15], percussive: [0.35, 0.2], density: [5, 3], low: [0.75, 0.3], regularity: 0.9, buildResolves: 0.85, repetition: 16, halfTime: 0.05 },
  hardstyle: { tempo: [150, 0.12], phrase: [0.1, 0.35, 0.4, 0.15], percussive: [0.5, 0.2], density: [5, 3], low: [0.9, 0.2], regularity: 0.9, buildResolves: 0.9, repetition: 16, halfTime: 0.1 },
  drumAndBass: { tempo: [174, 0.1], phrase: [0.1, 0.35, 0.4, 0.15], percussive: [0.5, 0.2], density: [7, 3], low: [0.8, 0.3], regularity: 0.85, buildResolves: 0.8, repetition: 16, halfTime: 0.45 },
  rock: { tempo: [120, 0.4], phrase: [0.35, 0.45, 0.15, 0.05], percussive: [0.35, 0.25], density: [4, 3], low: [0.6, 0.35], regularity: 0.7, buildResolves: 0.35, repetition: 8, halfTime: 0.15 },
  ambient: { tempo: [90, 1.2], phrase: [0.3, 0.35, 0.2, 0.15], percussive: [0.05, 0.15], density: [0.5, 1], low: [0.3, 0.4], regularity: 0.1, buildResolves: 0.2, repetition: 8, halfTime: 0.1 },
};

/** The generic profile never falls under this share: a profile may lean the priors, never take them over. */
export const GENERIC_FLOOR = 0.35;
/** Resemblance is followed over this long (s): style is a property of minutes, not of a bar. */
const STYLE_TAU = 20;
/** Temperature of the resemblance (1 = raw likelihoods; higher = flatter). */
const TEMPERATURE = 2;

const gauss = (x: number, centre: number, width: number): number => Math.exp(-0.5 * ((x - centre) / width) ** 2);
/** Log-normal tempo resemblance; a tempo at half or twice the centre also resembles it a little (octave errors). */
export function tempoResemblance(bpm: number, [centre, octaves]: readonly [number, number]): number {
  if (!(bpm > 0)) return 1;
  const at = (b: number) => Math.exp(-0.5 * (Math.log2(b / centre) / octaves) ** 2);
  return Math.max(at(bpm), 0.3 * at(bpm * 2), 0.3 * at(bpm / 2));
}
/** The universal tempo prior (log-normal at 120 BPM over an octave): how plausible a tempo is before any style. */
export const tempoPrior = (bpm: number): number => tempoResemblance(bpm, UNIVERSAL.tempo);

/** What the style evidence is made of, read from measures the DSP already exports. */
export interface StyleEvidence {
  bpm: number;
  /** 0..1 grid confidence. */
  regularity: number;
  percussive: number;
  density: number;
  low: number;
}

/**
 * Weighs the profiles by resemblance, followed over minutes. `priors` is the mix of their priors in force. With no
 * evidence (no sound, no pulse) the weights drift back to the generic profile at the same pace.
 */
export class StyleBlend {
  readonly weights = new Float32Array(STYLES.length);
  /** Effective priors (the weighted mix of the profiles), rewritten on each update. */
  readonly priors: { phrase: Float32Array; buildResolves: number; repetition: number; halfTime: number } = {
    phrase: new Float32Array(PHRASES.length), buildResolves: UNIVERSAL.buildResolves, repetition: UNIVERSAL.repetition, halfTime: UNIVERSAL.halfTime,
  };
  private readonly likelihood = new Float32Array(STYLES.length);
  leading: Style = 'generic';
  confidence = 0;

  constructor() { this.reset(); }

  reset(): void {
    this.weights.fill(0); this.weights[0] = 1; this.leading = 'generic'; this.confidence = 0;
    this.mix();
  }

  /** `evidence` null: nothing to resemble (silence, no pulse): the weights relax towards the generic profile. */
  update(evidence: Readonly<StyleEvidence> | null, dt: number): void {
    const l = this.likelihood;
    if (evidence) {
      let sum = 0;
      for (let i = 0; i < STYLES.length; i++) {
        const p = PROFILES[STYLES[i]];
        const raw = tempoResemblance(evidence.bpm, p.tempo) * gauss(evidence.percussive, p.percussive[0], p.percussive[1]) *
          gauss(evidence.density, p.density[0], p.density[1]) * gauss(evidence.low, p.low[0], p.low[1]) *
          gauss(evidence.regularity, p.regularity, 0.35);
        l[i] = raw ** (1 / TEMPERATURE); sum += l[i];
      }
      for (let i = 0; i < STYLES.length; i++) l[i] = sum > 0 ? l[i] / sum : i === 0 ? 1 : 0;
      // Generic resembles everything a little: below its floor, the other profiles share what is left above it.
      if (l[0] < GENERIC_FLOOR) {
        const scale = (1 - GENERIC_FLOOR) / Math.max(1e-9, 1 - l[0]);
        for (let i = 1; i < STYLES.length; i++) l[i] *= scale;
        l[0] = GENERIC_FLOOR;
      }
    } else { l.fill(0); l[0] = 1; }
    const k = 1 - Math.exp(-dt / STYLE_TAU);
    for (let i = 0; i < STYLES.length; i++) this.weights[i] += (l[i] - this.weights[i]) * k;
    this.mix();
  }

  private mix(): void {
    const w = this.weights, p = this.priors;
    let sum = 0, best = 1;
    for (let i = 0; i < STYLES.length; i++) { sum += w[i]; if (i > 1 && w[i] > w[best]) best = i; }
    p.phrase.fill(0); p.buildResolves = p.repetition = p.halfTime = 0;
    for (let i = 0; i < STYLES.length; i++) {
      const s = PROFILES[STYLES[i]], share = sum > 0 ? w[i] / sum : i === 0 ? 1 : 0;
      for (let k = 0; k < PHRASES.length; k++) p.phrase[k] += share * s.phrase[k];
      p.buildResolves += share * s.buildResolves; p.repetition += share * s.repetition; p.halfTime += share * s.halfTime;
    }
    // The leading profile and how much it leads: its share among the profiles, times how far the evidence has moved
    // the weights away from the generic one (all of it once generic is at its floor).
    const others = Math.max(1e-9, sum - w[0]);
    const lead = (w[best] / others) * Math.min(1, (1 - w[0]) / (1 - GENERIC_FLOOR));
    this.leading = lead > 0.3 ? STYLES[best] : 'generic';
    this.confidence = this.leading === 'generic' ? Math.min(1, w[0]) : Math.min(1, lead);
  }
}
