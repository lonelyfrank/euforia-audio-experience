import type { MemoryReading } from './StructuralMemory';
import type { ClockFrame, MusicalState, UnderstandingFrame } from './types';

/*
 * Musical reasoning: what the observations mean together. Every dimension is continuous and combines temporal,
 * rhythmic, spectral and structural evidence (never the level alone):
 *
 *   pulse        is there a beat, and is it confirmed            clock state × confidence
 *   groove       a pulse that holds over repeating bars           pulse × repetition × support
 *   tension      something is being prepared                      the experience's build evidence (reused, not
 *                                                                 recomputed), level and attacks rising bar over bar,
 *                                                                 the low end withdrawn while attacks go on, a phrase
 *                                                                 end approaching under that pressure
 *   breakdown    the floor has gone                               low end far under the track's own, sparse, quiet,
 *                                                                 after a groove
 *   transition   a structural change has just happened            boundary strength at a downbeat, DSP section change
 *   release      tension has just resolved                        a release heard (audio evidence, MusicalCognition)
 *   development  the pulse holds while the bars keep changing     pulse × novelty, outside tension
 *
 * The dominant state is chosen by priority among those past their entry threshold, kept until it falls under its exit
 * threshold, and changed only after a minimum dwell (release and transition are moments: they act at once). Each state
 * carries a reason: a constant naming its strongest evidence.
 */

/** Entry / exit thresholds per state, in priority order (the first past its entry wins). */
const RULES: readonly (readonly [MusicalState, number, number])[] = [
  ['release', 0.5, 0.3], ['transition', 0.5, 0.25], ['breakdown', 0.5, 0.3], ['risingTension', 0.45, 0.3],
  ['developing', 0.4, 0.25], ['stableGroove', 0.45, 0.3], ['establishingPulse', 0.2, 0.1],
];
const PRIORITY: Readonly<Record<MusicalState, number>> = {
  release: 0, transition: 1, breakdown: 2, risingTension: 3, developing: 4, stableGroove: 5, establishingPulse: 6, unknown: 7,
};
/** Seconds a state holds before another (not a moment) may replace it. */
export const MIN_DWELL = 1.5;
/** Tension follows its evidence up in this long (s), down in this long. */
const TENSION_UP = 0.4;
const TENSION_DOWN = 1.2;

const REASON = {
  release: 'low end back after tension (heard)', releaseSection: 'the DSP heard a drop section begin',
  transition: 'a downbeat far from the bars before it', transitionSection: 'the DSP heard a section change',
  breakdown: 'low end gone, sparse and under the track\'s level, after a groove',
  build: 'build evidence (rising energy, tension, brightness)', rise: 'level rising bar over bar', withdrawn: 'low end withdrawn while the attacks go on',
  busier: 'attacks thickening bar over bar', approach: 'a phrase end approaching under pressure',
  developing: 'the pulse holds while the bars keep changing', groove: 'confirmed pulse over repeating bars', loose: 'confirmed pulse, bars not yet repeating',
  acquiring: 'the tracker is acquiring a grid', silent: 'no sound', noPulse: 'sound without a periodic pulse',
} as const;

export interface InterpretationInput {
  time: number;
  dt: number;
  presence: number;
  /** The experience engine's build evidence and its confidence (ExperienceState.anticipation…): reused, not recomputed. */
  anticipation: number;
  anticipationConfidence: number;
  /** Seconds since the last release heard and the last DSP section change (Infinity: none), and whether that section is a drop. */
  releaseAge: number;
  sectionAge: number;
  sectionDrop: boolean;
  /** Boundary strength of a downbeat closed this call (0 if none), and the bar length (s). */
  boundary: number;
  barSeconds: number;
  /** The style's expectation that tension resolves on a phrase boundary. */
  buildResolves: number;
  /** Silence or lost source right now. */
  quiet: boolean;
}

const unit = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
const follow = (x: number, target: number, dt: number, tau: number): number => x + (target - x) * (1 - Math.exp(-dt / tau));

export class Interpreter {
  /** The groove there was lately (decays over half a minute): a breakdown is the floor going from under a groove. */
  private grooveMemory = 0;
  private transitionLevel = 0;
  private breakdownLevel = 0;

  reset(): void { this.grooveMemory = this.transitionLevel = this.breakdownLevel = 0; }

