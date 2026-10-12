import { describe, expect, it } from 'vitest';
import { SignalGenerator, type TestSignal } from '../audio/capture/testSignals';
import { newFrame, type AnalysisFrame } from '../audio/features/decode';
import { WasmAnalysis } from '../audio/features/WasmAnalysis';
import {
  AdaptiveMusicCalibration, CALIBRATION_PHASES, createCalibration, EVIDENCE, GAIN_MAX, GAIN_MIN, MIN_RANGE, SCALE_CALM, type CalibrationFrame,
} from './AdaptiveCalibration';
import { ExperienceEngine } from './ExperienceEngine';

const RATE = 200;

/** What a moment of a track is, as the hop frames say it. */
interface Moment {
  /** Momentary loudness (LUFS); null: silence. */
  lufs: number | null;
  /** Attacks per second, percussive share, the level of the lows against their own last seconds (0..1). */
  onsets?: number;
  percussive?: number;
  low?: number;
  floor?: number;
  presence?: number;
  quality?: number;
}

/**
 * Hop frames as the DSP would send them for a loudness that follows `at`: the online percentiles are tracked by the
 * same law as native/analysis/src/context.rs (stochastic steps of 3 LU/s), so the calibration is given what it is
 * given in the product.
 */
function source() {
  const a = newFrame(), q = [0, 0, 0, 0], P = [0.1, 0.5, 0.9, 0.95];
  let ready = false, time = 0;
  const next = (m: Moment, dt = 1 / RATE): AnalysisFrame => {
    time += dt;
    a.time = time; a.silent = m.lufs === null ? 1 : 0; a.presence = m.lufs === null ? 0 : m.presence ?? 1; a.sounding = a.presence > 0 ? 1 : 0;
    a.noiseFloorDb = m.floor ?? -70; a.energyConfidence = m.lufs === null ? 0 : (m.quality ?? 1) * a.presence;
    a.onsetDensity = m.onsets ?? 2; a.percussiveShare = m.percussive ?? 0.3;
    if (m.lufs !== null) {
      a.loudnessMomentary = m.lufs;
      if (!ready) { q.fill(m.lufs); ready = true; }
      for (let k = 0; k < 4; k++) q[k] += 3 * dt * (m.lufs > q[k] ? P[k] : P[k] - 1);
      for (let k = 1; k < 4; k++) q[k] = Math.max(q[k], q[k - 1]);
    } else a.loudnessMomentary = -70;
    for (let k = 0; k < 4; k++) a.loudnessQuantiles[k] = q[k];
    const low = m.lufs === null ? 0 : m.low ?? 0.5;
    for (let b = 0; b < 8; b++) { a.bandLevel[b] = m.lufs === null ? 0 : 0.7; a.bandRel[b] = b < 2 ? low : m.lufs === null ? 0 : 0.5; }
    return a;
  };
  return { next, restart: () => { ready = false; } };
}
type Source = ReturnType<typeof source>;

/** Feeds `seconds` of a track; `each` sees the calibration after every hop. */
function play(c: AdaptiveMusicCalibration, s: Source, seconds: number, at: (t: number) => Moment, each?: (f: CalibrationFrame, t: number) => void): void {
  for (let n = 1; n <= seconds * RATE; n++) { const t = n / RATE; c.update(s.next(at(t)), 1 / RATE); each?.(c.frame, t); }
}
/** A track whose level swings ±`swing` LU about `level` every four seconds, with a kick every half second in the lows. */
const track = (level: number, swing: number, over: Partial<Moment> = {}) => (t: number): Moment =>
  ({ lufs: level + swing * Math.sin(2 * Math.PI * t / 4), low: (t % 0.5) < 0.1 ? 0.9 : 0.25, ...over });

const bounded = (f: CalibrationFrame): void => {
  for (const key of ['confidence', 'energy', 'low', 'mid', 'high', 'transient', 'character', 'stability'] as const) {
    expect(Number.isFinite(f[key]), key).toBe(true); expect(f[key], key).toBeGreaterThanOrEqual(0); expect(f[key], key).toBeLessThanOrEqual(1);
  }
  expect(f.gain).toBeGreaterThanOrEqual(GAIN_MIN); expect(f.gain).toBeLessThanOrEqual(GAIN_MAX);
  expect(f.scale).toBeGreaterThanOrEqual(SCALE_CALM - 1e-9); expect(f.scale).toBeLessThanOrEqual(1);
  expect(Number.isFinite(f.range) && f.range >= 0).toBe(true); expect(CALIBRATION_PHASES).toContain(f.phase);
};

