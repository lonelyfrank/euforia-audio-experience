import { KIND, PREDICTION_KINDS, type CognitionFrame, type Prediction, type PredictionKind, type PredictionStatus } from './types';

/*
 * The ledger of what the cognition expects. A prediction is not an event: it has a window, a confidence and the
 * evidence it rests on, and it ends in one of three ways — confirmed by an observation inside its window, refuted by
 * evidence against it, or expired when its horizon passes with neither. At most one is open per kind (a new estimate of
 * the same thing updates it), so the slots never run out.
 *
 * Two guarantees: nothing is predicted for a moment already past (a proposal whose expected time is behind the present
 * is refused), and nothing is confirmed by an observation older than the prediction. Outcomes are counted per session,
 * with the mean error and lead of the confirmed ones and the Brier score of the confidences (expired counts as not
 * confirmed): the confidences are measured against what happened, not presented as probabilities.
 */

/** A proposal is an update (not a restatement) when its time moves by this share of its window or its confidence by this much. */
const MOVED = 0.25;
const REWEIGHED = 0.1;

export class PredictionLedger {
  private id = 0;
  /** Every resolution, for an evaluation (tests, the laboratory); unset in the product. */
  onResolve: ((p: Readonly<Prediction>) => void) | null = null;
  private readonly resolvedCount = new Uint32Array(PREDICTION_KINDS.length);

  constructor(private readonly frame: CognitionFrame) {}

  reset(): void {
    this.id = 0; this.resolvedCount.fill(0);
    for (const p of this.frame.predictions) p.id = 0;
    for (const p of this.frame.recent) p.id = 0;
  }

  /** The open prediction of a kind, or null. */
  open(kind: PredictionKind): Prediction | null {
    for (const p of this.frame.predictions) if (p.id !== 0 && p.kind === kind) return p;
    return null;
  }

  /**
   * Proposes (or updates) the prediction of `kind`: expected at `time`, confirmed by an observation in [early, late],
   * holding until `validUntil`. Refused (null) for a time already past.
   */
  propose(kind: PredictionKind, now: number, time: number, early: number, late: number, confidence: number, evidence: string, validUntil: number): Prediction | null {
    if (!(time >= now) || !Number.isFinite(time) || !(late >= early) || !(confidence > 0)) return null;
    let p = this.open(kind);
    if (p) {
      const width = Math.max(1e-3, p.late - p.early);
      if (Math.abs(time - p.time) > MOVED * width || Math.abs(confidence - p.confidence) > REWEIGHED || evidence !== p.evidence) {
        p.status = 'updated'; p.updates++;
      }
    } else {
      for (const slot of this.frame.predictions) if (slot.id === 0) { p = slot; break; }
      if (!p) return null;
      p.id = ++this.id; p.kind = kind; p.status = 'proposed'; p.created = now; p.updates = 0; p.resolved = 0; p.observed = 0; p.error = 0;
      this.frame.stats.proposed[KIND[kind]]++;
    }
    p.time = time; p.early = early; p.late = late; p.confidence = Math.min(1, confidence); p.evidence = evidence; p.validUntil = Math.max(validUntil, late);
    return p;
  }

  /** An observation of `kind` at `time`: confirms the open prediction whose window holds it. */
  observe(kind: PredictionKind, time: number, now: number): Prediction | null {
    const p = this.open(kind);
    if (!p || time < p.early || time > p.late || time < p.created) return null;
    p.observed = time; p.error = time - p.time;
    this.resolve(p, 'confirmed', now);
    return p;
  }

  refute(kind: PredictionKind, now: number): Prediction | null {
    const p = this.open(kind);
    if (p) this.resolve(p, 'refuted', now);
    return p;
  }

  /** Expires what has outlived its horizon; returns the last expired (for the surprise of a phrase that went on). */
  tick(now: number): Prediction | null {
    let expired: Prediction | null = null;
    for (const p of this.frame.predictions) if (p.id !== 0 && now > p.validUntil) { this.resolve(p, 'expired', now); expired = p; }
    return expired;
  }

  /** Drops what is open without counting it (the grid it rested on is gone, or a new session began). */
  withdraw(kind?: PredictionKind): void {
    for (const p of this.frame.predictions) if (p.id !== 0 && (kind === undefined || p.kind === kind)) p.id = 0;
  }

  /** 0..1: how strongly something structural is expected within `horizon` s (confidence × proximity); beats and downbeats, near certain, aside. */
  expectation(now: number, horizon: number): number {
    let best = 0;
    for (const p of this.frame.predictions) {
      if (p.id === 0 || p.kind === 'beat' || p.kind === 'downbeat') continue;
      const ahead = p.time - now, proximity = ahead <= 0 ? 1 : ahead >= horizon ? 0 : 1 - ahead / horizon;
      best = Math.max(best, p.confidence * proximity);
    }
    return best;
  }

  private resolve(p: Prediction, status: PredictionStatus, now: number): void {
    const s = this.frame.stats, k = KIND[p.kind], n = ++this.resolvedCount[k];
    p.status = status; p.resolved = now;
    if (status === 'confirmed') {
      s.confirmed[k]++;
      const c = s.confirmed[k];
      s.error[k] += (Math.abs(p.error) - s.error[k]) / c;
      s.lead[k] += (p.observed - p.created - s.lead[k]) / c;
    } else if (status === 'refuted') s.refuted[k]++;
    else s.expired[k]++;
    const outcome = status === 'confirmed' ? 1 : 0;
    s.brier[k] += ((p.confidence - outcome) ** 2 - s.brier[k]) / n;
    this.onResolve?.(p);
    if (p.kind !== 'beat') {
      // Newest first; beats are only counted (one per beat would wash the rest out).
      const recent = this.frame.recent;
      for (let i = recent.length - 1; i > 0; i--) Object.assign(recent[i], recent[i - 1]);
      Object.assign(recent[0], p);
    }
    p.id = 0;
  }
}
