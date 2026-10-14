import type { AnalysisFrame, BeatEvent, OnsetEvent, SectionEvent } from '../../audio/features/decode';
import { StyleBlend, UNIVERSAL, type StyleEvidence } from './knowledge';
import { Interpreter, type InterpretationInput } from './Interpretation';
import { MusicalClock, type Grouping } from './MusicalClock';
import { PredictionLedger } from './Predictions';
import { FREE_BEAT, lowShare, StructuralMemory } from './StructuralMemory';
import { createCognition, type CognitionFrame, type PredictionKind, type SurpriseKind } from './types';

/*
 * Euforia Musical Cognition (docs/musical-cognition.md): the layer that understands the music it hears, between the
 * DSP's measures and the director. Per analysis hop inside ExperienceEngine, on the capture clock, causal (nothing it
 * decides uses audio after the hop), from measures and events the DSP already exports and the experience's own build
 * evidence. It writes nothing back: not the world, not the event stream, not the experience state. The director reads
 * it from the snapshot, and falls back to what it did before whenever the cognition is not sure (`leads`).
 *
 * Rates: the clock follows every hop and event; the memory accumulates per hop and decides per beat and per bar; the
 * reasoning runs at each beat and ten times a second; the style blend twice a second (every two in the low budget,
 * where the reasoning also waits for beats). The release is the one observation made here: heard, never predicted —
 * a low attack after seconds of sound without low end under tension, with the low end and the level back within a
 * moment, or a drop section the DSP itself decided.
 */

export interface CognitionConfig {
  /** Off: nothing is computed and the frame says so; the experience and the director are exactly as without it. */
  enabled: boolean;
  /** The director may follow the cognition (phrase grid, transition window); off: the reactive direction as before. */
  direct: boolean;
  /** How far back the structural memory compares (s, 30–120). */
  memorySeconds: number;
  /** Stylistic priors (off: the universal ones only). */
  style: boolean;
  /** 'low': reasoning only at beats, style every 2 s (weaker machines). */
  budget: 'full' | 'low';
  /** Measure the cost per hop (diagnostics; off in the product). */
  profile: boolean;
}

export const DEFAULT_CONFIG: Readonly<CognitionConfig> = { enabled: true, direct: true, memorySeconds: 90, style: true, budget: 'full', profile: false };

/** What the experience engine already knows that the cognition reuses (its build evidence), so it is not computed twice. */
export interface CognitionContext {
  readonly anticipation: number;
  readonly anticipationConfidence: number;
}

/** The director follows the cognition's phrase grid from this confidence. */
export const LEAD_CONFIDENCE = 0.5;
/** Surprise decays in this long (s); structural expectations look this far ahead (s). */
const SURPRISE_TAU = 1.2;
export const HORIZON = 8;
const REASONING_INTERVAL = 0.1;
/** A quiet this long is a silence, then no signal (s). */
const PAUSE = 2;
const NO_SIGNAL = 8;
/** Release evidence: sound without low end this long first (s); then the low end back, with a low attack within this long (s) after it. */
const WITHOUT_LOW = 1.5;
const RELEASE_WINDOW = 0.35;
/** The attack that dates a release may come at most this long (s) before the low end is back. */
const ATTACK_BEFORE = 0.1;
/** A silence this long forgets the sound without low end before it: music coming back after silence is not a release. */
const SILENCE_FORGETS = 1;
/** One release per resolution: releases closer than this are the same one (s). */
const RELEASE_GAP = 4;
/** Seconds over which the experience's build evidence counts again after a silence. */
const REENTRY = 5;
/** How long an experience `drop` waits for a release to compare with (s). */
const DROP_MATCH = 4;
/** Grouping sources: none, the tracker's published meter, the memory's changes. */
const NONE = 0, METER = 1, CHANGES = 2;

const unit = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
const mod = (x: number, m: number): number => ((x % m) + m) % m;

