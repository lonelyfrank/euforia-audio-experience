import type { AnalysisFrame, BeatEvent, OnsetEvent } from '../../audio/features/decode';
import { tempoPrior } from './knowledge';
import type { ClockFrame } from './types';

/*
 * The musical clock. The beat grid is the DSP's (the phase-locked loop of native/analysis/src/beat.rs, its tempo
 * estimate and its accent hypotheses): nothing here tracks beats a second time. What this adds is what a listener
 * keeps and the tracker does not say:
 *
 * - a state: is there a pulse, is it confirmed, is it being carried through a gap, has it been lost;
 * - continuity: through a short pause the grid is carried (coasting) with a confidence that falls; when beats come
 *   back on that grid the count of beats and bars goes on, otherwise the clock re-anchors and forgets the bar. It never
 *   coasts longer than two bars or four seconds: a clock does not run on without a signal;
 * - verification: each predicted beat is checked against the onsets around it (support, sync error, jitter); a beat
 *   the music used to mark and did not is reported as an absence;
 * - octave: whether the pulse may be felt at half or twice the tracked tempo, as a plausibility from the low-end
 *   accents (on the beats, between them, on alternate beats) and the tempo prior; the tracker's choice is not changed;
 * - grouping: beats per bar and where the bar starts, only from evidence (the tracker's accents, or the structural
 *   memory's changes); with neither, bar positions stay unknown rather than an assumed 4/4.
 *
 * Musical time (`beat`, `bar`) is apart from the capture clock (`nextBeat`, all event times) and from render time (the
 * snapshot's clock is advanced to the heard moment by `presentClock`). Allocation-free after construction.
 */

/** Grid confidence and supported beats before the clock calls itself locked. */
const LOCK = 0.35;
const LOCK_BEATS = 4;
/** Below this the tracker's grid is freewheeling (no onsets support it): the clock coasts. */
const SUPPORTED = 0.15;
/** Downbeat and grouping confidence before bar positions are shown at all. */
export const DOWNBEAT = 0.3;
const GROUPING = 0.25;
/** The longest the grid is carried without support: beats, seconds; and how fast its confidence falls meanwhile (s). */
const COAST_BEATS = 8;
const COAST_SECONDS = 4;
const COAST_TAU = 1.5;
/** An onset within this fraction of the period (and at most MATCH_MAX s) of a beat confirms it. */
const MATCH = 0.15;
const MATCH_MAX = 0.07;
/** Beats that come back within this fraction of the period of the carried grid, at a tempo within TEMPO_KEPT, continue it. */
const CONTINUITY = 0.2;
const TEMPO_KEPT = 0.05;
/** Phase window of an onset on a beat / halfway between two. */
const ON_BEAT = 0.12;
/** Exponential weights per event of the running statistics. */
const ONSET_RATE = 0.1;
const BEAT_RATE = 0.2;
/** A tempo this far (relative) from its slow average is a change. */
const TEMPO_CHANGE = 0.05;
const PENDING = 8;
/** Onsets on the beats before the octave is judged. */
const OCTAVE_ONSETS = 12;
/** An onset is a low-end attack (it counts for the octave) from this low-region share. */
const LOW_ATTACK = 0.3;
const ONSETS = 16;

export interface ClockEvent {
  /** What the last call observed: an absence (a beat the music used to mark), an accent off its beat, a change of tempo. */
  kind: 'none' | 'missedBeat' | 'earlyAccent' | 'lateAccent' | 'tempoChange';
  time: number;
  /** 0..1: how much was expected (absence), how far off (accent), how large (tempo). */
  size: number;
  /** The confidence of the expectation it departs from. */
  confidence: number;
}

/** Beats per bar and where the bar begins: `offset` is a musical beat index that is a downbeat. */
export interface Grouping { beats: number; offset: number; confidence: number }

