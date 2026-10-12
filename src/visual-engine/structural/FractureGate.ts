import type { AudioEvent } from '../../experience/EventStream';
import { createFractureTuning, FRACTURE_LIMITS, within, type FractureTuning } from './SolidTypes';
import { finite, unit } from './StructuralTypes';

/*
 * The fracture gate: whether a musical event may break the bodies of a system.
 *
 * In the `events` mode of fracture the load on a link breaks nothing by
 * itself. A dated event of the experience stream (an impact, a drop) is
 * offered here; at the fixed step that reaches its audio time the gate decides
 * whether it passes, and how large a fracture it asks for. The bodies then
 * break where their own load law says (SolidSystem.shatter): the gate never
 * names a link.
 *
 *   evidence     how far the event stands out of the track's recent ones (its
 *                significance, rated upstream by the adaptive calibration:
 *                never an absolute level), and its confidence
 *   hysteresis   after a fracture the bar is higher and comes back down slowly
 *   cooldown     a least time between two fractures, on the simulation's clock
 *   budget       the system must have a body that can still take one
 *
 * What it decides depends on the events and on the steps only, so it is the
 * same at any frame rate. Fixed storage; nothing is allocated after construction.
 */

/** Events waiting for their step. More than this in one frame and the weakest is dropped. */
const PENDING = 8;
/** How far the bar stands above the threshold right after a cooldown (a share of what is left above it); it comes down over one more cooldown. */
const HYSTERESIS = 0.5;
/** The smallest fracture an event that just passes asks for, as a share of the largest. */
const AMOUNT_MIN = 0.2;
/** A drop is a release of what the music stored: it weighs at least this much, more with its strength. */
const DROP_WEIGHT = 0.6;

export const FRACTURE_VERDICTS = ['none', 'fired', 'manual', 'confidence', 'threshold', 'cooldown', 'budget'] as const;
export type FractureVerdict = typeof FRACTURE_VERDICTS[number];

export interface FractureStats {
  /** Events that reached their step in the `events` mode, and those that passed. */
  offered: number;
  fired: number;
  /** Fractures asked for by a tool. */
  manual: number;
  /** Events refused: too little confidence, below the bar, inside the cooldown, no body that could take one. */
  confidence: number;
  threshold: number;
  cooldown: number;
  budget: number;
  /** What became of the last event, its weight, and the bar it was held to. */
  verdict: FractureVerdict;
  weight: number;
  bar: number;
}

export class FractureGate {
  readonly tuning: FractureTuning = createFractureTuning();
  readonly stats: FractureStats = { offered: 0, fired: 0, manual: 0, confidence: 0, threshold: 0, cooldown: 0, budget: 0, verdict: 'none', weight: 0, bar: 0 };
  /** Audio time of the event that last passed (NaN: a tool's, or none): what the bodies seed its direction with. */
  time = NaN;
  private readonly times = new Float64Array(PENDING);
  private readonly weights = new Float32Array(PENDING);
  private readonly confidences = new Float32Array(PENDING);
  private readonly structure = new Float32Array(PENDING);
  private pending = 0;
  /** Weight, confidence and structural weight of the event being judged. */
  private readonly held = new Float32Array(3);
  private forced = 0;
  /** The simulation's clock at the last fracture. */
  private last = -Infinity;

  /**
   * An event of the experience stream, heard: kept until the step that reaches its audio time. Only what can break a
   * body is kept (an impact by how far it stands out, a drop by what it releases); everything else is not the gate's.
   */
  offer(event: Readonly<AudioEvent>): void {
    if (event.type !== 'impact' && event.type !== 'drop') return;
    const significance = unit(finite(event.significance)), weight = event.type === 'drop' ? Math.max(significance, unit(DROP_WEIGHT + (1 - DROP_WEIGHT) * finite(event.strength))) : significance;
    if (!Number.isFinite(event.audioTime) || !(weight > 0)) return;
    let at = this.pending;
    if (at === PENDING) {
      // Full: the weakest gives way, if this one is stronger.
      at = 0;
      for (let k = 1; k < PENDING; k++) if (this.weights[k] < this.weights[at]) at = k;
      if (this.weights[at] >= weight) return;
    } else this.pending++;
    this.times[at] = event.audioTime; this.weights[at] = weight; this.confidences[at] = unit(finite(event.confidence)); this.structure[at] = unit(finite(event.structuralWeight));
  }

