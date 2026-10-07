import { copyFrame, newFrame, type AnalysisFrame, type BeatEvent, type OnsetEvent, type SectionEvent } from '../audio/features/decode';
import { copyMorphology, MorphologyEngine } from '../morphology/SoundMorphology';
import { ResonantPhysics } from '../physics/ResonantPhysics';
import { WorldEngine, WorldIntegrator } from '../world/WorldEngine';
import { copyWorld } from '../world/WorldState';
import { EventStream } from './EventStream';
import { TemporalMemory } from './TemporalMemory';
import { ExperiencePlanner } from './ExperiencePlanner';
import { createSnapshot, createState, Derivative, follow, NARRATIVES, TRAJECTORIES, unit, type ExperienceSnapshot, type NarrativeState, type Trajectory } from './types';

const HISTORY = 256;
/** Onset regions (low, mid, high) → the energy band at their centre. */
const REGION_BAND = [1, 3, 5];
/** A silence at least this long is "long"; a silence ending sooner is a short gap. */
const LONG_SILENCE = 2;
const N = NARRATIVES.length;
const NARRATIVE = Object.fromEntries(NARRATIVES.map((n, i) => [n, i])) as { readonly [K in NarrativeState]: number };
const T = TRAJECTORIES.length;
const TRAJECTORY = Object.fromEntries(TRAJECTORIES.map((t, i) => [t, i])) as { readonly [K in Trajectory]: number };

/** One causal model per audio session. Ingest every hop, present only history already heard. */
export class ExperienceEngine {
  readonly memory = new TemporalMemory();
  readonly planner = new ExperiencePlanner();
  readonly physics = new ResonantPhysics();
  /** What kind of sound is being heard, per hop on the audio clock (the layer between the DSP and the matter). */
  readonly morphology = new MorphologyEngine();
  /** The persistent world the music acts on (bodies and fields), advanced per hop on the audio clock. */
  readonly world = new WorldEngine();
  /** Extrapolates the presented world from its snapshot to the heard time (same held forces). */
  private readonly presentation = new WorldIntegrator();
  /** Discrete events (analysis and experience), ordered by capture time. */
  readonly events = new EventStream();
  readonly state = createState();
  readonly presented = createSnapshot(newFrame());
  private readonly history = Array.from({ length: HISTORY }, () => createSnapshot(newFrame()));
  private readonly dEnergy = new Derivative(0.5);
  private readonly dComplexity = new Derivative(0.6);
  private readonly dTension = new Derivative(0.8);
  private readonly dOpenness = new Derivative(0.6);
  /** Narrative and trajectory evidence: raw scores and their smoothed shares. */
  private readonly scores = new Float64Array(N);
  private readonly shares = new Float64Array(N);
  private readonly trajectoryScores = new Float64Array(T);
  private written = 0;
  private lastSnapshot = -Infinity;
  private lastTime = -1;
  private lastHit = -Infinity;
  private lastRelease = -Infinity;
  private quiet = true;
  private candidate: NarrativeState = 'calm';
  private candidateSince = 0;
  private lastNarrative = 0;
  private trajectoryCandidate: Trajectory = 'plateau';
  private trajectorySince = 0;
  private previousEnergy = 0;
  private previousTension = 0;
  private presence = 0;
  private silenceStart = -1;
  private resetSince = -Infinity;
  private buildPeak = 0;
  private buildPeakTime = 0;
  private phraseBar = -1;
  ready = false;
  /** Number of input gaps > 0.5 s (history resets instead of replaying stale excitation). */
  gaps = 0;

  /** Analysis events, in stream order with the frames (borrowed: read now). */
  onset(o: OnsetEvent): void {
    this.events.push('onset', o.time, o.strength, this.presence, REGION_BAND[o.region] ?? -1, 0);
  }

  beat(b: BeatEvent): void {
    this.events.push('beat', b.time, b.confidence, b.confidence * this.presence);
    if (b.downbeat) this.events.push('downbeat', b.time, b.confidence, b.downbeatConfidence * this.presence, -1, 0.25);
  }