export class MusicalClock {
  readonly frame: ClockFrame;
  /** What happened at the last beat / onset / hop that a listener would notice (read, then overwritten). */
  readonly event: ClockEvent = { kind: 'none', time: 0, size: 0, confidence: 0 };
  /** The last predicted beat settled: how many so far, its time, whether an onset confirmed it and when that onset came. */
  readonly settled = { count: 0, time: 0, matched: false, onset: 0 };
  /** Integer beats since the anchor at the last beat event, and that beat's capture time. */
  beatCount = -1;
  lastBeat = 0;
  /** True on the beat call that re-anchored (the bar and phrase counts restart). */
  anchoredNow = false;
  private period = 0;
  private anchored = false;
  private everLocked = false;
  private supportedBeats = 0;
  private coastFrom = 0;
  private held = 0;
  private relockFrom = 0;
  private wasCoasting = false;
  /** Anchors so far, and the anchor the grid was carried from: a regain on the same one continues the count. */
  private epoch = 0;
  private coastEpoch = -1;
  private grouping: Grouping = { beats: 0, offset: 0, confidence: 0 };
  // Beats waiting for their onsets: capture time and whether one confirmed it.
  private readonly pendingTime = new Float64Array(PENDING);
  private readonly pendingMatched = new Uint8Array(PENDING);
  private readonly pendingOnset = new Float64Array(PENDING);
  private pendingCount = 0;
  private readonly onsetTime = new Float64Array(ONSETS);
  private readonly onsetStrength = new Float32Array(ONSETS);
  private onsetHead = 0;
  // Running statistics.
  private meanError = 0;
  private absError = 0;
  private spread = 0;
  private onLow = 0;
  /** Onsets seen on the beats since the grid was anchored: the octave is judged on enough of them. */
  private onBeats = 0;
  private halfLow = 0;
  private evenLow = 0;
  private oddLow = 0;
  private drift = 0;
  private slowBpm = 0;
  private lastTempoChange = -Infinity;
  private presence = 0;
  /** The style's prior that the pulse is felt in half (knowledge.ts), set by the cognition. */
  halfTimePrior = 0.1;

  constructor(frame: ClockFrame) { this.frame = frame; }

  /** Typed memory held (bytes), for the diagnostics. */
  static readonly bytes = PENDING * (8 + 1 + 8) + ONSETS * (8 + 4);

  reset(): void {
    const f = this.frame;
    Object.assign(f, {
      state: 'none', bpm: 0, period: 0, confidence: 0, beatPhase: 0, nextBeat: 0, beat: -1, meter: 0, meterConfidence: 0, downbeatConfidence: 0,
      barPosition: -1, barPhase: -1, bar: -1, nextDownbeat: 0, phraseBars: 0, phraseBar: -1, phraseConfidence: 0, nextPhrase: 0,
      stability: 0, syncErrorMs: 0, jitterMs: 0, support: 0, halfTime: 0, doubleTime: 0, ambiguity: 0, coastAge: 0, losses: 0, relocks: 0, continuations: 0, relockSeconds: 0,
    } satisfies ClockFrame);
    this.beatCount = -1; this.lastBeat = 0; this.anchoredNow = false; this.period = 0; this.anchored = this.everLocked = this.wasCoasting = false;
    this.supportedBeats = 0; this.coastFrom = this.held = this.relockFrom = 0; this.epoch = 0; this.coastEpoch = -1;
    this.grouping.beats = this.grouping.offset = this.grouping.confidence = 0;
    this.settled.count = this.settled.time = this.settled.onset = 0; this.settled.matched = false;
    this.pendingCount = 0; this.onsetHead = 0; this.onsetTime.fill(-Infinity); this.onsetStrength.fill(0);
    this.meanError = this.absError = this.spread = this.onLow = this.halfLow = this.evenLow = this.oddLow = this.drift = this.slowBpm = this.presence = this.onBeats = 0;
    this.lastTempoChange = -Infinity;
    this.clearEvent();
  }

  /** The capture stopped delivering: the grid is lost now (it cannot be carried over what was never heard). */
  interrupt(): void {
    if (this.anchored) this.lose();
    this.pendingCount = 0;
  }

  /** Whether a grid is anchored (beats are counted). */
  get grid(): boolean { return this.anchored; }

  /** Beats per bar and the bar's start as the evidence has them (see MusicalCognition): bar positions are only shown with one. */
  setGrouping(g: Readonly<Grouping>): void { Object.assign(this.grouping, g); }

