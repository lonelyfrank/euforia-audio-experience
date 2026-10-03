import { describe, expect, it } from 'vitest';
import { Dynamics, springMatrix } from './Dynamics';
import { PRESETS, type DynamicsType } from './presets';

/** Step response of a spring preset sampled every millisecond: target 0 → 1 at t = 0. */
function stepResponse(type: DynamicsType, seconds: number) {
  const d = new Dynamics();
  const c = d.channel('x', type);
  d.advance(0);
  d.setTarget(c, 1, 0);
  const values: number[] = [];
  for (let i = 1; i <= seconds * 1000; i++) {
    d.advance(i / 1000);
    values.push(d.value(c));
  }
  const rise = values.findIndex((v) => v >= 0.9) / 1000;
  const overshoot = Math.max(...values) - 1;
  let settle = 0;
  values.forEach((v, i) => {
    if (Math.abs(v - 1) > 0.02) settle = (i + 1) / 1000;
  });
  return { rise, overshoot, settle };
}

describe('spring presets: step response', () => {
  it('glide and drift settle without overshoot (ζ = 1)', () => {
    for (const type of ['glide', 'drift'] as const) {
      const r = stepResponse(type, 30);
      expect(r.overshoot).toBeLessThan(1e-6);
      const preset = PRESETS[type];
      if (preset.kind !== 'spring') throw new Error();
      // Critically damped: 90% at ≈ 3.89 / ω, 2% at ≈ 5.83 / ω.
      const omega = 2 * Math.PI * preset.frequency;
      expect(r.rise).toBeCloseTo(3.89 / omega, 1);
      expect(r.settle).toBeCloseTo(5.83 / omega, 1);
    }
  });

  it('pulse and swing overshoot as their damping says', () => {
    for (const type of ['pulse', 'swing'] as const) {
      const preset = PRESETS[type];
      if (preset.kind !== 'spring') throw new Error();
      const r = stepResponse(type, 10);
      const expected = Math.exp((-Math.PI * preset.damping) / Math.sqrt(1 - preset.damping ** 2));
      expect(r.overshoot).toBeCloseTo(expected, 2);
      expect(r.rise).toBeLessThan(1 / preset.frequency);
    }
  });

  it('the exact step matrix matches fine integration', () => {
    const m = new Float64Array(4);
    for (const [omega, zeta] of [[20, 0.3], [20, 1], [20, 2.5]]) {
      springMatrix(omega, zeta, 1 / 240, m);
      // Reference: semi-implicit Euler with 1000 sub-steps.
      let e = 1, v = 0;
      const h = 1 / 240 / 1000;
      for (let i = 0; i < 1000; i++) {
        v += (-omega * omega * e - 2 * zeta * omega * v) * h;
        e += v * h;
      }
      expect(m[0] * 1 + m[1] * 0).toBeCloseTo(e, 4);
      expect(m[2] * 1 + m[3] * 0).toBeCloseTo(v, 2);
    }
  });
});

describe('followers', () => {
  it('rise with their attack and fall with their release', () => {
    const d = new Dynamics();
    const c = d.channel('level', 'level');
    d.advance(0);
    d.setTarget(c, 1, 0);
    // Targets apply at the next step boundary (one step: the price of identical values at any frame rate).
    const h = d.step;
    d.advance(0.04 + h);
    expect(d.value(c)).toBeCloseTo(1 - Math.exp(-1), 3);
    d.advance(1);
    d.setTarget(c, 0, 1);
    d.advance(1.4 + h);
    expect(d.value(c)).toBeCloseTo(Math.exp(-1), 3);
  });

  it('change type with their state carried over, not across primitives', () => {
    const d = new Dynamics();
    const c = d.channel('bloom', 'level');
    d.advance(0);
    d.setTarget(c, 1, 0);
    d.advance(0.1);
    const before = d.value(c);
    d.setType(c, 'swell');
    d.advance(0.1001);
    expect(d.value(c)).toBeCloseTo(before, 3);
    expect(() => d.setType(c, 'glide')).toThrow();
  });
});

