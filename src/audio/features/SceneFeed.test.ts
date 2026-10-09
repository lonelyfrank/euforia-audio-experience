import { describe, expect, it } from 'vitest';
import { AudioAnalyzer } from '../analysis/AudioAnalyzer';
import { RECORD, SCENE_FIELDS as F, TAG } from './layout';
import { SceneFeed } from './SceneFeed';

type Scalars = Partial<Record<keyof typeof F, number>>;

/** A scene record: every 768 samples (3 hops at 48 kHz) unless told otherwise. */
function record(index: number, values: Scalars = {}, sample = (index + 1) * 768): Float64Array {
  const data = new Float64Array(RECORD.scene);
  data[0] = TAG.scene;
  data[F.sample[0]] = sample;
  for (const [name, value] of Object.entries(values)) data[F[name as keyof typeof F][0]] = value;
  // Arrays carry the record's index, so a test can tell which one was shown.
  data.fill(index, F.spectrum[0], F.spectrum[0] + F.spectrum[1]);
  data.fill(index, F.bassShape[0], F.bassShape[0] + F.bassShape[1]);
  return data;
}

const frame = () => new AudioAnalyzer().frame;

describe('SceneFeed', () => {
  it('shows nothing until a record arrives, then the newest', () => {
    const feed = new SceneFeed(), f = frame();
    expect(feed.read(f, 0, true)).toBe(false);
    feed.push(record(0, { volume: 0.2 }), 0);
    feed.push(record(1, { volume: 0.7, bassPitch: 55, leadClarity: 0.9, silent: 0 }), 0);
    expect(feed.read(f, 0, true)).toBe(true);
    expect(f.volume).toBe(0.7);
    expect(f.bassVoice.pitch).toBe(55);
    expect(f.leadVoice.clarity).toBeCloseTo(0.9, 12);
    expect(f.silent).toBe(false);
    expect(f.spectrum[5]).toBe(1);
    expect(f.bassVoice.shape[5]).toBe(1);
  });

  it('shows the record nearest to the audio delay, like the delayed window the frame loop used to analyse', () => {
    const feed = new SceneFeed(), f = frame();
    for (let i = 0; i < 10; i++) feed.push(record(i, { volume: i }), 0);
    // Newest is at sample 7680; 55 ms at 48 kHz = 2640 samples before it is 5040: the record at 5376 (index 6) is nearest.
    feed.read(f, 2640, true);
    expect(f.volume).toBe(6);
    feed.read(f, 0, true);
    expect(f.volume).toBe(9);
    // A delay longer than what is kept shows the oldest record there is.
    feed.read(f, 1e9, true);
    expect(f.volume).toBe(0);
  });

  it('keeps the newest second when more than that arrived', () => {
    const feed = new SceneFeed(), f = frame();
    for (let i = 0; i < 200; i++) feed.push(record(i, { volume: i }), 0);
    feed.read(f, 0, true);
    expect(f.volume).toBe(199);
    feed.read(f, 1e9, true);
    expect(f.volume).toBe(200 - 64);
  });

  it('shows a beat exactly once: kept when a frame spans two analyses, not repeated when two frames share one', () => {
    const feed = new SceneFeed(), f = frame();
    feed.push(record(0), 0);
    feed.read(f, 0, true);
    expect(f.beat).toBe(false);
    // A slow frame: two analyses arrived, the beat is in the first of them.
    feed.push(record(1, { beat: 1, beatPulse: 1, onset: 0.9, lowFlux: 0.8 }), 0);
    feed.push(record(2, { beat: 0, beatPulse: 0.88, onset: 0.1, lowFlux: 0.05, midFlux: 0.3 }), 0);
    feed.read(f, 0, true);
    expect(f.beat).toBe(true);
    // The pulse is the analysis' own envelope; the transients are the strongest of the frame.
    expect(f.beatPulse).toBeCloseTo(0.88, 12);
    expect(f.onset).toBeCloseTo(0.9, 12);
    expect(f.lowFlux).toBeCloseTo(0.8, 12);
    expect(f.midFlux).toBeCloseTo(0.3, 12);
    // A fast display: the same analysis again.
    feed.read(f, 0, true);
    expect(f.beat).toBe(false);
    expect(f.beatPulse).toBeCloseTo(0.88, 12);
    // A beat in the newest analysis, read twice.
    feed.push(record(3, { beat: 1, beatPulse: 1 }), 0);
    feed.read(f, 0, true);
    expect(f.beat).toBe(true);
    feed.read(f, 0, true);
    expect(f.beat).toBe(false);
  });

  it('keeps beat and pulse at rest when the beat response is off', () => {
    const feed = new SceneFeed(), f = frame();
    feed.push(record(0, { beat: 1, beatPulse: 1, onset: 0.6, bpm: 124 }), 0);
    feed.read(f, 0, false);
    expect(f.beat).toBe(false);
    expect(f.beatPulse).toBe(0);
    // Onset and tempo keep updating, as with the analyzer's own setting.
    expect(f.onset).toBeCloseTo(0.6, 12);
    expect(f.bpm).toBe(124);
  });

  it('starts over after a clear (a new capture clock)', () => {
    const feed = new SceneFeed(), f = frame();
    for (let i = 0; i < 5; i++) feed.push(record(i, { volume: i }), 0);
    feed.read(f, 0, true);
    feed.clear();
    expect(feed.read(f, 0, true)).toBe(false);
    feed.push(record(0, { volume: 0.5, beat: 1 }), 0);
    expect(feed.read(f, 0, true)).toBe(true);
    expect(f.volume).toBe(0.5);
    expect(f.beat).toBe(true);
  });

  it('reads a record from the middle of a batch', () => {
    const feed = new SceneFeed(), f = frame();
    const batch = new Float64Array(7 + RECORD.scene);
    batch.set(record(0, { volume: 0.4 }), 7);
    feed.push(batch, 7);
    feed.read(f, 0, true);
    expect(f.volume).toBe(0.4);
  });
});