  /** A beat of the DSP's grid, in stream order. */
  beat(b: Readonly<BeatEvent>): void {
    this.anchoredNow = false;
    const period = b.bpm > 0 ? 60 / b.bpm : this.period;
    if (!(period > 0) || !Number.isFinite(b.time)) return;
    const f = this.frame;
    if (!this.anchored) this.anchor(b.time);
    else {
      // Where this beat falls on the grid carried so far: a whole number of periods on (the same grid), or not.
      const k = Math.round((b.time - this.lastBeat) / this.period);
      const error = b.time - (this.lastBeat + k * this.period);
      const sameTempo = Math.abs(period / this.period - 1) <= TEMPO_KEPT;
      if (k >= 1 && Math.abs(error) <= CONTINUITY * this.period && sameTempo) {
        this.beatCount += k;
      } else if (k < 1) return; // The tracker moved its own grid (half a beat): the next beat says where it is.
      else this.anchor(b.time);
    }
    if (this.wasCoasting || f.state === 'lost') { this.relockFrom ||= b.time; }
    // Tempo: its drift, and a change worth noticing.
    const bpm = 60 / period;
    if (f.bpm > 0) this.drift += (Math.abs(bpm - f.bpm) / bpm - this.drift) * BEAT_RATE;
    this.slowBpm = this.slowBpm > 0 ? this.slowBpm + (bpm - this.slowBpm) * 0.05 : bpm;
    if (f.state === 'locked' && Math.abs(bpm / this.slowBpm - 1) > TEMPO_CHANGE && b.time - this.lastTempoChange > 4) {
      this.lastTempoChange = b.time; this.slowBpm = bpm;
      this.emit('tempoChange', b.time, Math.min(1, Math.abs(bpm / f.bpm - 1) * 5), f.confidence);
    }
    this.period = period; this.lastBeat = b.time; f.bpm = bpm; f.period = period;
    // Wait for the onsets that may confirm it (an onset can be reported a little after its beat).
    if (this.pendingCount === PENDING) this.finalize(false);
    const i = this.pendingCount++;
    this.pendingTime[i] = b.time; this.pendingMatched[i] = 0; this.pendingOnset[i] = 0;
    // Onsets already heard around it.
    for (let k = 0; k < ONSETS; k++) {
      if (this.onsetStrength[k] >= 0.3 && Math.abs(this.onsetTime[k] - b.time) <= this.window()) { this.pendingMatched[i] = 1; this.pendingOnset[i] = this.onsetTime[k]; break; }
    }
  }

  /** An onset, in stream order: it may confirm a beat, and it says where the low-end accents fall. */
  onset(o: Readonly<OnsetEvent>): void {
    if (!Number.isFinite(o.time)) return;
    this.onsetTime[this.onsetHead] = o.time; this.onsetStrength[this.onsetHead] = o.strength;
    this.onsetHead = (this.onsetHead + 1) % ONSETS;
    if (!this.anchored || !(this.period > 0)) return;
    const window = this.window();
    let matched = -1;
    for (let i = 0; i < this.pendingCount; i++) if (Math.abs(o.time - this.pendingTime[i]) <= window) { matched = i; break; }
    const accent = o.strength * o.low;
    const position = (o.time - this.lastBeat) / this.period, phase = ((position % 1) + 1) % 1;
    const f = this.frame;
    // Where the low-end attacks fall (kick, bass) decides how the pulse is felt; hats and snares say nothing of it.
    if (o.low < LOW_ATTACK) { /* not a low-end attack */ } else if (Math.min(phase, 1 - phase) <= ON_BEAT) {
      this.onBeats++;
      this.onLow += (accent - this.onLow) * ONSET_RATE;
      if (((this.beatCount + Math.round(position)) & 1) === 0) this.evenLow += (accent - this.evenLow) * ONSET_RATE;
      else this.oddLow += (accent - this.oddLow) * ONSET_RATE;
    } else if (Math.abs(phase - 0.5) <= ON_BEAT) this.halfLow += (accent - this.halfLow) * ONSET_RATE;
    // Only the first onset that marks a beat says when it fell (a roll's subdivisions after it are not a late beat).
    if (matched < 0 || o.strength < 0.3 || this.pendingMatched[matched] === 1) return;
    this.pendingMatched[matched] = 1; this.pendingOnset[matched] = o.time;
    const error = o.time - this.pendingTime[matched];
    this.meanError += (error - this.meanError) * ONSET_RATE;
    this.absError += (Math.abs(error) - this.absError) * ONSET_RATE;
    this.spread += (Math.abs(error - this.meanError) - this.spread) * ONSET_RATE;
    f.syncErrorMs = this.absError * 1000; f.jitterMs = this.spread * 1000;
    // A strong accent clearly off its beat, against a grid that holds: early or late.
    const off = Math.abs(error) - Math.max(0.025, 3 * this.spread);
    if (f.state === 'locked' && o.strength >= 0.5 && off > 0) this.emit(error < 0 ? 'earlyAccent' : 'lateAccent', o.time, Math.min(1, Math.abs(error) / (0.25 * this.period)), f.confidence);
  }

