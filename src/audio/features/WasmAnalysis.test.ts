import { describe, expect, it } from 'vitest';
import { SignalGenerator } from '../capture/testSignals';
import { WasmAnalysis } from './WasmAnalysis';

const SR = 48000;

/** Feeds a test signal in ~16.7 ms chunks (one render frame each), like the app does. */
async function run(signal: ConstructorParameters<typeof SignalGenerator>[0], seconds: number) {
  const analysis = await WasmAnalysis.create(SR, 1);
  const generator = new SignalGenerator(signal, SR);
  const chunk = new Float32Array(800);
  const beats: number[] = [];
  let onsets = 0;
  for (let f = 0; f < seconds * 60; f++) {
    generator.fill(chunk, 0, chunk.length);
    analysis.decoder.begin();
    analysis.push(chunk);
    const { decoder } = analysis;
    for (let i = 0; i < decoder.beats.count; i++) beats.push(decoder.beats.items[i].time);
    onsets += decoder.onsets.count;
  }
  return { frame: analysis.decoder.frame, beats, onsets, analysis };
}

describe('WebAssembly analysis', { timeout: 30000 }, () => {
  it('reports frames on the capture clock with named fields', async () => {
    const { frame } = await run('beat124', 2);
    expect(frame.time).toBeCloseTo(frame.sample / SR, 9);
    expect(frame.sample).toBeGreaterThan(SR * 1.9);
    expect(frame.bandDb).toBeInstanceOf(Float64Array);
    expect(frame.bandDb.length).toBe(8);
    expect(frame.presence).toBeGreaterThan(0.9);
  });

  it('tracks the beat of the synthetic groove', async () => {
    const { frame, beats, onsets } = await run('beat124', 12);
    expect(onsets).toBeGreaterThan(20);
    expect(frame.beatBpm).toBeGreaterThan(122);
    expect(frame.beatBpm).toBeLessThan(126);
    expect(frame.beatConfidence).toBeGreaterThan(0.5);
    // Beats arrive regularly once locked (the grid may first move once by half a beat, off the off-beats).
    const late = beats.filter((t) => t > 9);
    const gaps = late.slice(1).map((t, i) => t - late[i]);
    for (const gap of gaps) expect(gap).toBeCloseTo(60 / 124, 1);
  });

  it('is silent in silence and has no key yet', async () => {
    const { frame } = await run('silence', 1);
    expect(frame.silent).toBe(1);
    expect(frame.presence).toBe(0);
    expect(frame.key).toBe(-1);
  });
});

it('preserves side-only stereo through analysis and the experience visibility contract', async () => {
  const { ExperienceEngine } = await import('../../experience/ExperienceEngine');
  const analysis = await WasmAnalysis.create(SR,2);
  const engine = new ExperienceEngine();
  analysis.decoder.onFrame = a => engine.ingest(a);
  const generator = new SignalGenerator('phaseInversion',SR), chunk = new Float32Array(960);
  for(let n=0;n<300;n++){generator.fillStereo(chunk,480);analysis.push(chunk);}
  const a = analysis.decoder.frame;
  expect(a.width).toBeGreaterThan(0.99);
  expect(a.sideEnergy).toBeGreaterThan(0.01);
  expect(a.rms).toBeGreaterThan(0.15);
  expect(engine.state.energy).toBeGreaterThan(0.5);
  expect(engine.physics.frame.energy).toBeGreaterThan(0.001);
  analysis.dispose();
});

it('finds a 3/4 meter and forecasts its downbeats; equal accents abstain instead of assuming 4/4', { timeout: 60000 }, async () => {
  const { SignalGenerator } = await import('../capture/testSignals');
  const run = async (signal: 'waltz' | 'beat124') => {
    const analysis = await WasmAnalysis.create(SR, 2);
    const generator = new SignalGenerator(signal, SR), buffer = new Float32Array(960 * 2);
    const downbeats: number[] = [], forecasts: number[] = [];
    analysis.decoder.onBeat = (b) => { if (b.downbeat && b.time > 15) downbeats.push(b.time); };
    // Before a meter is published the forecast follows the fallback grouping, at low confidence.
    analysis.decoder.onFrame = (f) => { if (f.time > 15 && f.time < 25 && f.meter > 0 && f.nextDownbeatTime > 0) forecasts.push(f.nextDownbeatTime); };
    for (let i = 0; i < 1500; i++) { generator.fillStereo(buffer, 960); analysis.push(buffer); }
    const last = { ...analysis.decoder.frame };
    analysis.dispose();
    return { last, downbeats, forecasts };
  };
  const waltz = await run('waltz');
  expect(waltz.last.meter).toBe(3);
  expect(waltz.last.meterConfidence).toBeGreaterThan(0.4);
  // 150 BPM in 3: bars of 1.2 s.
  for (const t of waltz.downbeats) expect(Math.abs(t - Math.round(t / 1.2) * 1.2)).toBeLessThan(0.03);
  expect(waltz.forecasts.length).toBeGreaterThan(500);
  for (const t of waltz.forecasts) expect(Math.min(...waltz.downbeats.map((d) => Math.abs(d - t)))).toBeLessThan(0.03);
  const even = await run('beat124');
  expect(even.last.meter).toBe(0);
});
