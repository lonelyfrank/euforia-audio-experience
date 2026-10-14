import { DEFAULT_CONFIG, MusicalCognition, type CognitionConfig } from './MusicalCognition';
import { cognitionSink, runScenario, type Scenario, type Truth } from './scenarios';
import { CLOCK_STATES, MUSICAL_STATES, PREDICTION_KINDS, type MusicalState, type Prediction, type PredictionKind, type SurpriseKind } from './types';

/*
 * The measures of how well the cognition understood a piece whose form is known (a synthetic scenario): rhythm
 * (distance of the forecast beat from the true one, tempo error, how fast the grid comes back), structure (phrase
 * boundaries found, transitions that were not there, how often the reading changes), predictions (per kind: outcomes,
 * precision, the lead they gave, their timing error, the Brier score of their confidences) and releases (heard against
 * the true ones: matched, early, missed). A report, not a verdict: acceptance thresholds come after a baseline.
 */

export interface KindReport { proposed: number; confirmed: number; refuted: number; expired: number; precision: number | null; brier: number | null; leadSeconds: number | null; errorMs: number | null }
export interface Evaluation {
  scenario: string;
  seconds: number;
  /** Median |forecast next beat − true beat| (ms), sampled a quarter period before each true beat with a grid; share of true beats with one. */
  beatErrorMs: number | null;
  beatCoverage: number;
  /** Median relative tempo error (%) while the clock has a grid. */
  bpmErrorPct: number | null;
  relocks: number;
  continuations: number;
  losses: number;
  relockSeconds: number;
  /** Share of true downbeats the clock placed (bar position 0 within a quarter period), when it showed bar positions at all. */
  downbeatAccuracy: number | null;
  /** Phrase boundaries: confirmed predictions matching a true phrase start (precision over confirmed, recall over the true ones after the first two phrases). */
  phrasePrecision: number | null;
  phraseRecall: number | null;
  /** Entries into 'transition' farther than a bar from any true transition, phrase start or release. */
  falseTransitions: number;
  stateChangesPerMinute: number;
  states: Partial<Record<MusicalState, number>>;
  predictions: Record<PredictionKind, KindReport>;
  /** Releases: true ones, heard ones, heard within [−0.1, +0.6] s of a true one, heard before any true one (never wanted), mean latency (s). */
  releasesTrue: number;
  releasesHeard: number;
  releasesMatched: number;
  releasesEarly: number;
  releaseLatency: number | null;
  surprises: Partial<Record<SurpriseKind, number>>;
  /** Mean cost per hop (µs) of this run (synthetic: the machine's, not live). */
  microsPerHop: number;
}

/** What a run leaves for a timeline (the laboratory): the truth, every resolution, the releases heard, 10 samples a second. */
export interface Recording {
  evaluation: Evaluation;
  truth: Truth;
  resolved: Prediction[];
  heard: number[];
  /** Per sample: time, clock state index, musical state index, clock confidence, tension, surprise, expectation. */
  samples: Float32Array;
}
export const SAMPLE_FIELDS = 7;
const SAMPLE_RATE = 10;

const median = (x: number[]): number | null => {
  if (!x.length) return null;
  const s = [...x].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};
const near = (t: number, list: readonly number[], tolerance: number): boolean => list.some(x => Math.abs(x - t) <= tolerance);

export function evaluate(scenario: Scenario, config: Partial<CognitionConfig> = {}): Evaluation {
  return record(scenario, config).evaluation;
}

