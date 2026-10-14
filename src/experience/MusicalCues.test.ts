import { describe, expect, it, vi } from 'vitest';
import { SignalGenerator, type TestSignal } from '../audio/capture/testSignals';
import { WasmAnalysis } from '../audio/features/WasmAnalysis';
import { createAnticipation } from './Anticipation';
import { MusicalCognition } from './cognition/MusicalCognition';
import { cognitionSink, runScenario, SCENARIOS, type Truth } from './cognition/scenarios';
import { createCognition, createPrediction } from './cognition/types';
import { EventStream } from './EventStream';
import { ExperienceEngine } from './ExperienceEngine';
import { ACCENT_SIGNIFICANCE, CUE_SLOTS, copyCues, createCues, DROP_MATCH, forEachCue, MusicalCues, RESUME, SETTLE, type Cue } from './MusicalCues';

// The runs through the WASM analysis take a few seconds each on the development machine.
vi.setConfig({ testTimeout: 120000 });

const read = (cues: MusicalCues, from = 0): Cue[] => { const out: Cue[] = []; forEachCue(cues.frame, from, (c) => out.push({ ...c })); return out; };

/** A cognition frame and an anticipation frame set by hand, and the session's events, stepped hop by hop. */
function bench() {
  const cues = new MusicalCues(), events = new EventStream(), cognition = createCognition(), anticipation = createAnticipation();
  cognition.understanding.silence = 'none'; cognition.understanding.state = 'stableGroove';
  let now = 0;
  const run = (until: number, each?: (t: number) => void): void => {
    for (; now < until - 1e-9; now = Math.round((now + 0.01) * 1000) / 1000) { each?.(now); cues.hop(now, events, cognition, anticipation); }
  };
  return { cues, events, cognition, anticipation, run, get now() { return now; } };
}

