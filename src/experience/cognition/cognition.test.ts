import { describe, expect, it, vi } from 'vitest';
import { newFrame } from '../../audio/features/decode';
import { ExperienceEngine } from '../ExperienceEngine';
import { followCognition } from './director';
import { evaluate } from './evaluate';
import { MusicalCognition } from './MusicalCognition';
import { cognitionSink, runScenario, SCENARIOS, type Scenario, type ScenarioSink } from './scenarios';
import { createCognition, presentClock, type MusicalState, type Prediction } from './types';

/*
 * The cognition on synthetic feature sequences of known form (scenarios.ts): deterministic, no audio. The tracker in
 * those sequences is a mock of the DSP's; signals.test.ts runs real test signals through the WASM analysis.
 */

// Minutes of synthetic hops per test, some several scenarios over: more than the default 5 s on a power-limited machine.
vi.setConfig({ testTimeout: 60000 });

const scenario = (id: string): Scenario => SCENARIOS.find(s => s.id === id)!;
/** Runs a scenario into a fresh cognition, with a probe called after every hop. */
function run(id: string, each?: (c: MusicalCognition, time: number) => void, setup?: (c: MusicalCognition) => void) {
  const c = new MusicalCognition(), resolved: Prediction[] = [], heard: number[] = [];
  setup?.(c);
  c.ledger.onResolve = (p) => { resolved.push({ ...p }); };
  c.onRelease = (t) => { heard.push(t); };
  const sink = cognitionSink(c), hop = sink.hop;
  sink.hop = (a, context, dt) => { hop(a, context, dt); each?.(c, a.time); };
  const truth = runScenario(scenario(id), sink);
  return { c, truth, resolved, heard };
}

describe('musical cognition: clock', () => {
  it('1 · a stable beat: locked, on the true beats, tempo exact, bars where the downbeats are', () => {
    const e = evaluate(scenario('stable'));
    expect(e.beatErrorMs).toBeLessThan(10);
    expect(e.beatCoverage).toBeGreaterThan(0.85);
    expect(e.bpmErrorPct).toBeLessThan(1);
    expect(e.downbeatAccuracy).toBe(1);
    expect(e.predictions.beat.precision).toBeGreaterThan(0.95);
    expect(e.losses).toBe(0);
  });

  it('2 · a change of tempo is followed and noticed, the grid is not lost', () => {
    const e = evaluate(scenario('tempoChange'));
    expect(e.losses).toBe(0);
    expect(e.surprises.tempoChange).toBe(1);
    expect(e.beatErrorMs).toBeLessThan(20);
    const { c } = run('tempoChange');
    expect(c.frame.clock.bpm).toBeCloseTo(132, 0);
  });

  it('3 · half / double time: the ambiguity is reported as a plausibility, and lowers what rests on the grid', () => {
    let half = 0, double = 0, plainHalf = 0, plainDouble = 0;
    run('halfTime', (c) => { half = Math.max(half, c.frame.clock.halfTime); });
    run('doubleTime', (c) => { double = Math.max(double, c.frame.clock.doubleTime); });
    run('stable', (c) => { plainHalf = Math.max(plainHalf, c.frame.clock.halfTime); plainDouble = Math.max(plainDouble, c.frame.clock.doubleTime); });
    expect(half).toBeGreaterThan(0.5);
    expect(double).toBeGreaterThan(0.5);
    // A steady four-on-the-floor with off-beat hats is not ambiguous.
    expect(Math.max(plainHalf, plainDouble)).toBeLessThan(0.2);
    // The tracker's tempo is kept as it is: the ambiguity is a reading, not a correction.
    const { c } = run('halfTime');
    expect(c.frame.clock.bpm).toBeCloseTo(172, 0);
  });

  it('4 · a meter other than 4/4: grouped in 3, bar positions modulo 3, never a 4/4 bar', () => {
    const positions = new Set<number>();
    let meters = new Set<number>();
    const { c } = run('waltz', (c) => { if (c.frame.clock.barPosition >= 0) positions.add(c.frame.clock.barPosition); meters.add(c.frame.clock.meter); });
    expect(c.frame.clock.meter).toBe(3);
    expect([...positions].sort()).toEqual([0, 1, 2]);
    expect(meters.has(4)).toBe(false);
    expect(evaluate(scenario('waltz')).downbeatAccuracy).toBe(1);
    // A change of meter is followed: 3 at the end, and it was 4 before.
    meters = new Set<number>();
    const change = run('meterChange', (c) => { meters.add(c.frame.clock.meter); });
    expect(meters.has(4)).toBe(true);
    expect(change.c.frame.clock.meter).toBe(3);
  });

  it('5 · a beat the music used to mark goes missing: an absence is noticed, the grid holds', () => {
    const { c } = run('dropout');
    expect(c.frame.stats.missedBeats).toBeGreaterThanOrEqual(1);
    expect(c.frame.clock.losses).toBe(0);
    expect(evaluate(scenario('dropout')).surprises.missedBeat).toBeGreaterThanOrEqual(1);
  });

  it('6 · after a short pause the grid continues and the bar count goes on; after a long one it is lost and regained', () => {
    const short = evaluate(scenario('shortPause'));
    expect(short.continuations).toBe(1);
    expect(short.losses).toBe(0);
    const states: string[] = [];
    run('shortPause', (c) => { if (states.at(-1) !== c.frame.clock.state) states.push(c.frame.clock.state); });
    expect(states).toContain('coasting');
    const long = evaluate(scenario('longPause'));
    expect(long.losses).toBe(1);
    expect(long.relocks).toBe(1);
    expect(long.continuations).toBe(0);
    // Regained within a few seconds of the music coming back (the tracker needs two of them first).
    expect(long.relockSeconds).toBeLessThan(4);
  });

  it('the clock does not run on without a signal: coasting ends within two bars and four seconds', () => {
    let coastingSince = -1, longest = 0;
    run('longPause', (c, t) => {
      if (c.frame.clock.state === 'coasting') { if (coastingSince < 0) coastingSince = t; longest = Math.max(longest, t - coastingSince); } else coastingSince = -1;
    });
    expect(longest).toBeGreaterThan(0.3);
    expect(longest).toBeLessThanOrEqual(4.01);
  });

  it('confidence falls while evidence is missing (coasting) and is zero once the grid is lost', () => {
    let previous = '', last = 0, rises = 0, lostWithConfidence = 0, coasted = 0;
    run('longPause', (c) => {
      const { state, confidence } = c.frame.clock;
      if (state === 'coasting') { coasted++; if (previous === 'coasting' && confidence > last + 1e-12) rises++; }
      if ((state === 'lost' || state === 'none') && confidence !== 0) lostWithConfidence++;
      previous = state; last = confidence;
    });
    expect(coasted).toBeGreaterThan(10);
    expect(rises).toBe(0);
    expect(lostWithConfidence).toBe(0);
  });
});

