/*
 * The contract of Euforia Musical Cognition (docs/musical-cognition.md): what the engine understands of the music it
 * is hearing, kept apart from what it measured (the DSP's AnalysisFrame and events) and from what it does about it (the
 * director). Three kinds of statement, never mixed:
 *
 *   observations    what the DSP measured and the clock confirmed (a beat an onset landed on, a release heard)
 *   interpretations what that is likely to mean now (a stable groove, rising tension), each with a confidence and a reason
 *   predictions     what may happen next, in a window, with a confidence, the evidence behind it and what became of it
 *
 * Conventions of the project: times are capture-clock seconds and 0 means "none"; tempo 0 and meter 0 are unknown;
 * positions are −1 when unknown; confidences are 0..1 evidence weights, not calibrated probabilities (their calibration
 * is measured: `CognitionStats.brier`). Every object here has a fixed shape and is copied, never replaced, so a snapshot
 * costs no allocation.
 */

export const CLOCK_STATES = ['none', 'acquiring', 'locked', 'coasting', 'lost'] as const;
/**
 * none: never had a pulse this session · acquiring: a grid is forming · locked: the grid is confirmed by the onsets ·
 * coasting: the grid is carried through a short gap without support, its confidence falling · lost: the gap outlasted it.
 */
export type ClockState = typeof CLOCK_STATES[number];

export const MUSICAL_STATES = ['unknown', 'establishingPulse', 'stableGroove', 'developing', 'risingTension', 'breakdown', 'transition', 'release'] as const;
/** The dominant reading; the dimensions behind it are reported too, since a section may be a groove and rising at once. */
export type MusicalState = typeof MUSICAL_STATES[number];

export const PREDICTION_KINDS = ['beat', 'downbeat', 'phrase', 'transition', 'release'] as const;
export type PredictionKind = typeof PREDICTION_KINDS[number];
export const PREDICTION_STATUS = ['proposed', 'updated', 'confirmed', 'expired', 'refuted'] as const;
export type PredictionStatus = typeof PREDICTION_STATUS[number];

export const SILENCE_KINDS = ['none', 'pause', 'silence', 'noSignal', 'sourceLost'] as const;
/**
 * pause: a musical rest (sound stopped, the source still delivers, under 2 s) · silence: it lasts · noSignal: nothing
 * for long, or nothing since the session began · sourceLost: the analysis stopped arriving (capture interrupted).
 */
export type SilenceKind = typeof SILENCE_KINDS[number];

export const SURPRISE_KINDS = ['none', 'missedBeat', 'earlyAccent', 'lateAccent', 'pause', 'patternBreak', 'offPhraseChange', 'phraseProlonged',
  'unannouncedRelease', 'meterChange', 'tempoChange'] as const;
export type SurpriseKind = typeof SURPRISE_KINDS[number];

export const STYLES = ['generic', 'techno', 'house', 'trance', 'hardstyle', 'drumAndBass', 'rock', 'ambient'] as const;
export type Style = typeof STYLES[number];

/** The musical clock: tempo, phase, bar and phrase, each with the confidence that allows it to be shown at all. */
export interface ClockFrame {
  state: ClockState;
  /** Tracked tempo (BPM; 0 unknown) and its period (s; 0 unknown). */
  bpm: number;
  period: number;
  /** 0..1: the grid's confidence; while coasting it falls with the time since the last supported beat. */
  confidence: number;
  /** Position in the beat (0 on the beat … 1), meaningful while confidence > 0. */
  beatPhase: number;
  /** Capture time of the next beat (0: none). */
  nextBeat: number;
  /** Musical time: beats since the grid was anchored, plus the phase (−1: no grid). Kept across a pause the grid survives. */
  beat: number;
  /** Beats per bar (0: unknown) and the confidence in that grouping; the downbeat's own confidence apart. */
  meter: number;
  meterConfidence: number;
  downbeatConfidence: number;
  /** Beat within the bar (0 = downbeat; −1 unknown: never invented without downbeat evidence), bar phase 0..1 (−1). */
  barPosition: number;
  barPhase: number;
  /** Bars since the grid was anchored (−1 unknown), and the capture time of the next downbeat (0: none). */
  bar: number;
  nextDownbeat: number;
  /** Inferred phrase length (bars; 0 unknown), bar within it (−1 unknown), its confidence, the next boundary (0: none). */
  phraseBars: number;
  phraseBar: number;
  phraseConfidence: number;
  nextPhrase: number;
  /** 0..1: how steady the tempo has been (1 = no drift). */
  stability: number;
  /** Median-like distance of the onsets that confirm beats from the beats (ms), and its spread. */
  syncErrorMs: number;
  jitterMs: number;
  /** 0..1: share of recent predicted beats an onset confirmed. */
  support: number;
  /** 0..1 plausibility that the felt pulse is half / twice the tracked one, and the larger of the two. */
  halfTime: number;
  doubleTime: number;
  ambiguity: number;
  /** Seconds since the last supported beat while coasting (0 otherwise). */
  coastAge: number;
  /** Per session: grids lost, regained, regained in phase with the coasted grid (bar kept), seconds the last regain took. */
  losses: number;
  relocks: number;
  continuations: number;
  relockSeconds: number;
}

