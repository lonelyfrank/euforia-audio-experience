import { describe, expect, it } from 'vitest';
import type { AudioEvent } from '../../experience/EventStream';
import { createResonanceFrame } from '../../physics/MultiscaleResonance';
import { FractureGate } from './FractureGate';
import { ResonanceField } from './ResonanceField';
import { createReadout, shapeRate } from './SolidDynamics';
import {
  createFractureTuning, createSolidTuning, FORM, FRACTURE_LIMITS, INTACT, LOST, PULSE_LIMIT, SOLID_KINDS, SOLID_LIMITS, SOLID_PROFILES, solidProfile, type SolidKind, type SolidProfile,
} from './SolidTypes';
import { StructuralSystem } from './StructuralDynamics';
import { createStillEnvironment, V_MAX, type StructuralEnvironment } from './StructuralTypes';

const RADIUS = 0.6;
/** The world's potential, as a spring to the radius of each element's home layer (the one of Solid.test.ts). */
const hold: StructuralEnvironment['hold'] = (x, y, z, home, out) => {
  const r = Math.max(Math.hypot(x, y, z), 1e-4), k = -3 * (r - (0.3 + 0.95 * home)) / r;
  out[0] = x * k; out[1] = y * k; out[2] = z * k;
};
const ORDERED = { coherence: 0.9, harmony: 0.7, energy: 0.7, turbulence: 0.03 };

function make(kind: SolidKind, profile: SolidProfile, seed = 7) {
  const system = new StructuralSystem({ capacity: 32, seed, solids: {} }), solids = system.solids!;
  const body = system.seedSolid(kind, RADIUS, { tilt: 0.5, turn: 0.4 });
  Object.assign(solids.tuning, solidProfile(profile));
  solids.gate.tuning.mode = profile === 'legacy' ? 'load' : 'events';
  return { system, solids, body, state: solids.state, matter: system.state };
}
type Made = ReturnType<typeof make>;

/**
 * Rhythmic sound as the structure hears it: a kick every 0.484 s (124 BPM) as the pulse drive, a tone and the slow
 * modes in the resonance field. `level` scales all of it.
 */
function rhythm(level = 1, world: Partial<StructuralEnvironment> = {}) {
  const frame = createResonanceFrame(), field = new ResonanceField();
  const env: StructuralEnvironment = { ...createStillEnvironment(), ...ORDERED, hold, resonance: field, ...world };
  let time = 0;
  const tick = (dt: number): void => {
    time += dt;
    const beat = time % 0.484;
    env.pulse = level * Math.exp(-beat / 0.11);
    for (let k = 0; k < frame.meso.length; k++) { frame.mesoLevel[k] = 0.4 * level; frame.meso[k] = 0.4 * level * Math.sin(2 * Math.PI * (1 + 0.15 * k) * time); }
    for (let k = 0; k < frame.macro.length; k++) frame.macro[k] = 0.5 * level * Math.sin(2 * Math.PI * (0.3 + 0.1 * k) * time + k);
    field.update(frame);
  };
  return { env, tick };
}

const event = (audioTime: number, significance: number, confidence = 0.9, type: AudioEvent['type'] = 'impact', strength = 0.5): AudioEvent =>
  ({ type, audioTime, strength, confidence, band: 1, structuralWeight: 0.5, duration: 0, significance, seq: 0 });

const finiteState = (m: Made): boolean => {
  for (const array of [m.matter.position, m.matter.velocity, m.state.linkDamage, m.state.linkRest, m.state.cellVolume, m.state.frame, m.state.rest]) {
    for (let k = 0; k < array.length; k++) if (!Number.isFinite(array[k])) return false;
  }
  return true;
};
const centre = (m: Made): [number, number, number] => { const c = m.solids.centroid(m.body); return [c[0], c[1], c[2]]; };
const momentum = (m: Made): [number, number, number] => {
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < m.matter.count; i++) for (let k = 0; k < 3; k++) out[k] += m.matter.mass[i] * m.matter.velocity[i * 3 + k];
  return out;
};
const blow = (m: Made, strength: number, at = 1.4): void => {
  const p = m.matter.position, first = m.state.bodyFirst[m.body] * 3;
  m.system.strike(p[first] * at, p[first + 1] * at, p[first + 2] * at, strength, RADIUS);
};
/** Peak deviation from its own shape after a tool, how long it takes to come back to a tenth of it, and where it ends. */
function struck(kind: SolidKind, retention: number, tool: 'blow' | 'twist') {
  const m = make(kind, 'legacy'), env = createStillEnvironment(), r = createReadout(), h = m.system.config.step;
  m.solids.tuning.shapeRetention = retention;
  if (tool === 'blow') blow(m, 5); else m.solids.twist(m.body, 3);
  let peak = 0, at = 0, back = -1;
  for (let k = 0; k < 120 * 5; k++) {
    m.system.step(env);
    m.solids.read(m.body, env, r);
    if (r.deviation > peak) { peak = r.deviation; at = k * h; }
    if (back < 0 && k * h > at + 0.02 && r.deviation < 0.1 * peak) back = k * h - at;
  }
  return { peak, back, end: r.deviation, fractures: m.solids.stats.fractures };
}