export class MusicalCognition {
  readonly frame: CognitionFrame = createCognition();
  readonly config: CognitionConfig = { ...DEFAULT_CONFIG };
  readonly clock = new MusicalClock(this.frame.clock);
  readonly memory = new StructuralMemory();
  readonly style = new StyleBlend();
  readonly ledger = new PredictionLedger(this.frame);
  private readonly interpreter = new Interpreter();
  private readonly input: InterpretationInput = {
    time: 0, dt: 0, presence: 0, anticipation: 0, anticipationConfidence: 0, releaseAge: Infinity, sectionAge: Infinity, sectionDrop: false,
    boundary: 0, barSeconds: 2, buildResolves: UNIVERSAL.buildResolves, quiet: true,
  };
  private readonly evidence: StyleEvidence = { bpm: 0, regularity: 0, percussive: 0, density: 0, low: 0 };
  private readonly grouping: Grouping = { beats: 0, offset: 0, confidence: 0 };
  private readonly candidate: Grouping = { beats: 0, offset: 0, confidence: 0 };
  private source = NONE;
  private offered = NONE;
  private last: Readonly<AnalysisFrame> | null = null;
  private now = 0;
  private freeNext = 0;
  private freeIndex = 0;
  private quietSince = -1;
  private soundSeen = false;
  private interrupted = false;
  /** Since when sound has been back after a lost source (−1: not yet). */
  private recoverFrom = -1;
  private silentFor = 0;
  /** When sound came back after a silence of a second or more (−Infinity: never): its rise is a re-entry, not a build. */
  private backAt = -Infinity;
  private withoutLow = 0;
  private lowFor = 0;
  /** When the low end came back (−1: it has not, or too long ago to be the release), and when the last low attack was. */
  private lowBackAt = -1;
  private lowAttackAt = -Infinity;
  private recentTension = 0;
  private lastRelease = -Infinity;
  private lastSection = -Infinity;
  private sectionDrop = false;
  private nextReasoning = 0;
  private reasonedAt = -1;
  private nextStyle = 0;
  private pendingBoundary = 0;
  private lastStrongBar = -1;
  /** Capture time of the last phrase boundary that came where it was expected. */
  private phraseConfirmedAt = -Infinity;
  private beatSeen = false;
  private settledSeen = 0;
  private extended = false;
  private pendingDrop = -1;
  private disabled = false;
  /** Each release heard, for an evaluation (tests, the laboratory); unset in the product. */
  onRelease: ((time: number) => void) | null = null;

  constructor() {
    this.frame.diagnostics.memoryBytes = this.memory.bytes + MusicalClock.bytes + this.style.weights.byteLength * 2;
  }

  /** A new audio session: nothing of the previous one holds (the style blend included). */
  reset(): void {
    const enabled = this.frame.enabled, bytes = this.frame.diagnostics.memoryBytes;
    this.clock.reset(); this.memory.reset(); this.style.reset(); this.ledger.reset(); this.interpreter.reset();
    const fresh = createCognition();
    Object.assign(this.frame.understanding, fresh.understanding, { styles: this.frame.understanding.styles });
    this.frame.understanding.styles.fill(0); this.frame.understanding.styles[0] = 1;
    for (const key of ['proposed', 'confirmed', 'refuted', 'expired', 'brier', 'error', 'lead'] as const) this.frame.stats[key].fill(0);
    Object.assign(this.frame.stats, { missedBeats: 0, surprises: 0, stateChanges: 0, releases: 0, releasesUnannounced: 0, experienceDrops: 0, experienceDropsOff: 0, experienceDropsUnheard: 0, dropOffset: 0 });
    Object.assign(this.frame.diagnostics, { hops: 0, updateMicros: 0, bars: 0, beats: 0, fallback: 'no grid yet', memoryBytes: bytes });
    this.frame.time = 0; this.frame.enabled = enabled; this.frame.leads = false;
    this.grouping.beats = this.grouping.offset = this.grouping.confidence = 0; this.source = NONE;
    this.last = null; this.now = this.freeNext = this.freeIndex = 0; this.quietSince = this.recoverFrom = -1; this.soundSeen = this.interrupted = false;
    this.silentFor = this.withoutLow = this.lowFor = 0; this.backAt = -Infinity; this.lowBackAt = -1; this.lowAttackAt = -Infinity; this.recentTension = 0;
    this.lastRelease = this.lastSection = -Infinity; this.sectionDrop = false; this.nextReasoning = this.nextStyle = 0; this.reasonedAt = -1;
    this.pendingBoundary = 0; this.lastStrongBar = -1; this.phraseConfirmedAt = -Infinity; this.beatSeen = false; this.settledSeen = 0; this.extended = false; this.pendingDrop = -1;
    this.input.releaseAge = this.input.sectionAge = Infinity;
  }