describe('musical cues: what the scenes\' structural actions may act on', () => {
  it('an experience drop is never a cue by itself: unconfirmed without a release heard, matched with one', () => {
    const b = bench();
    b.run(5);
    b.events.push('drop', 5, 0.8, 0.9, -1, 0.7, 0, 0.95);
    b.run(12);
    expect(read(b.cues)).toEqual([]);
    expect(b.cues.frame.stats).toMatchObject({ releases: 0, dropsUnconfirmed: 1, dropsMatched: 0 });
    // A release heard 0.3 s after another drop: the release is the cue, the drop is counted as matched.
    b.events.push('drop', 12.2, 0.8, 0.9, -1, 0.7, 0, 0.95);
    b.run(12.6);
    b.cognition.stats.lastRelease = 12.5;
    b.run(16);
    const cues = read(b.cues);
    expect(cues.map((c) => [c.kind, c.status, c.time])).toEqual([['release', 'confirmed', 12.5]]);
    expect(b.cues.frame.stats).toMatchObject({ releases: 1, dropsMatched: 1, dropsUnconfirmed: 1 });
    expect(Math.abs(12.5 - 12.2)).toBeLessThanOrEqual(DROP_MATCH);
  });

  it('accents: only attacks that stand out, with confidence, not too close together, and not the music coming back after a silence', () => {
    const b = bench();
    b.run(1, (t) => {
      const k = Math.round(t * 100);
      if (k % 10 === 0) b.events.push('impact', t, 0.4, 0.9, 1, 0.3, 0, k === 50 ? 0.9 : 0.35);
    });
    b.events.push('impact', 1.0, 0.6, 0.3, 1, 0.3, 0, 0.95);
    b.events.push('impact', 1.1, 0.6, 0.9, 1, 0.3, 0, ACCENT_SIGNIFICANCE);
    b.events.push('impact', 1.2, 0.6, 0.9, 1, 0.3, 0, 0.99);
    b.run(2);
    expect(read(b.cues).map((c) => [c.kind, c.time])).toEqual([['accent', 0.5], ['accent', 1.1]]);
    b.events.push('silenceEnd', 3, 0.5, 1, -1, 0, 1);
    b.events.push('impact', 3.2, 0.8, 0.9, 1, 0.3, 0, 1);
    b.events.push('impact', 3 + RESUME + 0.1, 0.8, 0.9, 1, 0.3, 0, 1);
    b.run(6);
    expect(read(b.cues).map((c) => c.time)).toEqual([0.5, 1.1, 3 + RESUME + 0.1]);
    expect(b.cues.frame.stats).toMatchObject({ accents: 3, restarts: 1 });
  });

  it('a prediction prepares and is withdrawn when given up; it never becomes a release', () => {
    const b = bench(), p = b.cognition.predictions[0];
    b.run(2);
    Object.assign(p, createPrediction(), { id: 7, kind: 'release', status: 'proposed', time: 6, early: 5, late: 8, confidence: 0.6 });
    b.run(4);
    expect(b.cues.frame.expectation).toBeGreaterThan(0.3);
    p.time = 5;
    b.run(9);
    Object.assign(p, createPrediction());
    b.run(10);
    expect(read(b.cues).map((c) => [c.kind, c.status, c.ref])).toEqual([['prepare', 'predicted', 7], ['withdraw', 'refuted', 7]]);
    expect(b.cues.frame.stats).toMatchObject({ prepared: 1, withdrawn: 1, releases: 0 });
    // A prediction that is confirmed by a release heard: the release refers to it, nothing is withdrawn.
    Object.assign(p, createPrediction(), { id: 8, kind: 'release', status: 'proposed', time: 14, early: 13, late: 16, confidence: 0.7 });
    b.run(12);
    b.cognition.stats.lastRelease = 13.9;
    Object.assign(p, createPrediction());
    b.run(15);
    expect(read(b.cues, 2).map((c) => [c.kind, c.status, c.ref])).toEqual([['prepare', 'predicted', 8], ['release', 'confirmed', 8]]);
    // Weak predictions prepare nothing.
    Object.assign(p, createPrediction(), { id: 9, kind: 'release', status: 'proposed', time: 20, early: 19, late: 22, confidence: 0.2 });
    b.run(18);
    expect(b.cues.frame.stats.prepared).toBe(2);
  });

  it('without the cognition nothing is confirmed or predicted; a reset starts the session over; a consumer\'s cursor reads each cue once', () => {
    const b = bench();
    b.cognition.enabled = false; b.cognition.stats.lastRelease = 3;
    Object.assign(b.cognition.predictions[0], { id: 3, kind: 'release', confidence: 0.9, time: 4 });
    b.run(5);
    expect(read(b.cues)).toEqual([]);
    expect(b.cues.frame).toMatchObject({ live: false, phase: 'unknown' });
    b.cognition.enabled = true; b.cognition.predictions[0].id = 0;
    b.run(6);
    let cursor = 0, seen = 0;
    for (let k = 0; k < 40; k++) {
      b.events.push('impact', 6 + k * 0.5, 0.8, 0.9, 1, 0.3, 0, 0.9);
      b.run(6.5 + k * 0.5);
      cursor = forEachCue(b.cues.frame, cursor, () => { seen++; });
    }
    // The release heard at 3 (already there when the cognition came back) and forty accents, each read once, past the ring's size.
    expect(seen).toBe(41); expect(seen).toBeGreaterThan(CUE_SLOTS);
    const copy = createCues();
    copyCues(copy, b.cues.frame);
    expect(copy.cues).not.toBe(b.cues.frame.cues); expect(copy.seq).toBe(b.cues.frame.seq); expect(copy.cues[3]).toEqual(b.cues.frame.cues[3]);
    // A new session resets the engine's cognition too.
    b.cues.reset(); b.events.reset(); b.cognition.stats.lastRelease = 0;
    expect(b.cues.frame.seq).toBe(0); expect(b.cues.frame.stats.accents).toBe(0);
    // A consumer holding a cursor from the last session starts over.
    b.events.push('impact', 100, 0.8, 0.9, 1, 0.3, 0, 0.9);
    b.run(100.5);
    expect(forEachCue(b.cues.frame, cursor, () => { seen++; })).toBe(1);
  });
});

/**
 * The cognition's synthetic pieces (mock DSP, deterministic), with the experience's drops placed where they were measured
 * on test signals (docs/music-response.md §2.4–2.5: about 2 s before and after each musical drop, and 3–6 s after a
 * restart): only the release heard may come out as a release.
 */
function scenario(id: string): { cues: MusicalCues; truth: Truth } {
  const cognition = new MusicalCognition(), cues = new MusicalCues(), events = new EventStream(), anticipation = createAnticipation();
  const inner = cognitionSink(cognition), drops: number[] = [];
  const truth = runScenario(SCENARIOS.find((s) => s.id === id)!, {
    ...inner,
    start: (t) => {
      for (const r of t.releases) drops.push(r - 2, r + 2.2);
      for (const [, end] of t.silences) drops.push(end + 4);
      drops.sort((a, b) => a - b);
    },
    hop: (a, context, dt) => {
      inner.hop(a, context, dt);
      while (drops.length && drops[0] <= a.time) events.push('drop', drops.shift()!, 0.3, 0.6, -1, 0.5, 0, 0.6);
      anticipation.level = context.anticipation * context.anticipationConfidence;
      cues.hop(a.time, events, cognition.frame, anticipation);
    },
  });
  return { cues, truth };
}