describe('materials of a body', () => {
  it('the material a body is made with is the one it always had; the others are bounded whatever a tool writes', { timeout: 60000 }, () => {
    expect(solidProfile('legacy')).toEqual(createSolidTuning());
    expect(createSolidTuning()).toMatchObject({ shapeRetention: 0, maxPulse: 0, toughness: 1, recovery: 1 });
    expect(solidProfile('rigid')).toMatchObject({ shapeRetention: 0.9, maxPulse: 0.06 });
    expect(solidProfile('elastic').shapeRetention).toBeLessThan(solidProfile('rigid').shapeRetention);
    expect(PULSE_LIMIT).toBe(0.06); expect(SOLID_LIMITS.maxPulse[1]).toBe(PULSE_LIMIT);
    expect(createFractureTuning().mode).toBe('load');
    for (const profile of SOLID_PROFILES) for (const [key, value] of Object.entries(solidProfile(profile))) {
      const [min, max] = SOLID_LIMITS[key as keyof typeof SOLID_LIMITS];
      expect(value, key).toBeGreaterThanOrEqual(min); expect(value, key).toBeLessThanOrEqual(max);
    }
    // The conversion from a perceptual rigidity to a stiffness: none at none, growing without a bound it could reach.
    expect(shapeRate(0)).toBe(0); expect(shapeRate(0.9)).toBeGreaterThan(30 * shapeRate(0.5)); expect(shapeRate(5)).toBe(shapeRate(0.98)); expect(shapeRate(NaN)).toBe(0);
    // Overrides out of every range still give a simulation.
    const m = make('cube', 'rigid'), { env, tick } = rhythm(1);
    Object.assign(m.solids.tuning, { shapeRetention: 1e9, maxPulse: -5, toughness: NaN, recovery: Infinity, fragmentIntegrity: -3, mass: NaN });
    Object.assign(m.solids.gate.tuning, { confidence: NaN, threshold: 1e9, cooldown: -Infinity });
    for (let k = 0; k < 600; k++) { tick(1 / 120); if (k % 50 === 0) m.solids.gate.offer(event(0, 1)); m.system.step(env); }
    expect(finiteState(m)).toBe(true); expect(m.solids.stats.repairs).toBe(0);
    expect(FRACTURE_LIMITS.cooldown[0]).toBeGreaterThan(0);
  });

  it('a body of the legacy material hears no pulse and no event: it is the body it was', { timeout: 60000 }, () => {
    const play = (driven: boolean) => {
      const m = make('cube', 'legacy'), { env, tick } = rhythm(1);
      for (let k = 0; k < 120 * 12; k++) {
        tick(1 / 120);
        if (!driven) env.pulse = 0; else if (k % 40 === 0) m.solids.gate.offer(event(0, 1));
        if (k === 300) blow(m, 5);
        m.system.step(env);
      }
      return m;
    };
    const plain = play(false), driven = play(true);
    expect(Array.from(driven.matter.position)).toEqual(Array.from(plain.matter.position));
    expect(Array.from(driven.matter.velocity)).toEqual(Array.from(plain.matter.velocity));
    expect(Array.from(driven.state.linkState)).toEqual(Array.from(plain.state.linkState));
    expect(driven.solids.stats.events).toBe(0); expect(driven.solids.pulseOf(0)).toBe(0);
  });
});