describe('adaptive music calibration: learning', () => {
  it('learns by how much it has heard and how good it was, not by the clock; until then it is the uncalibrated reading', () => {
    const c = new AdaptiveMusicCalibration(), s = source();
    expect(c.frame).toEqual(createCalibration()); expect(c.frame.phase).toBe('waiting');
    const seen: string[] = [];
    let last = 0, phase = '';
    play(c, s, 40, track(-20, 4), (f, t) => {
      if (phase !== f.phase) { phase = f.phase; seen.push(`${f.phase}@${Math.round(t)}`); }
      expect(f.confidence).toBeGreaterThanOrEqual(last); last = f.confidence;
      bounded(f);
    });
    expect(seen).toEqual(['stabilizing@0', `learning@${EVIDENCE.stable}`, `consolidating@${EVIDENCE.learned}`, `adapted@${EVIDENCE.consolidated}`]);
    expect(c.frame.confidence).toBe(1); expect(c.frame.observed).toBeCloseTo(40, 6);
    // A weak, doubtful signal (half present, its levels not yet trusted) takes more than twice as long to the same phase.
    const doubtful = new AdaptiveMusicCalibration(), d = source();
    play(doubtful, d, 40, track(-20, 4, { presence: 0.5, quality: 0.3 }));
    expect(doubtful.frame.phase).toBe('learning'); expect(doubtful.frame.confidence).toBeLessThan(0.4); expect(doubtful.frame.observed).toBeCloseTo(40, 6);
    // In its first instants nothing is calibrated: the level is where the experience's own scale puts it, the gain is 1.
    const fresh = new AdaptiveMusicCalibration(), f = source();
    play(fresh, f, 0.5, () => ({ lufs: -33 }));
    expect(fresh.frame.energy).toBeCloseTo((-33 + 60) / 54, 1); expect(Math.abs(fresh.frame.gain - 1)).toBeLessThan(0.03); expect(fresh.frame.scale).toBeGreaterThan(0.99);
  });

  it('is deterministic, bounded for any input, and silent in silence', () => {
    const run = () => { const c = new AdaptiveMusicCalibration(), s = source(); play(c, s, 25, track(-24, 6)); return { ...c.frame, rated: c.rate(0.4) }; };
    expect(run()).toEqual(run());
    // Nothing heard: nothing learned, nothing put out, no gain, whatever the time that passes.
    const quiet = new AdaptiveMusicCalibration(), q = source();
    play(quiet, q, 30, () => ({ lufs: null }), (f) => { expect(f.energy + f.low + f.mid + f.high + f.transient).toBe(0); });
    expect(quiet.frame).toMatchObject({ phase: 'waiting', confidence: 0, observed: 0, gain: 1, epoch: 0 });
    // Broken frames: every field of the wire not a number, in turn and at once.
    const c = new AdaptiveMusicCalibration(), s = source();
    play(c, s, 12, track(-20, 4));
    for (const bad of [NaN, Infinity, -Infinity, 1e30, -1e30]) {
      for (let n = 0; n < 400; n++) {
        const a = s.next(track(-20, 4)(n / RATE));
        a.loudnessMomentary = n % 2 ? bad : -20; a.loudnessQuantiles.fill(bad); a.bandLevel.fill(bad); a.bandRel.fill(bad); a.noiseFloorDb = bad; a.onsetDensity = bad;
        a.percussiveShare = bad; a.energyConfidence = bad; a.presence = n % 3 ? bad : 1;
        c.update(a, 1 / RATE); bounded(c.frame);
        expect(Number.isFinite(c.rate(bad))).toBe(true);
      }
      c.update(s.next({ lufs: -20 }), bad); c.update(s.next({ lufs: -20 }), 0); c.update(s.next({ lufs: -20 }), -1);
      bounded(c.frame);
    }
  });
});

