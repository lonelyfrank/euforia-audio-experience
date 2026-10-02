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
