import { describe, expect, it } from 'vitest';
import { newFrame, type AnalysisFrame } from '../audio/features/decode';
import { ExperienceEngine } from '../experience/ExperienceEngine';
import { createState, type ExperienceState } from '../experience/types';
import { axisOf, createResonanceFrame, DEFAULT_RESONANCE, hzOf, mesoAxis, MultiscaleResonance, resolveResonance } from './MultiscaleResonance';

const HOP = 256 / 48000;

/** A resonator bank fed by hand: the measurements the DSP would export, one hop at a time. */
function bank(config = {}) {
  const resonance = new MultiscaleResonance(config), a: AnalysisFrame = newFrame(), state: ExperienceState = createState();
  const run = (seconds: number, each?: () => void) => {
    for (let k = 0; k < Math.round(seconds / HOP); k++) { a.time += HOP; each?.(); resonance.update(a, state, HOP); }
  };
  /** A steady, tonal sound whose strongest partial is at `hz`. */
  const tone = (hz: number) => {
    a.presence = 1; a.silent = 0; a.phaseCoherence = 1; state.flow = 1; state.energy = 0.6;
    a.pitchBins.fill(0); a.pitchBins[Math.round(12 * Math.log2(hz / 55))] = 1;
  };
  const silence = () => { a.presence = 0; a.silent = 1; a.pitchBins.fill(0); a.bandLevel.fill(0); a.bandTransient.fill(0); a.erb.fill(0); state.flow = state.energy = 0; };
  return { resonance, frame: resonance.frame, a, state, run, tone, silence };
}

const strongest = (levels: Float32Array): number => levels.reduce((best, value, k) => (value > levels[best] ? k : best), 0);