describe('adaptive music calibration: normalization within bounds', () => {
  it('places the same music the same way whatever the input level, and raises a quiet input only as far as the noise allows', () => {
    const at = (level: number, floor = -70) => {
      const c = new AdaptiveMusicCalibration(), s = source();
      let low = 1, high = 0, slew = 0, last = 1;
      play(c, s, 60, track(level, 5, { floor }), (f, t) => {
        // The gain is a slow statistic, updated a few times a second: its pace is what it moves in a second.
        if (Math.round(t * RATE) % RATE === 0) { slew = Math.max(slew, Math.abs(f.gain - last)); last = f.gain; }
        if (t > 40) { low = Math.min(low, f.energy); high = Math.max(high, f.energy); }
      });
      return { ...c.frame, low, high, slew };
    };
    const hot = at(-8), normal = at(-18), soft = at(-38), faint = at(-52, -60);
    // Relative: the track sits about its own typical level and swings as far, at −8 as at −38 LUFS.
    for (const x of [hot, soft]) { expect(Math.abs(x.high - normal.high)).toBeLessThan(0.06); expect(Math.abs(x.low - normal.low)).toBeLessThan(0.06); }
    expect(normal.high - normal.low).toBeGreaterThan(0.4);
    // The gain for whoever reads absolute levels: up for a quiet input, down for a hot one, never far, never fast.
    expect(soft.gain).toBeGreaterThan(1.4); expect(soft.gain).toBeLessThanOrEqual(GAIN_MAX);
    expect(hot.gain).toBeLessThan(0.95); expect(hot.gain).toBeGreaterThanOrEqual(GAIN_MIN);
    expect(Math.abs(normal.gain - 1)).toBeLessThan(0.1);
    for (const x of [hot, normal, soft, faint]) expect(x.slew).toBeLessThanOrEqual(0.12 + 1e-6);
    // A faint input eight decibels over its noise floor is not raised: the gain would raise the noise.
    expect(faint.gain).toBeLessThan(1.05);
  });

  it('keeps the contrast of a track and does not stretch a compressed one into a dynamic one', () => {
    const span = (swing: number) => {
      const c = new AdaptiveMusicCalibration(), s = source();
      let low = 1, high = 0;
      play(c, s, 60, track(-16, swing), (f, t) => { if (t > 40) { low = Math.min(low, f.energy); high = Math.max(high, f.energy); } });
      return { low, high, range: c.frame.range };
    };
    const compressed = span(1.5), dynamic = span(9);
    // A master that moves within 3 LU moves the response within a third of it; one that moves 18 LU, nearly all of it.
    expect(compressed.range).toBeLessThan(MIN_RANGE / 2); expect(compressed.high - compressed.low).toBeLessThan(0.35);
    expect(dynamic.range).toBeGreaterThan(MIN_RANGE); expect(dynamic.high - dynamic.low).toBeGreaterThan(0.6);
    // Within one track: quiet passage, typical, loud passage, silence, in that order.
    const c = new AdaptiveMusicCalibration(), s = source(), level = (t: number): number | null => (t > 50 ? null : t > 46 ? -8 : t > 42 ? -30 : -18);
    const seen: Record<string, number> = {};
    play(c, s, 52, (t) => ({ lufs: level(t) }), (f, t) => { if ([41.9, 45.9, 49.9, 51.9].includes(Math.round(t * 10) / 10)) seen[String(Math.round(t))] = f.energy; });
    expect(seen['52']).toBe(0); expect(seen['46']).toBeLessThan(seen['42'] - 0.2); expect(seen['50']).toBeGreaterThan(seen['42'] + 0.2);
  });

  it('a calm track stays calmer than a driving one at the same level: its character is not its tempo, and not its loudness', () => {
    const of = (over: Partial<Moment>, swing: number) => {
      const c = new AdaptiveMusicCalibration(), s = source();
      let energy = 0, n = 0;
      play(c, s, 60, track(-18, swing, over), (f, t) => { if (t > 40) { energy += f.energy; n++; } });
      return { ...c.frame, mean: energy / n };
    };
    const ambient = of({ onsets: 0.4, percussive: 0.08 }, 8), techno = of({ onsets: 9, percussive: 0.6 }, 2);
    expect(ambient.character).toBeLessThan(0.2); expect(techno.character).toBeGreaterThan(0.7);
    expect(ambient.scale).toBeLessThan(0.7); expect(techno.scale).toBeGreaterThan(0.88);
    // Both sit at their own typical level, and the calm one tops out lower: the difference between the two is kept.
    expect(ambient.mean).toBeLessThan(techno.mean - 0.08); expect(ambient.low).toBeLessThanOrEqual(ambient.scale);
    // The same character at another input level: the scale follows the music, not the volume.
    const c = new AdaptiveMusicCalibration(), s = source();
    play(c, s, 60, (t) => ({ ...track(-40, 2, { onsets: 9, percussive: 0.6 })(t) }));
    expect(c.frame.character).toBeCloseTo(techno.character, 1);
  });
});