  section(e: SectionEvent): void {
    this.events.push('sectionBoundary', e.time, e.novelty, e.confidence, -1, unit(0.5 + e.novelty * 0.5));
  }

  ingest(a: AnalysisFrame): void {
    if (a.time === this.lastTime) return;
    if (a.time < this.lastTime || (this.lastTime >= 0 && a.time - this.lastTime > 0.5)) {
      this.reset(); this.gaps++;
    }
    const dt = this.lastTime >= 0 ? a.time - this.lastTime : Math.min(a.time, 256 / 48000);
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    this.lastTime = a.time;
    // The interval up to this hop runs on the forces held since the previous one.
    this.world.advance(a.time);
    const s = this.state;
    const quiet = !!a.silent || a.presence < 0.06;
    const presence = quiet ? 0 : a.presence;
    this.presence = presence;
    const energy = unit((a.loudnessMomentary + 60) / 54) * presence;
    const complexity = unit(0.45 * a.entropy + 0.25 * a.complexity + 0.2 * unit(a.onsetDensity / 8) + 0.1 * a.spatialMovement) * presence;
    const disorder = unit(0.4 * a.flatness + 0.3 * a.inharmonicity + 0.3 * a.phaseDeviation) * presence;
    const tension = unit(a.roughness * 0.4 + disorder * 0.25 + Math.max(0, a.loudnessSlope) / 15) * presence;
    this.memory.update(a, energy, complexity, tension, dt);
    s.time = a.time; s.energy = energy; s.perceivedLoudness = a.loudnessMomentary;
    s.relativeLoudness = a.loudnessPosition * presence;
    s.complexity = follow(s.complexity, complexity, dt, 0.25);
    s.tension = follow(s.tension, tension, dt, 0.8);
    s.openness = follow(s.openness, unit(0.6 * a.width * a.stereoConfidence + 0.4 * a.perceivedBrightness) * presence, dt, 0.6);
    // Bands above their own noise floor: a noisy room does not read as a dense mix.
    let activeBands = 0;
    for (let b = 0; b < 8; b++) activeBands += a.bandLevel[b];
    s.density = unit(a.entropy * 0.4 + a.onsetDensity / 16 + activeBands / 8 * 0.3) * presence;
    let activity = 0;
    for (let b = 0; b < 8; b++) activity += a.bandActivity[b];
    s.motion = unit(activity / 4 + a.onsetDensity / 12) * presence;
    s.order = unit(a.harmonicity * 0.5 + a.phaseCoherence * 0.3 + (1 - a.entropy) * 0.2) * presence;
    s.chaos = disorder;
    s.flow = a.harmonicShare * presence;
    s.resonance = a.harmonicity * a.phaseCoherence * presence;
    this.derivatives(a, dt);
    s.energyTrend = Math.max(-1, Math.min(1, (this.memory.energy[1] - this.memory.energy[2]) * 4));
    s.complexityTrend = Math.max(-1, Math.min(1, (this.memory.complexity[1] - this.memory.complexity[2]) * 4));
    s.confidence = presence * unit(a.time / 3);
    s.rhythmConfidence = a.beatConfidence * presence;
    s.novelty = follow(s.novelty, Math.max(this.memory.novelty, a.novelty * a.structureConfidence), dt, 0.3);
    s.familiarity = this.memory.familiarity; s.motif = this.memory.motif; s.recurrence = this.memory.recurrence;
    s.beatPhase = a.beatPhase;
    s.meterConfidence = a.meterConfidence;
    s.barPhase = a.meterConfidence > 0.2 ? a.barPhase : 0;
    s.phrasePhase = a.meterConfidence > 0.2 && a.phraseBars > 0 ? (a.phraseBar + a.barPhase) / a.phraseBars : 0;
    if (a.phraseBars > 0 && a.phraseBar === 0 && this.phraseBar > 0) {
      this.events.push('phraseBoundary', a.time, unit(s.novelty + 0.3), a.structureConfidence * presence, -1, unit(0.4 + s.novelty));
    }
    this.phraseBar = a.phraseBars > 0 ? a.phraseBar : -1;
    // Confidence-weighted causal evidence: no scheduled "known drop" and no lookahead.
    // A build is a sustained rise: the 2 s vs 10 s trend and the current velocity must agree, so the
    // plateau after a step (a drop) is not read as building. While a release is fresh, its energy is the release.
    const rise = Math.min(Math.max(0, s.energyTrend), unit(s.energyVelocity * 30));
    const building = unit(rise * 1.1 + s.tension * 0.35 + Math.max(0, s.complexityTrend) * 0.4 +
      Math.max(0, a.expansionTrend) * 0.3 + Math.max(0, a.brightnessSlope) * 0.5) * (1 - s.release);
    s.anticipation = follow(s.anticipation, building * s.confidence * unit(a.onsetDensity / 2 + a.roughness), dt, 0.6);
    s.anticipationConfidence = s.confidence * (0.4 + 0.6 * Math.max(s.rhythmConfidence, a.structureConfidence));
    this.detectBuildPeak(a.time);
    s.releasePotential = unit(s.releasePotential + (Math.max(0, s.anticipation - 0.15) / 0.85 * 0.16 - (1 - s.anticipation) * s.releasePotential * 0.025) * dt);
    s.release *= Math.exp(-dt / 1.4);
    s.impact *= Math.exp(-dt / 0.16);
    const onset = Math.max(a.shortTransient * 0.8, a.onsetStrength * 0.5) * presence;
    if (onset > 0.3 && a.time - this.lastHit > 0.12) {
      const structural = unit(s.novelty + Math.max(0, energy - this.memory.energy[1]) * 2);
      const release = s.releasePotential > 0.16 && structural > 0.12 && a.time - this.lastRelease > 4;
      const power = unit(onset * (0.5 + s.releasePotential) * (0.6 + 0.4 * structural) * s.confidence);
      s.eventId++; s.eventTime = a.time; s.eventStrength = power;
      s.impact = power; this.lastHit = a.time;
      const band = strongestBand(a);
      this.events.push('impact', a.time, power, s.confidence, band, structural);
      // Where the hit sits in the stereo image decides where it pushes the world from (mono: centred).
      this.world.impact(a.time, power, band, (band >= 0 ? a.bandPan[band] : a.balance) * a.stereoConfidence);
      if (release) {
        s.release = unit(s.releasePotential * (0.5 + structural));
        this.events.push('drop', a.time, s.release, s.anticipationConfidence, -1, unit(s.releasePotential + structural * 0.5));
        this.world.release(a.time, s.release);
        // The release resolves what was anticipated.
        s.releasePotential *= 0.2; s.anticipation *= 0.3; this.lastRelease = a.time; this.memory.drops++;
      }
    }
    s.pressure = unit(s.energy * 0.35 + s.releasePotential * 0.65);
    this.silence(a.time, quiet, energy, dt);
    this.trajectory(a.time, quiet);
    this.narrative(a.time, quiet, energy, dt);
    this.predict(a);
    this.planner.update(s, a, dt);
    this.physics.update(a, s, dt);
    this.morphology.update(a, dt);
    this.world.setForces(a, s, this.planner.intents, presence);
    if (a.time - this.lastSnapshot >= 1 / 120 - 1e-9) {
      const snapshot = this.history[this.written++ % HISTORY];
      Object.assign(snapshot.state, s); Object.assign(snapshot.plan, this.planner.plan);
      for (let i = 0; i < snapshot.intents.length; i++) Object.assign(snapshot.intents[i], this.planner.intents[i]);
      copyPhysics(snapshot.physics, this.physics.frame); copyFrame(snapshot.acoustic, a);
      copyWorld(snapshot.world, this.world.state); copyMorphology(snapshot.morphology, this.morphology.state);
      this.lastSnapshot = a.time;
    }
  }