describe('musical cognition: structure and memory', () => {
  it('7 · a repeated pattern is recognized (its length), and repetition is not novelty', () => {
    let novelty = 0;
    const { c } = run('loop', (c, t) => { if (t > 20) novelty = Math.max(novelty, c.frame.understanding.novelty); });
    expect(c.frame.understanding.pattern).toBe(4);
    expect(c.frame.understanding.repetition).toBeGreaterThan(0.6);
    expect(novelty).toBeLessThan(0.3);
    // A loop with no phrase boundaries gets no phrase grid.
    expect(c.frame.clock.phraseBar).toBe(-1);
  });

  it('9 · phrase boundaries: the length is inferred, boundaries are predicted and confirmed where they are', () => {
    const e = evaluate(scenario('stable'));
    expect(e.phrasePrecision).toBe(1);
    expect(e.phraseRecall).toBeGreaterThanOrEqual(0.5);
    const { c } = run('stable');
    expect(c.frame.clock.phraseBars).toBe(8);
    const long = run('phrases16');
    expect(long.c.frame.clock.phraseBars).toBe(16);
    expect(evaluate(scenario('phrases16')).phrasePrecision).toBe(1);
  });

  it('a phrase position is never shown without downbeat evidence and confidence', () => {
    for (const id of ['stable', 'loop', 'noise', 'halfTime', 'longPause']) {
      run(id, (c) => {
        const k = c.frame.clock;
        if (k.phraseBar >= 0) { expect(k.barPosition).toBeGreaterThanOrEqual(0); expect(k.phraseConfidence).toBeGreaterThanOrEqual(0.3); }
        if (k.barPosition >= 0) { expect(k.meter).toBeGreaterThan(0); expect(k.downbeatConfidence).toBeGreaterThanOrEqual(0.3); }
      });
    }
  });

  it('8 · 12 · a change outside the expected phrase is a surprise, and the phrase grid is not trusted blindly', () => {
    const e = evaluate(scenario('offPhrase'));
    const flagged = (e.surprises.offPhraseChange ?? 0) + (e.surprises.patternBreak ?? 0);
    expect(flagged).toBeGreaterThanOrEqual(1);
    // The phrase prediction that the change contradicted did not end confirmed.
    const { resolved } = run('offPhrase');
    expect(resolved.filter(p => p.kind === 'phrase' && p.status === 'confirmed').every(p => Math.abs(p.error) < 0.6)).toBe(true);
  });
});

