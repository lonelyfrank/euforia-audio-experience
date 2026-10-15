import type { AnticipationFrame } from './Anticipation';
import type { CognitionFrame, MusicalState } from './cognition/types';
import type { AudioEvent, EventCursor, EventStream } from './EventStream';

/*
 * Musical cues: what the scenes' structural actions (a solid that forms, a structure that emerges from the ground, a
 * body that breaks) may act on. A semantic adapter over what the engine already has — the DSP's dated events, the
 * musical cognition's observations and predictions, the anticipation the world holds — never a second detector: no
 * FFT, no PCM, no envelope read for an event. It writes nothing into the world, the state or the event stream (the
 * Tunnel and every other scene see exactly what they saw before); it publishes a fixed-shape frame in the snapshot.
 *
 * Five things are kept apart, because acting on the wrong one is what makes a scene break on a drop that was not there:
 *
 *   anticipation   the world's charge (a build's evidence × confidence)          a level: may prepare, never acts
 *   prediction     a release the cognition expects, in a window                   `prepare` (predicted) / `withdraw` (refuted);
 *                  not in the seconds right after a release heard (SETTLE)
 *   observation    one measured event that stands out (an accent), a phrase       `accent` / `phrase` (observed)
 *   confirmation   a release heard: low end back after seconds without it,        `release` (confirmed)
 *                  under tension, with a low attack (MusicalCognition)
 *   execution      what a scene did with a cue                                     the consumer's own account
 *
 * The experience's own `drop` (docs/music-response.md §2.4–2.5: on synthetic signals ±2 s off the musical drop, and
 * false after a pause) is never a cue by itself: it is matched to a heard release (±DROP_MATCH) or counted unconfirmed.
 * A prediction never confirms anything: only a heard release is a release. An accent right after a silence is a
 * restart, not an accent. Allocation-free after construction.
 */

export const CUE_KINDS = ['accent', 'phrase', 'prepare', 'withdraw', 'release'] as const;
export type CueKind = typeof CUE_KINDS[number];
export const CUE_STATUS = ['observed', 'confirmed', 'predicted', 'refuted'] as const;
export type CueStatus = typeof CUE_STATUS[number];
/** The reading of the moment for whoever decides how much structure to build: a coarse grouping of the cognition's state. */
export const CUE_PHASES = ['unknown', 'silence', 'groove', 'rising', 'breakdown', 'release'] as const;
export type CuePhase = typeof CUE_PHASES[number];

export interface Cue {
  /** 0: an empty slot. Grows through the session; a consumer keeps the last one it has read. */
  seq: number;
  kind: CueKind;
  status: CueStatus;
  /** Capture time of what it refers to: the event, the release heard, or when a prediction was made or given up. */
  time: number;
  /** For a prediction: the release's expected time (0 otherwise). */
  expected: number;
  /** 0..1: how much it weighs (significance of an accent, what a release resolves, a prediction's confidence). */
  strength: number;
  confidence: number;
  /** The prediction a `prepare` / `withdraw` refers to (0: none). */
  ref: number;
}

export interface CueStats {
  accents: number;
  /** Accents not taken because they came right after a silence (a restart is not an accent). */
  restarts: number;
  phrases: number;
  prepared: number;
  withdrawn: number;
  releases: number;
  /** Experience `drop` events matched to a heard release, and those that were not (never a cue). */
  dropsMatched: number;
  dropsUnconfirmed: number;
}

export interface CuesFrame {
  time: number;
  /** Whether the cognition is running: without it nothing is confirmed or predicted, and only accents and phrases come. */
  live: boolean;
  phase: CuePhase;
  /** 0..1 levels: the world's anticipation (never confirms), the expectation of a release (open predictions × proximity). */
  anticipation: number;
  expectation: number;
  /** 0..1 dimensions of the cognition's reading: groove, tension, breakdown; and whether it is silent now. */
  groove: number;
  tension: number;
  breakdown: number;
  silent: boolean;
  /**
   * 0..1: how much the last bars repeat the bars one pattern back (the cognition's structural memory; 0 while no pattern
   * is known), and how steady its clock is. Readings, never events: what recurs and how steadily, not when.
   */
  repetition: number;
  stability: number;
  /** The newest cue's seq (0: none yet). */
  seq: number;
  /** The last CUE_SLOTS cues, slot `seq % CUE_SLOTS`. */
  cues: Cue[];
  stats: CueStats;
}

const unit = (x: number): number => Math.min(1, Math.max(0, x));

