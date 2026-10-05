import type { AnalysisFrame } from '../audio/features/decode';
import { createPhysicsFrame, type PhysicsFrame } from '../physics/ResonantPhysics';

/** Narrative role (where the music is going), distinct from Mood (its character). */
export const NARRATIVES = ['calm', 'floating', 'building', 'ascending', 'climax', 'release', 'descending', 'suspended', 'reset'] as const;
export type NarrativeState = typeof NARRATIVES[number];
/** State + direction, from trends at several time scales. */
export const TRAJECTORIES = ['plateau', 'rising', 'falling', 'building', 'releasing', 'stabilizing', 'destabilizing', 'suspended'] as const;
export type Trajectory = typeof TRAJECTORIES[number];
/** hard-cut / soft-fade: how a silence began; long-silence once it lasts. A short gap is a silenceEnd event under 0.6 s. */
export type SilenceKind = 'none' | 'hard-cut' | 'soft-fade' | 'long-silence';
export const INTENTS = ['expand', 'contract', 'flow', 'impact', 'cohere', 'fragment', 'suspend', 'dissolve', 'breathe', 'rotate',
  'pulse', 'accelerate', 'decelerate', 'reveal'] as const;
export type IntentKind = typeof INTENTS[number];
/** Index of each intent in `ExperienceSnapshot.intents`. */
export const INTENT = Object.fromEntries(INTENTS.map((kind, i) => [kind, i])) as { readonly [K in IntentKind]: number };
/** Semantic intent, on the capture clock. Continuous intents refresh; impact is event-stamped. */
export interface VisualIntent {
  kind: IntentKind;
  strength: number;
  duration: number;
  attack: number;
  release: number;
  spatialBias: number;
  confidence: number;
  time: number;
}
export interface ExperienceState {
  time: number;
  energy: number;
  perceivedLoudness: number;
  complexity: number;
  tension: number;
  openness: number;
  density: number;
  motion: number;
  order: number;
  chaos: number;
  impact: number;
  flow: number;
  pressure: number;
  resonance: number;
  energyTrend: number;
  complexityTrend: number;
  /** Momentary loudness between the session's P10 and P95 (0.5 = typical): relative, not volume. */
  relativeLoudness: number;
  /** First/second derivatives (per second): experience values here, DSP descriptors passed through from Rust. */
  energyVelocity: number;
  energyAcceleration: number;
  complexityVelocity: number;
  tensionVelocity: number;
  opennessVelocity: number;
  loudnessVelocity: number;
  brightnessVelocity: number;
  entropyVelocity: number;
  harmonicityVelocity: number;
  widthVelocity: number;
  trajectory: Trajectory;
  trajectoryConfidence: number;
  anticipation: number;
  anticipationConfidence: number;
  releasePotential: number;
  release: number;
  novelty: number;
  familiarity: number;
  motif: number;
  recurrence: number;
  narrative: NarrativeState;
  /** Smoothed probability of the current narrative among the candidates (not calibrated). */
  narrativeConfidence: number;
  confidence: number;
  rhythmConfidence: number;
  beatPhase: number;
  barPhase: number;
  phrasePhase: number;
  meterConfidence: number;
  /** Event identity persists across render frames; time is never RAF time. */
  eventId: number;
  eventTime: number;
  eventStrength: number;
  silenceDuration: number;
  silenceAbruptness: number;
  silenceKind: SilenceKind;
  precedingEnergy: number;
  precedingTension: number;
  visualEntropy: number;
  fatigue: number;
  /** Forecasts on the capture clock (0 = none) with their confidence: preparation, not certainty. */
  nextBeatTime: number;
  nextBeatConfidence: number;
  nextDownbeatTime: number;
  nextDownbeatConfidence: number;
  nextPhraseTime: number;
  nextPhraseConfidence: number;
  /** Seconds ahead the forecasts look (1–4 s, longer with a confident grid). */
  predictionHorizon: number;
  /** Deterministic evidence over the horizon (0..1, not calibrated probabilities). */
  likelyContinuation: number;
  likelyBuild: number;
  likelyRelease: number;
  likelyBoundary: number;
  predictionConfidence: number;
}
export interface ExperiencePlan {
  currentIntent: IntentKind;
  nextIntent: IntentKind;
  horizon: number;
  transitionStart: number;
  transitionEnd: number;
  /** 0..1: the window rests on a forecast phrase boundary (its confidence), or only on the horizon (low). */
  transitionConfidence: number;
  maxIntensity: number;
  desiredEntropy: number;
  sceneContinuity: number;
  contrastTarget: number;
  confidence: number;
}
export interface ExperienceSnapshot {
  state: ExperienceState;
  plan: ExperiencePlan;
  intents: VisualIntent[];
  physics: PhysicsFrame;
  /** Owned copy, so a later decode cannot mutate the heard snapshot. */
  acoustic: AnalysisFrame;
}
export const createState = (): ExperienceState => ({
  time: 0, energy: 0, perceivedLoudness: -70, complexity: 0, tension: 0, openness: 0,
  density: 0, motion: 0, order: 0, chaos: 0, impact: 0, flow: 0, pressure: 0, resonance: 0,
  energyTrend: 0, complexityTrend: 0, relativeLoudness: 0, energyVelocity: 0, energyAcceleration: 0,
  complexityVelocity: 0, tensionVelocity: 0, opennessVelocity: 0, loudnessVelocity: 0, brightnessVelocity: 0,
  entropyVelocity: 0, harmonicityVelocity: 0, widthVelocity: 0, trajectory: 'plateau', trajectoryConfidence: 0,
  anticipation: 0, anticipationConfidence: 0,
  releasePotential: 0, release: 0, novelty: 0, familiarity: 0, motif: -1, recurrence: 0,
  narrative: 'calm', narrativeConfidence: 0, confidence: 0, rhythmConfidence: 0, beatPhase: 0, barPhase: 0, phrasePhase: 0, meterConfidence: 0,
  eventId: 0, eventTime: -1, eventStrength: 0, silenceDuration: 0, silenceAbruptness: 0, silenceKind: 'none',
  precedingEnergy: 0, precedingTension: 0, visualEntropy: 0, fatigue: 0,
  nextBeatTime: 0, nextBeatConfidence: 0, nextDownbeatTime: 0, nextDownbeatConfidence: 0, nextPhraseTime: 0, nextPhraseConfidence: 0,
  predictionHorizon: 1, likelyContinuation: 0, likelyBuild: 0, likelyRelease: 0, likelyBoundary: 0, predictionConfidence: 0,
});
export const createPlan = (): ExperiencePlan => ({ currentIntent: 'flow', nextIntent: 'flow', horizon: 4,
  transitionStart: 0, transitionEnd: 0, transitionConfidence: 0, maxIntensity: 1, desiredEntropy: 0, sceneContinuity: 1, contrastTarget: 0, confidence: 0 });
