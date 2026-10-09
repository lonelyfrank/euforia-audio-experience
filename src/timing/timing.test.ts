import { describe, expect, it } from 'vitest';
import { ClockSync } from './ClockSync';
import { RhythmGate } from './RhythmGate';
import { Timing, type OnsetInput, type TimingInput } from './Timing';

describe('ClockSync', () => {
  it('takes the fastest path through jittery observations', () => {
    const clock = new ClockSync();
    // True offset 100 s; deliveries arrive 2–12 ms late.
    for (let i = 0; i < 200; i++) {
      const capture = i * 0.01;
      const delay = 0.002 + ((i * 7919) % 100) / 10000;
      clock.observe(100 + capture + delay, capture);
    }
    expect(clock.offset).toBeGreaterThan(100.0019);
    expect(clock.offset).toBeLessThan(100.0025);
  });

  it('uses the reported age of the newest sample', () => {
    const clock = new ClockSync();
    clock.observe(10.05, 1, 0.05);
    expect(clock.toHost(1)).toBeCloseTo(10, 9);
    expect(clock.toCapture(10)).toBeCloseTo(1, 9);
  });

  it('follows a slow drift without jumping', () => {
    const clock = new ClockSync();
    let maxStep = 0;
    let previous = 0;
    for (let i = 0; i < 3000; i++) {
      const capture = i * 0.01;
      // The audio clock runs 100 ppm slow against the host clock.
      clock.observe(50 + capture * 1.0001 + 0.003, capture);
      if (i > 0) maxStep = Math.max(maxStep, Math.abs(clock.offset - previous));
      previous = clock.offset;
    }
    expect(clock.toHost(30)).toBeCloseTo(50 + 30 * 1.0001 + 0.003, 2);
    expect(maxStep).toBeLessThan(0.001);
  });
});

/** Deterministic pseudo-random numbers in 0..1. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('ClockSync under transport jitter', () => {
  /** Batches every 10 ms, each delivered late by a base delay plus a long-tailed jitter (the native IPC under load). */
  function run(seconds: number, jitter: number, cadence = 0.01, drift = 0) {
    const clock = new ClockSync();
    const random = noise(7);
    let largestStep = 0, min = Infinity, max = -Infinity, previousHeard = -Infinity, backwards = 0, previous = 0;
    const from = 5;
    for (let i = 0; i * cadence < seconds; i++) {
      const capture = i * cadence;
      const late = 0.004 + jitter * -Math.log(1 - random() * 0.999);
      const now = 200 + capture * (1 + drift) + late;
      clock.observe(now, capture);
      if (capture >= from) {
        largestStep = Math.max(largestStep, Math.abs(clock.offset - previous));
        min = Math.min(min, clock.offset);
        max = Math.max(max, clock.offset);
        // What a frame rendered now would be timed at (frames come on the host clock, not with the messages).
        const heard = clock.toCapture(200 + capture * (1 + drift));
        if (heard < previousHeard) backwards++;
        previousHeard = heard;
      }
      previous = clock.offset;
    }
    return { clock, largestStep, excursion: max - min, backwards };
  }

  it('does not step with the arrival of each message: the mapping glides, whatever the jitter', () => {
    // Deliveries 4 ms late plus an exponential tail of mean 6 ms: up to tens of milliseconds, as measured natively.
    const { clock, largestStep, excursion } = run(60, 0.006);
    // The fastest path is found (within the luck of the window)…
    expect(clock.offset).toBeGreaterThan(200.004 - 1e-9);
    expect(clock.offset).toBeLessThan(200.0052);
    // …and once found the offset moves by microseconds per message, a millisecond or so in a minute.
    expect(largestStep).toBeLessThan(0.00005);
    expect(excursion).toBeLessThan(0.0015);
    expect(clock.resyncs).toBe(0);
  });

  it('keeps the mapped time monotonic while it follows a drifting audio clock', () => {
    // 300 ppm of drift (a poor USB interface) with the same jitter, for two minutes.
    const { clock, backwards, largestStep } = run(120, 0.006, 0.01, 3e-4);
    expect(backwards).toBe(0);
    // While it follows the drift it moves at most 2 ms per second: a fraction of a millisecond between two messages.
    expect(largestStep).toBeLessThan(0.0002);
    // Still within a few milliseconds of the truth at the end.
    expect(Math.abs(clock.toHost(120) - (200 + 120 * (1 + 3e-4) + 0.004))).toBeLessThan(0.006);
  });

  it('is as steady with one message per scene frame as with one per capture callback', () => {
    const coarse = run(60, 0.006, 0.016);
    expect(coarse.largestStep).toBeLessThan(0.00005);
    expect(coarse.excursion).toBeLessThan(0.002);
  });

  it('starts over when the clocks really jump apart (a suspended machine), and only then', () => {
    const clock = new ClockSync();
    for (let i = 0; i < 1000; i++) clock.observe(50 + i * 0.01 + 0.003, i * 0.01);
    expect(clock.resyncs).toBe(0);
    // The host slept 3 s: every delivery is now 3 s "late".
    for (let i = 1000; i < 1300; i++) clock.observe(53 + i * 0.01 + 0.003, i * 0.01);
    expect(clock.resyncs).toBe(1);
    expect(clock.toHost(13)).toBeCloseTo(53 + 13 + 0.003, 6);
  });

  it('forgets everything on reset', () => {
    const clock = new ClockSync();
    for (let i = 0; i < 500; i++) clock.observe(50 + i * 0.01, i * 0.01);
    clock.reset();
    expect(clock.ready).toBe(false);
    clock.observe(900, 1);
    expect(clock.offset).toBe(899);
  });
});