describe('musical cues on the cognition\'s synthetic pieces', () => {
  it('buildDrop: one release, where the low end comes back, prepared beforehand; the drops off it are not releases', () => {
    const { cues, truth } = scenario('buildDrop'), all = read(cues);
    const releases = all.filter((c) => c.kind === 'release');
    expect(truth.releases).toHaveLength(1);
    expect(releases).toHaveLength(1);
    expect(releases[0].time).toBeGreaterThanOrEqual(truth.releases[0] - 0.1); expect(releases[0].time).toBeLessThan(truth.releases[0] + 0.6);
    expect(releases[0].status).toBe('confirmed');
    expect(all.findIndex((c) => c.kind === 'prepare')).toBeLessThan(all.findIndex((c) => c.kind === 'release'));
    expect(cues.frame.stats.dropsUnconfirmed).toBe(2);
  });

  it('falseBuild: prepared, then withdrawn; no release, whatever the experience fires', () => {
    const { cues } = scenario('falseBuild'), all = read(cues);
    expect(all.filter((c) => c.kind === 'release')).toEqual([]);
    expect(cues.frame.stats.prepared).toBeGreaterThanOrEqual(1);
    expect(cues.frame.stats.withdrawn).toBe(cues.frame.stats.prepared);
  });

  it('pauses, tempo and meter changes, a lost source: no release and nothing to prepare for', () => {
    for (const id of ['shortPause', 'longPause', 'tempoChange', 'meterChange', 'stable', 'sourceLost']) {
      const { cues } = scenario(id);
      expect(cues.frame.stats.releases, id).toBe(0);
      expect(cues.frame.stats.prepared, id).toBe(0);
    }
  });
});

/** Test signals through the WASM analysis and the experience engine, as the replay does: the engine's own cues. */
async function play(signal: TestSignal, seconds: number): Promise<{ engine: ExperienceEngine; cues: Cue[] }> {
  const wasm = await WasmAnalysis.create(48000, 2), engine = new ExperienceEngine(), d = wasm.decoder, cues: Cue[] = [];
  let cursor = 0;
  d.onFrame = (a) => { engine.ingest(a); cursor = forEachCue(engine.cues.frame, cursor, (c) => cues.push({ ...c })); };
  d.onOnset = (o) => engine.onset(o); d.onBeat = (b) => engine.beat(b); d.onSection = (s) => engine.section(s);
  const generator = new SignalGenerator(signal, 48000), chunk = new Float32Array(480 * 2);
  try {
    for (let n = 0; n < seconds * 100; n++) { d.begin(); generator.fillStereo(chunk, 480); wasm.push(chunk); }
  } finally { wasm.dispose(); }
  return { engine, cues };
}

describe('musical cues on test signals through the WASM analysis', () => {
  it('buildDrop: two releases, at the drops (18 s, 50 s), never before; the experience\'s drops around them are not cues', async () => {
    const { engine, cues } = await play('buildDrop', 58), releases = cues.filter((c) => c.kind === 'release');
    expect(releases.map((c) => c.status)).toEqual(['confirmed', 'confirmed']);
    for (const [i, drop] of [18, 50].entries()) { expect(releases[i].time).toBeGreaterThanOrEqual(drop - 0.1); expect(releases[i].time).toBeLessThan(drop + 0.6); }
    const s = engine.cues.frame.stats;
    expect(s.dropsMatched + s.dropsUnconfirmed).toBe(engine.cognition.frame.stats.experienceDrops);
    // Measured: the experience fires about 2 s before and after each drop (docs/music-response.md §2.4); none is a cue.
    expect(s.dropsUnconfirmed).toBeGreaterThanOrEqual(2);
    // Prepared before each release, and nothing prepared in the seconds right after one (the tension has just resolved).
    const prepares = cues.filter((c) => c.kind === 'prepare');
    for (const drop of [18, 50]) expect(prepares.some((c) => c.time < drop && c.time > drop - 8)).toBe(true);
    for (const c of prepares) for (const r of releases) expect(c.time - r.time < 0 || c.time - r.time >= SETTLE).toBe(true);
    expect(prepares).toHaveLength(2);
    expect(s.withdrawn).toBe(0);
  });

  it('startStop: the music coming back is neither a release nor an accent; the experience\'s drops there stay unconfirmed', async () => {
    const { engine, cues } = await play('startStop', 50), s = engine.cues.frame.stats;
    expect(cues.filter((c) => c.kind === 'release')).toEqual([]);
    expect(s.prepared).toBe(0);
    expect(s.dropsUnconfirmed).toBe(engine.cognition.frame.stats.experienceDrops);
    expect(s.dropsUnconfirmed).toBeGreaterThanOrEqual(1);
    for (const c of cues.filter((c) => c.kind === 'accent')) expect(c.status).toBe('observed');
  });

  it('beat124: a steady groove gives no release, no preparation and accents only now and then', async () => {
    const { engine, cues } = await play('beat124', 40), s = engine.cues.frame.stats;
    expect(s.releases).toBe(0); expect(s.prepared).toBe(0);
    // 124 BPM over 40 s is about 80 kicks: an accent is an exception among them, never one per kick.
    expect(cues.filter((c) => c.kind === 'accent').length).toBeLessThan(80 * 0.25);
    expect(engine.cues.frame.phase).toBe('groove');
  });
});
