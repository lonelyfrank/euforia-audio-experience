import { describe, expect, it, vi } from 'vitest';
import { SignalGenerator, type TestSignal } from '../../audio/capture/testSignals';
import { WasmAnalysis } from '../../audio/features/WasmAnalysis';
import { ExperienceEngine } from '../ExperienceEngine';
import type { MusicalState, Prediction } from './types';

/*
 * The cognition on the real path: deterministic test signals (audio/capture/testSignals.ts) through the WASM analysis
 * (the same DSP as the desktop), the decoder and ExperienceEngine, as the replay does. The beat tracker here is the
 * DSP's own. Synthetic audio, not music: these are regressions of known behaviour, not a validation (docs/musical-cognition.md §9).
 */

// Each run analyses up to a minute of audio (about 6× faster than real time on the development machine).
vi.setConfig({ testTimeout: 120000 });

interface Run { engine: ExperienceEngine; resolved: Prediction[]; heard: number[]; states: Set<MusicalState>; meters: Set<number>; positions: Set<number> }
async function play(signal: TestSignal, seconds: number): Promise<Run> {
  const wasm = await WasmAnalysis.create(48000, 2), engine = new ExperienceEngine(), d = wasm.decoder;
  const run: Run = { engine, resolved: [], heard: [], states: new Set(), meters: new Set(), positions: new Set() };
  engine.cognition.ledger.onResolve = (p) => { run.resolved.push({ ...p }); };
  engine.cognition.onRelease = (t) => { run.heard.push(t); };
  d.onFrame = (a) => {
    engine.ingest(a);
    const c = engine.cognition.frame;
    run.states.add(c.understanding.state); run.meters.add(c.clock.meter);
    if (c.clock.barPosition >= 0) run.positions.add(c.clock.barPosition);
  };
  d.onOnset = (o) => engine.onset(o);
  d.onBeat = (b) => engine.beat(b);
  d.onSection = (s) => engine.section(s);
  const generator = new SignalGenerator(signal, 48000), chunk = new Float32Array(480 * 2);
  try {
    for (let n = 0; n < seconds * 100; n++) { d.begin(); generator.fillStereo(chunk, 480); wasm.push(chunk); }
  } finally { wasm.dispose(); }
  return run;
}
const confirmedShare = (r: Run, kind: Prediction['kind']): number => {
  const mine = r.resolved.filter(p => p.kind === kind);
  return mine.length ? mine.filter(p => p.status === 'confirmed').length / mine.length : NaN;
};

describe('musical cognition on test signals through the WASM analysis', () => {
  it('beat124: locked at 124, beats confirmed by the onsets, grouped in 4 by its harmonic changes, no phrase and no release invented', async () => {
    const r = await play('beat124', 40), c = r.engine.cognition.frame;
    expect(c.clock.state).toBe('locked');
    expect(c.clock.bpm).toBeCloseTo(124, 0);
    expect(confirmedShare(r, 'beat')).toBeGreaterThan(0.95);
    expect(c.clock.syncErrorMs).toBeLessThan(15);
    // Four equal kicks give the tracker no accent (it publishes no meter); the bass line's changes give the grouping.
    expect(c.clock.meter).toBe(4);
    expect(confirmedShare(r, 'downbeat')).toBeGreaterThan(0.6);
    expect(c.clock.phraseBar).toBe(-1);
    expect(c.stats.releases).toBe(0);
    expect(c.stats.proposed[4]).toBe(0);
    expect(c.understanding.state).toBe('stableGroove');
    expect(c.clock.ambiguity).toBeLessThan(0.2);
  });

  it('waltz: grouped in 3 (accent and harmony agree), never a 4/4 bar', async () => {
    const r = await play('waltz', 40), c = r.engine.cognition.frame;
    expect(c.clock.meter).toBe(3);
    expect(r.meters.has(4)).toBe(false);
    expect([...r.positions].every(p => p < 3)).toBe(true);
    expect(confirmedShare(r, 'downbeat')).toBeGreaterThan(0.9);
  });

  it('startStop: pauses carry the grid then lose it, music comes back without a release; the experience\'s drops there are counted as unheard', async () => {
    const r = await play('startStop', 50), c = r.engine.cognition.frame;
    expect(c.clock.losses).toBeGreaterThanOrEqual(2);
    expect(c.clock.relocks).toBeGreaterThanOrEqual(2);
    expect(r.heard).toHaveLength(0);
    expect(c.stats.proposed[4]).toBe(0);
    // docs/music-response.md §2.5: the experience reads a restart as a build; the cognition hears no release there.
    expect(c.stats.experienceDrops).toBeGreaterThanOrEqual(1);
    expect(c.stats.experienceDropsUnheard).toBe(c.stats.experienceDrops);
    expect(r.states.has('unknown')).toBe(true);
  });

  it('buildDrop: the build is read as rising tension and both drops are heard where the low end comes back — never before', async () => {
    const r = await play('buildDrop', 58), c = r.engine.cognition.frame;
    expect(r.states.has('risingTension')).toBe(true);
    expect(r.heard).toHaveLength(2);
    // The bass returns at 18.0 s and 50.0 s, the first kick a quarter of a second later.
    for (const [i, drop] of [18, 50].entries()) {
      expect(r.heard[i]).toBeGreaterThanOrEqual(drop - 0.1);
      expect(r.heard[i]).toBeLessThan(drop + 0.6);
    }
    expect(c.stats.releasesUnannounced).toBe(0);
    expect(r.resolved.filter(p => p.kind === 'release' && p.status === 'confirmed').length).toBeGreaterThanOrEqual(1);
    // The experience's own drop events, compared with the heard releases (docs/music-response.md §2.4).
    expect(c.stats.experienceDrops).toBeGreaterThanOrEqual(1);
  });

  it('pad and white noise: no pulse, no prediction, nothing heard', async () => {
    for (const signal of ['pad', 'whiteNoise'] as const) {
      const r = await play(signal, 16), c = r.engine.cognition.frame;
      expect(c.clock.state, signal).toBe('none');
      expect([...c.stats.proposed].reduce((a, b) => a + b, 0), signal).toBe(0);
      expect(r.heard, signal).toHaveLength(0);
      expect(r.states.has('stableGroove'), signal).toBe(false);
    }
  });
});