describe('multiscale resonance', () => {
  it('has three scales whose resonator counts are a configuration, within limits', () => {
    expect(resolveResonance()).toEqual(DEFAULT_RESONANCE);
    const small = new MultiscaleResonance({ macro: 8, meso: 24, micro: 4 });
    expect([small.frame.macro.length, small.frame.meso.length, small.frame.mesoLevel.length, small.frame.micro.length]).toEqual([8, 24, 24, 4]);
    const large = createResonanceFrame({ macro: 16, meso: 64, micro: 16 });
    expect([large.macro.length, large.meso.length, large.micro.length]).toEqual([16, 64, 16]);
    // Nonsense is clamped, never trusted.
    expect(resolveResonance({ macro: 1e9, meso: NaN, micro: -3 })).toEqual({ macro: 16, meso: 8, micro: 2 });
    // The frequency axis is logarithmic over the audible range, both ways.
    expect(axisOf(20)).toBe(0); expect(axisOf(20000)).toBeCloseTo(1, 12); expect(hzOf(axisOf(440))).toBeCloseTo(440, 6);
  });

  it('a tone sets the group at its own pitch ringing, and little else', () => {
    for (const hz of [110, 440, 1760]) {
      const b = bank();
      b.tone(hz);
      b.run(4);
      const at = strongest(b.frame.mesoLevel), expected = Math.floor(axisOf(hz) * b.frame.meso.length);
      expect(Math.abs(at - expected), `${hz} Hz`).toBeLessThanOrEqual(1);
      // Driven at its own frequency a resonator swings as far as it is driven.
      expect(b.frame.mesoLevel[at]).toBeGreaterThan(0.8); expect(b.frame.mesoLevel[at]).toBeLessThan(1.2);
      for (let k = 0; k < b.frame.meso.length; k++) if (Math.abs(k - at) > 2) expect(b.frame.mesoLevel[k]).toBeLessThan(0.05);
      expect(Math.abs(b.frame.centre - mesoAxis(at, b.frame.meso.length))).toBeLessThan(0.05);
      expect(b.frame.focus).toBeGreaterThan(0.5);
    }
  });

  it('swings, not just glows: the displacement is signed and oscillates at the group\'s own visual frequency', () => {
    const b = bank();
    b.tone(440);
    b.run(3);
    const at = strongest(b.frame.mesoLevel);
    let crossings = 0, last = b.frame.meso[at], peak = 0;
    b.run(2, () => { const x = b.frame.meso[at]; if (x * last < 0) crossings++; last = x; peak = Math.max(peak, Math.abs(x)); });
    // Between 0.9 and 6.5 Hz: several swings in two seconds, far below any frame rate.
    expect(crossings).toBeGreaterThan(4); expect(crossings).toBeLessThan(30);
    expect(peak).toBeGreaterThan(0.7);
  });

  it('rings on and dies away in silence: nothing rises, the low end outlasts the high end', () => {
    const low = bank(), high = bank();
    low.tone(70); high.tone(3000);
    low.run(4); high.run(4);
    const lowAt = strongest(low.frame.mesoLevel), highAt = strongest(high.frame.mesoLevel);
    low.silence(); high.silence();
    let previous = low.frame.mesoEnergy, rose = 0;
    low.run(0.5, () => { if (low.frame.mesoEnergy > previous + 1e-9) rose++; previous = low.frame.mesoEnergy; });
    high.run(0.5);
    expect(rose).toBe(0);
    expect(low.frame.mesoLevel[lowAt]).toBeGreaterThan(0.5);
    expect(high.frame.mesoLevel[highAt]).toBeLessThan(0.3);
    expect(low.frame.mesoLevel[lowAt]).toBeGreaterThan(2 * high.frame.mesoLevel[highAt]);
    low.run(30);
    expect(low.frame.mesoEnergy).toBeLessThan(1e-4); expect(low.frame.macroEnergy).toBeLessThan(1e-4); expect(low.frame.microEnergy).toBeLessThan(1e-6);
  });

  it('a transient strikes the groups of its band, an event the slow modes, and the top of the spectrum the micro bands', () => {
    const b = bank();
    b.a.presence = 1; b.state.energy = 0.5;
    // A kick: a rise in the bass band for a few hops.
    b.a.bandTransient[1] = 1; b.run(3 * HOP + 1e-9); b.a.bandTransient[1] = 0;
    const bass = Math.floor(axisOf(120) * 32), treble = Math.floor(axisOf(8000) * 32);
    expect(b.frame.mesoLevel[bass]).toBeGreaterThan(0.03);
    expect(b.frame.mesoLevel[treble]).toBe(0);
    expect(b.frame.macroEnergy).toBe(0);
    b.state.eventId = 1; b.state.eventStrength = 1; b.run(HOP + 1e-9);
    expect(b.frame.macroEnergy).toBeGreaterThan(0.2);
    // Hi-hats: level and transients at the top. Micro is taken at once and let go in a tenth of a second.
    expect(b.frame.microEnergy).toBe(0);
    b.a.bandLevel[6] = b.a.bandLevel[7] = 1; b.a.sharpness = 0.5; b.run(0.05);
    expect(b.frame.micro[b.frame.micro.length - 1]).toBeGreaterThan(0.7);
    expect(b.frame.micro[0]).toBeLessThan(b.frame.micro[b.frame.micro.length - 1]);
    b.a.bandLevel.fill(0); b.run(0.5);
    expect(b.frame.microEnergy).toBeLessThan(0.02);
  });

  it('is deterministic, finite for broken input, and forgets on reset', () => {
    const one = bank(), two = bank();
    for (const b of [one, two]) { b.tone(330); b.a.bandLevel.fill(0.7); b.a.erb.fill(0.6); b.run(2); }
    expect(Array.from(one.frame.meso)).toEqual(Array.from(two.frame.meso));
    expect(Array.from(one.frame.macro)).toEqual(Array.from(two.frame.macro));
    one.a.pitchBins.fill(NaN); one.a.bandLevel.fill(Infinity); one.a.bandTransient.fill(-Infinity); one.a.erb.fill(NaN); one.a.sharpness = NaN;
    one.a.presence = Infinity; one.state.flow = NaN; one.state.energy = NaN; one.state.eventStrength = Infinity; one.state.eventId = 9;
    one.run(1);
    const f = one.frame;
    for (const value of [...f.macro, ...f.meso, ...f.mesoLevel, ...f.micro, f.macroEnergy, f.mesoEnergy, f.microEnergy, f.centre, f.focus]) expect(Number.isFinite(value)).toBe(true);
    two.resonance.reset();
    expect(two.frame.mesoEnergy).toBe(0); expect(Math.max(...two.frame.mesoLevel, ...two.frame.macro.map(Math.abs))).toBe(0);
  });

  it('is advanced per hop by the experience engine and presented as an owned copy at the heard time', () => {
    const engine = new ExperienceEngine(), a = newFrame();
    a.presence = 1; a.phaseCoherence = 1; a.harmonicShare = 1; a.loudnessMomentary = -14; a.pitchBins[36] = 1;
    for (let k = 0; k < 600; k++) { a.time += HOP; engine.ingest(a); }
    const heard = engine.present(a.time)!;
    expect(heard.resonance).not.toBe(engine.resonance.frame);
    expect(heard.resonance.meso).not.toBe(engine.resonance.frame.meso);
    expect(heard.resonance.mesoEnergy).toBeGreaterThan(0);
    expect(strongest(heard.resonance.mesoLevel)).toBe(strongest(engine.resonance.frame.mesoLevel));
    // The twelve membrane modes the existing scenes read are still there, untouched by the new scales.
    expect(heard.physics.modes).toHaveLength(12);
    engine.reset();
    expect(engine.resonance.frame.mesoEnergy).toBe(0);
  });
});
