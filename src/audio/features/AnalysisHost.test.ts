import { describe, expect, it } from 'vitest';
import { ClockSync } from '../../timing/ClockSync';
import { SignalGenerator } from '../capture/testSignals';
import { AnalysisHost, type BatchInfo, type HostSource } from './AnalysisHost';
import { BrowserAnalysis } from './BrowserAnalysis';
import { AnalysisDecoder, type AnalysisFrame } from './decode';
import { CLOCK_FIELDS, RECORD, TAG } from './layout';
import { FILLED, PcmRing, WRITTEN } from './PcmRing';
import { RecordStage } from './RecordStage';
import { WasmAnalysis } from './WasmAnalysis';

const SR = 48000;

/** A host whose clock is driven by the test; collects the decoded frames and batch infos. */
async function host(source: HostSource) {
  let now = 0;
  const decoder = new AnalysisDecoder();
  const frames: { time: number; sample: number; onset: number; loudness: number }[] = [];
  decoder.onFrame = (f: AnalysisFrame) => frames.push({ time: f.time, sample: f.sample, onset: f.onsetStrength, loudness: f.loudnessMomentary });
  const batches: { length: number; info: BatchInfo; clock: number[] }[] = [];
  const h = await AnalysisHost.create({ sampleRate: SR, source, adaptive: false }, {
    records: (batch, length, info) => {
      batches.push({ length, info: { ...info }, clock: [...batch.subarray(length - RECORD.clock, length)] });
      decoder.decode(batch, length);
      h.recycle(batch.buffer as ArrayBuffer);
    },
  }, () => now);
  return { h, frames, batches, advance: (s: number) => { now += s; } };
}

describe('AnalysisHost', () => {
  it('forwards every hop exactly as a direct analysis of the same PCM, whatever the pump cadence', async () => {
    const run = await host({ kind: 'generator', signal: 'beat124' });
    // Irregular pumps: 3 ms … 40 ms apart, 6 s in total.
    let t = 0;
    for (let i = 0; t < 6; i++) {
      const step = [0.003, 0.016, 0.04, 0.007][i % 4];
      run.advance(step);
      t += step;
      run.h.pump();
    }
    const direct = await WasmAnalysis.create(SR, 2);
    const reference: number[] = [];
    direct.decoder.onFrame = (f) => reference.push(f.loudnessMomentary);
    const pcm = new Float32Array(run.h.analysed * 2);
    new SignalGenerator('beat124', SR).fillStereo(pcm, run.h.analysed);
    direct.push(pcm);
    expect(run.frames.length).toBe(reference.length);
    expect(run.frames.length).toBe(Math.floor(run.h.analysed / 256));
    run.frames.forEach((f, i) => {
      expect(f.sample).toBe((i + 1) * 256);
      expect(f.time).toBeCloseTo(((i + 1) * 256) / SR, 12);
      expect(f.loudness).toBe(reference[i]);
    });
    direct.dispose();
    run.h.dispose();
  });

  it('ends each batch with a clock record the stage turns into a clock observation', async () => {
    const run = await host({ kind: 'generator', signal: 'beat124' });
    run.advance(0.1);
    run.h.pump();
    const last = run.batches.at(-1)!;
    expect(last.clock[0]).toBe(TAG.clock);
    expect(last.clock[1]).toBe(run.h.analysed);
    expect(last.clock[2]).toBeGreaterThanOrEqual(0);
    // Batches are numbered, so the receiver can tell one that never arrived.
    expect(run.batches.map((b) => b.clock[CLOCK_FIELDS.sequence[0]])).toEqual(run.batches.map((_, i) => i));
    const stage = new RecordStage(SR);
    const batch = new Float64Array(RECORD.clock);
    batch.set([TAG.clock, SR, 0.002]);
    stage.stage(batch, batch.length, 11);
    const clock = new ClockSync();
    stage.drain(new AnalysisDecoder(), clock, SR);
    // Sample 48000 = 1 s of capture, 2 ms old when it arrived at host time 11 s.
    expect(clock.toHost(1)).toBeCloseTo(10.998, 9);
    run.h.dispose();
  });

  it('analyses a short loss as silence (exact clock) and restarts the epoch after a long one', async () => {
    const ring = new SharedArrayBuffer(PcmRing.bytes(SR * 2, 2));
    const run = await host({ kind: 'shared', ring });
    const producer = new PcmRing(ring, 2);
    const block = new Float32Array(4800 * 2).fill(0.1);
    const write = (seconds: number) => { for (let i = 0; i < seconds * 10; i++) producer.write(block, 4800); };
    write(1);
    run.h.pump();
    expect(run.h.analysed).toBe(SR);
    // 3 s at once overflows a 2.73 s ring by 0.27 s: zero-filled, the clock still counts every frame.
    write(3);
    run.h.pump();
    expect(run.h.analysed).toBe(4 * SR);
    expect(run.h.epoch).toBe(0);
    expect(run.batches.at(-1)!.clock[CLOCK_FIELDS.lost[0]]).toBeGreaterThan(0.2 * SR);
    // 5 s at once loses more than a second: new epoch, the clock starts over with what remains.
    write(5);
    run.h.pump();
    expect(run.h.epoch).toBe(1);
    expect(run.h.analysed).toBe(producer.capacity);
    expect(run.batches.at(-1)!.clock[CLOCK_FIELDS.epoch[0]]).toBe(1);
    run.h.dispose();
  });

  it('falls back to the main thread without workers and still analyses off the frame cadence', async () => {
    const analysis = await BrowserAnalysis.start(SR, { kind: 'generator', signal: 'beat124' });
    expect(analysis.stats.mode).toBe('main-thread');
    const decoder = new AnalysisDecoder();
    const clock = new ClockSync();
    await new Promise((resolve) => setTimeout(resolve, 60));
    analysis.read(decoder, clock);
    expect(decoder.frames).toBeGreaterThan(5);
    expect(clock.ready).toBe(true);
    analysis.dispose();
  });
});