describe('the rigid resonant body', () => {
  it('stays whole and itself through a minute of rhythmic sound: it pulses within 6%, deforms by a fraction of a per cent, and no cell turns', { timeout: 180000 }, () => {
    for (const kind of SOLID_KINDS) {
      const m = make(kind, 'rigid'), { env, tick } = rhythm(1), r = createReadout(), h = m.system.config.step;
      // Everything the sound can do to it, at once: the fullest drive, and three times the coupling of the product.
      m.system.tuning.resonanceCoupling = 3;
      let low = 1, high = 1, deviation = 0, strain = 0, inverted = 0, volumeLow = Infinity, volumeHigh = 0;
      for (let k = 0; k < 120 * 60; k++) {
        tick(h);
        // Ordinary attacks of the track keep arriving: none of them is an event.
        if (k % 58 === 0) m.solids.gate.offer(event(0, 0.5));
        m.system.step(env);
        if (k % 4 === 0) {
          m.solids.read(m.body, env, r);
          low = Math.min(low, r.scale); high = Math.max(high, r.scale); deviation = Math.max(deviation, r.deviation); strain = Math.max(strain, r.edgeStrain);
          volumeLow = Math.min(volumeLow, r.volume / r.volumeReference); volumeHigh = Math.max(volumeHigh, r.volume / r.volumeReference);
        }
        inverted += m.solids.stats.inverted;
      }
      // Whole: every link, every face, every cell, one piece.
      expect(m.solids.read(m.body, env, r), kind).toMatchObject({ pieces: 1, sealed: true, form: 'volume', broken: 0, lost: 0 });
      expect(m.solids.stats, kind).toMatchObject({ fractures: 0, events: 0, repairs: 0 });
      // It pulses, visibly, and never past the limit (linear scale, not volume).
      expect(high - low, kind).toBeGreaterThan(0.04);
      expect(high, kind).toBeLessThanOrEqual(1 + PULSE_LIMIT + 1e-9); expect(low, kind).toBeGreaterThanOrEqual(1 - PULSE_LIMIT - 1e-9);
      expect(Math.abs(m.solids.pulseOf(m.body))).toBeLessThanOrEqual(PULSE_LIMIT);
      // Apart from that pulse it keeps its shape: its silhouette is the figure's.
      expect(deviation, kind).toBeLessThan(0.005);
      // An edge is never further from its length than the pulse and the little vibration left to it.
      expect(strain, kind).toBeLessThan(PULSE_LIMIT + 0.02);
      // The volume follows the cube of the scale and no cell is ever found inside out.
      expect(volumeLow, kind).toBeGreaterThan((1 - PULSE_LIMIT) ** 3 - 0.02); expect(volumeHigh, kind).toBeLessThan((1 + PULSE_LIMIT) ** 3 + 0.02);
      expect(inverted, kind).toBe(0);
      for (let c = 0; c < m.state.cells; c++) expect(m.state.measure(c)).toBeGreaterThan(0);
      expect(finiteState(m), kind).toBe(true);
      for (let i = 0; i < m.matter.count * 3; i++) expect(Math.abs(m.matter.velocity[i])).toBeLessThanOrEqual(V_MAX);
    }
  });

  it('is visibly more stable than the body held by its links alone, by the share its retention says', { timeout: 120000 }, () => {
    for (const kind of SOLID_KINDS) {
      const legacy = struck(kind, 0, 'blow'), rigid = struck(kind, 0.9, 'blow');
      expect(legacy.fractures + rigid.fractures).toBe(0);
      // Retention 0.9: about a tenth of the deformation the same blow leaves in the links alone (the calibration of shapeRate).
      expect(rigid.peak / legacy.peak, kind).toBeGreaterThan(0.06); expect(rigid.peak / legacy.peak, kind).toBeLessThan(0.14);
      // More retention, less deformation, all the way.
      let last = legacy.peak;
      for (const retention of [0.3, 0.5, 0.75, 0.9, 0.95]) { const peak = struck(kind, retention, 'blow').peak; expect(peak, `${kind} ${retention}`).toBeLessThan(last); last = peak; }
      // A torsion (no net rotation asked of it) deforms it less still, and it comes back.
      const twisted = struck(kind, 0.9, 'twist'), loose = struck(kind, 0, 'twist');
      expect(twisted.peak / loose.peak, kind).toBeLessThan(0.12);
      // Recovery: back within a tenth of its worst in a few hundredths of a second, and to its shape exactly.
      expect(rigid.back, kind).toBeGreaterThan(0); expect(rigid.back, kind).toBeLessThan(0.1); expect(rigid.back, kind).toBeLessThanOrEqual(legacy.back);
      expect(rigid.end, kind).toBeLessThan(1e-5); expect(twisted.end, kind).toBeLessThan(1e-5);
    }
  });

  it('is free to move and turn: a blow carries it and spins it as it would the links alone, and holding its shape gives it no momentum', { timeout: 60000 }, () => {
    const still = createStillEnvironment();
    // The same blow, off its centre: the momentum it gives is the same whatever the material.
    const legacy = make('cube', 'legacy'), rigid = make('cube', 'rigid');
    // Beside its first vertex and across it, so that it also turns the body.
    const aside = (m: Made): void => { const p = m.matter.position; m.system.strike(p[0] - 0.4 * p[1], p[1] + 0.4 * p[0], p[2] + 0.3, 4, RADIUS); };
    for (const m of [legacy, rigid]) { aside(m); m.system.step(still); }
    const a = momentum(legacy), b = momentum(rigid);
    for (let k = 0; k < 3; k++) expect(b[k]).toBeCloseTo(a[k], 5);
    expect(Math.hypot(...b)).toBeGreaterThan(0.05);
    // It travels and it turns: its fitted rotation leaves the pose it was made in, and its shape goes with it.
    const start = centre(rigid), r = createReadout();
    for (let k = 0; k < 120; k++) rigid.system.step(still);
    const end = centre(rigid), frame = rigid.state.frame;
    expect(Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2])).toBeGreaterThan(0.01);
    expect(Math.abs(frame[3])).toBeLessThan(0.99999); expect(Math.hypot(frame[0], frame[1], frame[2], frame[3])).toBeCloseTo(1, 9);
    expect(rigid.solids.read(rigid.body, still, r).deviation).toBeLessThan(2e-3);
    // The reference geometry is never written: not by the motion, not by the sound.
    const made = make('cube', 'rigid'), reference = Array.from(made.state.rest), scale = made.state.bodyScale[0];
    const { env, tick } = rhythm(1);
    for (let k = 0; k < 600; k++) { tick(1 / 120); if (k === 100) blow(made, 4); made.system.step(env); }
    expect(Array.from(made.state.rest)).toEqual(reference); expect(made.state.bodyScale[0]).toBe(scale);
    // Without any force from outside (a still medium, the sound only): its centre of mass stays where it is.
    const alone = make('icosahedron', 'rigid'), sound = rhythm(1, { hold: createStillEnvironment().hold });
    const from = centre(alone);
    let most = 0;
    for (let k = 0; k < 120 * 20; k++) { sound.tick(1 / 120); alone.system.step(sound.env); most = Math.max(most, Math.abs(alone.solids.pulseOf(0))); }
    const to = centre(alone);
    expect(most).toBeGreaterThan(0.03);
    expect(Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])).toBeLessThan(1e-4);
    // What momentum it has is the medium's drag on matter that is not all alike, a small share of what its pulse moves.
    let moving = 0;
    for (let i = 0; i < alone.matter.count; i++) moving += alone.matter.mass[i] * Math.hypot(alone.matter.velocity[i * 3], alone.matter.velocity[i * 3 + 1], alone.matter.velocity[i * 3 + 2]);
    expect(Math.hypot(...momentum(alone))).toBeLessThan(0.05 * moving);
  });

  it('pulses with the swing of the drive, not with its level, and comes to rest in silence', { timeout: 60000 }, () => {
    const m = make('tetrahedron', 'rigid'), env = { ...createStillEnvironment(), ...ORDERED }, r = createReadout(), h = m.system.config.step;
    const run = (seconds: number, each?: () => void) => { for (let k = 0; k < Math.round(seconds / h); k++) { m.system.step(env); each?.(); } };
    // A drive that only holds moves nothing once it is the usual level.
    env.pulse = 0.8; run(12);
    expect(Math.abs(m.solids.pulseOf(0))).toBeLessThan(2e-3);
    // An attack above it opens the body at once, by no more than the material allows; the gap after it draws it in.
    let high = 0, low = 0;
    env.pulse = 1; run(0.15, () => { high = Math.max(high, m.solids.pulseOf(0)); });
    expect(high).toBeGreaterThan(0.015); expect(high).toBeLessThanOrEqual(PULSE_LIMIT);
    env.pulse = 0; run(0.5, () => { low = Math.min(low, m.solids.pulseOf(0)); });
    expect(low).toBeLessThan(-0.03); expect(low).toBeGreaterThanOrEqual(-PULSE_LIMIT);
    // The body is at the scale it is asked for: one authority, the simulation's.
    env.pulse = 1; run(0.4);
    m.solids.read(0, env, r);
    expect(r.scale - 1).toBeCloseTo(r.pulse, 2);
    // A smaller largest pulse is a smaller pulse; none is none.
    m.solids.tuning.maxPulse = 0.02; env.pulse = 0; run(3); env.pulse = 1;
    let small = 0;
    run(0.3, () => { small = Math.max(small, Math.abs(m.solids.pulseOf(0))); });
    expect(small).toBeGreaterThan(0.005); expect(small).toBeLessThanOrEqual(0.02);
    m.solids.tuning.maxPulse = 0; run(0.1);
    expect(m.solids.pulseOf(0)).toBe(0);
    // Silence: the world is no longer alive, and the body comes back to its reference scale and stops.
    m.solids.tuning.maxPulse = PULSE_LIMIT; env.pulse = 1; run(1); env.pulse = 0; env.energy = 0; run(8);
    m.solids.read(0, env, r);
    expect(Math.abs(r.pulse)).toBeLessThan(1e-6); expect(Math.abs(r.scale - 1)).toBeLessThan(1e-4); expect(m.solids.stats.kinetic).toBeLessThan(1e-8);
  });

  it('is the same body at 30, 60 and 144 frames per second, events included, and bit for bit the same twice', { timeout: 120000 }, () => {
    const run = (fps: number) => {
      const m = make('cube', 'rigid'), { env, tick } = rhythm(1), h = m.system.config.step, heard = new Set<number>();
      m.system.advance(0, env);
      for (let f = 1; f <= 12 * fps; f++) {
        const now = f / fps;
        // The events of the session, heard a fifth of a second ahead as a real one hears them: each is taken by the step that reaches its own time.
        for (const at of [3.21, 7.777, 8.05]) if (!heard.has(at) && now >= at - 0.2) { heard.add(at); m.solids.gate.offer(event(at, 0.95)); }
        // One step at a time, so the sound each step hears is the same function of the simulation's clock at every rate.
        while (m.system.time + h <= now + 1e-9) { tick(h); m.system.advance(m.system.time + h, env); }
      }
      return m;
    };
    const a = run(30), b = run(60), c = run(144), again = run(60);
    // The second event falls inside the cooldown of the first; the third stands just after it and below the raised bar.
    expect(a.solids.gate.stats).toMatchObject({ offered: 3, fired: 1 }); expect(a.solids.stats.fractures).toBeGreaterThan(0);
    for (const other of [b, c]) {
      expect(other.solids.stats.events).toBe(a.solids.stats.events); expect(other.solids.stats.fractures).toBe(a.solids.stats.fractures);
      expect(Array.from(other.state.linkState)).toEqual(Array.from(a.state.linkState));
      expect(Array.from(other.matter.position)).toEqual(Array.from(a.matter.position));
    }
    expect(Array.from(again.matter.position)).toEqual(Array.from(b.matter.position)); expect(Array.from(again.matter.velocity)).toEqual(Array.from(b.matter.velocity));
  });
});