  update(u: UnderstandingFrame, clock: Readonly<ClockFrame>, m: Readonly<MemoryReading>, x: Readonly<InterpretationInput>): boolean {
    const dt = x.dt, bar = Math.max(0.5, x.barSeconds);
    const pulseWeight = clock.state === 'locked' ? 1 : clock.state === 'coasting' ? 0.7 : clock.state === 'acquiring' ? 0.5 : 0;
    u.pulse = pulseWeight * Math.sqrt(unit(clock.confidence));
    u.groove = x.quiet ? 0 : u.pulse * (0.4 + 0.6 * m.repetition) * (0.5 + 0.5 * clock.support);
    this.grooveMemory = Math.max(u.groove, this.grooveMemory * Math.exp(-dt / 30));
    u.repetition = m.repetition; u.pattern = m.pattern; u.novelty = m.novelty; u.boundary = m.boundary;

    // Tension: the strongest of its kinds of evidence decides the reason; together they decide how much.
    const build = unit(x.anticipation * x.anticipationConfidence * 1.6);
    const rise = unit(m.levelSlope / 0.08);
    const busier = unit(m.densitySlope / 1.5);
    const withdrawn = m.lowReference > 0.3 ? unit((m.lowReference - m.low) / m.lowReference) * unit(m.density / 3) : 0;
    const pressure = build + rise + withdrawn;
    const approach = clock.phraseConfidence >= 0.35 && clock.phraseBars > 0 && clock.phraseBar >= 0 && pressure > 0.25
      ? ((clock.phraseBar + Math.max(0, clock.barPhase)) / clock.phraseBars) ** 2 * x.buildResolves : 0;
    let raw = unit(0.45 * build + 0.2 * rise + 0.15 * busier + 0.3 * withdrawn + 0.15 * approach);
    if (x.quiet || x.releaseAge < 2 * bar) raw = 0;
    u.tension = follow(u.tension, raw, dt, raw > u.tension ? TENSION_UP : TENSION_DOWN);
    u.tensionConfidence = x.quiet ? 0 : unit(x.presence) * (0.4 + 0.6 * Math.max(u.pulse, clock.phraseConfidence));

    // Breakdown: the floor gone from under a groove (sparse, quiet, low end far under the track's own).
    const floorGone = m.lowReference > 0.3 ? unit((0.5 * m.lowReference - m.low) / (0.5 * m.lowReference)) : 0;
    const sparse = unit((2.5 - m.density) / 2), quiet = unit((0.5 - m.level) / 0.3);
    this.breakdownLevel = follow(this.breakdownLevel, x.quiet ? 0 : floorGone * sparse * (0.5 + 0.5 * quiet) * unit(this.grooveMemory * 2), dt, 1);
    u.breakdown = this.breakdownLevel;
    this.transitionLevel = Math.max(this.transitionLevel * Math.exp(-dt / bar), x.boundary, x.sectionAge < 0.5 * bar ? 0.6 : 0);
    u.transition = this.transitionLevel;
    u.release = x.releaseAge < 2 * bar ? Math.exp(-x.releaseAge / (2 * bar)) : 0;
    u.development = x.quiet ? 0 : u.pulse * unit((m.novelty - 0.15) / 0.4) * (1 - u.tension) * (1 - 0.5 * m.repetition);

    // The dominant reading.
    let next: MusicalState = 'unknown';
    if (!x.quiet) for (const [state, enter] of RULES) if (this.score(state, u, clock) >= enter) { next = state; break; }
    if (next === 'unknown' && !x.quiet && u.pulse >= 0.5) next = 'stableGroove';
    const current = u.state;
    let exit = Infinity;
    for (const [state, , out] of RULES) if (state === current) exit = out;
    const holds = !x.quiet && this.score(current, u, clock) >= exit;
    let changed = false;
    if (next !== current && !(holds && PRIORITY[next] >= PRIORITY[current])) {
      const moment = next === 'release' || next === 'transition' || x.quiet || current === 'unknown' || current === 'establishingPulse';
      if (moment || x.time - u.since >= MIN_DWELL) {
        u.previous = current; u.state = next; u.since = x.time; changed = true;
      }
    }
    u.confidence = u.state === 'unknown' ? (x.quiet ? 1 : 1 - u.pulse) : unit(this.score(u.state, u, clock));
    u.reason = this.reason(u, x, build, rise, busier, withdrawn, approach);
    return changed;
  }

  /** How much the evidence supports a state (0..1). */
  private score(s: MusicalState, u: Readonly<UnderstandingFrame>, clock: Readonly<ClockFrame>): number {
    switch (s) {
      case 'release': return u.release;
      case 'transition': return u.transition;
      case 'breakdown': return u.breakdown;
      case 'risingTension': return u.tension * (0.5 + 0.5 * u.tensionConfidence);
      case 'developing': return u.development;
      case 'stableGroove': return u.groove;
      case 'establishingPulse': return clock.state === 'acquiring' ? u.pulse : 0;
      default: return 0;
    }
  }

  private reason(u: UnderstandingFrame, x: Readonly<InterpretationInput>, build: number, rise: number, busier: number, withdrawn: number, approach: number): string {
    switch (u.state) {
      case 'release': return x.sectionDrop && x.sectionAge <= x.releaseAge ? REASON.releaseSection : REASON.release;
      case 'transition': return x.sectionAge < x.barSeconds && u.boundary < 0.5 ? REASON.transitionSection : REASON.transition;
      case 'breakdown': return REASON.breakdown;
      case 'risingTension': {
        const top = Math.max(build * 0.45, rise * 0.2, busier * 0.15, withdrawn * 0.3, approach * 0.15);
        return top === build * 0.45 ? REASON.build : top === withdrawn * 0.3 ? REASON.withdrawn : top === rise * 0.2 ? REASON.rise : top === busier * 0.15 ? REASON.busier : REASON.approach;
      }
      case 'developing': return REASON.developing;
      case 'stableGroove': return u.repetition >= 0.5 ? REASON.groove : REASON.loose;
      case 'establishingPulse': return REASON.acquiring;
      default: return x.quiet ? REASON.silent : REASON.noPulse;
    }
  }
}