  /** One analysis hop: state, phase and positions as of `a.time`. */
  hop(a: Readonly<AnalysisFrame>): void {
    const f = this.frame, now = a.time;
    this.presence = a.silent ? 0 : a.presence;
    // Beats whose onsets can no longer arrive are settled.
    while (this.pendingCount > 0 && now - this.pendingTime[0] > this.window() + 0.03) this.finalize(true);
    const fresh = this.anchored && now - this.lastBeat <= 1.5 * this.period;
    const supported = fresh && a.beatBpm > 0 && a.beatConfidence >= SUPPORTED && this.presence > 0.06;
    if (supported) {
      if (this.wasCoasting || f.state === 'lost') this.relockFrom ||= now;
      // Back on the grid that was carried: the count of beats and bars goes on.
      if (this.wasCoasting && this.coastEpoch === this.epoch) f.continuations++;
      this.wasCoasting = false; this.coastFrom = 0; this.coastEpoch = -1;
      f.confidence = a.beatConfidence;
      const locked = a.beatConfidence >= LOCK && this.supportedBeats >= LOCK_BEATS;
      f.state = locked ? 'locked' : 'acquiring';
      if (locked) {
        this.everLocked = true;
        if (this.relockFrom > 0) { f.relocks++; f.relockSeconds = now - this.relockFrom; this.relockFrom = 0; }
      }
      f.beatPhase = a.beatPhase; f.nextBeat = a.nextBeatTime; f.coastAge = 0;
      this.held = f.confidence;
    } else if (this.anchored && (f.state === 'locked' || f.state === 'coasting' || (f.state === 'acquiring' && this.held >= LOCK))) {
      // No support: carry the grid, for a while.
      if (!this.wasCoasting) {
        this.wasCoasting = true; this.coastEpoch = this.epoch;
        this.coastFrom = Math.min(now, this.lastBeat + this.period); this.held = Math.max(this.held, f.confidence);
      }
      f.coastAge = Math.max(0, now - this.coastFrom);
      if (f.coastAge > Math.min(COAST_SECONDS, COAST_BEATS * this.period)) this.lose();
      else {
        f.state = 'coasting';
        f.confidence = this.held * Math.exp(-f.coastAge / COAST_TAU);
        const ahead = (now - this.lastBeat) / this.period;
        f.beatPhase = ((ahead % 1) + 1) % 1;
        f.nextBeat = this.lastBeat + Math.ceil(ahead + 1e-9) * this.period;
      }
    } else if (f.state === 'acquiring' && !fresh) {
      // A grid that never held is dropped as soon as its beats stop.
      this.anchored = false; f.state = this.everLocked ? 'lost' : 'none'; f.confidence = 0; this.supportedBeats = 0;
    }
    if (f.state === 'none' || f.state === 'lost') { this.clearPositions(); f.confidence = 0; }
    else this.positions(now);
    f.stability = this.anchored ? Math.max(0, 1 - this.drift * 25) : 0;
    this.octave();
  }

  /** Clears the last event once the cognition has read it. */
  clearEvent(): void { this.event.kind = 'none'; this.event.size = this.event.confidence = 0; }

  private window(): number { return Math.min(MATCH_MAX, MATCH * (this.period || 0.5)); }

  private anchor(time: number): void {
    this.anchored = true; this.anchoredNow = true; this.beatCount = 0; this.lastBeat = time; this.supportedBeats = 0; this.epoch++; this.onBeats = 0;
    this.pendingCount = 0;
  }

  private lose(): void {
    const f = this.frame;
    this.anchored = false; this.wasCoasting = false; this.coastFrom = 0; this.supportedBeats = 0; this.relockFrom = 0;
    if (f.state !== 'lost' && f.state !== 'none') f.losses++;
    f.state = this.everLocked ? 'lost' : 'none';
    f.confidence = 0; f.coastAge = 0;
    this.clearPositions();
  }

