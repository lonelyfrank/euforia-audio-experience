import { describe, expect, it } from 'vitest';
import { newFrame } from '../audio/features/decode';
import { AnticipationLedger, ANTICIPATION, createAnticipation, LAPSE_AFTER, RELEASE_HOLD } from './Anticipation';
import { ExperienceEngine } from './ExperienceEngine';
import type { AudioEvent } from './EventStream';

const HOP = 256 / 48000;
/** `seconds` of hops with the expectation `at(t)` gives; returns the time reached. */
function run(ledger: AnticipationLedger, from: number, seconds: number, at: (t: number) => number, stored = 0): number {
  let t = from;
  for (let n = 0; n < Math.round(seconds / HOP); n++) { t += HOP; ledger.update(t, HOP, at(t), stored); }
  return t;
}

describe('anticipation: what is expected, and what became of it', () => {
  it('expects nothing of steady music: evidence under the bar opens no anticipation', () => {
    const ledger = new AnticipationLedger();
    // What a steady groove gives: evidence that comes and goes below a quarter.
    run(ledger, 0, 30, (t) => 0.12 + 0.1 * Math.sin(t * 3));
    expect(ledger.frame.phase).toBe('none'); expect(ledger.frame.opened).toBe(0);
    // More of it, still short of a forecast: uncertain, and nothing is opened.
    run(ledger, 30, 5, () => 0.35);
    expect(ledger.frame.phase).toBe('uncertain'); expect(ledger.frame.opened).toBe(0);
    // One hop of full evidence is not a build.
    ledger.update(35 + HOP, HOP, 1, 0);
    expect(ledger.frame.opened).toBe(0);
  });

  it('a build opens one, a release confirms it and says how long it took; then it is over', () => {
    const ledger = new AnticipationLedger();
    let t = run(ledger, 0, 5, () => 0.1);
    t = run(ledger, t, 6, (now) => Math.min(1, (now - 5) / 4), 0.4);
    const f = ledger.frame;
    expect(f.phase).toBe('probable'); expect(f.opened).toBe(1); expect(f.stored).toBe(0.4);
    // It opened where the evidence passed the bar (followed over a moment, so a little after).
    expect(f.since).toBeGreaterThan(5 + 4 * ANTICIPATION.open); expect(f.since).toBeLessThan(5 + 4 * ANTICIPATION.open + 0.8);
    expect(f.age).toBeCloseTo(t - f.since, 9);
    const since = f.since;
    ledger.release(t);
    expect(f.phase).toBe('confirmed'); expect(f.confirmed).toBe(1); expect(f.lead).toBeCloseTo(t - since, 9); expect(f.since).toBe(0);
    // The release is felt for as long as its front takes to pass; with the evidence gone, nothing is expected after it.
    const end = run(ledger, t, RELEASE_HOLD - 0.1, () => 0);
    expect(f.phase).toBe('confirmed');
    run(ledger, end, 0.5, () => 0);
    expect(f.phase).toBe('none');
    expect([f.opened, f.confirmed, f.expired, f.unannounced]).toEqual([1, 1, 0, 0]);
  });

  it('a build that goes nowhere lapses, once, after its evidence has been gone for a while; a waver does not end it', () => {
    const ledger = new AnticipationLedger();
    let t = run(ledger, 0, 4, () => 0.9);
    expect(ledger.frame.phase).toBe('probable');
    // The evidence wavers about where it is held: the same anticipation, still open.
    t = run(ledger, t, 6, (now) => 0.32 + 0.12 * Math.sin(now * 5));
    expect(ledger.frame.opened).toBe(1); expect(ledger.frame.phase).toBe('probable');
    // It is gone: open a while longer (the forecast may still come true), then lapsed.
    t = run(ledger, t, LAPSE_AFTER - 0.5, () => 0);
    expect(ledger.frame.phase).toBe('probable'); expect(ledger.frame.expired).toBe(0);
    t = run(ledger, t, 2, () => 0);
    expect(ledger.frame.phase).toBe('none'); expect(ledger.frame.expired).toBe(1); expect(ledger.frame.expiredAt).toBeGreaterThan(t - 2);
    run(ledger, t, 20, () => 0);
    expect([ledger.frame.opened, ledger.frame.confirmed, ledger.frame.expired]).toEqual([1, 0, 1]);
  });

  it('a release nothing announced is counted as that; broken input changes nothing; a new session starts the account over', () => {
    const ledger = new AnticipationLedger();
    const t = run(ledger, 0, 3, () => 0.05);
    ledger.release(t);
    expect(ledger.frame.unannounced).toBe(1); expect(ledger.frame.confirmed).toBe(0); expect(ledger.frame.phase).toBe('confirmed');
    ledger.update(NaN, HOP, 1, 1); ledger.update(t + HOP, NaN, 1, 1); ledger.update(t + HOP, 0, 1, 1); ledger.release(NaN);
    ledger.update(t + HOP, HOP, NaN, Infinity);
    for (const value of Object.values(ledger.frame)) if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    expect(ledger.frame.unannounced).toBe(1);
    ledger.reset();
    expect(ledger.frame).toEqual(createAnticipation());
  });
});