  /** Future audio may already be captured (Bluetooth). Never present its narrative early. */
  present(heardTime: number): ExperienceSnapshot | undefined {
    const count = Math.min(this.written, HISTORY);
    for (let back = 1; back <= count; back++) {
      const candidate = this.history[(this.written - back) % HISTORY];
      if (candidate.state.time <= heardTime + 1e-9) {
        // A stalled transport is not sustained sound. Drop stale states without inventing audio events.
        if (heardTime - candidate.state.time > 0.5) { this.ready = false; return undefined; }
        copySnapshot(this.presented, candidate);
        // A pure function of the snapshot and the heard time: the same at any frame rate.
        this.presentation.integrate(this.presented.world, heardTime - candidate.state.time);
        this.ready = true; return this.presented;
      }
    }
    this.ready = false; return undefined;
  }

  reset(): void {
    this.memory.reset(); this.planner.reset(); this.physics.reset(); this.world.reset(); this.events.reset(); this.morphology.reset();
    this.dEnergy.reset(); this.dComplexity.reset(); this.dTension.reset(); this.dOpenness.reset();
    this.shares.fill(0); this.scores.fill(0); this.trajectoryScores.fill(0);
    Object.assign(this.state, createState());
    copySnapshot(this.presented, createSnapshot(newFrame()));
    this.written = 0; this.lastSnapshot = this.lastHit = this.lastRelease = -Infinity; this.lastTime = -1;
    this.quiet = true; this.candidate = 'calm'; this.candidateSince = this.lastNarrative = 0;
    this.trajectoryCandidate = 'plateau'; this.trajectorySince = 0;
    this.previousEnergy = this.previousTension = this.presence = 0; this.ready = false;
    this.silenceStart = -1; this.resetSince = -Infinity; this.buildPeak = this.buildPeakTime = 0; this.phraseBar = -1;
  }