export const createIntents = (): VisualIntent[] => INTENTS.map(kind => ({ kind, strength: 0, duration: 1, attack: 0.1, release: 1, spatialBias: 0, confidence: 0, time: 0 }));
export function createSnapshot(acoustic: AnalysisFrame): ExperienceSnapshot {
  return { state: createState(), plan: createPlan(), intents: createIntents(), physics: createPhysicsFrame(), acoustic };
}
export const unit = (x: number): number => Math.min(1, Math.max(0, x));
export const follow = (x: number, target: number, dt: number, tau: number): number => x + (target - x) * (1 - Math.exp(-dt / tau));

/** Smoothed value with first and second derivatives (per second), on the audio clock. */
export class Derivative {
  value = 0;
  velocity = 0;
  acceleration = 0;
  private started = false;
  constructor(private readonly tau: number) {}
  update(x: number, dt: number): void {
    if (!this.started) { this.value = x; this.started = true; return; }
    const previous = this.value, velocity = this.velocity;
    this.value = follow(this.value, x, dt, this.tau * 0.5);
    this.velocity = follow(this.velocity, (this.value - previous) / dt, dt, this.tau);
    this.acceleration = follow(this.acceleration, (this.velocity - velocity) / dt, dt, this.tau * 2);
  }
  reset(): void { this.value = this.velocity = this.acceleration = 0; this.started = false; }
}