describe('the fracture gate', () => {
  const gated = (set: Partial<ReturnType<typeof createFractureTuning>> = {}) => { const gate = new FractureGate(); Object.assign(gate.tuning, { mode: 'events' }, set); return gate; };

  it('passes only an event that stands out, is trusted, comes after the cooldown and finds a body that can take it', () => {
    const gate = gated();
    // Nothing offered, nothing asked.
    expect(gate.take(1, 1, true)).toBe(0); expect(gate.stats.verdict).toBe('none');
    // An ordinary attack, a usual accent: below the threshold.
    gate.offer(event(1, 0.5)); expect(gate.take(1, 10, true)).toBe(0); expect(gate.stats.verdict).toBe('threshold');
    // One that stands out but is not trusted.
    gate.offer(event(1, 0.95, 0.2)); expect(gate.take(1, 10, true)).toBe(0); expect(gate.stats.verdict).toBe('confidence');
    // One that stands out, with no body able to take it: the cooldown is not spent on it.
    gate.offer(event(1, 0.95)); expect(gate.take(1, 10, false)).toBe(0); expect(gate.stats.verdict).toBe('budget');
    gate.offer(event(1, 0.95));
    const amount = gate.take(1, 10, true);
    expect(amount).toBeGreaterThan(0.2); expect(amount).toBeLessThanOrEqual(1); expect(gate.stats.verdict).toBe('fired'); expect(gate.time).toBe(1);
    // Inside the cooldown nothing passes, however strong.
    gate.offer(event(2, 1)); expect(gate.take(2, 12, true)).toBe(0); expect(gate.stats.verdict).toBe('cooldown');
    // Right after it the bar is higher than the threshold (hysteresis) and comes down with time.
    gate.offer(event(3, 0.8)); expect(gate.take(3, 14.1, true)).toBe(0); expect(gate.stats.verdict).toBe('threshold'); expect(gate.stats.bar).toBeGreaterThan(0.8);
    gate.offer(event(4, 0.8)); expect(gate.take(4, 30, true)).toBeGreaterThan(0); expect(gate.stats.bar).toBeLessThan(0.72);
    expect(gate.stats).toMatchObject({ offered: 7, fired: 2, confidence: 1, threshold: 2, cooldown: 1, budget: 1 });
  });

  it('asks for more the further an event passes the bar and the more it matters for the form, never by its level', () => {
    const amount = (significance: number, structural: number, strength: number) => {
      const gate = gated();
      gate.offer({ ...event(0, significance), structuralWeight: structural, strength });
      return gate.take(0, 100, true);
    };
    expect(amount(0.75, 0.5, 0.5)).toBeLessThan(amount(0.9, 0.5, 0.5)); expect(amount(0.9, 0.5, 0.5)).toBeLessThan(amount(1, 0.5, 0.5));
    expect(amount(0.9, 0, 0.5)).toBeLessThan(amount(0.9, 1, 0.5));
    // The strength of an impact (its level) changes nothing: only how far it stands out.
    expect(amount(0.9, 0.5, 0.05)).toBe(amount(0.9, 0.5, 1)); expect(amount(0.4, 1, 1)).toBe(0);
    // A drop is a release of what the music stored: it weighs by what it releases even when no single attack stood out.
    const drop = gated();
    drop.offer(event(0, 0.2, 0.9, 'drop', 0.9));
    expect(drop.take(0, 100, true)).toBeGreaterThan(0.2);
    // Beats, onsets and boundaries are not the gate's.
    const other = gated();
    for (const type of ['beat', 'onset', 'downbeat', 'sectionBoundary', 'phraseBoundary', 'buildPeak', 'silenceEnd'] as const) other.offer(event(0, 1, 1, type, 1));
    expect(other.take(0, 100, true)).toBe(0); expect(other.stats.offered).toBe(0);
  });

  it('takes an event at the step that reaches its own time, the strongest of an instant, and keeps a bounded queue', () => {
    const gate = gated();
    gate.offer(event(5, 0.9)); gate.offer(event(5.004, 1)); gate.offer(event(9, 0.95));
    expect(gate.take(4.99, 50, true)).toBe(0); expect(gate.stats.offered).toBe(0);
    expect(gate.take(5.008, 50.01, true)).toBeGreaterThan(0); expect(gate.stats.weight).toBe(1); expect(gate.time).toBeCloseTo(5.004, 9);
    // Without a clock everything is due.
    gate.offer(event(1e9, 0.9)); expect(gate.take(NaN, 200, true)).toBeGreaterThan(0);
    // More than the queue holds: the weakest give way, nothing grows, nothing breaks.
    const full = gated();
    for (let k = 0; k < 100; k++) full.offer(event(k, 0.3 + 0.006 * k));
    expect(full.take(1e6, 10, true)).toBeGreaterThan(0); expect(full.stats.weight).toBeCloseTo(0.3 + 0.006 * 99, 5);
    // In the load mode the gate is idle; a tool's fracture passes in any mode, once; a new session forgets what waited.
    const idle = new FractureGate();
    idle.offer(event(0, 1)); expect(idle.take(0, 100, true)).toBe(0); expect(idle.stats.offered).toBe(0);
    idle.force(0.6); expect(idle.take(0, 100, true)).toBeCloseTo(0.6, 6); expect(idle.take(0, 100, true)).toBe(0); expect(idle.stats.manual).toBe(1);
    const reset = gated();
    reset.offer(event(0, 1)); reset.reset(); expect(reset.take(0, 100, true)).toBe(0);
    for (const broken of [NaN, Infinity]) { reset.offer({ ...event(broken, 1) }); reset.offer({ ...event(0, broken) }); }
    expect(reset.take(1, 200, true)).toBe(0);
  });
});