  private derivatives(a: AnalysisFrame, dt: number): void {
    const s = this.state;
    this.dEnergy.update(s.energy, dt); this.dComplexity.update(s.complexity, dt);
    this.dTension.update(s.tension, dt); this.dOpenness.update(s.openness, dt);
    s.energyVelocity = this.dEnergy.velocity; s.energyAcceleration = this.dEnergy.acceleration;
    s.complexityVelocity = this.dComplexity.velocity; s.tensionVelocity = this.dTension.velocity;
    s.opennessVelocity = this.dOpenness.velocity;
    // DSP descriptors are differentiated in Rust; only passed through here.
    s.loudnessVelocity = a.loudnessSlope; s.brightnessVelocity = a.brightnessSlope; s.entropyVelocity = a.entropySlope;
    s.harmonicityVelocity = a.harmonicitySlope; s.widthVelocity = a.expansionTrend;
  }

  /** A build peaks when anticipation falls clearly below its running maximum; stamped at the maximum. */
  private detectBuildPeak(time: number): void {
    const s = this.state;
    if (s.anticipation > this.buildPeak) { this.buildPeak = s.anticipation; this.buildPeakTime = time; }
    else if (this.buildPeak > 0.3 && s.anticipation < this.buildPeak * 0.75) {
      this.events.push('buildPeak', this.buildPeakTime, this.buildPeak, s.anticipationConfidence, -1, s.releasePotential);
      this.buildPeak = s.anticipation;
    } else if (this.buildPeak <= 0.3) this.buildPeak = Math.max(s.anticipation, this.buildPeak * 0.999);
  }

  private silence(time: number, quiet: boolean, energy: number, dt: number): void {
    const s = this.state;
    if (quiet) {
      if (!this.quiet) {
        s.precedingEnergy = this.previousEnergy; s.precedingTension = this.previousTension;
        // Fast-memory energy preserves an abrupt cut; a long fade has already relaxed it.
        s.silenceAbruptness = unit(this.memory.energy[0] * 1.6);
        this.memory.pauses++;
        this.silenceStart = time;
        this.events.push('silenceStart', time, s.silenceAbruptness, 1, -1, s.precedingTension);
      }
      s.silenceDuration += dt;
      s.silenceKind = s.silenceDuration >= LONG_SILENCE ? 'long-silence' : s.silenceAbruptness > 0.45 ? 'hard-cut' : 'soft-fade';
    } else {
      if (this.quiet && this.silenceStart >= 0) {
        this.events.push('silenceEnd', time, unit(s.silenceDuration / LONG_SILENCE), 1, -1, s.precedingTension, s.silenceDuration);
        if (s.silenceDuration >= LONG_SILENCE) this.resetSince = time;
      }
      s.silenceDuration = 0; s.silenceAbruptness = 0; s.silenceKind = 'none';
      this.previousEnergy = energy; this.previousTension = s.tension;
    }
    this.quiet = quiet;
  }