describe('adaptive music calibration: pauses, tracks and sources', () => {
  /** A calibration that knows a track at `level`, and its source. */
  const known = (level = -20) => { const c = new AdaptiveMusicCalibration(), s = source(); play(c, s, 45, track(level, 4)); return { c, s }; };

  it('a short pause changes nothing; a long silence makes the references prove themselves again; a very long one doubts them', () => {
    const { c, s } = known();
    const before = { ...c.frame };
    play(c, s, 1.5, () => ({ lufs: null }), (f) => { expect(f.energy).toBe(0); });
    play(c, s, 0.02, track(-20, 4));
    expect(c.frame).toMatchObject({ phase: 'adapted', confidence: 1, epoch: before.epoch }); expect(c.frame.gain).toBeCloseTo(before.gain, 2);
    // The attacks keep their measure across it: one far beyond the usual still stands out right after.
    const usual = (calibration: AdaptiveMusicCalibration): void => { for (let k = 0; k < 24; k++) calibration.rate(k % 4 ? 0.18 : 0.24); };
    usual(c);
    expect(c.rate(0.6)).toBeGreaterThan(0.9);
    // A long silence (as long as the experience calls long): what returns is rated low at first, and the gain goes back towards 1.
    const long = known(-38), gain = long.c.frame.gain;
    usual(long.c);
    play(long.c, long.s, 5, () => ({ lufs: null }));
    play(long.c, long.s, 0.05, track(-38, 4));
    expect(long.c.rate(0.6)).toBeLessThan(0.1);
    expect(long.c.frame).toMatchObject({ confidence: 1, epoch: 0 });
    play(long.c, long.s, 1, track(-38, 4));
    expect(long.c.frame.gain).toBeLessThan(gain); expect(long.c.frame.gain).toBeGreaterThan(1);
    // A few seconds on they act again: nothing was forgotten, and the gain is on its way back.
    play(long.c, long.s, 6, track(-38, 4));
    expect(long.c.rate(0.24)).toBeLessThan(0.3); expect(long.c.frame.gain).toBeGreaterThan(gain - 0.25);
    // Much longer and they are doubted: kept as a first guess, learned again.
    const stale = known();
    play(stale.c, stale.s, 25, () => ({ lufs: null }));
    play(stale.c, stale.s, 0.05, track(-20, 4));
    expect(stale.c.frame.epoch).toBe(1); expect(stale.c.frame.confidence).toBeLessThan(0.4); expect(stale.c.frame.phase).toBe('learning');
  });

  it('another track at another level is followed within seconds, with nothing extreme on the way', () => {
    const { c, s } = known(-32);
    for (let k = 0; k < 24; k++) c.rate(k % 4 ? 0.18 : 0.24);
    const gain = c.frame.gain;
    let top = 0, slew = 0, last = gain, stability = 1, significance = 0;
    // No silence between them: the next track is 18 LU hotter, and its kicks twice as strong.
    play(c, s, 30, track(-14, 4), (f, t) => {
      top = Math.max(top, f.energy); stability = Math.min(stability, f.stability);
      if (Math.round(t * RATE) % RATE === 0) { slew = Math.max(slew, Math.abs(f.gain - last)); last = f.gain; }
      if (Math.round(t * RATE) % 100 === 0) significance = Math.max(significance, t > 4 ? c.rate(0.45) : (c.rate(0.45), 0));
      bounded(f);
    });
    // It was noticed (the references no longer described what was heard) and counted once.
    expect(stability).toBeLessThan(0.5); expect(c.frame.epoch).toBe(1);
    // Nothing jumped: the gain moved at its own pace, down, and the level saturated at 1 at most.
    expect(slew).toBeLessThanOrEqual(0.12 + 1e-6); expect(c.frame.gain).toBeLessThan(gain - 0.3); expect(top).toBeLessThanOrEqual(1);
    // After a few seconds the stronger kicks are this track's usual ones.
    expect(significance).toBeLessThan(0.7);
    // Half a minute on it is this track's calibration: its typical level reads typical again.
    let mean = 0, n = 0;
    play(c, s, 20, track(-14, 4), (f) => { mean += f.energy; n++; });
    expect(mean / n / c.frame.scale).toBeGreaterThan(0.35); expect(mean / n / c.frame.scale).toBeLessThan(0.65); expect(c.frame.stability).toBeGreaterThan(0.9);
  });

  it('a lost capture keeps the track; a new source forgets everything', () => {
    const { c, s } = known(-36);
    const learned = { ...c.frame };
    c.interrupt();
    expect(c.frame).toMatchObject({ energy: 0, low: 0, transient: 0, confidence: learned.confidence, phase: 'adapted', epoch: 0 }); expect(c.frame.gain).toBe(learned.gain);
    // Back at once, but nothing stands out for the first instants.
    play(c, s, 0.1, track(-36, 4));
    expect(c.rate(0.9)).toBeLessThan(0.2); expect(c.frame.energy).toBeGreaterThan(0);
    c.reset();
    expect(c.frame).toEqual({ ...createCalibration(), epoch: 1 });
    // The next source is learned from nothing: its first seconds are uncalibrated, whatever the last one was.
    s.restart();
    play(c, s, 2, track(-12, 4));
    expect(c.frame.phase).toBe('stabilizing'); expect(Math.abs(c.frame.gain - 1)).toBeLessThan(0.02); expect(c.rate(0.9)).toBeLessThanOrEqual(0.5);
  });

  it('switched off it is the uncalibrated reading, and says so', () => {
    const c = new AdaptiveMusicCalibration(), s = source();
    c.enabled = false;
    play(c, s, 45, track(-38, 4), (f) => bounded(f));
    expect(c.frame).toMatchObject({ phase: 'off', confidence: 0, gain: 1, scale: 1, stability: 1 });
    // The level on the experience's own scale (a quiet input reads quiet), the lows by how far they stand over their floor.
    expect(c.frame.energy).toBeCloseTo((s.next({ lufs: -38 }).loudnessMomentary + 60) / 54, 0); expect(c.frame.energy).toBeLessThan(0.5);
    expect(c.frame.low).toBeCloseTo(0.7, 5);
    expect(c.rate(0.37)).toBeCloseTo(0.37, 9);
    c.enabled = true;
    play(c, s, 3, track(-38, 4));
    expect(c.frame.phase).not.toBe('off');
  });
});