  /**
   * The capture stopped delivering (a gap in the analysis): the grid is lost and what rested on it is withdrawn; what
   * was learned of the track (memory, style) stays, as the calibration's does.
   */
  interrupt(): void {
    this.clock.interrupt(); this.ledger.withdraw();
    this.interrupted = true; this.recoverFrom = -1; this.lowBackAt = -1; this.withoutLow = 0;
  }

  onset(o: Readonly<OnsetEvent>): void {
    if (!this.config.enabled) return;
    this.clock.onset(o);
    // A low attack just as the low end comes back after seconds without it (see releaseEvidence): the release, heard.
    if (o.low >= 0.5 && o.strength >= 0.35) {
      this.lowAttackAt = o.time;
      if (this.lowBackAt >= 0 && o.time >= this.lowBackAt - ATTACK_BEFORE && o.time <= this.lowBackAt + RELEASE_WINDOW && (this.last?.loudnessPosition ?? 0) >= 0.5) this.heardRelease(o.time);
    }
    // A marked downbeat confirms the one expected there.
    const p = this.ledger.open('downbeat');
    if (p && o.low * o.strength >= 0.3) this.ledger.observe('downbeat', o.time, this.now);
  }

  beat(b: Readonly<BeatEvent>): void {
    if (!this.config.enabled) return;
    const clock = this.clock, memory = this.memory;
    // The beat that just ended is closed in the memory under the count it had.
    if (clock.grid && clock.beatCount >= 0) {
      const before = memory.reading.boundaryBar, start = clock.lastBeat;
      memory.closeBeat(clock.beatCount, start, false);
      if (memory.reading.boundaryBar !== before && memory.reading.boundaryBar >= 0) this.boundary(memory.reading.boundary, start, memory.reading.boundaryBar);
      if (memory.reading.patternBreak > 0) {
        // A pattern that breaks where a phrase was expected to begin is the music doing what was expected.
        const expected = memory.reading.breakTime - this.phraseConfirmedAt <= 1.5 * this.barSeconds();
        if (!expected) this.surprise('patternBreak', memory.reading.patternBreak / 0.6, memory.reading.repetition, memory.reading.breakTime);
        memory.reading.patternBreak = 0;
      }
    }
    clock.beat(b);
    if (clock.anchoredNow) {
      memory.reanchor(); this.source = NONE; this.grouping.beats = this.grouping.offset = this.grouping.confidence = 0; this.lastStrongBar = -1;
      this.ledger.withdraw('downbeat'); this.ledger.withdraw('phrase'); this.ledger.withdraw('transition');
    }
    this.group(b);
    this.beatSeen = true;
  }

  section(e: Readonly<SectionEvent>): void {
    if (!this.config.enabled) return;
    this.lastSection = e.time; this.sectionDrop = e.kind === 2;
    // The DSP decided a drop section: the low end came back with a jump in energy (native/analysis/src/structure.rs).
    if (this.sectionDrop) this.heardRelease(e.time);
    this.ledger.observe('transition', e.time, this.now);
  }

  /** The experience engine's own `drop` (unchanged, docs/music-response.md §2.4): compared with the releases heard. */
  experienceDrop(time: number): void {
    if (!this.config.enabled) return;
    const s = this.frame.stats;
    s.experienceDrops++;
    if (Math.abs(time - this.lastRelease) <= DROP_MATCH) this.compareDrop(time - this.lastRelease);
    else this.pendingDrop = time;
  }