/** What the music is doing, as dimensions (0..1) with the dominant reading, its reason and its age. */
export interface UnderstandingFrame {
  state: MusicalState;
  previous: MusicalState;
  confidence: number;
  /** Capture time the state began. */
  since: number;
  /** Why, in a few words (a constant of the interpreter: no string is built per hop). */
  reason: string;
  pulse: number;
  groove: number;
  tension: number;
  tensionConfidence: number;
  breakdown: number;
  transition: number;
  release: number;
  development: number;
  /** How much the last bars repeat the bars one pattern back, and that pattern's length in bars (0 unknown). */
  repetition: number;
  pattern: number;
  /** How far the last bar stands from the bars before it (0..1), and the boundary strength of the last downbeat. */
  novelty: number;
  boundary: number;
  /** 0..1: how strongly something is expected within the horizon (confidence × proximity of the open predictions). */
  expectation: number;
  /** 0..1: how far what happened departs from what was expected, decaying; the confidence of that expectation; what it was. */
  surprise: number;
  surpriseConfidence: number;
  surpriseKind: SurpriseKind;
  surpriseAt: number;
  silence: SilenceKind;
  silenceSeconds: number;
  /** The stylistic profile the evidence resembles most (never a classification), its share, and every share. */
  style: Style;
  styleConfidence: number;
  styles: Float32Array;
}

export interface Prediction {
  /** 0: an empty slot. Ids grow through the session. */
  id: number;
  kind: PredictionKind;
  status: PredictionStatus;
  /** Expected capture time, and the window an observation must fall in to confirm it. */
  time: number;
  early: number;
  late: number;
  confidence: number;
  /** What it rests on (a constant). */
  evidence: string;
  /** When it was proposed, until when it holds, when it was resolved (0: open). */
  created: number;
  validUntil: number;
  resolved: number;
  /** The observation that resolved it (0: none) and its distance from the expected time (s). */
  observed: number;
  error: number;
  updates: number;
}

/** Outcomes per session, per kind; and how the confidences fared (Brier score: 0 perfect, 0.25 a coin). */
export interface CognitionStats {
  proposed: Uint32Array;
  confirmed: Uint32Array;
  refuted: Uint32Array;
  expired: Uint32Array;
  brier: Float32Array;
  /** Mean |error| (s) of the confirmed ones, and the mean lead (s) from proposal to confirmation. */
  error: Float32Array;
  lead: Float32Array;
  missedBeats: number;
  surprises: number;
  stateChanges: number;
  /** Releases heard (audio evidence), and those no prediction announced. */
  releases: number;
  releasesUnannounced: number;
  /** The experience's own `drop` events, compared with the releases heard: how many, how many fell ±0.5 s off one, and the last offset (s; − = early). */
  experienceDrops: number;
  experienceDropsOff: number;
  experienceDropsUnheard: number;
  dropOffset: number;
}

export interface CognitionDiagnostics {
  /** Hops processed this session; µs per hop (only measured when profiling); typed memory held (bytes). */
  hops: number;
  updateMicros: number;
  memoryBytes: number;
  /** Bars and beats in the structural memory. */
  bars: number;
  beats: number;
  /** Why the director is not following the cognition right now ('' when it is). */
  fallback: string;
}

export interface CognitionFrame {
  time: number;
  enabled: boolean;
  /** The director follows the cognition's phrase grid now (else it keeps the reactive path: `diagnostics.fallback` says why). */
  leads: boolean;
  clock: ClockFrame;
  understanding: UnderstandingFrame;
  /** Open predictions (fixed slots; id 0 = empty). */
  predictions: Prediction[];
  /** The last resolved predictions, newest first (beats are only counted). */
  recent: Prediction[];
  stats: CognitionStats;
  diagnostics: CognitionDiagnostics;
}

export const PREDICTION_SLOTS = 8;
export const RECENT = 8;
export const KIND = Object.fromEntries(PREDICTION_KINDS.map((k, i) => [k, i])) as { readonly [K in PredictionKind]: number };