describe('envelopes', () => {
  it('jump to the peak at the impulse time, with no step or frame quantization', () => {
    const d = new Dynamics();
    const c = d.channel('flash', 'flash');
    d.advance(0);
    d.impulse(c, 1, 0.10123);
    d.advance(0.101);
    expect(d.value(c)).toBe(0);
    d.advance(0.10124);
    expect(d.value(c)).toBeGreaterThan(0.999);
    const decay = PRESETS.flash.kind === 'envelope' ? PRESETS.flash.decay : 0;
    d.advance(0.10123 + decay);
    expect(d.value(c)).toBeCloseTo(Math.exp(-1), 6);
  });

  it('show a late impulse at its peak when it is first seen (fast path)', () => {
    const d = new Dynamics();
    const c = d.channel('hit', 'hit');
    d.advance(1);
    d.impulse(c, 0.8, 0.95); // reported 50 ms late
    d.advance(1.0001);
    expect(d.value(c)).toBeGreaterThan(0.79);
  });
});

describe('determinism', () => {
  /** The same events, read at the same audio times, with different frame partitions. */
  function trace(frames: number[]) {
    const d = new Dynamics();
    const pulse = d.channel('pulse', 'pulse');
    const glide = d.channel('glide', 'glide');
    const flash = d.channel('flash', 'flash');
    const level = d.channel('level', 'level');
    d.advance(0);
    for (let beat = 0; beat < 8; beat++) {
      d.impulse(pulse, 0.5, beat * 0.5 + 0.013);
      d.impulse(flash, 1, beat * 0.5 + 0.013);
    }
    d.setTarget(glide, 1, 0.7);
    d.setTarget(level, 0.8, 0.3);
    d.setTarget(level, 0.1, 1.2);
    d.snap(2.0, 0.5);
    d.setTarget(glide, 0, 2.0);
    const samples = new Map<number, number[]>();
    let t = 0;
    for (const frame of frames) {
      t += frame;
      d.advance(t);
      samples.set(Math.round(t * 1e6), [d.value(pulse), d.value(glide), d.value(flash), d.value(level)]);
    }
    return samples;
  }

  it('gives the same values at 60 fps, 144 fps and with irregular frames', () => {
    const at60 = trace(Array.from({ length: 240 }, () => 1 / 60));
    const at144 = trace(Array.from({ length: 576 }, () => 1 / 144));
    // Irregular frames that still land on every 1/60 s mark (so the samples can be compared).
    const irregular: number[] = [];
    for (let i = 0; i < 240; i++) irregular.push(...(i % 3 === 0 ? [1 / 120, 1 / 120] : i % 3 === 1 ? [1 / 60] : [1 / 180, 1 / 90]));
    const atIrregular = trace(irregular);
    let compared = 0;
    for (const [time, values] of at60) {
      for (const other of [at144, atIrregular]) {
        const v = other.get(time);
        if (!v) continue;
        compared++;
        for (let k = 0; k < 4; k++) expect(v[k]).toBeCloseTo(values[k], 9);
      }
    }
    expect(compared).toBeGreaterThan(200);
  });
});

describe('snap', () => {
  it('stops the build-up trail at a section boundary', () => {
    const d = new Dynamics();
    const swing = d.channel('swing', 'swing');
    const flash = d.channel('flash', 'flash');
    d.advance(0);
    // A busy build: kicks every quarter beat.
    for (let i = 0; i < 16; i++) d.impulse(swing, 0.4, i * 0.12);
    d.impulse(flash, 1, 1.9);
    d.snap(2.0, 0.5);
    d.advance(2.0 + 1 / 240);
    expect(Math.abs(d.inspect(swing).velocity)).toBeLessThan(1e-9);
    expect(d.inspect(swing).zeta).toBe(1);
    expect(d.value(flash)).toBe(0);
    // Within one bar at 120 BPM (2 s) the swing is back at rest: no trail.
    d.advance(4.0);
    expect(Math.abs(d.value(swing))).toBeLessThan(0.02);
    expect(d.inspect(swing).zeta).toBeCloseTo(PRESETS.swing.kind === 'spring' ? PRESETS.swing.damping : 0, 9);
  });
});