export const CUE_SLOTS = 16;
/** An accent stands out this far of the track's own (significance) with this confidence, at most this often (s). */
export const ACCENT_SIGNIFICANCE = 0.7;
const ACCENT_CONFIDENCE = 0.5;
const ACCENT_GAP = 0.25;
/** After a silence the first attacks are the music coming back, not accents (s). */
export const RESUME = 2;
/** A phrase boundary needs this much confidence. */
const PHRASE_CONFIDENCE = 0.5;
/** A release prediction prepares from this confidence, unless it was made this soon after a release heard (s): the tension has just resolved. */
const PREPARE_CONFIDENCE = 0.35;
export const SETTLE = 4;
/** An experience `drop` and a heard release this close are the same moment (s); a drop waits this long for one (s). */
export const DROP_MATCH = 0.5;
const DROP_WAIT = 3;
/** How far ahead an expected release counts (s): beyond, its proximity is 0. */
const HORIZON = 8;

const PHASE_OF: Record<MusicalState, CuePhase> = {
  unknown: 'unknown', establishingPulse: 'unknown', stableGroove: 'groove', developing: 'groove', transition: 'groove',
  risingTension: 'rising', breakdown: 'breakdown', release: 'release',
};

const createCue = (): Cue => ({ seq: 0, kind: 'accent', status: 'observed', time: 0, expected: 0, strength: 0, confidence: 0, ref: 0 });
const createStats = (): CueStats => ({ accents: 0, restarts: 0, phrases: 0, prepared: 0, withdrawn: 0, releases: 0, dropsMatched: 0, dropsUnconfirmed: 0 });

export const createCues = (): CuesFrame => ({
  time: 0, live: false, phase: 'unknown', anticipation: 0, expectation: 0, groove: 0, tension: 0, breakdown: 0, silent: true, repetition: 0, stability: 0,
  seq: 0, cues: Array.from({ length: CUE_SLOTS }, createCue), stats: createStats(),
});

export function copyCues(to: CuesFrame, from: Readonly<CuesFrame>): void {
  const { cues, stats } = to;
  Object.assign(to, from);
  to.cues = cues; to.stats = stats;
  for (let i = 0; i < CUE_SLOTS; i++) Object.assign(cues[i], from.cues[i]);
  Object.assign(stats, from.stats);
}

/**
 * The cues after `cursor` (a seq) in a frame, oldest first, without allocating; returns the new cursor. Cues older
 * than the ring holds are gone (a consumer reads every frame; cues are seconds apart).
 */
export function forEachCue(frame: Readonly<CuesFrame>, cursor: number, visit: (cue: Readonly<Cue>) => void): number {
  // A frame from another session (its seq went back) starts over.
  const from = frame.seq < cursor ? 0 : cursor;
  for (let seq = Math.max(from + 1, frame.seq - CUE_SLOTS + 1); seq <= frame.seq; seq++) {
    const cue = frame.cues[seq % CUE_SLOTS];
    if (cue.seq === seq) visit(cue);
  }
  return frame.seq;
}

export class MusicalCues {
  readonly frame: CuesFrame = createCues();
  private readonly cursor: EventCursor = { time: -Infinity, seq: 0 };
  private lastAccent = -Infinity;
  private silenceEnd = -Infinity;
  private lastRelease = 0;
  /** The release prediction prepared for (0: none) and an experience drop waiting for a release (−1: none). */
  private prepared = 0;
  private pendingDrop = -1;
  private readonly visit = (e: AudioEvent): void => this.event(e);

