import { describe, expect, it } from 'vitest';
import { AudioAnalyzer } from '../analysis/AudioAnalyzer';
import { ClockSync } from '../../timing/ClockSync';
import { AnalysisDecoder } from './decode';
import { CLOCK_FIELDS, FRAME_FIELDS, HOP, ONSET_FIELDS, RECORD, SCENE_FIELDS, TAG } from './layout';
import { RecordStage } from './RecordStage';

const SR = 48000;

function frameRecord(hop: number): number[] {
  const r = new Array<number>(RECORD.frame).fill(0);
  r[0] = TAG.frame;
  r[FRAME_FIELDS.sample[0]] = hop * HOP;
  r[FRAME_FIELDS.time[0]] = (hop * HOP) / SR;
  return r;
}
function onsetRecord(time: number): number[] {
  const r = new Array<number>(RECORD.onset).fill(0);
  r[0] = TAG.onset;
  r[ONSET_FIELDS.time[0]] = time;
  return r;
}
function sceneRecord(sample: number, volume: number): number[] {
  const r = new Array<number>(RECORD.scene).fill(0);
  r[0] = TAG.scene;
  r[SCENE_FIELDS.sample[0]] = sample;
  r[SCENE_FIELDS.volume[0]] = volume;
  return r;
}
function clockRecord(sample: number, sequence: number, epoch = 0, more: Partial<Record<keyof typeof CLOCK_FIELDS, number>> = {}): number[] {
  const r = new Array<number>(RECORD.clock).fill(0);
  r[0] = TAG.clock;
  r[CLOCK_FIELDS.sample[0]] = sample;
  r[CLOCK_FIELDS.sequence[0]] = sequence;
  r[CLOCK_FIELDS.epoch[0]] = epoch;
  for (const [name, value] of Object.entries(more)) r[CLOCK_FIELDS[name as keyof typeof CLOCK_FIELDS][0]] = value;
  return r;
}
const batch = (...records: number[][]) => Float64Array.from(records.flat());

/** A decoder that writes down what it is given, in order. */
function recorder() {
  const decoder = new AnalysisDecoder();
  const seen: string[] = [];
  decoder.onFrame = (f) => seen.push(`f${f.sample / HOP}`);
  decoder.onOnset = (o) => seen.push(`o${o.time}`);
  return { decoder, seen };
}

describe('RecordStage', () => {
  it('sends scene records straight to their feed and stages the rest in order', () => {
    const stage = new RecordStage(SR);
    const b = batch(frameRecord(1), frameRecord(2), onsetRecord(7), frameRecord(3), sceneRecord(768, 0.6), frameRecord(4), clockRecord(1024, 0));
    stage.stage(b, b.length, 1);
    // The scene is readable at once, before any frame decodes the rest.
    const frame = new AudioAnalyzer().frame;
    expect(stage.scenes.read(frame, 0, true)).toBe(true);
    expect(frame.volume).toBe(0.6);
    expect(stage.pending).toBe(b.length - RECORD.scene);
    const { decoder, seen } = recorder();
    stage.drain(decoder, new ClockSync(), SR);
    expect(seen).toEqual(['f1', 'f2', 'o7', 'f3', 'f4']);
    expect(stage.pending).toBe(0);
  });

  it('decodes a bounded number of hops per frame and works a backlog off over the next ones, skipping nothing', () => {
    const stage = new RecordStage(SR);
    // A stall: 40 hops arrive before the next frame, with an onset every 10.
    const expected: string[] = [];
    for (let n = 0; n < 4; n++) {
      const records: number[][] = [];
      for (let h = n * 10 + 1; h <= n * 10 + 10; h++) {
        records.push(frameRecord(h));
        expected.push(`f${h}`);
      }
      records.push(onsetRecord(n), clockRecord((n + 1) * 10 * HOP, n));
      expected.push(`o${n}`);
      const b = batch(...records);
      stage.stage(b, b.length, n);
    }
    const { decoder, seen } = recorder();
    const clock = new ClockSync();
    const perFrame: number[] = [];
    for (let frame = 0; frame < 5 && stage.pending > 0; frame++) {
      const before = decoder.frames;
      decoder.begin();
      stage.drain(decoder, clock, SR, 12);
      perFrame.push(decoder.frames - before);
    }
    expect(perFrame).toEqual([12, 12, 12, 4]);
    expect(seen).toEqual(expected);
    // Every batch's clock observation was given on the first frame: the clock does not wait for the backlog.
    expect(clock.ready).toBe(true);
  });

  it('starts over when the producer restarted its capture clock: nothing of the old epoch reaches the consumers', () => {
    const stage = new RecordStage(SR);
    let b = batch(frameRecord(500), sceneRecord(500 * HOP, 0.9), clockRecord(500 * HOP, 41));
    stage.stage(b, b.length, 1);
    b = batch(frameRecord(1), sceneRecord(HOP, 0.1), clockRecord(HOP, 42, 1));
    stage.stage(b, b.length, 2);
    expect(stage.epoch).toBe(1);
    const { decoder, seen } = recorder();
    stage.drain(decoder, new ClockSync(), SR);
    expect(seen).toEqual(['f1']);
    const frame = new AudioAnalyzer().frame;
    stage.scenes.read(frame, 1e9, true);
    expect(frame.volume).toBe(0.1);
  });

  it('reports what the producer says of itself and notices a batch that never arrived', () => {
    const stage = new RecordStage(SR);
    for (const sequence of [0, 1, 3, 4]) {
      const b = batch(frameRecord(sequence + 1), clockRecord((sequence + 1) * HOP, sequence, 0, { load: 0.07, quality: 1, lost: 480, age: 0.004 }));
      stage.stage(b, b.length, sequence);
    }
    expect(stage.stats).toMatchObject({ batches: 4, missed: 1, load: 0.07, quality: 1, lost: 480, age: 0.004 });
  });

  it('drops what is pending when the frame loop stalls past its capacity, and counts it', () => {
    const stage = new RecordStage(SR);
    const hops = Array.from({ length: 100 }, (_, i) => frameRecord(i + 1));
    const b = batch(...hops, clockRecord(100 * HOP, 0));
    // 3 s of capacity; 4 s arrive unread.
    for (let n = 0; n < 8; n++) stage.stage(b, b.length, n);
    expect(stage.stats.dropped).toBeGreaterThan(0);
    expect(stage.pending).toBeLessThanOrEqual(Math.ceil((SR / HOP) * 3) * (RECORD.frame + RECORD.onset + RECORD.beat) + 64 * RECORD.clock);
    const { decoder, seen } = recorder();
    stage.drain(decoder, new ClockSync(), SR);
    // What is left is whole batches, in order.
    expect(seen.length % 100).toBe(0);
    expect(seen.slice(0, 3)).toEqual(['f1', 'f2', 'f3']);
  });

  it('keeps what is pending when resized for the negotiated sample rate', () => {
    const stage = new RecordStage(SR);
    const b = batch(frameRecord(1), frameRecord(2), clockRecord(2 * HOP, 0));
    stage.stage(b, b.length, 1);
    stage.resize(96000);
    const { decoder, seen } = recorder();
    stage.drain(decoder, new ClockSync(), 96000);
    expect(seen).toEqual(['f1', 'f2']);
  });

  it('ignores the rest of a batch that is out of sync', () => {
    const stage = new RecordStage(SR);
    const b = Float64Array.from([...frameRecord(1), 99, 1, 2, 3]);
    stage.stage(b, b.length, 1);
    const { decoder, seen } = recorder();
    stage.drain(decoder, new ClockSync(), SR);
    expect(seen).toEqual(['f1']);
  });
});