  /** One analysis hop, after the experience engine has read it (`context` is its state). */
  hop(a: Readonly<AnalysisFrame>, context: Readonly<CognitionContext>, dt: number): void {
    const f = this.frame;
    if (!this.config.enabled) { if (!this.disabled) this.disable(); return; }
    if (this.disabled) { this.disabled = false; this.reset(); }
    const start = this.config.profile ? performance.now() : 0;
    this.last = a; this.now = a.time; f.time = a.time; f.enabled = true;
    const now = a.time, u = f.understanding;
    const low = lowShare(a);
    this.memory.hop(a, low);
    this.clock.hop(a);
    if (!this.clock.grid) {
      // No grid: the memory still slices the sound, without bars.
      if (now >= this.freeNext) { this.freeNext = now + FREE_BEAT; this.memory.closeBeat(this.freeIndex++, now, true); }
    } else this.freeNext = now + FREE_BEAT;
    const quiet = this.silence(a, dt);
    this.releaseEvidence(a, low, quiet, dt);
    this.recentTension = Math.max(u.tension, this.recentTension * Math.exp(-dt / 4));
    // What the clock noticed: an absence, an accent off its beat, a change of tempo.
    const e = this.clock.event;
    if (e.kind !== 'none') {
      if (e.kind === 'missedBeat') f.stats.missedBeats++;
      this.surprise(e.kind, e.size, e.confidence, e.time);
      this.clock.clearEvent();
    }
    this.phrase();
    this.beats(now, a);
    if (this.beatSeen) this.forecast(now);
    this.expire(now);
    const lowBudget = this.config.budget === 'low';
    if (this.beatSeen || (!lowBudget && now >= this.nextReasoning) || (quiet !== this.input.quiet)) this.reason(a, context, now, quiet);
    if (now >= this.nextStyle) this.blend(a, quiet, lowBudget ? 2 : 0.5);
    this.beatSeen = false;
    u.surprise *= Math.exp(-dt / SURPRISE_TAU);
    u.expectation = this.ledger.expectation(now, HORIZON);
    if (this.pendingDrop >= 0 && now - this.pendingDrop > DROP_MATCH) { f.stats.experienceDropsUnheard++; this.pendingDrop = -1; }
    this.lead(now);
    const d = f.diagnostics;
    d.hops++; d.bars = this.memory.reading.bars; d.beats = this.memory.reading.beats;
    if (this.config.profile) d.updateMicros += ((performance.now() - start) * 1000 - d.updateMicros) * 0.05;
  }

  // ---- observations --------------------------------------------------------------------------

  /** Quiet, pause, silence, no signal, lost source. Returns whether there is no sound now. */
  private silence(a: Readonly<AnalysisFrame>, dt: number): boolean {
    const u = this.frame.understanding, presence = a.silent ? 0 : a.presence, quiet = presence < 0.06, now = a.time;
    if (quiet) {
      if (this.quietSince < 0) {
        this.quietSince = now;
        // The music stopped under a confident pulse it was marking: a pause is noticed only against an expectation of more.
        const expected = u.pulse * this.frame.clock.support;
        if (expected >= 0.5) this.surprise('pause', 1, expected, now);
      }
      this.silentFor += dt;
    } else {
      if (this.silentFor >= SILENCE_FORGETS) this.backAt = now;
      this.quietSince = -1; this.soundSeen = true; this.silentFor = 0;
      // After a lost source the state says so for a moment of sound, not only on the hop that came back.
      if (this.interrupted) { if (this.recoverFrom < 0) this.recoverFrom = now; else if (now - this.recoverFrom >= 0.5) { this.interrupted = false; this.recoverFrom = -1; } }
    }
    const quietFor = this.quietSince >= 0 ? now - this.quietSince : 0;
    u.silence = this.interrupted ? 'sourceLost' : !quiet ? 'none' : !this.soundSeen || quietFor >= NO_SIGNAL ? 'noSignal' : quietFor >= PAUSE ? 'silence' : 'pause';
    u.silenceSeconds = quietFor;
    return quiet || this.interrupted;
  }