  /** Scores from trends at 0.15/2/10/45 s and the derivatives; switching needs a margin held for a moment. */
  private trajectory(time: number, quiet: boolean): void {
    const s = this.state, e = this.memory.energy, c = this.memory.complexity, sc = this.trajectoryScores;
    const mid = (e[1] - e[2]) * 5, slow = (e[2] - e[3]) * 4, fast = s.energyVelocity * 2;
    // Agreement of the fast, middle and slow scales makes a direction; one scale alone is weak evidence.
    const agree = (x: number, y: number) => (Math.sign(x) === Math.sign(y) ? 1 : 0.5);
    sc.fill(0);
    sc[TRAJECTORY.plateau] = 0.3;
    sc[TRAJECTORY.rising] = unit(mid * agree(mid, fast) + Math.max(0, slow) * 0.5);
    sc[TRAJECTORY.falling] = unit(-mid * agree(mid, fast) + Math.max(0, -slow) * 0.5);
    sc[TRAJECTORY.building] = unit(s.anticipation * 1.4 * (0.5 + 0.5 * unit(mid * 2 + s.tensionVelocity * 4)));
    sc[TRAJECTORY.releasing] = unit(s.release * 1.6);
    const destabilizing = (c[1] - c[2]) * 5 + s.complexityVelocity * 2 + Math.max(0, s.entropyVelocity);
    sc[TRAJECTORY.destabilizing] = unit(destabilizing * 0.8);
    sc[TRAJECTORY.stabilizing] = unit(-destabilizing * 0.8);
    sc[TRAJECTORY.suspended] = quiet && s.silenceDuration > 0.12 ? 1.5 : 0;
    let best = 0;
    for (let i = 1; i < T; i++) if (sc[i] > sc[best]) best = i;
    let second = -Infinity;
    for (let i = 0; i < T; i++) if (i !== best) second = Math.max(second, sc[i]);
    const next = TRAJECTORIES[best];
    if (next !== this.trajectoryCandidate) { this.trajectoryCandidate = next; this.trajectorySince = time; }
    const current = TRAJECTORY[s.trajectory];
    if (next !== s.trajectory && (next === 'suspended' || next === 'releasing' ||
      (sc[best] > sc[current] + 0.1 && time - this.trajectorySince > 0.4))) s.trajectory = next;
    const held = TRAJECTORY[s.trajectory];
    // Margin over the strongest rival, centred at 0.5: a tie reads as half-confident.
    s.trajectoryConfidence = unit(0.5 + sc[held] - (held === best ? second : sc[best])) * s.confidence;
  }

  /** Smoothed shares of narrative evidence, with hysteresis; silence and release act at once. */
  private narrative(time: number, quiet: boolean, energy: number, dt: number): void {
    const s = this.state, sc = this.scores, p = this.shares;
    sc.fill(0);
    sc[NARRATIVE.calm] = 0.2 + 0.3 * (1 - energy) * (1 - s.motion);
    sc[NARRATIVE.floating] = s.flow * (1 - s.motion) * 0.9;
    sc[NARRATIVE.building] = s.anticipation * 1.4;
    sc[NARRATIVE.ascending] = unit(s.energyTrend * 6) * (1 - s.anticipation) * 0.8;
    sc[NARRATIVE.climax] = unit((energy - 0.6) * 4) * unit((this.memory.energy[1] - 0.55) * 4) * (0.6 + 0.4 * s.relativeLoudness) * 1.2;
    sc[NARRATIVE.release] = s.release * 1.6;
    sc[NARRATIVE.descending] = unit(-s.energyTrend * 6) * 0.9;
    sc[NARRATIVE.reset] = Math.max(0, 1 - (time - this.resetSince) / 2);
    let sum = 0;
    for (let i = 0; i < N; i++) sum += sc[i];
    for (let i = 0; i < N; i++) p[i] = follow(p[i], sc[i] / sum, dt, 0.35);
    let best = 0;
    for (let i = 1; i < N; i++) if (p[i] > p[best]) best = i;
    let next = NARRATIVES[best];
    if (quiet) next = s.silenceAbruptness > 0.45 ? 'suspended' : 'calm';
    // Music returning after a long silence starts over at once; evidence takes over after.
    else if (time - this.resetSince < 1.5) next = 'reset';
    if (next !== this.candidate) { this.candidate = next; this.candidateSince = time; }
    const current = NARRATIVE[s.narrative];
    if (next !== s.narrative && ((quiet && s.silenceDuration > 0.12) || (next === 'release' && s.release > 0.25) || next === 'reset' ||
      (p[NARRATIVE[next]] > p[current] + 0.08 && time - this.candidateSince > 0.7 && time - this.lastNarrative > 2))) {
      s.narrative = next; this.lastNarrative = time;
      if (next === 'climax') this.memory.climaxes++;
    }
    s.narrativeConfidence = quiet ? 1 : p[NARRATIVE[s.narrative]];
  }