describe('adaptive music calibration: rating attacks', () => {
  it('an ordinary attack is ordinary, a usual accent is usual, and only what goes beyond the accents stands out', () => {
    const c = new AdaptiveMusicCalibration(), s = source();
    // The first attacks of a track have no measure: none is more than ordinary, whatever its strength.
    play(c, s, 1, track(-20, 4));
    for (const power of [0.2, 0.9, 0.3, 1]) expect(c.rate(power)).toBeLessThanOrEqual(0.5);
    play(c, s, 20, track(-20, 4));
    // A bar: three kicks and an accent, over and over.
    const bar = [0.3, 0.18, 0.2, 0.18];
    let accent = 0, plain = 0;
    for (let k = 0; k < 64; k++) { const rated = c.rate(bar[k % 4]); if (k >= 32) { if (k % 4 === 0) accent = Math.max(accent, rated); else plain = Math.max(plain, rated); } }
    expect(plain).toBeLessThan(0.15); expect(accent).toBeGreaterThan(0.3); expect(accent).toBeLessThan(0.65);
    // One far beyond the accents stands out, and is felt at once and for a fraction of a second.
    expect(c.rate(0.6)).toBeGreaterThan(0.9); expect(c.frame.transient).toBeGreaterThan(0.9);
    play(c, s, 1, track(-20, 4));
    expect(c.frame.transient).toBeLessThan(0.01);
    // The same again is no longer new: it is the accent now.
    expect(c.rate(0.6)).toBeLessThan(0.7);
    // And it is forgotten: a while of the usual bar later it stands out again.
    for (let k = 0; k < 80; k++) c.rate(bar[k % 4]);
    expect(c.rate(0.6)).toBeGreaterThan(0.85);
    // Levels do not matter: the same pattern a quarter as strong is rated the same way.
    const quiet = new AdaptiveMusicCalibration(), q = source();
    play(quiet, q, 21, track(-20, 4));
    for (let k = 0; k < 64; k++) quiet.rate(bar[k % 4] / 4);
    expect(quiet.rate(0.15)).toBeGreaterThan(0.9);
  });
});