  /**
   * One hop, after the cognition and the anticipation: `now` is the hop's capture time. Reads the events the engine
   * pushed up to now, the cognition's frame and the anticipation's. Must not allocate.
   */
  hop(now: number, events: EventStream, cognition: Readonly<CognitionFrame>, anticipation: Readonly<AnticipationFrame>): void {
    const f = this.frame, u = cognition.understanding;
    f.time = now; f.live = cognition.enabled;
    events.forEachHeard(this.cursor, now, this.visit);

    // Confirmation: a release the cognition heard.
    const heard = cognition.enabled ? cognition.stats.lastRelease : 0;
    if (heard > 0 && heard !== this.lastRelease) {
      this.lastRelease = heard;
      // What it resolves: the tension that was there before, at least what an unannounced release is worth.
      this.push('release', 'confirmed', heard, 0, unit(Math.max(0.5, anticipation.stored, u.tension)), 1, this.prepared);
      f.stats.releases++;
      this.prepared = 0;
      if (this.pendingDrop >= 0 && Math.abs(heard - this.pendingDrop) <= DROP_MATCH) { f.stats.dropsMatched++; this.pendingDrop = -1; }
    }
    if (this.pendingDrop >= 0 && now - this.pendingDrop > DROP_WAIT) {
      // Waited long enough: a drop no release came to is unconfirmed (unless a release was heard just before it).
      if (Math.abs(this.lastRelease - this.pendingDrop) <= DROP_MATCH && this.lastRelease > 0) f.stats.dropsMatched++;
      else f.stats.dropsUnconfirmed++;
      this.pendingDrop = -1;
    }

    // Prediction: prepare for a release the cognition expects; withdraw when it is given up.
    let open = 0, expectation = 0;
    if (cognition.enabled) {
      for (const p of cognition.predictions) {
        if (p.id === 0 || p.kind !== 'release') continue;
        open = p.id;
        expectation = Math.max(expectation, p.confidence * unit(1 - Math.max(0, p.time - now) / HORIZON));
        if (p.id !== this.prepared && p.confidence >= PREPARE_CONFIDENCE && !(this.lastRelease > 0 && p.created - this.lastRelease < SETTLE && p.created >= this.lastRelease)) {
          this.prepared = p.id;
          this.push('prepare', 'predicted', now, p.time, p.confidence, p.confidence, p.id);
          f.stats.prepared++;
        }
      }
    }
    if (this.prepared !== 0 && open !== this.prepared) {
      // The prediction prepared for is no longer open and no release was heard for it: it was refuted or lapsed.
      this.push('withdraw', 'refuted', now, 0, 0, 1, this.prepared);
      f.stats.withdrawn++;
      this.prepared = 0;
    }

    f.phase = !cognition.enabled ? 'unknown' : u.silence !== 'none' ? 'silence' : PHASE_OF[u.state];
    f.silent = u.silence !== 'none';
    f.anticipation = unit(anticipation.level); f.expectation = unit(expectation);
    f.groove = unit(u.groove); f.tension = unit(u.tension); f.breakdown = unit(u.breakdown);
    f.repetition = cognition.enabled ? unit(u.repetition) : 0; f.stability = cognition.enabled ? unit(cognition.clock.stability) : 0;
  }

  /** A new audio session. The counts are the session's: they start over too. */
  reset(): void {
    const f = this.frame;
    Object.assign(f, createCues(), { cues: f.cues, stats: f.stats });
    for (const cue of f.cues) Object.assign(cue, createCue());
    Object.assign(f.stats, createStats());
    this.cursor.time = -Infinity; this.cursor.seq = 0; this.cursor.epoch = undefined;
    this.lastAccent = this.silenceEnd = -Infinity; this.lastRelease = 0; this.prepared = 0; this.pendingDrop = -1;
  }

  private event(e: Readonly<AudioEvent>): void {
    const f = this.frame;
    switch (e.type) {
      case 'impact':
        if (e.significance < ACCENT_SIGNIFICANCE || e.confidence < ACCENT_CONFIDENCE || e.audioTime - this.lastAccent < ACCENT_GAP) return;
        if (e.audioTime - this.silenceEnd < RESUME) { f.stats.restarts++; return; }
        this.lastAccent = e.audioTime;
        this.push('accent', 'observed', e.audioTime, 0, e.significance, e.confidence, 0);
        f.stats.accents++;
        return;
      case 'phraseBoundary':
        if (e.confidence < PHRASE_CONFIDENCE) return;
        this.push('phrase', 'observed', e.audioTime, 0, e.strength, e.confidence, 0);
        f.stats.phrases++;
        return;
      case 'silenceEnd':
        this.silenceEnd = e.audioTime;
        return;
      case 'drop':
        // Never a cue: it waits for a release heard near it.
        if (this.lastRelease > 0 && Math.abs(e.audioTime - this.lastRelease) <= DROP_MATCH) f.stats.dropsMatched++;
        else { if (this.pendingDrop >= 0) f.stats.dropsUnconfirmed++; this.pendingDrop = e.audioTime; }
        return;
      default:
    }
  }

  private push(kind: CueKind, status: CueStatus, time: number, expected: number, strength: number, confidence: number, ref: number): void {
    const f = this.frame, seq = ++f.seq, cue = f.cues[seq % CUE_SLOTS];
    cue.seq = seq; cue.kind = kind; cue.status = status; cue.time = time; cue.expected = expected;
    cue.strength = unit(strength); cue.confidence = unit(confidence); cue.ref = ref;
  }
}