describe('RhythmGate', () => {
  const run = (gate: RhythmGate, confidence: (t: number) => number, seconds: number, from = 0) => {
    const modes: string[] = [];
    for (let t = from; t < from + seconds; t += 1 / 60) {
      gate.update(confidence(t), 1 / 60);
      if (modes[modes.length - 1] !== gate.mode) modes.push(gate.mode);
    }
    return modes;
  };

  it('engages after a held confidence and ramps the weight in', () => {
    const gate = new RhythmGate();
    run(gate, () => 0.8, 0.9);
    expect(gate.mode).toBe('free');
    run(gate, () => 0.8, 0.3);
    expect(gate.mode).toBe('grid');
    expect(gate.weight).toBeLessThan(0.5);
    run(gate, () => 0.8, 5);
    expect(gate.weight).toBeGreaterThan(0.9);
  });

  it('does not flicker on a confidence that hovers or dips briefly', () => {
    const gate = new RhythmGate();
    run(gate, () => 0.8, 4);
    // Dips below the release threshold for 1 s at a time, and hovering in the hysteresis band.
    const modes = run(gate, (t) => (t % 3 < 1 ? 0.2 : 0.5), 30, 4);
    expect(modes).toEqual(['grid']);
  });

  it('falls back to free when the grid is lost, without a jump', () => {
    const gate = new RhythmGate();
    run(gate, () => 0.9, 6);
    let previous = gate.weight;
    let maxStep = 0;
    for (let i = 0; i < 300; i++) {
      gate.update(0.1, 1 / 60);
      maxStep = Math.max(maxStep, Math.abs(gate.weight - previous));
      previous = gate.weight;
    }
    expect(gate.mode).toBe('free');
    expect(gate.weight).toBeLessThan(0.1);
    expect(maxStep).toBeLessThan(0.05);
  });
});

/** A steady 120 BPM grid as the analysis reports it at capture time `capture` (its newest sample). */
function analysisAt(capture: number, confidence = 0.9): TimingInput {
  const time = capture;
  const period = 0.5;
  const index = Math.floor(time / period);
  return { time, nextBeatTime: (index + 1) * period, beatBpm: 120, beatConfidence: confidence, barPhase: ((index % 4) + (time / period - index)) / 4, presence: 1 };
}