describe('musical cognition: reasoning, expectation, prediction', () => {
  it('11 · a build that drops: tension rises, a release is predicted, then heard on the drop — never before it', () => {
    let tension = 0;
    let drop = Infinity;
    const { c, truth, resolved, heard } = run('buildDrop', (c, t) => { if (t < drop) tension = Math.max(tension, c.frame.understanding.tension); }, (c) => { c.onRelease = (t) => { drop = Math.min(drop, t); }; });
    expect(tension).toBeGreaterThan(0.45);
    expect(heard.length).toBe(1);
    expect(heard[0]).toBeGreaterThanOrEqual(truth.releases[0] - 0.05);
    expect(heard[0] - truth.releases[0]).toBeLessThan(0.6);
    const confirmed = resolved.filter(p => p.kind === 'release' && p.status === 'confirmed');
    expect(confirmed.length).toBe(1);
    // Predicted ahead of time, confirmed by what was heard after the prediction.
    expect(confirmed[0].observed - confirmed[0].created).toBeGreaterThan(1);
    expect(c.frame.stats.releasesUnannounced).toBe(0);
  });

  it('a late drop: the expectation is carried past the boundary and the drop is still heard', () => {
    const { heard, truth, resolved } = run('lateDrop');
    expect(heard.length).toBe(1);
    expect(heard[0] - truth.releases[0]).toBeGreaterThanOrEqual(-0.05);
    expect(resolved.some(p => p.kind === 'release' && p.status === 'confirmed')).toBe(true);
  });

  it('10 · a build that goes nowhere: the release prediction is refuted or lapses, no release is heard', () => {
    const { c, resolved, heard } = run('falseBuild');
    expect(heard.length).toBe(0);
    expect(c.frame.stats.releases).toBe(0);
    const release = resolved.filter(p => p.kind === 'release');
    expect(release.length).toBeGreaterThanOrEqual(1);
    expect(release.every(p => p.status !== 'confirmed')).toBe(true);
    // It was read as a breakdown after the build.
    expect(evaluate(scenario('falseBuild')).states.breakdown).toBeGreaterThanOrEqual(1);
  });

  it('no release is confirmed by expectation alone: every heard release is near a true one, in every scenario', () => {
    for (const s of SCENARIOS) {
      const e = evaluate(s);
      expect(e.releasesEarly, s.id).toBe(0);
      expect(e.releasesHeard, s.id).toBe(e.releasesMatched);
    }
  });

  it('13 · audio that is not music: no pulse, no prediction, the reading stays unknown', () => {
    const states = new Set<MusicalState>();
    let reason = '';
    const { c } = run('noise', (c, t) => { states.add(c.frame.understanding.state); if (t > 10 && t < 30) reason = c.frame.understanding.reason; });
    expect(c.frame.clock.state).toBe('none');
    expect([...c.frame.stats.proposed].reduce((a, b) => a + b, 0)).toBe(0);
    expect([...states]).toEqual(['unknown']);
    expect(reason).toBe('sound without a periodic pulse');
  });

  it('14 · a long silence: no signal, nothing expected, nothing surprising', () => {
    const { c } = run('silence');
    const u = c.frame.understanding;
    expect(u.silence).toBe('noSignal');
    expect(u.state).toBe('unknown');
    expect(u.expectation).toBe(0);
    expect(c.frame.stats.surprises).toBe(0);
    expect(c.frame.clock.confidence).toBe(0);
  });

  it('a silence is not a surprise unless a groove was there to expect more: a pause in a groove is', () => {
    expect(evaluate(scenario('silence')).surprises.pause ?? 0).toBe(0);
    expect(evaluate(scenario('shortPause')).surprises.pause).toBeGreaterThanOrEqual(1);
  });

  it('15 · a source interrupted: the grid is lost and what rested on it withdrawn; the state says the source was lost', () => {
    const kinds = new Set<string>();
    const { c } = run('sourceLost', (c) => { kinds.add(c.frame.understanding.silence); });
    expect(kinds.has('sourceLost')).toBe(true);
    expect(c.frame.clock.losses).toBe(1);
    expect(c.frame.clock.relocks).toBe(1);
    // After a new session nothing of the old one holds.
    c.reset();
    expect(c.frame.clock.state).toBe('none');
    expect(c.frame.stats.proposed.every(n => n === 0)).toBe(true);
    expect(c.frame.predictions.every(p => p.id === 0)).toBe(true);
  });

  it('16 · a restart gives the same reading: deterministic, nothing kept across a reset', () => {
    const digest = (c: MusicalCognition): string => JSON.stringify({ clock: c.frame.clock, u: { ...c.frame.understanding, styles: [...c.frame.understanding.styles] }, s: [...c.frame.stats.proposed, ...c.frame.stats.confirmed] });
    const first = run('buildDrop').c;
    const again = new MusicalCognition();
    runScenario(scenario('loop'), cognitionSink(again));
    again.reset();
    runScenario(scenario('buildDrop'), cognitionSink(again));
    expect(digest(again)).toBe(digest(first));
  });

  it('predictions are never retroactive, never confirmed by an older observation, and resolve once', () => {
    for (const s of SCENARIOS) {
      const { resolved } = run(s.id);
      const ids = new Set<number>();
      for (const p of resolved) {
        expect(p.time, s.id).toBeGreaterThanOrEqual(p.created - 1e-9);
        if (p.status === 'confirmed') { expect(p.observed).toBeGreaterThanOrEqual(p.created - 1e-9); expect(p.observed).toBeGreaterThanOrEqual(p.early - 1e-9); expect(p.observed).toBeLessThanOrEqual(p.late + 1e-9); }
        expect(ids.has(p.id)).toBe(false); ids.add(p.id);
      }
    }
  });

  it('the reading does not flicker: dwell and hysteresis bound the changes of state', () => {
    for (const s of SCENARIOS) {
      const e = evaluate(s);
      expect(e.stateChangesPerMinute, s.id).toBeLessThan(15);
      expect(e.falseTransitions, s.id).toBe(0);
    }
  });

  it('expectation and surprise are bounded, finite and come with a confidence', () => {
    let outside = 0, unnamed = 0, hops = 0;
    for (const id of ['buildDrop', 'offPhrase', 'dropout', 'shortPause']) {
      run(id, (c) => {
        const u = c.frame.understanding;
        hops++;
        for (const v of [u.expectation, u.surprise, u.surpriseConfidence, u.tension, u.tensionConfidence, u.groove, u.pulse, u.confidence]) if (!(v >= 0 && v <= 1)) outside++;
        if (u.surprise > 0.05 && u.surpriseKind === 'none') unnamed++;
      });
    }
    expect(hops).toBeGreaterThan(10000);
    expect(outside).toBe(0);
    expect(unnamed).toBe(0);
  });

  it('style profiles weigh priors and never classify on a pulse alone: generic keeps its share', () => {
    const { c } = run('stable');
    const w = c.frame.understanding.styles;
    expect(w[0]).toBeGreaterThanOrEqual(0.3);
    expect([...w].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    const off = run('stable', undefined, (c) => { c.config.style = false; }).c;
    expect(off.frame.understanding.style).toBe('generic');
  });
});

describe('musical cognition: budget, lifecycle, the director', () => {
  it('17 · the low budget keeps the clock, the releases and the phrases, and costs no more', () => {
    for (const id of ['stable', 'buildDrop', 'shortPause']) {
      const full = evaluate(scenario(id)), low = evaluate(scenario(id), { budget: 'low', memorySeconds: 30 });
      expect(low.beatErrorMs, id).toBe(full.beatErrorMs);
      expect(low.releasesMatched, id).toBe(full.releasesMatched);
      expect(low.losses, id).toBe(full.losses);
    }
    expect(evaluate(scenario('stable'), { budget: 'low', memorySeconds: 30 }).phrasePrecision).toBe(1);
  });

  it('disabled: nothing is computed, the frame says so, and turning it back on starts clean', () => {
    const c = new MusicalCognition();
    c.config.enabled = false;
    runScenario(scenario('buildDrop'), cognitionSink(c));
    expect(c.frame.enabled).toBe(false);
    expect(c.frame.clock.state).toBe('none');
    expect(c.frame.stats.proposed.every(n => n === 0)).toBe(true);
    expect(c.frame.leads).toBe(false);
    c.config.enabled = true;
    runScenario(scenario('stable'), cognitionSink(c));
    expect(c.frame.enabled).toBe(true);
    expect(c.frame.clock.state).not.toBe('none');
  });

  it('the director follows the cognition only when it leads, and otherwise leaves the show\'s input as the DSP gave it', () => {
    const input = { phraseBar: 3, phraseBars: 8, nextPhraseTime: 10, structureConfidence: 0.6 } as Parameters<typeof followCognition>[0];
    const before = { ...input };
    const frame = createCognition();
    expect(followCognition(input, undefined)).toBe(false);
    expect(followCognition(input, frame)).toBe(false);
    expect(input).toEqual(before);
    frame.leads = true; Object.assign(frame.clock, { phraseBar: 7, phraseBars: 16, nextPhrase: 12.5, phraseConfidence: 0.8 });
    expect(followCognition(input, frame)).toBe(true);
    expect(input).toMatchObject({ phraseBar: 7, phraseBars: 16, nextPhraseTime: 12.5, structureConfidence: 0.8 });
    frame.enabled = false;
    const again = { ...before } as typeof input;
    expect(followCognition(again, frame)).toBe(false);
  });

  it('leads only with a confident phrase grid, and says why not otherwise', () => {
    const { c } = run('stable', (c) => {
      if (c.frame.leads) { expect(c.frame.clock.phraseConfidence).toBeGreaterThanOrEqual(0.5); expect(c.frame.diagnostics.fallback).toBe(''); }
      else expect(c.frame.diagnostics.fallback).not.toBe('');
    });
    void c;
    const noise = run('noise').c;
    expect(noise.frame.leads).toBe(false);
    expect(noise.frame.diagnostics.fallback).toBe('no grid');
  });

  it('the presented clock advances with the heard moment and nothing else', () => {
    const f = createCognition();
    Object.assign(f.clock, { state: 'locked', period: 0.5, confidence: 0.9, beatPhase: 0.9, beat: 10.9, meter: 4, barPhase: 0.975 });
    presentClock(f.clock, 20, 20.1);
    expect(f.clock.beatPhase).toBeCloseTo(0.1, 9);
    expect(f.clock.beat).toBeCloseTo(11.1, 9);
    expect(f.clock.barPhase).toBeCloseTo(0.025, 9);
    const still = createCognition();
    presentClock(still.clock, 20, 20.1);
    expect(still.clock).toEqual(createCognition().clock);
  });
});

describe('musical cognition inside the experience engine', () => {
  /** Drives an ExperienceEngine with a scenario (as the decoder would): hops, onsets, beats, sections. */
  function drive(engine: ExperienceEngine, id: string): void {
    const a = newFrame();
    const sink: ScenarioSink = {
      hop: (frame) => { Object.assign(a, frame); engine.ingest(a); }, onset: (o) => engine.onset(o), beat: (b) => engine.beat(b), section: (e) => engine.section(e), gap: () => {},
    };
    runScenario(scenario(id), sink);
  }
  const digest = (e: ExperienceEngine): string => {
    let events = '';
    for (let i = 0; i < e.events.count; i++) { const x = e.events.at(i); events += `${x.type}${x.audioTime}${x.strength}${x.confidence}|`; }
    return JSON.stringify({ world: e.world.state, state: e.state }) + events;
  };

  it('the experience, the world and the events are the same with the cognition on or off; the plan differs only when it leads', () => {
    const on = new ExperienceEngine(), off = new ExperienceEngine(), nodirect = new ExperienceEngine();
    off.cognition.config.enabled = false; nodirect.cognition.config.direct = false;
    for (const engine of [on, off, nodirect]) drive(engine, 'buildDrop');
    expect(digest(on)).toBe(digest(off));
    expect(digest(nodirect)).toBe(digest(off));
    // Without leading, the plan is the plan of before, number for number.
    expect(nodirect.planner.plan).toEqual(off.planner.plan);
    expect(off.cognition.frame.enabled).toBe(false);
    expect(on.cognition.frame.stats.releases).toBe(1);
  });

  it('a session reset reaches the cognition; a gap in the analysis interrupts it', () => {
    const engine = new ExperienceEngine();
    drive(engine, 'stable');
    expect(engine.cognition.frame.clock.state).not.toBe('none');
    engine.reset();
    expect(engine.cognition.frame.clock.state).toBe('none');
    expect(engine.presented.cognition.clock.state).toBe('none');
    const a = newFrame();
    drive(engine, 'stable');
    // A frame two seconds later than the last: frames were lost, the grid is lost with them.
    Object.assign(a, { time: engine.cognition.frame.time + 2, presence: 1, sounding: 1 });
    engine.ingest(a);
    expect(['lost', 'none']).toContain(engine.cognition.frame.clock.state);
    expect(engine.cognition.frame.understanding.silence).toBe('sourceLost');
  });

  it('the snapshot presented at the heard moment carries the cognition of that moment, never of a later one', () => {
    const engine = new ExperienceEngine();
    drive(engine, 'buildDrop');
    const heard = engine.cognition.frame.time - 0.3;
    const s = engine.present(heard)!;
    expect(s).toBeDefined();
    expect(s.cognition.time).toBeLessThanOrEqual(heard + 1e-9);
    expect(s.cognition.time).toBeGreaterThan(heard - 0.02);
  });
});
