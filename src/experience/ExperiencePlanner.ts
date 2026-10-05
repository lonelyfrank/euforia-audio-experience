import type { AnalysisFrame } from '../audio/features/decode';
import { createIntents, createPlan, follow, unit, type ExperienceState } from './types';

/** Narrative → semantic intent. No scene IDs, shader uniforms or genre assumptions. */
export class ExperiencePlanner {
  readonly plan = createPlan();
  readonly intents = createIntents();
  private fatigue = 0;

  update(s: ExperienceState, a: AnalysisFrame, dt: number): void {
    const p = this.plan;
    const previousIntent = p.currentIntent;
    // This is an intent-side proxy; renderer feedback adds layer/activity cost in the engine.
    s.visualEntropy = unit(0.22 * s.energy + 0.28 * s.complexity + 0.2 * s.motion + 0.15 * s.impact + 0.15 * s.openness);
    this.fatigue = follow(this.fatigue, Math.max(0, s.visualEntropy - 0.55) / 0.45, dt, s.visualEntropy > 0.55 ? 12 : 4);
    s.fatigue = this.fatigue;
    p.currentIntent = s.silenceDuration > 0.12 ? (s.silenceAbruptness > 0.45 ? 'suspend' : 'dissolve') :
      s.release > 0.3 ? 'expand' : s.anticipation > 0.4 ? 'contract' : s.chaos > 0.65 ? 'fragment' : 'flow';
    p.nextIntent = s.anticipation > 0.35 || s.likelyRelease > 0.4 ? 'expand' : this.fatigue > 0.3 ? 'breathe' : s.order > 0.6 ? 'cohere' : 'flow';
    p.horizon = 2 + 6 * (1 - s.confidence * 0.6 - s.anticipation * 0.4);
    const ahead = s.nextPhraseTime - s.time;
    if (s.nextPhraseTime > 0 && s.nextPhraseConfidence > 0.35 && ahead > 0 && ahead <= p.horizon) {
      // A forecast boundary inside the horizon: prepare for it rather than for an arbitrary moment.
      p.transitionStart = s.nextPhraseTime - Math.min(0.5, ahead * 0.5);
      p.transitionEnd = s.nextPhraseTime + 1;
      p.transitionConfidence = s.nextPhraseConfidence;
    } else if (p.currentIntent !== previousIntent || s.time >= p.transitionEnd) {
      p.transitionStart = s.time + p.horizon * 0.35;
      p.transitionEnd = s.time + p.horizon;
      p.transitionConfidence = s.confidence * 0.3;
    }
    p.maxIntensity = unit(0.62 + 0.38 * Math.max(s.release, s.energy) - this.fatigue * 0.25);
    p.desiredEntropy = unit(s.complexity * 0.65 + s.release * 0.25 - this.fatigue * 0.35);
    p.contrastTarget = unit(s.novelty * 0.6 + s.release * 0.4 + this.fatigue * 0.3);
    p.sceneContinuity = unit(0.8 + s.familiarity * 0.2 - p.contrastTarget * 0.6);
    p.confidence = s.confidence;
    for (const i of this.intents) {
      i.confidence = s.confidence;
      i.spatialBias = a.balance * a.stereoConfidence;
      i.time = s.time; i.duration = p.horizon; i.attack = 0.25; i.release = 1.2;
      switch (i.kind) {
        case 'expand': i.strength = unit(s.openness * 0.6 + s.release * 0.4); break;
        case 'contract': i.strength = s.anticipation * s.releasePotential; i.confidence = s.anticipationConfidence; break;
        case 'flow': i.strength = s.flow; break;
        case 'impact': i.strength = s.eventStrength; i.time = s.eventTime; i.duration = 0.6; i.attack = 0.005; i.release = 0.35; break;
        case 'cohere': i.strength = s.order; break;
        case 'fragment': i.strength = s.chaos * p.desiredEntropy; break;
        case 'suspend': i.strength = s.silenceDuration > 0 ? s.silenceAbruptness : 0; break;
        case 'dissolve': i.strength = unit(s.silenceDuration / 3) * (1 - s.silenceAbruptness * 0.5); break;
        case 'breathe': i.strength = this.fatigue; break;
        case 'rotate': i.strength = s.motion * (0.4 + a.spatialMovement * 0.6); break;
        // Peaks on the forecast beat and swells before it: the picture prepares instead of reacting late.
        case 'pulse':
          i.strength = 0.5 + 0.5 * Math.cos(s.beatPhase * Math.PI * 2);
          i.confidence = s.nextBeatConfidence; i.time = s.nextBeatTime;
          i.duration = a.beatBpm > 0 ? 60 / a.beatBpm : 0.5; i.attack = i.duration * 0.5; i.release = i.duration * 0.5; break;
        case 'accelerate': i.strength = unit(s.energyVelocity * 4 + s.complexityVelocity * 2); break;
        case 'decelerate': i.strength = unit(-s.energyVelocity * 4 - s.complexityVelocity * 2); break;
        case 'reveal': i.strength = unit(s.novelty * (0.5 + s.opennessVelocity * 3)) * (0.4 + 0.6 * s.order); break;
      }
    }
  }
  reset(): void { this.fatigue = 0; Object.assign(this.plan, createPlan()); for (const i of this.intents) i.strength = 0; }
}