describe('anticipation in the engine: a false forecast is recovered from', () => {
  function tone() {
    const a = newFrame();
    a.presence = a.sounding = a.phaseCoherence = a.harmonicity = a.harmonicShare = 1;
    a.loudnessMomentary = -18; a.entropy = 0.15; a.beatConfidence = 0.9; a.structureConfidence = 0.8;
    a.bandDb.fill(-40); a.bandDb[3] = -18;
    return a;
  }
  /** A build over `rise` seconds from 5 s on; `drop`: whether it lands (a hard attack with novelty) or just stops rising. */
  function session(drop: boolean, seconds = 40) {
    const e = new ExperienceEngine(), a = tone(), rise = 14;
    const trace: { time: number; potential: number; speed: number; radius: number; level: number; phase: string }[] = [];
    for (let n = 1; n <= seconds * 200; n++) {
      const t = a.time = n / 200; a.sample = n * 240;
      const building = t >= 5 && t < 5 + rise;
      a.loudnessMomentary = t < 5 ? -40 : building ? -40 + (t - 5) * 1.8 : drop ? -12 : -40;
      a.loudnessSlope = building ? 1.8 : 0;
      a.onsetDensity = building ? 6 : 2; a.roughness = building ? 0.6 : 0.1;
      a.shortTransient = drop && t >= 5 + rise && t < 5 + rise + 0.01 ? 1 : 0;
      a.novelty = drop && t >= 5 + rise && t < 5 + rise + 1 ? 0.8 : 0;
      e.ingest(a);
      if (n % 20 === 0) trace.push({ time: t, potential: e.world.state.potential, speed: e.world.state.speed, radius: e.world.state.radius, level: e.anticipation.frame.level, phase: e.anticipation.frame.phase });
    }
    const events: AudioEvent[] = Array.from({ length: e.events.count }, (_, i) => ({ ...e.events.at(i) }));
    return { e, trace, events };
  }

  it('confirmed: the build is expected, stored, and released by the drop', () => {
    const { e, trace, events } = session(true);
    const f = e.anticipation.frame;
    expect(f.opened).toBeGreaterThanOrEqual(1); expect(f.confirmed).toBe(1); expect(f.unannounced).toBe(0);
    expect(f.lead).toBeGreaterThan(2);
    expect(events.filter((x) => x.type === 'drop')).toHaveLength(1);
    // What was stored for it turned into motion at the release.
    const before = trace.filter((x) => x.time < 19).at(-1)!, after = trace.find((x) => x.time > 19.2)!;
    expect(before.potential).toBeGreaterThan(0.3); expect(after.potential).toBeLessThan(0.6 * before.potential);
    expect(e.presented.anticipation).toEqual(createAnticipation());
    expect(e.present(40)!.anticipation.confirmed).toBe(1);
  });

  it('false: nothing is released, what was stored leaks away without a jump, and nothing is left suspended', () => {
    const { e, trace, events } = session(false);
    const f = e.anticipation.frame;
    // It was expected, and for a while the world held potential for it.
    expect(f.opened).toBeGreaterThanOrEqual(1);
    const peak = Math.max(...trace.map((x) => x.potential));
    expect(peak).toBeGreaterThan(0.3);
    // No drop, no release front: the forecast lapsed.
    expect(events.some((x) => x.type === 'drop')).toBe(false);
    expect(f.confirmed).toBe(0); expect(f.expired).toBe(f.opened); expect(f.phase).toBe('none'); expect(f.since).toBe(0);
    expect(e.world.state.releaseTime).toBe(-Infinity); expect(e.world.state.releaseStrength).toBe(0);
    // The stored potential only leaks from where the build stopped: never up again, never by a step, and it is going.
    const after = trace.filter((x) => x.time >= 19.5);
    for (let i = 1; i < after.length; i++) {
      expect(after[i].potential).toBeLessThanOrEqual(after[i - 1].potential + 1e-9);
      expect(after[i - 1].potential - after[i].potential).toBeLessThan(0.02);
      expect(Math.abs(after[i].radius - after[i - 1].radius)).toBeLessThan(0.05);
    }
    expect(after.at(-1)!.potential).toBeLessThan(0.15 * peak);
    for (const x of trace) for (const value of [x.potential, x.speed, x.radius, x.level]) expect(Number.isFinite(value)).toBe(true);
  });

  it('a new session starts the account over; the ledger changes nothing in the world', () => {
    const { e } = session(true, 22);
    expect(e.anticipation.frame.confirmed).toBe(1);
    e.reset();
    expect(e.anticipation.frame).toEqual(createAnticipation());
    // The same session with the account never read: the same world, bit for bit.
    const first = session(false, 12).e.world.state, second = session(false, 12).e.world.state;
    expect({ ...first, forces: { ...first.forces } }).toEqual({ ...second, forces: { ...second.forces } });
  });
});