  /**
   * The release, heard — never from expectation alone: after seconds of sound without low end, under tension (or after
   * a breakdown), the low end comes back to most of what is heard, the level with it, and a low attack marks the moment
   * (at most a moment before the low end is back, or within a third of a second after). It is dated at that attack.
   */
  private releaseEvidence(a: Readonly<AnalysisFrame>, low: number, quiet: boolean, dt: number): void {
    const now = a.time;
    if (quiet) { if (this.silentFor >= SILENCE_FORGETS) this.withoutLow = 0; this.lowBackAt = -1; }
    else if (low < 0.3) { this.withoutLow += dt; this.lowFor = 0; this.lowBackAt = -1; }
    else if (low >= 0.5) {
      const pressure = Math.max(this.recentTension, this.frame.understanding.breakdown);
      if (low >= 0.7 && this.lowBackAt < 0 && this.withoutLow >= WITHOUT_LOW && pressure >= 0.3 && a.loudnessPosition >= 0.5) {
        this.lowBackAt = now;
        if (this.lowAttackAt >= now - ATTACK_BEFORE - 0.02) this.heardRelease(this.lowAttackAt);
      }
      this.lowFor += dt;
      // The floor has been there for a while: the time without it is over.
      if (this.lowFor >= 0.5) this.withoutLow = 0;
    }
    if (this.lowBackAt >= 0 && now > this.lowBackAt + RELEASE_WINDOW) this.lowBackAt = -1;
  }

  private heardRelease(time: number): void {
    this.lowBackAt = -1;
    if (time - this.lastRelease < RELEASE_GAP) return;
    const s = this.frame.stats, now = this.now;
    this.lastRelease = time; s.releases++; this.withoutLow = 0; this.extended = false;
    this.onRelease?.(time);
    const open = this.ledger.open('release');
    if (!(open && this.ledger.observe('release', time, now))) {
      // Not when (or not as) it was expected: the expectation was wrong, and the release was not announced.
      if (open) this.ledger.refute('release', now);
      s.releasesUnannounced++;
      this.surprise('unannouncedRelease', 1 - this.frame.understanding.expectation, 0.7, time);
    }
    this.ledger.observe('transition', time, now);
    this.recentTension = 0;
    if (this.pendingDrop >= 0 && time - this.pendingDrop <= DROP_MATCH) { this.compareDrop(this.pendingDrop - time); this.pendingDrop = -1; }
  }

  private compareDrop(offset: number): void {
    const s = this.frame.stats;
    s.dropOffset = offset;
    if (Math.abs(offset) > 0.5) s.experienceDropsOff++;
  }

  /** A downbeat's boundary strength, computed one beat after it (`time` is the downbeat's). */
  private boundary(strength: number, time: number, bar: number): void {
    const now = this.now, c = this.frame.clock;
    this.pendingBoundary = Math.max(this.pendingBoundary, strength);
    if (strength >= 0.2) this.ledger.observe('downbeat', time, now);
    const phrase = this.ledger.open('phrase');
    if (phrase && strength >= 0.3 && time >= phrase.early && time <= phrase.late) { this.ledger.observe('phrase', time, now); this.phraseConfirmedAt = time; }
    else if (strength >= 0.5 && c.phraseConfidence >= 0.4 && c.phraseBar !== 0) {
      // A change where the phrase grid did not put one: the grid was wrong, or the music broke it.
      if (phrase && Math.abs(time - phrase.time) >= 0.75 * this.barSeconds()) this.ledger.refute('phrase', now);
      this.surprise('offPhraseChange', strength, c.phraseConfidence, time);
    }
    if (strength >= 0.5) { this.ledger.observe('transition', time, now); this.lastStrongBar = bar; }
  }