  /** A fracture asked for by a tool (`amount` 0..1): at the next step, whatever the mode and the gate. */
  force(amount: number): void {
    this.forced = Math.max(this.forced, unit(finite(amount)));
  }

  /**
   * The step that ends at the audio time `now` (NaN: no clock, everything is due), `clock` seconds into the
   * simulation. Returns the size of the fracture to make in it (0..1), 0 for none. `able`: whether some body could
   * take one (links enough to give, pieces short of its budget).
   */
  take(now: number, clock: number, able: boolean): number {
    const stats = this.stats;
    if (this.forced > 0) {
      const amount = this.forced;
      this.forced = 0; this.last = clock; this.time = NaN;
      stats.manual++; stats.verdict = 'manual'; stats.weight = amount; stats.bar = 0;
      return amount;
    }
    // The strongest of the events this step has reached; the rest of them happened in the same instant.
    const held = this.held;
    let found = false;
    for (let k = this.pending - 1; k >= 0; k--) {
      if (this.times[k] > now) continue;
      if (!found || this.weights[k] > held[0] || (this.weights[k] === held[0] && this.times[k] < this.time)) {
        this.time = this.times[k]; held[0] = this.weights[k]; held[1] = this.confidences[k]; held[2] = this.structure[k];
        found = true;
      }
      // Taken out of the queue: the last one waiting moves into its place.
      const end = --this.pending;
      this.times[k] = this.times[end]; this.weights[k] = this.weights[end]; this.confidences[k] = this.confidences[end]; this.structure[k] = this.structure[end];
    }
    if (!found || this.tuning.mode !== 'events') return 0;
    const tuning = this.tuning, weight = stats.weight = held[0], cooldown = within(tuning.cooldown, FRACTURE_LIMITS.cooldown, 4), threshold = within(tuning.threshold, FRACTURE_LIMITS.threshold, 0.7);
    const since = clock - this.last;
    // After a fracture the next event has more to prove, and less so as time passes: a body does not break and break again.
    const bar = threshold + (1 - threshold) * HYSTERESIS * Math.exp(-Math.max(0, since - cooldown) / cooldown);
    stats.offered++; stats.bar = bar;
    if (held[1] < within(tuning.confidence, FRACTURE_LIMITS.confidence, 0.5)) { stats.confidence++; stats.verdict = 'confidence'; return 0; }
    if (since < cooldown) { stats.cooldown++; stats.verdict = 'cooldown'; return 0; }
    if (weight < bar) { stats.threshold++; stats.verdict = 'threshold'; return 0; }
    if (!able) { stats.budget++; stats.verdict = 'budget'; return 0; }
    this.last = clock;
    stats.fired++; stats.verdict = 'fired';
    // How much breaks follows how far the event passed the bar and how much it matters for the form, never the level.
    return unit(AMOUNT_MIN + (1 - AMOUNT_MIN) * unit((weight - bar) / Math.max(1 - bar, 1e-6)) * (0.6 + 0.4 * held[2]));
  }

  /** Seconds since the last fracture on the simulation's clock (Infinity before any). */
  since(clock: number): number {
    return clock - this.last;
  }

  /** A new audio session: what was waiting belongs to another clock. The count of what happened is the tools' to clear. */
  reset(): void {
    this.pending = 0; this.forced = 0; this.time = NaN;
  }

  clear(): void {
    const stats = this.stats;
    this.reset();
    this.last = -Infinity;
    stats.offered = stats.fired = stats.manual = stats.confidence = stats.threshold = stats.cooldown = stats.budget = stats.weight = stats.bar = 0; stats.verdict = 'none';
  }
}