export const createClock = (): ClockFrame => ({
  state: 'none', bpm: 0, period: 0, confidence: 0, beatPhase: 0, nextBeat: 0, beat: -1, meter: 0, meterConfidence: 0, downbeatConfidence: 0,
  barPosition: -1, barPhase: -1, bar: -1, nextDownbeat: 0, phraseBars: 0, phraseBar: -1, phraseConfidence: 0, nextPhrase: 0,
  stability: 0, syncErrorMs: 0, jitterMs: 0, support: 0, halfTime: 0, doubleTime: 0, ambiguity: 0, coastAge: 0, losses: 0, relocks: 0, continuations: 0, relockSeconds: 0,
});
export const createUnderstanding = (): UnderstandingFrame => ({
  state: 'unknown', previous: 'unknown', confidence: 0, since: 0, reason: 'nothing heard yet', pulse: 0, groove: 0, tension: 0, tensionConfidence: 0,
  breakdown: 0, transition: 0, release: 0, development: 0, repetition: 0, pattern: 0, novelty: 0, boundary: 0, expectation: 0,
  surprise: 0, surpriseConfidence: 0, surpriseKind: 'none', surpriseAt: 0, silence: 'noSignal', silenceSeconds: 0,
  style: 'generic', styleConfidence: 0, styles: new Float32Array(STYLES.length),
});
export const createPrediction = (): Prediction => ({
  id: 0, kind: 'beat', status: 'proposed', time: 0, early: 0, late: 0, confidence: 0, evidence: '', created: 0, validUntil: 0, resolved: 0, observed: 0, error: 0, updates: 0,
});
const kinds = (): Uint32Array => new Uint32Array(PREDICTION_KINDS.length);
const measures = (): Float32Array => new Float32Array(PREDICTION_KINDS.length);
export const createStats = (): CognitionStats => ({
  proposed: kinds(), confirmed: kinds(), refuted: kinds(), expired: kinds(), brier: measures(), error: measures(), lead: measures(),
  missedBeats: 0, surprises: 0, stateChanges: 0, releases: 0, releasesUnannounced: 0, experienceDrops: 0, experienceDropsOff: 0, experienceDropsUnheard: 0, dropOffset: 0,
});
export const createCognition = (): CognitionFrame => ({
  time: 0, enabled: true, leads: false, clock: createClock(), understanding: createUnderstanding(),
  predictions: Array.from({ length: PREDICTION_SLOTS }, createPrediction), recent: Array.from({ length: RECENT }, createPrediction),
  stats: createStats(), diagnostics: { hops: 0, updateMicros: 0, memoryBytes: 0, bars: 0, beats: 0, fallback: 'no grid yet' },
});

export function copyStats(to: CognitionStats, from: Readonly<CognitionStats>): void {
  const { proposed, confirmed, refuted, expired, brier, error, lead } = to;
  Object.assign(to, from);
  to.proposed = proposed; to.confirmed = confirmed; to.refuted = refuted; to.expired = expired; to.brier = brier; to.error = error; to.lead = lead;
  proposed.set(from.proposed); confirmed.set(from.confirmed); refuted.set(from.refuted); expired.set(from.expired);
  brier.set(from.brier); error.set(from.error); lead.set(from.lead);
}
export function copyCognition(to: CognitionFrame, from: Readonly<CognitionFrame>): void {
  to.time = from.time; to.enabled = from.enabled; to.leads = from.leads;
  Object.assign(to.clock, from.clock);
  const styles = to.understanding.styles;
  Object.assign(to.understanding, from.understanding);
  to.understanding.styles = styles; styles.set(from.understanding.styles);
  for (let i = 0; i < to.predictions.length; i++) Object.assign(to.predictions[i], from.predictions[i]);
  for (let i = 0; i < to.recent.length; i++) Object.assign(to.recent[i], from.recent[i]);
  copyStats(to.stats, from.stats);
  Object.assign(to.diagnostics, from.diagnostics);
}

/**
 * The clock as it reads at `heard`, a moment after its snapshot (≤ one snapshot interval, the same as the world's
 * extrapolation): the phase and the musical time advance with the period. A pure function of the snapshot and the
 * heard time, so the same at any frame rate. Nothing else moves: interpretations and predictions are not extrapolated.
 */
export function presentClock(clock: ClockFrame, from: number, heard: number): void {
  const ahead = heard - from;
  if (!(ahead > 0) || !(clock.period > 0) || clock.confidence <= 0) return;
  const beats = ahead / clock.period;
  clock.beatPhase = (clock.beatPhase + beats) % 1;
  if (clock.beat >= 0) clock.beat += beats;
  if (clock.barPhase >= 0 && clock.meter > 0) clock.barPhase = (clock.barPhase + beats / clock.meter) % 1;
}