  /** Beats the clock settled: the beat prediction is confirmed by an onset on it, refuted by music that did not mark it. */
  private beats(now: number, a: Readonly<AnalysisFrame>): void {
    const settled = this.clock.settled;
    if (settled.count === this.settledSeen) return;
    this.settledSeen = settled.count;
    const p = this.ledger.open('beat');
    if (!p || Math.abs(settled.time - p.time) > 0.5 * (this.frame.clock.period || 0.5)) return;
    if (settled.matched) this.ledger.observe('beat', settled.onset, now);
    else if (!a.silent && a.presence > 0.3) this.ledger.refute('beat', now);
  }

  // ---- interpretation ------------------------------------------------------------------------

  private reason(a: Readonly<AnalysisFrame>, context: Readonly<CognitionContext>, now: number, quiet: boolean): void {
    const x = this.input, u = this.frame.understanding;
    x.dt = this.reasonedAt >= 0 ? Math.max(0, now - this.reasonedAt) : 0;
    x.time = now; x.presence = a.silent ? 0 : a.presence; x.quiet = quiet;
    // Music coming back after a silence rises for a few seconds: the experience reads that as a build (docs/music-response.md
    // §2.5); here its evidence counts again only once the music has been back a while.
    x.anticipation = context.anticipation * unit((now - this.backAt - 1) / REENTRY); x.anticipationConfidence = context.anticipationConfidence;
    x.releaseAge = now - this.lastRelease; x.sectionAge = now - this.lastSection; x.sectionDrop = this.sectionDrop;
    x.boundary = this.pendingBoundary; x.barSeconds = this.barSeconds(); x.buildResolves = this.style.priors.buildResolves;
    if (this.interpreter.update(u, this.frame.clock, this.memory.reading, x)) this.frame.stats.stateChanges++;
    this.pendingBoundary = 0; this.reasonedAt = now; this.nextReasoning = now + REASONING_INTERVAL;
  }

  private blend(a: Readonly<AnalysisFrame>, quiet: boolean, interval: number): void {
    const c = this.frame.clock, u = this.frame.understanding, e = this.evidence;
    const hearing = this.config.style && !quiet && (c.state === 'locked' || a.onsetDensity < 1);
    if (hearing) { e.bpm = c.state === 'locked' ? c.bpm : 0; e.regularity = c.confidence; e.percussive = a.percussiveShare; e.density = a.onsetDensity; e.low = this.memory.reading.low; }
    this.style.update(hearing ? e : null, interval);
    if (!this.config.style) this.style.reset();
    u.style = this.style.leading; u.styleConfidence = this.style.confidence; u.styles.set(this.style.weights);
    this.memory.priors = this.style.priors.phrase;
    this.clock.halfTimePrior = this.style.priors.halfTime;
    this.memory.windowBars = Math.max(8, Math.min(64, Math.round(this.config.memorySeconds / this.barSeconds())));
    this.nextStyle = this.now + interval;
  }

  /** Beats per bar and where the bar starts, from the best witness: the tracker's meter or accents, or the memory's changes. */
  private group(b: Readonly<BeatEvent>): void {
    const a = this.last, count = this.clock.beatCount, g = this.grouping, k = this.candidate;
    k.beats = k.offset = k.confidence = 0; this.offered = NONE;
    // The tracker's grouping only once it publishes a meter: its bar positions without one assume four beats.
    if (a && a.meter >= 3 && a.meterConfidence >= 0.2) this.offer(METER, a.meter, mod(count - b.barPosition, a.meter), (a.meterConfidence + a.downbeatConfidence) / 2);
    const m = this.memory.grouping;
    if (m.beats > 0) this.offer(CHANGES, m.beats, m.offset, m.confidence);
    const source = this.offered, moved = source !== NONE && (k.beats !== g.beats || k.offset !== g.offset);
    if (source !== NONE) { g.beats = k.beats; g.offset = k.offset; g.confidence = k.confidence; this.source = source; }
    else g.confidence *= 0.9;
    if (moved) { this.ledger.withdraw('downbeat'); this.ledger.withdraw('phrase'); this.ledger.withdraw('transition'); }
    this.clock.setGrouping(g);
    this.memory.setBars(g.beats > 0 ? g.beats : 4, g.beats > 0 ? g.offset : 0, g.beats > 0 && g.confidence >= 0.25);
  }