/** A test signal, scaled by `gain`, through the real analysis (WASM) into an experience engine. */
async function hear(signal: TestSignal, seconds: number, gain = 1, engine = new ExperienceEngine(), each?: (engine: ExperienceEngine, t: number) => void) {
  const SR = 48000, pcm = new Float32Array(seconds * SR * 2), batch = 480;
  new SignalGenerator(signal, SR).fillStereo(pcm, seconds * SR);
  if (gain !== 1) for (let i = 0; i < pcm.length; i++) pcm[i] *= gain;
  const wasm = await WasmAnalysis.create(SR, 2);
  let frames = 0;
  wasm.decoder.onFrame = (a) => { engine.ingest(a); if (++frames % 20 === 0) each?.(engine, a.time); };
  wasm.decoder.onOnset = (o) => engine.onset(o); wasm.decoder.onBeat = (b) => engine.beat(b); wasm.decoder.onSection = (s) => engine.section(s);
  for (let at = 0; at + batch <= seconds * SR; at += batch) { wasm.decoder.begin(); wasm.push(pcm.subarray(at * 2, (at + batch) * 2)); }
  wasm.dispose();
  return engine;
}
/** The impacts of the session and how each was rated. */
const impacts = (engine: ExperienceEngine, from = 0): { time: number; significance: number; strength: number }[] => {
  const out = [];
  for (let i = 0; i < engine.events.count; i++) { const e = engine.events.at(i); if (e.type === 'impact' && e.audioTime >= from) out.push({ time: e.audioTime, significance: e.significance, strength: e.strength }); }
  return out;
};