describe('fracture by musical events', () => {
  const sum = (m: Made): number => { let total = 0; for (let i = 0; i < m.matter.count; i++) total += m.matter.mass[i]; return total; };
  const pieces = (m: Made): Set<number> => { const set = new Set<number>(); for (let i = 0; i < m.matter.count; i++) set.add(m.state.component[i]); return set; };
  const settle = (m: Made, env: StructuralEnvironment, tick: (dt: number) => void, seconds: number, each?: (k: number) => void): void => {
    for (let k = 0; k < Math.round(seconds * 120); k++) { tick(1 / 120); m.system.step(env); each?.(k); }
  };

  it('nothing breaks by itself: not in silence, not under a blow, not through a minute of ordinary attacks', { timeout: 120000 }, () => {
    // Silence, and a blow that breaks the same body when its links may break under load.
    for (const kind of SOLID_KINDS) {
      const loose = make(kind, 'legacy'), body = make(kind, 'rigid'), still = createStillEnvironment();
      for (const m of [loose, body]) { blow(m, 11, 0.5); for (let k = 0; k < 360; k++) m.system.step(still); }
      expect(loose.solids.stats.fractures, kind).toBeGreaterThan(0);
      expect(body.solids.stats).toMatchObject({ fractures: 0, events: 0 }); expect(body.state.bodySealed[0]).toBe(1);
    }
    // A hot, tense, incoherent world that tears the links alone apart loads this body and breaks nothing: the load is still measured.
    const m = make('cube', 'rigid'), { env, tick } = rhythm(1, { coherence: 0.1, turbulence: 1, tension: 1, release: 1 });
    let stress = 0;
    settle(m, env, tick, 20, () => { stress = Math.max(stress, m.solids.stats.peak); });
    expect(stress).toBeGreaterThan(0.5); expect(m.solids.stats.fractures).toBe(0);
    // Fatigue builds and stops short of breaking: only an event completes a fracture.
    let worn = 0;
    for (let l = 0; l < m.state.links; l++) { expect(m.state.linkState[l]).toBe(INTACT); expect(m.state.linkDamage[l]).toBeLessThan(1); worn = Math.max(worn, m.state.linkDamage[l]); }
    expect(worn).toBeGreaterThan(0.05);
    const same = make('cube', 'legacy'), other = rhythm(1, { coherence: 0.1, turbulence: 1, tension: 1, release: 1 });
    settle(same, other.env, other.tick, 20);
    expect(same.solids.stats.fractures).toBeGreaterThan(0);
    // Ordinary attacks, two a second for a minute, all trusted: none passes.
    const calm = make('icosahedron', 'rigid'), sound = rhythm(1);
    settle(calm, sound.env, sound.tick, 60, (k) => { if (k % 60 === 0) calm.solids.gate.offer(event(0, 0.3 + 0.3 * ((k / 60) % 2))); });
    expect(calm.solids.gate.stats).toMatchObject({ offered: 120, fired: 0, threshold: 120 });
    expect(calm.solids.stats.fractures).toBe(0);
  });

  it('an event that passes breaks the body along one plane, within its share of the links: nothing is created, moved or lost', { timeout: 120000 }, () => {
    for (const kind of SOLID_KINDS) {
      const m = make(kind, 'rigid'), { env, tick } = rhythm(1), links = m.state.links;
      // A body that has only just been made is still settling: an event that would break it leaves it whole.
      m.solids.gate.offer(event(0, 1)); settle(m, env, tick, 0.5);
      expect(m.solids.stats.fractures, kind).toBe(0);
      settle(m, env, tick, 6);
      const identity = { f0: Array.from(m.matter.f0), mass: Array.from(m.matter.mass), phase: Array.from(m.matter.phase) }, mass = sum(m), count = m.matter.count;
      const position = Array.from(m.matter.position), velocity = Array.from(m.matter.velocity);
      m.solids.gate.offer(event(0, 1));
      tick(1 / 120); m.system.step(env);
      const broken = m.solids.stats.fractures;
      expect(m.solids.stats.events, kind).toBe(1);
      // Controlled: at least one link, at most the share one event may break; more than one piece, never dust.
      expect(broken, kind).toBeGreaterThan(0); expect(broken, kind).toBeLessThanOrEqual(Math.ceil(0.5 * links));
      expect(m.state.bodyPieces[0], kind).toBeGreaterThanOrEqual(1); expect(m.state.bodyPieces[0], kind).toBeLessThan(count);
      // Identity and mass: the same elements, as they were.
      expect(m.matter.count).toBe(count); expect(sum(m)).toBe(mass);
      expect(Array.from(m.matter.f0)).toEqual(identity.f0); expect(Array.from(m.matter.mass)).toEqual(identity.mass); expect(Array.from(m.matter.phase)).toEqual(identity.phase);
      // Continuity: in the step of the fracture no element is anywhere but where its velocity took it, and no velocity jumps.
      for (let i = 0; i < count; i++) {
        const moved = Math.hypot(m.matter.position[i * 3] - position[i * 3], m.matter.position[i * 3 + 1] - position[i * 3 + 1], m.matter.position[i * 3 + 2] - position[i * 3 + 2]);
        const speed = Math.hypot(velocity[i * 3], velocity[i * 3 + 1], velocity[i * 3 + 2]), now = Math.hypot(m.matter.velocity[i * 3], m.matter.velocity[i * 3 + 1], m.matter.velocity[i * 3 + 2]);
        expect(moved, kind).toBeLessThan((Math.max(speed, now) + 0.3) / 120 + 1e-6);
        expect(Math.abs(now - speed), kind).toBeLessThan(0.3);
      }
      // Every link is holding, remembered or forgotten; what holds lies in one piece; the pieces are what the links say.
      expect(m.solids.stats.intact + m.solids.stats.broken + m.solids.stats.lost).toBe(links);
      for (let l = 0; l < links; l++) if (m.state.linkState[l] === INTACT) expect(m.state.component[m.state.linkA[l]]).toBe(m.state.component[m.state.linkB[l]]);
      expect(pieces(m).size).toBe(m.state.bodyPieces[0]);
    }
  });

  it('what parted moves apart with equal and opposite momentum, and a larger event breaks more', { timeout: 120000 }, () => {
    const still = { ...createStillEnvironment(), drag: 0.2 };
    const split = (significance: number) => {
      const m = make('icosahedron', 'rigid');
      // A body that has just been made is still settling: the music breaks nothing of it at once.
      for (let k = 0; k < 240; k++) m.system.step(still);
      m.solids.gate.offer(event(0, significance));
      const before = centre(m);
      for (let k = 0; k < 24; k++) m.system.step(still);
      const p = momentum(m);
      let each = 0;
      for (let i = 0; i < m.matter.count; i++) each += m.matter.mass[i] * Math.hypot(m.matter.velocity[i * 3], m.matter.velocity[i * 3 + 1], m.matter.velocity[i * 3 + 2]);
      return { m, broken: m.solids.stats.fractures, net: Math.hypot(...p), each, drift: Math.hypot(...centre(m).map((x, k) => x - before[k])) };
    };
    const small = split(0.75), large = split(1);
    expect(small.broken).toBeGreaterThan(0); expect(large.broken).toBeGreaterThan(small.broken);
    // The pieces move, the body as a whole does not: the shock gives it no momentum.
    expect(large.each).toBeGreaterThan(0.3); expect(large.net).toBeLessThan(0.03 * large.each); expect(large.drift).toBeLessThan(5e-3);
    // The same event twice is the same fracture; another instant, another plane.
    const cut = (time: number) => {
      const m = make('icosahedron', 'rigid');
      m.system.advance(0, still);
      m.solids.gate.offer(event(time, 1));
      for (let f = 1; f <= 60 * (time + 0.5); f++) m.system.advance(f / 60, still);
      expect(m.solids.stats.events).toBe(1);
      return Array.from(m.state.linkState).join('');
    };
    expect(cut(2.031)).toBe(cut(2.031)); expect(new Set([cut(2.031), cut(2.047), cut(2.052), cut(2.068)]).size).toBeGreaterThan(1);
  });

  it('the cooldown holds, a broken body is not broken again, and a link that has just formed is not undone', { timeout: 120000 }, () => {
    // Events that all stand out, four a second for half a minute: one fracture per cooldown at most, and far fewer once the body is in pieces.
    const m = make('icosahedron', 'rigid'), { env, tick } = rhythm(1);
    m.solids.gate.tuning.cooldown = 3;
    settle(m, env, tick, 30, (k) => { if (k % 30 === 0) m.solids.gate.offer(event(0, 1)); });
    const stats = m.solids.gate.stats;
    expect(stats.offered).toBe(120); expect(stats.fired).toBeGreaterThan(0); expect(stats.fired).toBeLessThanOrEqual(10);
    expect(stats.cooldown + stats.budget + stats.threshold).toBe(stats.offered - stats.fired); expect(stats.budget).toBeGreaterThan(0);
    expect(m.solids.stats.events).toBeLessThanOrEqual(stats.fired);
    // The budget: never more pieces than a third of its elements allows before it stops taking events, and it is never dust.
    expect(m.state.bodyLargest[0]).toBeGreaterThanOrEqual(1); expect(m.state.bodyPieces[0]).toBeLessThan(m.matter.count);
    expect(finiteState(m)).toBe(true); expect(m.solids.stats.repairs).toBe(0);
    // Right after an event nothing forms again: the body does not flicker between broken and whole.
    const t = make('tetrahedron', 'rigid'), calm = rhythm(0.3);
    settle(t, calm.env, calm.tick, 2);
    t.solids.gate.offer(event(0, 1));
    settle(t, calm.env, calm.tick, 1.4);
    expect(t.solids.stats.fractures).toBeGreaterThan(0); expect(t.solids.stats.reforms).toBe(0);
  });

  it('a piece that can hold a shape holds it and pulses; a chain is left to its links', { timeout: 120000 }, () => {
    // A world that is alive and sounding but holds together too little for anything to form again: the pieces stay pieces.
    const apart = { coherence: 0.3 };
    const m = make('icosahedron', 'rigid'), { env, tick } = rhythm(1, apart), r = createReadout();
    settle(m, env, tick, 2);
    m.solids.gate.offer(event(0, 1));
    let deviation = 0, low = 1, high = 1;
    // Ten seconds of the same sound on the pieces.
    settle(m, env, tick, 10, (k) => {
      if (k < 240 || k % 4) return;
      m.solids.read(0, env, r);
      deviation = Math.max(deviation, r.deviation); low = Math.min(low, r.scale); high = Math.max(high, r.scale);
    });
    expect(m.solids.stats.fractures).toBeGreaterThan(0); expect(m.solids.stats.reforms).toBe(0);
    const shaped = Array.from(pieces(m)).filter((root) => m.state.form[root] >= FORM.surface);
    expect(shaped.length).toBeGreaterThan(0);
    // The pieces that have a shape keep it (a few tenths of a per cent of the body's size) and still pulse, within the limit.
    expect(deviation).toBeLessThan(0.04); expect(high - low).toBeGreaterThan(0.01);
    expect(high).toBeLessThanOrEqual(1 + PULSE_LIMIT + 1e-9); expect(low).toBeGreaterThanOrEqual(1 - PULSE_LIMIT - 1e-9);
    // Their own motion goes on: each piece has its centre and its velocity, and the sound still reaches its matter.
    expect(m.solids.stats.kinetic).toBeGreaterThan(1e-6); expect(r.meso).toBeGreaterThan(0.1);
    // The same pieces of the legacy material (the same links broken, the same sound, nothing else allowed to break):
    // held by their links alone they are driven link by link, and are many times further from their shape.
    const loose = make('icosahedron', 'legacy'), again = rhythm(1, apart), q = createReadout();
    loose.solids.gate.tuning.mode = 'events';
    settle(loose, again.env, again.tick, 2);
    for (let l = 0; l < m.state.links; l++) if (m.state.linkState[l] !== INTACT) loose.solids.sever(l);
    let floppy = 0;
    settle(loose, again.env, again.tick, 10, (k) => { if (k >= 240 && k % 4 === 0) floppy = Math.max(floppy, loose.solids.read(0, again.env, q).deviation); });
    expect(loose.solids.stats.fractures).toBe(m.solids.stats.fractures);
    expect(floppy).toBeGreaterThan(3 * deviation);
    // Asked for no integrity, the pieces of the rigid material are left to their links too.
    const bare = make('icosahedron', 'rigid'), third = rhythm(1, apart);
    bare.solids.tuning.fragmentIntegrity = 0;
    settle(bare, third.env, third.tick, 2);
    bare.solids.gate.offer(event(0, 1));
    settle(bare, third.env, third.tick, 4);
    expect(bare.solids.stats.fractures).toBe(m.solids.stats.fractures); expect(finiteState(bare)).toBe(true);
  });

  it('finds itself again by its own memory, with no jump; where it cannot, it stays in pieces and forgets', { timeout: 180000 }, () => {
    // A tetrahedron broken by an event in a calm, ordered, living world: its links form again, one at a time.
    const m = make('tetrahedron', 'rigid'), { env, tick } = rhythm(0.25), r = createReadout();
    settle(m, env, tick, 2);
    m.solids.gate.offer(event(0, 1));
    const last = new Float64Array(m.matter.count * 3);
    let jump = 0, reformedAt = -1;
    settle(m, env, tick, 40, (k) => {
      for (let i = 0; i < m.matter.count * 3; i++) {
        if (k > 0) jump = Math.max(jump, Math.abs(m.matter.position[i] - last[i]));
        last[i] = m.matter.position[i];
      }
      if (reformedAt < 0 && m.solids.stats.reforms > 0) reformedAt = k / 120;
    });
    expect(m.solids.stats.fractures).toBeGreaterThan(0); expect(m.solids.stats.reforms).toBeGreaterThan(0);
    // Not at once (the hold after an event), and never by a jump: nothing moves further in a step than the fastest matter can.
    expect(reformedAt).toBeGreaterThan(1.5); expect(jump).toBeLessThanOrEqual(V_MAX / 120 + 1e-9); expect(jump).toBeLessThan(0.03);
    // Whole again it is its own shape again, at its reference scale but for the pulse.
    m.solids.read(0, env, r);
    expect(r.edgesIntact).toBeGreaterThanOrEqual(5);
    if (r.pieces === 1 && r.edgesIntact === 6) { expect(r.deviation).toBeLessThan(0.02); expect(Math.abs(r.scale - 1)).toBeLessThanOrEqual(PULSE_LIMIT + 1e-9); }
    // Silence: nothing forms, however long. The body stays in pieces, finite and still, and remembers.
    const lost = make('cube', 'rigid'), sound = rhythm(1);
    settle(lost, sound.env, sound.tick, 2);
    lost.solids.gate.offer(event(0, 1));
    settle(lost, sound.env, sound.tick, 0.5);
    const broken = lost.solids.stats.fractures, silent = createStillEnvironment();
    expect(broken).toBeGreaterThan(0);
    for (let k = 0; k < 120 * 60; k++) lost.system.step(silent);
    expect(lost.solids.stats).toMatchObject({ reforms: 0, broken, lost: 0 }); expect(lost.solids.stats.kinetic).toBeLessThan(1e-6);
    // A hot world: the ends never settle and forget. What is forgotten does not come back when the world is ordered
    // again: recomposition fails, and that is a state like any other (finite, bounded, the pieces still themselves).
    lost.system.tuning.temperature = 1;
    settle(lost, sound.env, sound.tick, 60);
    expect(lost.solids.stats).toMatchObject({ reforms: 0, broken: 0, lost: broken });
    lost.system.tuning.temperature = null;
    settle(lost, sound.env, sound.tick, 20);
    expect(lost.solids.stats.reforms).toBe(0);
    for (let l = 0; l < lost.state.links; l++) expect([INTACT, LOST]).toContain(lost.state.linkState[l]);
    expect(finiteState(lost)).toBe(true); expect(lost.solids.stats.repairs).toBe(0);
    expect(lost.solids.read(0, sound.env, r).deviation).toBeLessThan(0.04);
  });
});