  /** Grid forecasts with confidence, and evidence of what the next seconds hold. No lookahead. */
  private predict(a: AnalysisFrame): void {
    const s = this.state;
    const presence = this.presence;
    s.nextBeatTime = a.nextBeatTime;
    s.nextBeatConfidence = a.nextBeatTime > 0 ? a.beatConfidence * presence : 0;
    s.nextDownbeatTime = a.nextDownbeatTime;
    // With an unknown meter the grid groups beats by an internal fallback: a weaker forecast, not none.
    s.nextDownbeatConfidence = a.nextDownbeatTime > 0 ? a.downbeatConfidence * (a.meter > 0 ? 0.5 + 0.5 * a.meterConfidence : 0.4) * presence : 0;
    s.nextPhraseTime = a.nextPhraseTime;
    s.nextPhraseConfidence = a.nextPhraseTime > 0 ? a.structureConfidence * s.nextDownbeatConfidence : 0;
    const horizon = 1 + 3 * s.rhythmConfidence;
    s.predictionHorizon = horizon;
    const ahead = s.nextPhraseTime - s.time;
    const phraseNear = s.nextPhraseTime > 0 && ahead >= 0 && ahead <= horizon ? (1 - ahead / horizon) * s.nextPhraseConfidence : 0;
    s.likelyBoundary = unit(Math.max(phraseNear, s.novelty * 0.6 + Math.max(0, s.complexityVelocity) * 2));
    s.likelyBuild = unit(s.anticipation * 1.2 + Math.max(0, s.energyVelocity) * 3 + Math.max(0, s.tensionVelocity) * 2) * s.confidence;
    s.likelyRelease = unit(s.releasePotential * (0.4 + 0.8 * s.likelyBoundary));
    s.likelyContinuation = unit(1 - Math.max(s.likelyBuild, s.likelyRelease, s.likelyBoundary)) * (0.5 + 0.5 * s.familiarity) * s.confidence;
    s.predictionConfidence = s.confidence * (0.4 + 0.6 * s.rhythmConfidence);
  }
}

function strongestBand(a: AnalysisFrame): number {
  let band = 0;
  for (let b = 1; b < 8; b++) if (a.bandTransient[b] > a.bandTransient[band]) band = b;
  return a.bandTransient[band] > 0 ? band : -1;
}
function copyPhysics(to: ExperienceSnapshot['physics'], from: ExperienceSnapshot['physics']): void {
  const modes = to.modes, waves = to.waves;
  Object.assign(to, from); to.modes = modes; to.waves = waves;
  modes.set(from.modes); waves.set(from.waves);
}
function copySnapshot(to: ExperienceSnapshot, from: ExperienceSnapshot): void {
  Object.assign(to.state, from.state); Object.assign(to.plan, from.plan);
  for (let i = 0; i < to.intents.length; i++) Object.assign(to.intents[i], from.intents[i]);
  copyPhysics(to.physics, from.physics); copyFrame(to.acoustic, from.acoustic); copyWorld(to.world, from.world);
  copyMorphology(to.morphology, from.morphology);
}
