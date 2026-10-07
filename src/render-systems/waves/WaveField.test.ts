import { describe, expect, it } from 'vitest';
import { EventStream } from '../../experience/EventStream';
import { MAX_WAVES, WaveField } from './WaveField';

/** Front radius and amplitude of every live front at `now`, strongest first. */
const fronts = (w: WaveField, now: number) =>
  Array.from({ length: MAX_WAVES }, (_, i) => ({ radius: w.speed[i] * w.age(i, now), amplitude: w.amplitude(i, now), band: w.band[i], width: w.width[i] }))
    .filter((f) => f.amplitude > 0).sort((a, b) => b.amplitude - a.amplitude);

describe('wave field', () => {
  it('an impact starts a front at its audio time, which then propagates and decays', () => {
    const events = new EventStream(), waves = new WaveField();
    events.push('impact', 1, 0.8, 1, 1, 0.6);
    // Not heard yet: nothing starts ahead of its time.
    waves.update(0.9, events);
    expect(waves.active(0.9)).toBe(0);
    waves.update(1.1, events);
    const early = fronts(waves, 1.1)[0];
    expect(early.radius).toBeCloseTo(0.1 * (1.6 + 0.8 / 7), 5);
    waves.update(1.6, events);
    const late = fronts(waves, 1.6)[0];
    expect(late.radius).toBeGreaterThan(early.radius * 5);
    expect(late.amplitude).toBeLessThan(early.amplitude * 0.6);
    // It ends by itself and frees its slot.
    waves.update(6, events);
    expect(waves.active(6)).toBe(0);
  });

  it('looks the same at any frame rate and for any arrival order', () => {
    const run = (fps: number, late: boolean) => {
      const events = new EventStream(), waves = new WaveField();
      const pending: [number, number, number][] = [[0.5, 0.9, 0], [0.82, 0.6, 6], [1.31, 0.8, 2]];
      for (let frame = 1; frame <= fps * 2; frame++) {
        const now = frame / fps;
        // Late: an event reaches the stream 0.12 s after its audio time (analysis and transport delay).
        while (pending.length && pending[0][0] + (late ? 0.12 : -0.3) <= now) {
          const [time, strength, band] = pending.shift()!;
          events.push('impact', time, strength, 1, band, 0.5);
        }
        waves.update(now, events);
      }
      return fronts(waves, 2);
    };
    const reference = run(60, false);
    expect(reference).toHaveLength(3);
    for (const other of [run(30, false), run(144, false), run(60, true), run(144, true)]) {
      expect(other).toHaveLength(3);
      other.forEach((front, i) => {
        expect(front.radius).toBeCloseTo(reference[i].radius, 9);
        expect(front.amplitude).toBeCloseTo(reference[i].amplitude, 9);
      });
    }
  });

  it('a drop is one broad, slow, long front; a plain beat or a weak onset is none', () => {
    const events = new EventStream(), waves = new WaveField();
    events.push('beat', 1, 1, 1);
    events.push('downbeat', 1, 1, 1);
    events.push('onset', 1.2, 0.3, 1, 1);
    events.push('impact', 1.4, 0.15, 0.5, 1, 0);
    waves.update(1.5, events);
    expect(waves.active(1.5)).toBe(0);
    events.push('impact', 2, 0.7, 1, 5, 0.5);
    events.push('drop', 2, 0.8, 1);
    waves.update(2.05, events);
    // The impact that carries the drop and the drop are the same moment: one front, the stronger description.
    const [front] = fronts(waves, 2.05);
    expect(waves.active(2.05)).toBe(1);
    expect(front.band).toBe(-1);
    expect(front.width).toBeGreaterThan(0.4);
    waves.update(4, events);
    expect(waves.active(4)).toBe(1);
  });

  it('band character: low fronts are broad and slow, high ones thin and fast', () => {
    const events = new EventStream(), waves = new WaveField();
    events.push('impact', 1, 0.9, 1, 0, 0.5);
    events.push('impact', 1.3, 0.9, 1, 7, 0.5);
    waves.update(1.4, events);
    const low = waves.band.indexOf(0), high = waves.band.indexOf(1);
    expect(waves.speed[high]).toBeGreaterThan(waves.speed[low]);
    expect(waves.width[high]).toBeLessThan(waves.width[low]);
  });

  it('is bounded: a dense stream keeps the strongest fronts, never more than its size', () => {
    const events = new EventStream(), waves = new WaveField();
    for (let frame = 1; frame <= 60 * 120; frame++) {
      const now = frame / 60;
      if (frame % 6 === 0) events.push('impact', now - 0.01, 0.3 + 0.7 * ((frame * 7919) % 97) / 97, 1, frame % 8, 0.5);
      waves.update(now, events, Math.sin(now), 1);
      expect(waves.active(now)).toBeLessThanOrEqual(MAX_WAVES);
    }
    for (let i = 0; i < MAX_WAVES; i++) {
      expect(Number.isFinite(waves.amplitude(i, 120))).toBe(true);
      expect(waves.strength[i]).toBeLessThanOrEqual(2);
      for (let k = 0; k < 3; k++) expect(Math.abs(waves.origin[i * 3 + k])).toBeLessThan(1);
    }
  });

  it('a scene mounted mid-session starts no front for what has long passed', () => {
    const events = new EventStream();
    events.push('impact', 1, 1, 1, 0, 1);
    events.push('impact', 99.8, 1, 1, 0, 1);
    const waves = new WaveField();
    waves.update(100, events);
    expect(waves.active(100)).toBe(1);
    expect(fronts(waves, 100)[0].radius).toBeCloseTo(0.2 * 1.6, 5);
  });

  it('a new session clears the fronts of the old one', () => {
    const events = new EventStream(), waves = new WaveField();
    events.push('impact', 10, 1, 1, 0, 1);
    waves.update(10.1, events);
    expect(waves.active(10.1)).toBe(1);
    // The stream restarts (session reset) and the clock starts over.
    events.reset();
    waves.update(0.05, events);
    expect(waves.active(0.05)).toBe(0);
    events.push('impact', 0.1, 1, 1, 0, 1);
    waves.update(0.2, events);
    expect(waves.active(0.2)).toBe(1);
    waves.reset();
    expect(waves.active(0.2)).toBe(0);
  });
});