describe('tap.worklet', () => {
  it('streams continuous stereo into the shared ring and fills skipped quanta with silence', async () => {
    const g = globalThis as Record<string, unknown>;
    let Processor: new () => { port: { onmessage: (e: { data: unknown }) => void; postMessage: () => void }; process(inputs: Float32Array[][]): boolean } = undefined!;
    g.AudioWorkletProcessor = class { port = { onmessage: null as unknown, postMessage: () => {} }; };
    g.registerProcessor = (_: string, p: typeof Processor) => { Processor = p; };
    g.sampleRate = SR;
    // @ts-expect-error -- a plain AudioWorklet script, loaded here with stubbed globals.
    await import('../capture/tap.worklet.js');
    const tap = new Processor();
    const ring = new SharedArrayBuffer(PcmRing.bytes(4096, 2));
    tap.port.onmessage({ data: { type: 'analysis', ring, port: null } });
    const reader = new PcmRing(ring, 2);
    const quantum = (value: number) => [[new Float32Array(128).fill(value), new Float32Array(128).fill(-value)]];
    g.currentFrame = 0;
    tap.process(quantum(0.5));
    g.currentFrame = 256; // one quantum skipped
    tap.process(quantum(0.25));
    const state = new Int32Array(ring, 0, 4);
    expect(Atomics.load(state, WRITTEN)).toBe(384);
    expect(Atomics.load(state, FILLED)).toBe(128);
    const out = new Float32Array(384 * 2);
    expect(reader.readInto(out)).toBe(384);
    expect([out[0], out[1]]).toEqual([0.5, -0.5]);
    expect([out[256], out[257]]).toEqual([0, 0]);
    expect([out[512], out[513]]).toEqual([0.25, -0.25]);
  });
});