  /** A witness of the grouping: kept if it is the one followed, else taken only when clearly more sure. */
  private offer(from: number, beats: number, offset: number, confidence: number): void {
    const k = this.candidate, margin = from === this.source || this.source === NONE ? 0 : 0.1;
    if (confidence > k.confidence + margin || (from === this.source && confidence >= k.confidence - 0.1)) {
      k.beats = beats; k.offset = offset; k.confidence = confidence; this.offered = from;
    }
  }

  /** The phrase position as the memory's posterior has it, shown only with downbeats, a grid, and an unambiguous tempo. */
  private phrase(): void {
    const c = this.frame.clock, m = this.memory.reading;
    const bar = c.barPosition >= 0 && c.beat >= 0 ? this.memory.barOf(Math.floor(c.beat)) : -1;
    if (m.phraseBars > 0 && bar >= 0) {
      const confidence = m.phraseConfidence * unit(c.downbeatConfidence / 0.5) * (1 - 0.5 * c.ambiguity) * unit(c.confidence / 0.35);
      const position = mod(bar - m.phraseOffset, m.phraseBars);
      c.phraseBars = m.phraseBars; c.phraseConfidence = confidence;
      c.phraseBar = confidence >= 0.3 ? position : -1;
      c.nextPhrase = confidence >= 0.3 && c.nextDownbeat > 0 ? c.nextDownbeat + (m.phraseBars - position - 1) * c.meter * c.period : 0;
    } else { c.phraseBars = 0; c.phraseBar = -1; c.phraseConfidence = 0; c.nextPhrase = 0; }
  }

  // ---- predictions ---------------------------------------------------------------------------

  /** What to expect next, re-estimated at every beat. A prediction whose moment has come is left to be resolved. */
  private forecast(now: number): void {
    const c = this.frame.clock, u = this.frame.understanding, period = c.period || 0.5, L = this.ledger;
    const grid = c.state === 'locked' || c.state === 'coasting';
    if (grid && c.nextBeat > now && !this.due('beat', now)) {
      const w = Math.min(0.07, 0.15 * period);
      L.propose('beat', now, c.nextBeat, c.nextBeat - w, c.nextBeat + w, c.confidence * (0.5 + 0.5 * c.support), 'grid', c.nextBeat + w + 0.15);
    }
    if (grid && c.barPosition >= 0 && c.nextDownbeat > now && !this.due('downbeat', now)) {
      const w = Math.min(0.07, 0.15 * period);
      L.propose('downbeat', now, c.nextDownbeat, c.nextDownbeat - w, c.nextDownbeat + w, c.downbeatConfidence, 'grouping', c.nextDownbeat + period + 0.15);
    }
    const phrased = grid && c.phraseConfidence >= 0.3 && c.nextPhrase > now;
    if (phrased && !this.due('phrase', now)) L.propose('phrase', now, c.nextPhrase, c.nextPhrase - period, c.nextPhrase + period, c.phraseConfidence, 'phrase grid', c.nextPhrase + period + 0.15);
    // A change at the next boundary: the loop has lasted as long as this music lets one last, or tension asks for it.
    const bar = c.barPosition >= 0 && c.beat >= 0 ? this.memory.barOf(Math.floor(c.beat)) : -1;
    const run = this.lastStrongBar >= 0 && bar >= 0 ? bar - this.lastStrongBar : 0;
    const due = unit(run / Math.max(4, this.style.priors.repetition));
    const change = Math.max(due * u.repetition, u.tension);
    if (phrased && c.phraseConfidence >= 0.45 && change >= 0.45 && !this.due('transition', now)) {
      L.propose('transition', now, c.nextPhrase, c.nextPhrase - period, c.nextPhrase + period, c.phraseConfidence * change, u.tension >= due * u.repetition ? 'tension at a phrase end' : 'pattern has lasted', c.nextPhrase + period + 0.15);
    }
    // The release, where the tension points: the next phrase boundary if there is a grid of phrases, else a wide window.
    const open = L.open('release');
    if (u.tension >= 0.4 && u.tensionConfidence >= 0.3 && !(open && now > open.time)) {
      const resolves = 0.5 + 0.5 * this.style.priors.buildResolves;
      if (phrased) {
        const confidence = unit(u.tension * u.tensionConfidence * resolves * (0.6 + 0.4 * c.phraseConfidence) * 1.6);
        L.propose('release', now, c.nextPhrase, c.nextPhrase - period, c.nextPhrase + 2 * period, confidence, 'tension towards a phrase boundary', c.nextPhrase + 2 * period);
      } else {
        // A window that opens where the expectation began and reaches the horizon: re-estimating it does not move its start.
        const confidence = unit(u.tension * u.tensionConfidence * resolves * 0.6 * 1.6), from = open && !open.evidence.startsWith('tension towards') ? open.early : now;
        L.propose('release', now, now + HORIZON / 2, from, now + HORIZON, confidence, 'tension, no phrase grid', now + HORIZON);
      }
    }
  }

