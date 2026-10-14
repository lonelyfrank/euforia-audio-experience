import { describe, expect, it } from 'vitest';
import { GENERIC_FLOOR, PHRASES, StyleBlend, tempoPrior } from './knowledge';
import { PredictionLedger } from './Predictions';
import { createCognition, KIND, type Prediction } from './types';

describe('prediction ledger', () => {
  it('refuses a prediction for a moment already past, and one without confidence', () => {
    const f = createCognition(), L = new PredictionLedger(f);
    expect(L.propose('phrase', 10, 9.5, 9, 10, 0.8, 'grid', 11)).toBeNull();
    expect(L.propose('phrase', 10, 12, 11, 13, 0, 'grid', 14)).toBeNull();
    expect(f.stats.proposed[KIND.phrase]).toBe(0);
  });

  it('keeps one open prediction per kind: a new estimate updates it, a restatement does not', () => {
    const f = createCognition(), L = new PredictionLedger(f);
    const p = L.propose('release', 10, 20, 19, 21, 0.5, 'tension', 21)!;
    expect(p.status).toBe('proposed');
    L.propose('release', 10.5, 20.1, 19.1, 21.1, 0.52, 'tension', 21.1);
    expect(p.status).toBe('proposed');
    L.propose('release', 11, 22, 21, 23, 0.7, 'tension', 23);
    expect(p.status).toBe('updated'); expect(p.updates).toBe(1); expect(p.created).toBe(10);
    expect(f.predictions.filter(x => x.id !== 0)).toHaveLength(1);
    expect(f.stats.proposed[KIND.release]).toBe(1);
  });

  it('is confirmed only inside its window and not by an observation older than itself; outcomes, lead and Brier are counted', () => {
    const f = createCognition(), L = new PredictionLedger(f), seen: Prediction[] = [];
    L.onResolve = (p) => { seen.push({ ...p }); };
    L.propose('phrase', 10, 20, 19.5, 20.5, 0.8, 'grid', 21);
    expect(L.observe('phrase', 19, 19.2)).toBeNull();
    expect(L.observe('phrase', 20.2, 20.4)).not.toBeNull();
    expect(seen[0]).toMatchObject({ status: 'confirmed', observed: 20.2 });
    expect(seen[0].error).toBeCloseTo(0.2, 9);
    expect(f.stats.confirmed[KIND.phrase]).toBe(1);
    expect(f.stats.lead[KIND.phrase]).toBeCloseTo(10.2, 5);
    expect(f.stats.brier[KIND.phrase]).toBeCloseTo(0.04, 5);
    // An observation from before the prediction existed confirms nothing.
    L.propose('downbeat', 30, 31, 29, 32, 0.6, 'grouping', 32);
    expect(L.observe('downbeat', 29.5, 30.1)).toBeNull();
    expect(L.open('downbeat')).not.toBeNull();
  });

  it('expires what outlives its horizon, refutes on evidence, withdraws without counting', () => {
    const f = createCognition(), L = new PredictionLedger(f);
    L.propose('transition', 0, 5, 4.5, 5.5, 0.6, 'pattern', 6);
    expect(L.tick(5.9)).toBeNull();
    expect(L.tick(6.1)!.kind).toBe('transition');
    expect(f.stats.expired[KIND.transition]).toBe(1);
    expect(f.stats.brier[KIND.transition]).toBeCloseTo(0.36, 5);
    L.propose('release', 7, 9, 8, 10, 0.5, 'tension', 10);
    L.refute('release', 8);
    expect(f.stats.refuted[KIND.release]).toBe(1);
    L.propose('phrase', 11, 12, 11.5, 12.5, 0.5, 'grid', 13);
    L.withdraw();
    expect(f.predictions.every(p => p.id === 0)).toBe(true);
    expect(f.stats.proposed[KIND.phrase]).toBe(1);
    expect(f.stats.expired[KIND.phrase] + f.stats.refuted[KIND.phrase] + f.stats.confirmed[KIND.phrase]).toBe(0);
  });

  it('keeps the last resolutions newest first, beats only counted', () => {
    const f = createCognition(), L = new PredictionLedger(f);
    for (let i = 0; i < 12; i++) { L.propose('downbeat', i, i + 0.5, i + 0.4, i + 0.6, 0.5, 'g', i + 0.7); L.tick(i + 0.8); }
    L.propose('beat', 20, 20.5, 20.4, 20.6, 0.9, 'grid', 20.7); L.tick(21);
    expect(f.recent[0].time).toBeCloseTo(11.5, 9);
    expect(f.recent.every(p => p.kind === 'downbeat')).toBe(true);
    expect(f.stats.expired[KIND.beat]).toBe(1);
  });

  it('the structural expectation weighs confidence by proximity, beats and downbeats aside', () => {
    const f = createCognition(), L = new PredictionLedger(f);
    L.propose('beat', 0, 0.4, 0.3, 0.5, 1, 'grid', 0.6);
    L.propose('downbeat', 0, 1, 0.9, 1.1, 1, 'grouping', 1.2);
    expect(L.expectation(0, 8)).toBe(0);
    L.propose('release', 0, 4, 3, 5, 0.8, 'tension', 5);
    expect(L.expectation(0, 8)).toBeCloseTo(0.4, 9);
    expect(L.expectation(4, 8)).toBeCloseTo(0.8, 9);
  });
});

describe('musical knowledge', () => {
  it('universal priors: phrase lengths sum to one, tempo plausibility peaks at 120 and falls by the octave', () => {
    const blend = new StyleBlend();
    expect([...blend.priors.phrase].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(blend.priors.phrase.length).toBe(PHRASES.length);
    expect(tempoPrior(120)).toBeCloseTo(1, 9);
    expect(tempoPrior(240)).toBeLessThan(0.65);
    expect(tempoPrior(60)).toBeCloseTo(tempoPrior(240), 9);
  });

  it('profiles weigh the priors by resemblance, never past the generic floor, and relax back without evidence', () => {
    const blend = new StyleBlend();
    const dnb = { bpm: 174, regularity: 0.9, percussive: 0.5, density: 7, low: 0.8 };
    for (let i = 0; i < 600; i++) blend.update(dnb, 0.5);
    expect(blend.weights[0]).toBeGreaterThanOrEqual(GENERIC_FLOOR - 1e-6);
    expect(blend.leading).toBe('drumAndBass');
    // Leaned towards the profile's half-time prior, never all the way (the generic share stays).
    expect(blend.priors.halfTime).toBeGreaterThan(0.15);
    const ambient = { bpm: 0, regularity: 0.05, percussive: 0.02, density: 0.3, low: 0.2 };
    for (let i = 0; i < 600; i++) blend.update(ambient, 0.5);
    expect(blend.leading).toBe('ambient');
    for (let i = 0; i < 600; i++) blend.update(null, 0.5);
    expect(blend.leading).toBe('generic');
    expect(blend.weights[0]).toBeGreaterThan(0.95);
  });

  it('a regular four-on-the-floor alone does not decide a style: it resembles several', () => {
    const blend = new StyleBlend();
    for (let i = 0; i < 600; i++) blend.update({ bpm: 128, regularity: 0.95, percussive: 0.42, density: 4.8, low: 0.82 }, 0.5);
    const [, techno, house] = blend.weights;
    expect(Math.min(techno, house) / Math.max(techno, house)).toBeGreaterThan(0.3);
    expect(blend.weights[0]).toBeGreaterThanOrEqual(GENERIC_FLOOR - 1e-6);
  });
});
