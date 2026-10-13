/*
 * What the engine expects, and what became of it. Nothing is predicted here:
 * the forecast is the one the experience already makes and the world is
 * already charged with (`WorldForces.charge`: the evidence of a build weighted
 * by its confidence), and the confirmation is the release the experience
 * already detects. This only keeps the account that neither of them keeps:
 *
 *   none        nothing is expected
 *   uncertain   some evidence of a build, not enough to prepare for
 *   probable    the evidence holds: an anticipation is open, and the world stores potential for it
 *   confirmed   a release has just happened (for as long as its front is felt)
 *
 * and, per session, how many anticipations opened, how many a release
 * confirmed (and how long after they opened), how many lapsed without one, and
 * how many releases nothing had announced. A lapsed anticipation changes
 * nothing in the world: what was stored for it leaks, as it always did.
 *
 * It is a reading for whoever has to tell these cases apart (the tools, the
 * tests of a scene's recovery): scenes do not branch on it, they keep reading
 * the world, where the same forecast is a force. Per hop on the capture clock,
 * deterministic, allocation-free.
 */

export const ANTICIPATION_PHASES = ['none', 'uncertain', 'probable', 'confirmed'] as const;
export type AnticipationPhase = typeof ANTICIPATION_PHASES[number];

export interface AnticipationFrame {
  /** Capture clock (s). */
  time: number;
  phase: AnticipationPhase;
  /** 0..1: the evidence of a build weighted by its confidence, as the world is charged with it, followed over a moment. */
  level: number;
  /** 0..1: what the world holds stored for a release (its potential). */
  stored: number;
  /** Audio time the open anticipation began (0: none is open), and how long it has been open (s). */
  since: number;
  age: number;
  /** Anticipations opened, confirmed by a release, lapsed without one; and releases nothing had announced. Per session. */
  opened: number;
  confirmed: number;
  expired: number;
  unannounced: number;
  /** Seconds from the opening of the last confirmed anticipation to its release (0 before any). */
  lead: number;
  /** Audio time of the last release and of the last lapse (0 before any). */
  releasedAt: number;
  expiredAt: number;
}

export const createAnticipation = (): AnticipationFrame => ({
  time: 0, phase: 'none', level: 0, stored: 0, since: 0, age: 0, opened: 0, confirmed: 0, expired: 0, unannounced: 0, lead: 0, releasedAt: 0, expiredAt: 0,
});

export function copyAnticipation(to: AnticipationFrame, from: Readonly<AnticipationFrame>): void {
  Object.assign(to, from);
}

/** The level is the charge followed over this long (s): a single hop of evidence opens nothing. */
const LEVEL_TAU = 0.4;
/**
 * An anticipation opens at OPEN and is held down to HOLD; below UNCERTAIN nothing is expected. On steady music the
 * level stays under 0.25 (a four-on-the-floor groove, a pad, a pop arrangement); a build takes it past 0.5 for seconds.
 */
export const ANTICIPATION = { open: 0.45, hold: 0.25, uncertain: 0.25, clear: 0.15 } as const;
/** An open anticipation whose evidence has been gone this long (s) has lapsed: the build went nowhere. */
export const LAPSE_AFTER = 4;
/** A release is felt this long (s): the time its front takes to pass (the scenes' own release time). */
export const RELEASE_HOLD = 1.6;

const unit = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);

/** Owns the account of one audio session. Advanced per analysis hop by ExperienceEngine. */
export class AnticipationLedger {
  readonly frame = createAnticipation();
  private open = false;
  private uncertain = false;
  /** Audio time the evidence of the open anticipation was last there. */
  private lastEvidence = 0;

  /**
   * One hop. `expectation` 0..1: the build evidence × its confidence as the world is charged with it this hop;
   * `stored`: the world's potential. In silence nothing is expected, and what was open lapses in its time.
   */
  update(time: number, dt: number, expectation: number, stored: number): void {
    const f = this.frame;
    if (!(dt > 0) || !Number.isFinite(dt) || !Number.isFinite(time)) return;
    f.time = time;
    f.level += (unit(Number.isFinite(expectation) ? expectation : 0) - f.level) * (1 - Math.exp(-dt / LEVEL_TAU));
    f.stored = unit(Number.isFinite(stored) ? stored : 0);
    if (!this.open && f.level >= ANTICIPATION.open) {
      this.open = true; f.opened++; f.since = time;
    }
    if (this.open) {
      if (f.level >= ANTICIPATION.hold) this.lastEvidence = time;
      else if (time - this.lastEvidence >= LAPSE_AFTER) { this.open = false; f.expired++; f.expiredAt = time; f.since = 0; }
    }
    if (f.level >= ANTICIPATION.uncertain) this.uncertain = true; else if (f.level < ANTICIPATION.clear) this.uncertain = false;
    f.age = this.open ? time - f.since : 0;
    f.phase = f.releasedAt > 0 && time - f.releasedAt < RELEASE_HOLD ? 'confirmed' : this.open ? 'probable' : this.uncertain ? 'uncertain' : 'none';
  }

  /** A release the experience has just detected, at its own audio time. */
  release(time: number): void {
    const f = this.frame;
    if (!Number.isFinite(time)) return;
    if (this.open) { f.confirmed++; f.lead = time - f.since; this.open = false; f.since = 0; f.age = 0; }
    else f.unannounced++;
    // The release resolves what was expected: the evidence heard so far is spent, and a new anticipation needs new evidence.
    f.level = 0; this.uncertain = false;
    f.releasedAt = time; f.phase = 'confirmed';
  }

  reset(): void {
    Object.assign(this.frame, createAnticipation());
    this.open = this.uncertain = false; this.lastEvidence = 0;
  }
}
