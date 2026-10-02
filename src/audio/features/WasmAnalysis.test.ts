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

describe('WebAssembly analysis', () => {
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