describe('adaptive music calibration on the real analysis (synthetic signals through WASM)', () => {
  it('silence, hiss and hum: nothing is learned as music, nothing stands out, no gain is asked', { timeout: 240000 }, async () => {
    for (const signal of ['silence', 'hiss', 'hum'] as const) {
      const engine = await hear(signal, 30, 1, undefined, (e) => bounded(e.calibration.frame));
      const f = engine.calibration.frame;
      // Whatever a floor is taken for, it never produces an event that stands out, and never a gain worth the name.
      expect(impacts(engine).filter((x) => x.significance >= 0.7), signal).toHaveLength(0);
      expect(f.gain, signal).toBeLessThan(1.1); expect(f.transient, signal).toBeLessThan(0.7);
      if (signal === 'silence') {
        expect(f).toMatchObject({ phase: 'waiting', confidence: 0, energy: 0, low: 0, mid: 0, high: 0, gain: 1, transient: 0 });
        for (let i = 0; i < engine.events.count; i++) expect(['impact', 'drop', 'onset']).not.toContain(engine.events.at(i).type);
      }
    }
  });

  it('a steady beat: its kicks are ordinary once it is known, at any tempo and at any input level', { timeout: 240000 }, async () => {
    for (const [signal, gain] of [['beat124', 1], ['beat174', 1], ['beat124', 0.05], ['kicks', 1]] as const) {
      const energies: number[] = [];
      const engine = await hear(signal, 40, gain, undefined, (e, t) => { bounded(e.calibration.frame); if (t > 25) energies.push(e.calibration.frame.energy); });
      const f = engine.calibration.frame, label = `${signal} × ${gain}`;
      expect(['consolidating', 'adapted'], label).toContain(f.phase); expect(f.confidence, label).toBeGreaterThan(0.6);
      // Periodic sound has accents and hardly an event: of the attacks of the last twenty seconds, a few in a hundred
      // stand out (those the experience itself gives half as much power again), never a run of them.
      const late = impacts(engine, 20), out = late.filter((x) => x.significance >= 0.7);
      expect(late.length, label).toBeGreaterThan(10);
      expect(out.length, label).toBeLessThanOrEqual(Math.max(1, Math.ceil(0.04 * late.length)));
      for (let k = 1; k < out.length; k++) expect(out[k].time - out[k - 1].time, label).toBeGreaterThan(4);
      // The lows are heard to move, at any level.
      expect(Math.max(...energies), label).toBeGreaterThan(0.2);
    }
    // The same beat 14 dB down is placed the same way (relative), and asks for more gain (absolute).
    const loud = await hear('beat124', 40), soft = await hear('beat124', 40, 0.2), faint = await hear('beat124', 40, 0.05);
    expect(Math.abs(loud.calibration.frame.range - soft.calibration.frame.range)).toBeLessThan(3);
    expect(soft.calibration.frame.gain).toBeGreaterThan(loud.calibration.frame.gain + 0.1); expect(soft.calibration.frame.gain).toBeLessThanOrEqual(GAIN_MAX);
    expect(Math.abs(loud.calibration.frame.character - soft.calibration.frame.character)).toBeLessThan(0.1);
    // 26 dB down it stands so little over the floor the DSP has learned that raising it would raise the noise: it is raised less, or not at all.
    expect(faint.calibration.frame.gain).toBeLessThanOrEqual(soft.calibration.frame.gain + 0.05); expect(faint.calibration.frame.gain).toBeGreaterThanOrEqual(1 - 1e-6);
  });

  it('dynamic music: the drop stands out of what led to it, a sustained chord is calmer than a beat', { timeout: 240000 }, async () => {
    const engine = await hear('buildDrop', 32, 1, undefined, (e) => bounded(e.calibration.frame));
    const drops = [];
    for (let i = 0; i < engine.events.count; i++) { const e = engine.events.at(i); if (e.type === 'drop') drops.push(e); }
    expect(drops.length).toBeGreaterThan(0);
    for (const drop of drops) expect(Math.max(drop.significance, 0.6 + 0.4 * drop.strength)).toBeGreaterThan(0.6);
    // Nothing of the ambient opening stands out before the track is known.
    expect(impacts(engine).filter((x) => x.time < 6 && x.significance >= 0.7)).toHaveLength(0);
    const pad = await hear('pad', 40), beat = await hear('beat174', 40);
    expect(pad.calibration.frame.character).toBeLessThan(beat.calibration.frame.character - 0.1);
    expect(pad.calibration.frame.scale).toBeLessThan(beat.calibration.frame.scale);
    // Compressed noise at one level: a narrow range, and a response that stays in the middle of it.
    const noise = await hear('noise', 40);
    expect(noise.calibration.frame.range).toBeLessThan(MIN_RANGE);
  });

  it('level changes, stops and restarts, and a new source: bounded all the way, and the world is what it was without it', { timeout: 240000 }, async () => {
    for (const signal of ['crescendo', 'startStop', 'noiseMusic', 'breakdown', 'fadeCut'] as const) {
      let slew = 0, last = 1;
      const engine = await hear(signal, 40, 1, undefined, (e) => { const f = e.calibration.frame; bounded(f); slew = Math.max(slew, Math.abs(f.gain - last)); last = f.gain; });
      // Per twenty hops (about a tenth of a second): the gain never moves faster than its slew.
      expect(slew, signal).toBeLessThan(0.03);
      expect(engine.calibration.frame.gain, signal).toBeLessThanOrEqual(GAIN_MAX);
    }
    // A change of source is a new session: the engine resets, and so does what was learned of the device.
    const engine = await hear('beat124', 20);
    expect(engine.calibration.frame.confidence).toBeGreaterThan(0.5);
    engine.reset();
    expect(engine.calibration.frame).toMatchObject({ phase: 'waiting', confidence: 0, gain: 1, epoch: 1 }); expect(engine.presented.calibration.phase).toBe('waiting');
    await hear('pad', 3, 0.05, engine);
    expect(engine.calibration.frame.phase).toBe('stabilizing'); expect(Math.abs(engine.calibration.frame.gain - 1)).toBeLessThan(0.05);
    // The calibration stands beside the world: with it off, the world, the state and the events are the same to the last bit.
    const on = await hear('buildDrop', 24), off = new ExperienceEngine();
    off.calibration.enabled = false;
    await hear('buildDrop', 24, 1, off);
    expect(off.world.state).toEqual(on.world.state); expect(off.state).toEqual(on.state); expect(off.events.count).toBe(on.events.count);
    for (let i = 0; i < on.events.count; i++) expect({ ...off.events.at(i), significance: 0 }).toEqual({ ...on.events.at(i), significance: 0 });
    expect(off.calibration.frame.phase).toBe('off');
  });
});