  /** Settles the oldest pending beat: support up or down, and an absence where onsets were expected. */
  private finalize(report: boolean): void {
    const f = this.frame, matched = this.pendingMatched[0] === 1, time = this.pendingTime[0];
    const before = f.support, settled = this.settled;
    settled.count++; settled.time = time; settled.matched = matched; settled.onset = this.pendingOnset[0];
    if (matched) { f.support += (1 - f.support) * BEAT_RATE; this.supportedBeats++; }
    else if (this.presence > 0.3) {
      f.support += (0 - f.support) * BEAT_RATE;
      // The music had marked its beats and this one it did not: noticed only against a grid that holds.
      if (report && f.state === 'locked' && before >= 0.7) this.emit('missedBeat', time, before, f.confidence);
    }
    this.pendingCount--;
    this.pendingTime.copyWithin(0, 1, this.pendingCount + 1);
    this.pendingMatched.copyWithin(0, 1, this.pendingCount + 1);
    this.pendingOnset.copyWithin(0, 1, this.pendingCount + 1);
  }

  private positions(now: number): void {
    const f = this.frame, g = this.grouping;
    const musical = this.beatCount + Math.max(0, (now - this.lastBeat) / this.period);
    f.beat = musical;
    const beats = g.beats, known = beats >= 3 && g.confidence >= GROUPING;
    f.meter = known ? beats : 0;
    f.meterConfidence = known ? g.confidence * Math.min(1, f.confidence / LOCK) : 0;
    f.downbeatConfidence = known ? f.meterConfidence : 0;
    if (known && f.downbeatConfidence >= DOWNBEAT) {
      const fromDownbeat = musical - g.offset;
      const inBar = ((fromDownbeat % beats) + beats) % beats;
      f.barPosition = Math.floor(inBar);
      f.barPhase = inBar / beats;
      f.bar = Math.floor(fromDownbeat / beats);
      f.nextDownbeat = f.nextBeat > 0 ? f.nextBeat + ((beats - 1 - f.barPosition) % beats) * this.period : 0;
    } else { f.barPosition = -1; f.barPhase = -1; f.bar = -1; f.nextDownbeat = 0; }
  }

  private clearPositions(): void {
    const f = this.frame;
    f.beat = -1; f.beatPhase = 0; f.nextBeat = 0; f.barPosition = -1; f.barPhase = -1; f.bar = -1; f.nextDownbeat = 0;
    f.meter = 0; f.meterConfidence = 0; f.downbeatConfidence = 0;
  }

  /** Half / double-time plausibility from where the low-end accents fall, weighed by how plausible each tempo is. */
  private octave(): void {
    const f = this.frame;
    if (!(f.bpm > 0) || this.onBeats < OCTAVE_ONSETS || this.onLow + this.halfLow < 0.02) { f.halfTime = f.doubleTime = f.ambiguity = 0; return; }
    const unit = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);
    const own = Math.max(0.05, tempoPrior(f.bpm));
    // The low end also hits halfway between the beats: the pulse may be twice as fast.
    const between = unit((this.halfLow / Math.max(0.02, this.onLow) - 0.35) / 0.45);
    f.doubleTime = between * unit(tempoPrior(f.bpm * 2) / own);
    // The low end hits much harder on alternate beats: the pulse may be half as fast.
    const strong = Math.max(this.evenLow, this.oddLow), weak = Math.min(this.evenLow, this.oddLow);
    const alternate = strong > 0.02 ? unit((1 - weak / strong - 0.3) / 0.4) : 0;
    f.halfTime = unit(alternate * unit(tempoPrior(f.bpm / 2) / own) + this.halfTimePrior * alternate * 0.5);
    f.ambiguity = Math.max(f.halfTime, f.doubleTime);
  }

  private emit(kind: ClockEvent['kind'], time: number, size: number, confidence: number): void {
    // The strongest of what happened since the cognition last read it.
    if (this.event.kind !== 'none' && this.event.size * this.event.confidence >= size * confidence) return;
    this.event.kind = kind; this.event.time = time; this.event.size = size; this.event.confidence = confidence;
  }
}