  /** A prediction whose moment has come waits for its observation: it is not moved on to the next one. */
  private due(kind: PredictionKind, now: number): boolean {
    const p = this.ledger.open(kind);
    return p !== null && now > p.time;
  }

  /** The kind-specific endings, before the ledger expires what has outlived its horizon. */
  private expire(now: number): void {
    const u = this.frame.understanding, c = this.frame.clock, L = this.ledger;
    const release = L.open('release');
    if (release) {
      if (u.tension < 0.12 && this.recentTension < 0.2) L.refute('release', now);
      else if (now > release.late && !this.extended && u.tension >= 0.35 && c.phraseConfidence >= 0.3 && c.nextPhrase > now) {
        // The boundary passed with the tension still rising: a longer build, expected at the next one (once).
        this.extended = true;
        L.propose('release', now, c.nextPhrase, c.nextPhrase - c.period, c.nextPhrase + 2 * c.period, release.confidence * 0.8, 'tension still rising past the boundary', c.nextPhrase + 2 * c.period);
      }
    }
    if (c.state === 'none' || c.state === 'lost') { L.withdraw('beat'); L.withdraw('downbeat'); L.withdraw('phrase'); L.withdraw('transition'); }
    const expired = L.tick(now);
    if (expired && expired.kind === 'transition' && expired.confidence >= 0.5) this.surprise('phraseProlonged', 0.5, expired.confidence, now);
    if (expired && expired.kind === 'release') this.extended = false;
  }

  private surprise(kind: SurpriseKind, size: number, confidence: number, time: number): void {
    const u = this.frame.understanding, value = unit(size) * unit(confidence);
    if (value < 0.05) return;
    if (value >= u.surprise) { u.surprise = value; u.surpriseConfidence = unit(confidence); u.surpriseKind = kind; u.surpriseAt = time; }
    if (value >= 0.2) this.frame.stats.surprises++;
  }

  /** Whether the director follows the cognition now, and why not. */
  private lead(now: number): void {
    const f = this.frame, c = f.clock;
    f.leads = this.config.direct && c.phraseConfidence >= LEAD_CONFIDENCE && c.nextPhrase > now;
    f.diagnostics.fallback = f.leads ? '' : !this.config.direct ? 'direction by cognition off' : c.state === 'none' || c.state === 'lost' ? 'no grid'
      : c.barPosition < 0 ? 'no downbeat evidence' : c.phraseBars === 0 ? 'no phrase structure yet' : 'phrase grid not confident';
  }

  private barSeconds(): number {
    const c = this.frame.clock;
    return c.period > 0 ? (c.meter || 4) * c.period : 2;
  }

  private disable(): void {
    this.reset();
    this.disabled = true;
    const f = this.frame;
    f.enabled = false; f.leads = false; f.diagnostics.fallback = 'cognition disabled';
    f.understanding.reason = 'cognition disabled';
  }
}
