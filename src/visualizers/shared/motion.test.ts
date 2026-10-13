import { describe, expect, it } from 'vitest';
import { EventStream } from '../../experience/EventStream';
import { AccentGate, ARRIVED, follow, HysteresisGate, RateFollower } from './motion';

describe('shared motion: what travels with the world', () => {
  it('a followed speed covers the world\'s own distance, the same at any frame rate, and stops when the world does', () => {
    // Kicks: a jump of speed every half second (1.2 + 1.6·exp(−t / 0.15)), coasting down between them, for 8 s; then a
    // world that stands still. `travelled` is the world's own distance by then.
    const travelled = (t: number): number => {
      const s = Math.min(t, 8), kicks = Math.floor(s / 0.5 + 1e-9), since = s - kicks * 0.5;
      return 1.2 * s + 1.6 * 0.15 * (kicks * (1 - Math.exp(-0.5 / 0.15)) + 1 - Math.exp(-Math.max(0, since) / 0.15));
    };
    const run = (fps: number): number => {
      const f = new RateFollower();
      let distance = 0, jerk = 0, last = 0;
      for (let k = 0; k < 14 * fps; k++) {
        // As a scene has it: the world's displacement over the frame (WorldView.dTravel), as a rate.
        const covered = f.step(1 / fps, (travelled((k + 1) / fps) - travelled(k / fps)) * fps, 0.2);
        jerk = Math.max(jerk, Math.abs(covered - last) * fps); last = covered; distance += covered;
      }
      expect(f.rate).toBe(0);
      // A kick is a jump of 1.6 in the world's speed; followed, no frame changes speed by more than a third of it.
      expect(jerk).toBeLessThan(1.6 / 3);
      return distance;
    };
    // Followed, the distance is the world's own once the coast is over: the same at any frame rate.
    for (const fps of [30, 60, 120, 144]) expect(run(fps)).toBeCloseTo(travelled(8), 3);
  });

  it('a follower arrives: what the world has stopped asking for does not fade for ever', () => {
    let y = 1;
    for (let k = 0; k < 400; k++) y = follow(y, 0, Math.exp(-(1 / 60) / 0.3));
    expect(y).toBe(0);
    expect(follow(0.5 + ARRIVED / 2, 0.5, 0.9)).toBe(0.5);
  });

  it('a gate opens when its drive really passes the bar, slowly, and closes later than it opened', () => {
    const gate = new HysteresisGate(0.3, 0.12, 0.6, 1.4);
    // A drive that wavers below the bar opens nothing.
    for (let k = 0; k < 600; k++) gate.step(1 / 60, 0.2 + 0.09 * Math.sin(k));
    expect(gate.aperture).toBe(0);
    gate.step(1 / 60, 0.31);
    expect(gate.open).toBe(true); expect(gate.aperture).toBeLessThan(0.05);
    // Open, it stays open while the drive wavers between the two bars.
    for (let k = 0; k < 600; k++) gate.step(1 / 60, 0.2 + 0.07 * Math.sin(k));
    expect(gate.aperture).toBe(1);
    let frames = 0;
    while (gate.aperture > 0 && frames < 1000) { gate.step(1 / 60, 0.05); frames++; }
    expect(frames).toBeGreaterThan(80); expect(frames).toBeLessThan(90);
    // Mounted into a strained world it is open at once.
    gate.prime(0.8);
    expect(gate.aperture).toBe(1);
  });

  it('accents are the events that stand out, one at a time, by their age; an ordinary kick is refused', () => {
    const events = new EventStream(), gate = new AccentGate(0.7, 2);
    const strike = (time: number, significance: number, type: 'impact' | 'drop' | 'onset' = 'impact'): void => events.push(type, time, 0.6, 0.9, 1, 0.4, 0, significance);
    // What was heard before the gate was there opens nothing in it.
    strike(0.5, 1);
    gate.read(events, 1);
    expect(gate.taken).toBe(0); expect(gate.value(0.5)).toBe(0);
    strike(1.2, 0.4); strike(1.5, 0.95); strike(1.6, 1, 'onset'); strike(1.9, 1); strike(2.2, NaN);
    gate.read(events, 2.5);
    expect(gate.taken).toBe(1); expect(gate.refused).toBe(3); expect(gate.time).toBe(1.5);
    // Its level is how far it passed the bar; what is held of it is gone with its age on the audio clock.
    expect(gate.level).toBeCloseTo(0.5 + 0.5 * 0.25 / 0.3, 12);
    expect(gate.value(0.5)).toBeCloseTo(gate.level * Math.exp(-1 / 0.5), 12);
    // Two seconds after the one taken, the next one is taken; an event that will be heard later waits for its time.
    strike(3.6, 0.8, 'drop'); strike(9, 1);
    gate.read(events, 3.7);
    expect(gate.taken).toBe(2); expect(gate.time).toBe(3.6);
    gate.reset();
    expect(gate.value(0.5)).toBe(0); expect(gate.taken + gate.refused).toBe(0);
    // A reset is not a reason to hear the past again.
    gate.read(events, 4);
    expect(gate.taken).toBe(0);
  });
});