describe('Timing', () => {
  const FPS = 60;
  const frame = 1 / FPS;
  const OFFSET = 1000; // host = capture + OFFSET

  function simulate(seconds: number, output: number, lag: number, confidence = 0.9, onsets: number[] = []) {
    const timing = new Timing();
    timing.latency.output = output;
    timing.latency.renderFrames = 1.5;
    const clock = new ClockSync();
    const beats: { heard: number; position: number; downbeat: boolean }[] = [];
    const impacts: { frameHeard: number; late: number }[] = [];
    const queue = [...onsets];
    const pending: OnsetInput[] = [];
    for (let f = 0; f < seconds * FPS; f++) {
      const now = OFFSET + f * frame;
      const capture = now - OFFSET;
      const input = analysisAt(capture, confidence);
      clock.observe(now, input.time);
      // Onsets are reported `lag` seconds after they happen (detection delay), stamped with their own time.
      pending.length = 0;
      while (queue.length && queue[0] + lag <= input.time) pending.push({ time: queue.shift()!, strength: 1, region: 0 });
      timing.update(now, frame, input, pending, pending.length, clock, frame);
      if (timing.beat) beats.push({ heard: timing.heardTime, position: timing.beat.barPosition, downbeat: timing.beat.downbeat });
      for (let i = 0; i < timing.impactCount; i++) impacts.push({ frameHeard: timing.heardTime, late: timing.impacts[i].late });
    }
    return { beats, impacts, timing };
  }

  it('shows each beat in the frame seen closest to when it is heard', () => {
    const { beats } = simulate(10, 0.1, 0.03);
    const late = beats.filter((b) => b.heard > 3);
    expect(late.length).toBeGreaterThanOrEqual(13);
    for (const b of late) {
      const error = b.heard - Math.round(b.heard / 0.5) * 0.5;
      expect(Math.abs(error)).toBeLessThanOrEqual(frame / 2 + 1e-9);
    }
    // One cue per beat, downbeats every fourth.
    for (let i = 1; i < late.length; i++) expect(late[i].heard - late[i - 1].heard).toBeCloseTo(0.5, 1);
    for (const b of late) expect(b.downbeat).toBe(Math.round(b.heard / 0.5) % 4 === 0);
  });

  it('predicts ahead of the analysis when the output is fast', () => {
    // No output latency: the frame is seen 1.5 frames from now, after the newest analysed sample.
    const { timing, beats } = simulate(6, 0, 0.04);
    expect(timing.lead).toBeCloseTo(1.5 * frame, 6);
    for (const b of beats.filter((x) => x.heard > 3)) expect(Math.abs(b.heard - Math.round(b.heard / 0.5) * 0.5)).toBeLessThanOrEqual(frame / 2 + 1e-9);
  });

  it('holds attacks until they are heard, or shows them at once when already late', () => {
    // Slow output (Bluetooth-like): the attack waits for its moment.
    const slow = simulate(4, 0.2, 0.03, 0.9, [2.0]);
    expect(slow.impacts).toHaveLength(1);
    expect(Math.abs(slow.impacts[0].frameHeard - 2.0)).toBeLessThanOrEqual(frame / 2 + 1e-9);
    expect(slow.impacts[0].late).toBeLessThan(frame);
    // Fast output: the analysis lag cannot be hidden; it is shown at once and reported as late.
    const fast = simulate(4, 0, 0.03, 0.9, [2.0]);
    expect(fast.impacts).toHaveLength(1);
    expect(fast.impacts[0].late).toBeGreaterThan(0.03);
    // The detection delay is measured from the attack's capture to the frame that learns of it.
    expect(fast.timing.onsetDelay).toBeGreaterThanOrEqual(0.03);
    expect(fast.timing.onsetDelay).toBeLessThan(0.03 + frame + 1e-9);
  });

  it('gives no beats without a trusted grid', () => {
    const { beats, timing } = simulate(8, 0.05, 0.03, 0.2);
    expect(beats).toHaveLength(0);
    expect(timing.mode).toBe('free');
  });
});