/** Runs a scenario into a fresh cognition and keeps what it did, with its evaluation. */
export function record(scenario: Scenario, config: Partial<CognitionConfig> = {}): Recording {
  const c = new MusicalCognition();
  Object.assign(c.config, DEFAULT_CONFIG, config);
  const resolved: Prediction[] = [], heard: number[] = [], beatErrors: number[] = [], bpmErrors: number[] = [], transitions: number[] = [];
  const states: Partial<Record<MusicalState, number>> = {}, surprises: Partial<Record<SurpriseKind, number>> = {};
  let truth: Readonly<Truth> | null = null, nextBeat = 0, sampled = 0, downbeatsShown = 0, downbeatsRight = 0, nextDownbeat = 0;
  let state: MusicalState = 'unknown', surpriseAt = -1, hops = 0, cost = 0, nextSample = 0;
  const samples: number[] = [];
  c.ledger.onResolve = (p) => { resolved.push({ ...p }); };
  c.onRelease = (t) => { heard.push(t); };
  const sink = cognitionSink(c);
  const hop = sink.hop;
  sink.start = (t) => { truth = t; };
  sink.hop = (a, context, dt) => {
    const start = performance.now();
    hop(a, context, dt);
    cost += performance.now() - start; hops++;
    const f = c.frame, k = f.clock, u = f.understanding, t = truth!;
    // Rhythm: the forecast next beat, a quarter period before each true beat.
    while (nextBeat < t.beats.length && a.time >= t.beats[nextBeat] - 0.25 * (k.period || 0.5)) {
      const target = t.beats[nextBeat++];
      if ((k.state === 'locked' || k.state === 'coasting') && k.nextBeat > 0) { beatErrors.push(Math.abs(k.nextBeat - target) * 1000); sampled++; }
    }
    while (nextDownbeat < t.downbeats.length && a.time >= t.downbeats[nextDownbeat] + 0.25 * (k.period || 0.5)) {
      nextDownbeat++;
      if (k.barPosition >= 0) { downbeatsShown++; if (k.barPosition === 0) downbeatsRight++; }
    }
    if (k.state === 'locked' && k.bpm > 0) {
      const segment = t.beats.findIndex(b => b > a.time);
      if (segment > 0) { const truePeriod = t.beats[segment] - t.beats[segment - 1]; if (truePeriod > 0.2 && truePeriod < 1.2) bpmErrors.push(Math.abs(k.bpm - 60 / truePeriod) / (60 / truePeriod) * 100); }
    }
    if (a.time >= nextSample) {
      nextSample = a.time + 1 / SAMPLE_RATE;
      samples.push(a.time, CLOCK_STATES.indexOf(k.state), MUSICAL_STATES.indexOf(u.state), k.confidence, u.tension, u.surprise, u.expectation);
    }
    if (u.state !== state) { state = u.state; states[state] = (states[state] ?? 0) + 1; if (state === 'transition') transitions.push(a.time); }
    if (u.surpriseAt !== surpriseAt && u.surprise >= 0.2) { surpriseAt = u.surpriseAt; surprises[u.surpriseKind] = (surprises[u.surpriseKind] ?? 0) + 1; }
  };
  const t = runScenario(scenario, sink);
  const f = c.frame, k = f.clock;
  const predictions = {} as Record<PredictionKind, KindReport>;
  for (const kind of PREDICTION_KINDS) {
    const mine = resolved.filter(p => p.kind === kind), ok = mine.filter(p => p.status === 'confirmed');
    predictions[kind] = {
      proposed: f.stats.proposed[PREDICTION_KINDS.indexOf(kind)], confirmed: ok.length, refuted: mine.filter(p => p.status === 'refuted').length,
      expired: mine.filter(p => p.status === 'expired').length, precision: mine.length ? ok.length / mine.length : null,
      brier: mine.length ? mine.reduce((s, p) => s + (p.confidence - (p.status === 'confirmed' ? 1 : 0)) ** 2, 0) / mine.length : null,
      leadSeconds: ok.length ? ok.reduce((s, p) => s + p.observed - p.created, 0) / ok.length : null,
      errorMs: ok.length ? ok.reduce((s, p) => s + Math.abs(p.error), 0) / ok.length * 1000 : null,
    };
  }
  const phrasesConfirmed = resolved.filter(p => p.kind === 'phrase' && p.status === 'confirmed').map(p => p.observed);
  const truePhrases = t.phrases.slice(2);
  const bar = 4 * 60 / 124, structural = [...t.transitions, ...t.phrases, ...t.releases, ...t.tempoChanges];
  const matched = heard.filter(h => t.releases.some(r => h - r >= -0.1 && h - r <= 0.6));
  const evaluation: Evaluation = {
    scenario: scenario.id, seconds: t.duration,
    beatErrorMs: median(beatErrors), beatCoverage: t.beats.length ? sampled / t.beats.length : 0, bpmErrorPct: median(bpmErrors),
    relocks: k.relocks, continuations: k.continuations, losses: k.losses, relockSeconds: k.relockSeconds,
    downbeatAccuracy: downbeatsShown ? downbeatsRight / downbeatsShown : null,
    phrasePrecision: phrasesConfirmed.length ? phrasesConfirmed.filter(p => near(p, t.phrases, 0.15)).length / phrasesConfirmed.length : null,
    phraseRecall: truePhrases.length ? truePhrases.filter(p => near(p, phrasesConfirmed, 0.15)).length / truePhrases.length : null,
    falseTransitions: transitions.filter(x => !near(x, structural, bar + 0.6)).length,
    stateChangesPerMinute: f.stats.stateChanges / (t.duration / 60), states,
    predictions,
    releasesTrue: t.releases.length, releasesHeard: heard.length, releasesMatched: matched.length,
    releasesEarly: heard.filter(h => !t.releases.some(r => h >= r - 0.1)).length,
    releaseLatency: matched.length ? matched.reduce((s, h) => s + h - t.releases.reduce((b, r) => (Math.abs(r - h) < Math.abs(b - h) ? r : b), Infinity), 0) / matched.length : null,
    surprises, microsPerHop: hops ? cost / hops * 1000 : 0,
  };
  return { evaluation, truth: t, resolved, heard, samples: Float32Array.from(samples) };
}
