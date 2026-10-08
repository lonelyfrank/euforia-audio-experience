import { describe, expect, it, vi } from 'vitest';
import { createResonanceFrame } from '../../physics/MultiscaleResonance';
import { MEMORY_TAU } from './BondSystem';
import { bandwidthOf, ResonanceField, responseAt } from './ResonanceField';
import { StructuralSystem } from './StructuralDynamics';
import { createIdentity, draw, hash32, identityOf, MASS_HIGH, MASS_LOW, type Population } from './StructuralIdentity';
import { createStillEnvironment, JOINT, LIFECYCLE, LIFECYCLES, MAX_BONDS, MEMORY_SLOTS, ROLE, ROLE_COUNT, SPAN, type StructuralEnvironment } from './StructuralTypes';

const STRUCTURAL: Population = { id: 7, centre: 0.42, spread: 0.03 };
const FINE: Population = { id: 8, centre: 0.9, spread: 0.03 };

/** An environment set by hand: levels, a medium, and a resonance ringing where the test puts it. */
function world(over: Partial<StructuralEnvironment> = {}) {
  const frame = createResonanceFrame(), field = new ResonanceField();
  const env: StructuralEnvironment = { ...createStillEnvironment(), resonance: field, ...over };
  let time = 0, axis = -1, level = 0;
  /** Sets one group of the axis ringing (a tone at that pitch); −1: nothing rings. */
  const ring = (at: number, amount = 0.6) => { axis = at; level = amount; };
  const tick = (dt: number) => {
    time += dt;
    frame.meso.fill(0); frame.mesoLevel.fill(0);
    if (axis >= 0) {
      const k = Math.min(frame.meso.length - 1, Math.floor(axis * frame.meso.length));
      frame.mesoLevel[k] = level; frame.meso[k] = level * Math.sin(2 * Math.PI * 2.5 * time);
    }
    field.update(frame);
  };
  const run = (system: StructuralSystem, seconds: number, each?: (t: number) => void) => {
    const h = system.config.step;
    for (let k = 0; k < Math.round(seconds / h); k++) { tick(h); system.step(env); each?.(time); }
  };
  return { env, frame, field, ring, tick, run };
}

/** Coherent, harmonic, alive and calm: what lets structure form. */
const ORDERED = { coherence: 0.9, harmony: 0.7, energy: 0.7, turbulence: 0.03 };
/** A medium that shears what is in it, inside a soft wall (so pieces stay in the world). */
const shear = (strength: number): StructuralEnvironment['flow'] => (x, y, z, out) => {
  const r = Math.hypot(x, y, z), wall = -2.5 * Math.max(0, r - 1.4) / Math.max(r, 1e-6);
  out[0] = strength * Math.sin(3 * y) + x * wall; out[1] = strength * Math.sin(3 * x + 1) + y * wall; out[2] = z * wall;
};
const still: StructuralEnvironment['flow'] = (_x, _y, _z, out) => { out[0] = out[1] = out[2] = 0; };

const kinetic = (system: StructuralSystem): number => {
  const s = system.state;
  let sum = 0;
  for (let i = 0; i < s.count; i++) sum += 0.5 * s.mass[i] * (s.velocity[i * 3] ** 2 + s.velocity[i * 3 + 1] ** 2 + s.velocity[i * 3 + 2] ** 2);
  return sum;
};
const finiteState = (system: StructuralSystem): boolean => {
  const s = system.state;
  for (const array of [s.position, s.velocity, s.excitation, s.vibration, s.order, s.temperature, s.cohesion, s.stress, s.roles, s.bondStress, s.bondDamage, s.bondRest, s.memStrength]) {
    for (let k = 0; k < array.length; k++) if (!Number.isFinite(array[k])) return false;
  }
  return true;
};
/** Two elements of one kind of matter, a wire's length apart, free. */
function pair(populationA = STRUCTURAL, populationB = STRUCTURAL, distance = 0.4) {
  const system = new StructuralSystem({ capacity: 8, seed: 11 });
  system.state.add(11, populationA, -distance / 2, 0, 0, system.config.reach);
  system.state.add(11, populationB, distance / 2, 0, 0, system.config.reach);
  return system;
}

describe('physical identity', () => {
  it('is a pure function of seed, number and population: the same matter every time, no two elements alike', { timeout: 60000 }, () => {
    const a = createIdentity(), b = createIdentity(), population: Population = { id: 1, centre: 0.5, spread: 0.4 };
    expect(identityOf(5, 17, population, a)).toEqual(identityOf(5, 17, population, b));
    expect(identityOf(5, 18, population, b).f0).not.toBe(a.f0);
    expect(identityOf(6, 17, population, b).f0).not.toBe(a.f0);
    expect(identityOf(5, 17, { ...population, id: 2 }, b).f0).not.toBe(a.f0);
    // The hash is integer arithmetic (a shader computes the same bits) and its draws are exact float32 values in [0, 1).
    expect(hash32(1, 2, 3)).toBe(hash32(1, 2, 3)); expect(Number.isInteger(hash32(1, 2, 3))).toBe(true);
    for (let k = 0; k < 200; k++) { const u = draw(9, k, k % 7); expect(u).toBeGreaterThanOrEqual(0); expect(u).toBeLessThan(1); expect(Math.fround(u)).toBe(u); }
    const masses = new Set<number>(), pitches = new Set<number>();
    for (let i = 0; i < 2000; i++) { const id = identityOf(5, i, population, a); masses.add(id.mass); pitches.add(id.f0); }
    // A continuous distribution, not a handful of categories.
    expect(masses.size).toBeGreaterThan(1990); expect(pitches.size).toBeGreaterThan(1990);
  });

  it('follows the frequency axis continuously: low matter is heavy and tough, middle matter binds, fine matter is light and carried', { timeout: 60000 }, () => {
    const id = createIdentity(), at = (centre: number) => {
      const mean = { mass: 0, coupling: 0, bondAffinity: 0, resistance: 0, q: 0, persistence: 0 };
      for (let i = 0; i < 400; i++) {
        identityOf(3, i, { id: 1, centre, spread: 0.02 }, id);
        for (const key of Object.keys(mean) as (keyof typeof mean)[]) mean[key] += id[key] / 400;
      }
      return mean;
    };
    const low = at(0.1), middle = at(0.45), high = at(0.8), top = at(0.97);
    expect(low.mass).toBeGreaterThan(2 * middle.mass); expect(middle.mass).toBeGreaterThan(1.5 * high.mass);
    expect(low.mass).toBeLessThan(MASS_LOW * 1.2); expect(top.mass).toBeGreaterThan(MASS_HIGH * 0.8);
    expect(high.coupling).toBeGreaterThan(low.coupling + 0.25);
    expect(middle.bondAffinity).toBeGreaterThan(low.bondAffinity + 0.3); expect(middle.bondAffinity).toBeGreaterThan(high.bondAffinity + 0.3);
    expect(middle.q).toBeGreaterThan(low.q); expect(low.resistance).toBeGreaterThan(high.resistance);
    expect(top.persistence).toBeLessThan(0.5); expect(middle.persistence).toBeCloseTo(1, 9);
    // No steps anywhere along the axis: neighbouring pitches are neighbouring matter.
    let previous = at(0).mass;
    for (let c = 0.02; c <= 1; c += 0.02) { const mass = at(c).mass; expect(Math.abs(mass - previous)).toBeLessThan(0.35); previous = mass; }
  });
});

describe('resonance response', () => {
  it('peaks at the natural frequency and falls away, the narrower the more selective the element', { timeout: 60000 }, () => {
    for (const f0 of [0.2, 0.5, 0.8]) {
      for (const q of [0, 0.5, 1]) {
        expect(responseAt(f0, f0, q)).toBe(1);
        let previous = 1;
        for (let away = 0.02; away < 0.4; away += 0.02) { const r = responseAt(f0 + away, f0, q); expect(r).toBeLessThan(previous); expect(responseAt(f0 - away, f0, q)).toBeCloseTo(r, 12); previous = r; }
      }
      expect(responseAt(f0 + 0.1, f0, 1)).toBeLessThan(0.5 * responseAt(f0 + 0.1, f0, 0));
    }
    expect(bandwidthOf(1)).toBeLessThan(bandwidthOf(0) / 4);
  });

  it('makes different matter answer the same sound differently', { timeout: 60000 }, () => {
    const w = world();
    w.ring(0.45); w.tick(0.1);
    const at = (f0: number, q: number) => w.field.at(f0, q)[1];
    // A tone at 0.45: matter of that pitch takes it, matter an octave or more away takes little.
    const own = at(0.45, 1);
    expect(own).toBeGreaterThan(0.3);
    expect(at(0.45, 1)).toBeGreaterThan(at(0.4, 1)); expect(at(0.4, 1)).toBeGreaterThan(at(0.3, 1)); expect(at(0.3, 1)).toBeGreaterThan(at(0.1, 1));
    expect(at(0.75, 1)).toBeLessThan(0.1 * own);
    // A selective element takes a tone at its own pitch whole; a broad one takes less of it, and more of a tone far away.
    expect(at(0.45, 1)).toBeGreaterThan(1.5 * at(0.45, 0));
    expect(at(0.7, 0)).toBeGreaterThan(3 * at(0.7, 1));
    // Broadband sound reaches everything, broad matter most; all of it bounded.
    w.frame.mesoLevel.fill(0.5); w.frame.meso.fill(0.5); w.frame.micro.fill(1); w.field.update(w.frame);
    expect(at(0.5, 0)).toBeGreaterThan(at(0.5, 1));
    for (let f = 0; f <= 1; f += 0.05) for (let q = 0; q <= 1; q += 0.25) { const r = w.field.at(f, q); expect(Math.abs(r[0])).toBeLessThanOrEqual(1.25); expect(r[1]).toBeLessThanOrEqual(1.25); expect(r[2]).toBeLessThanOrEqual(1); }
    // Fine matter takes the micro excitation, heavy matter hardly.
    expect(w.field.at(0.95, 0.5)[2]).toBeGreaterThan(3 * w.field.at(0.1, 0.5)[2]);
    // Without a heard frame nothing rings.
    w.field.update(undefined);
    expect(w.field.live).toBe(false); expect(Array.from(w.field.at(0.45, 1))).toEqual([0, 0, 0]);
  });

  it('reaches the elements of a system: same place, same sound, different response', { timeout: 60000 }, () => {
    const system = new StructuralSystem({ capacity: 8, seed: 2 }), s = system.state, w = world(ORDERED);
    const a = s.add(2, STRUCTURAL, 0.5, 0, 0, 0.4), b = s.add(2, FINE, 0.5, 0, 0, 0.4);
    w.ring(0.42); w.run(system, 0.5);
    expect(s.excitation[a]).toBeGreaterThan(0.15); expect(s.excitation[b]).toBeLessThan(0.1 * s.excitation[a]);
    expect(Math.abs(s.vibration[a])).toBeGreaterThan(0);
    // Development override: no coupling to the resonance, no micro response.
    system.tuning.resonanceCoupling = 0; w.run(system, 0.1);
    expect(s.excitation[a]).toBe(0);
  });
});

describe('bonds', () => {
  it('form between compatible elements once both have settled, not at once', { timeout: 60000 }, () => {
    const system = pair(), w = world(ORDERED);
    w.ring(0.42);
    w.run(system, 0.5);
    expect(system.stats.bonds).toBe(0);
    expect(system.state.lifecycle[0]).not.toBe(LIFECYCLE.bound);
    let formedAt = -1;
    w.run(system, 8, (t) => { if (formedAt < 0 && system.state.bonds > 0) formedAt = t; });
    expect(formedAt).toBeGreaterThan(1);
    expect(system.state.bonds).toBe(1); expect(system.state.bondSpan[system.state.span[0]]).toBe(1);
    expect(system.state.spanPartner(0)).toBe(1);
    expect(LIFECYCLES[system.state.lifecycle[0]]).toBe('bound');
    // The wire settles to the length its matter prefers, from the length it was made at.
    const b = system.state.span[0];
    expect(system.state.bondRest[b]).toBeCloseTo(system.state.bondTarget[b], 2);
    expect(system.state.bondTarget[b]).toBeCloseTo(0.5 * (system.state.reach[0] + system.state.reach[1]), 6);
  });

  it('do not form under incompatible conditions', { timeout: 60000 }, () => {
    const cases: [string, StructuralSystem, Partial<StructuralEnvironment>][] = [
      ['unlike pitch', pair(STRUCTURAL, FINE), ORDERED],
      ['too far apart', pair(STRUCTURAL, STRUCTURAL, 1.6), ORDERED],
      ['an incoherent world', pair(), { ...ORDERED, coherence: 0.15, harmony: 0 }],
      ['a turbulent world', pair(), { ...ORDERED, turbulence: 1, release: 1 }],
      ['silence', pair(), { ...ORDERED, energy: 0 }],
    ];
    for (const [name, system, env] of cases) {
      const w = world(env);
      w.ring(0.42); w.run(system, 12);
      expect(system.state.bonds, name).toBe(0);
    }
    // Development overrides act the same way: a hot or incoherent world settles nothing.
    for (const key of ['temperature', 'coherence'] as const) {
      const system = pair(), w = world(ORDERED);
      system.tuning[key] = key === 'temperature' ? 1 : 0;
      w.ring(0.42); w.run(system, 12);
      expect(system.state.bonds, key).toBe(0);
    }
    // Elements moving apart do not bond either: a shearing medium keeps them from it.
    const moving = pair(), w = world({ ...ORDERED, flow: (x, _y, _z, out) => { out[0] = 3 * Math.sign(x); out[1] = out[2] = 0; } });
    w.ring(0.42); w.run(moving, 6);
    expect(moving.state.bonds).toBe(0);
  });

  it('break when their load passes their strength, and free the bond, never the matter', { timeout: 60000 }, () => {
    const system = new StructuralSystem({ capacity: 16, seed: 4 }), s = system.state, w = world(ORDERED);
    system.seedPolygon(4, 0.55, { bonded: true });
    w.ring(0.42); w.run(system, 2);
    expect(s.bonds).toBe(8); expect(system.stats.loops).toBe(1); expect(system.stats.fractures).toBe(0);
    const before = { count: s.count, f0: Array.from(s.f0.subarray(0, 8)), mass: Array.from(s.mass.subarray(0, 8)) };
    // A release, stored tension and a turbulent world load every bond at once.
    Object.assign(w.env, { release: 1, tension: 1, turbulence: 1 });
    let broken = 0, jump = 0;
    const position = Float32Array.from(s.position.subarray(0, 24)), excitation = Array.from(s.excitation.subarray(0, 8));
    w.run(system, 1.5, () => {
      if (broken === 0 && system.stats.fractures > 0) {
        broken = system.stats.fractures;
        // At the instant of the break nothing jumps: every piece is where it was a step ago, moving as it moved.
        for (let i = 0; i < 8; i++) jump = Math.max(jump, Math.hypot(s.position[i * 3] - position[i * 3], s.position[i * 3 + 1] - position[i * 3 + 1], s.position[i * 3 + 2] - position[i * 3 + 2]));
      }
      position.set(s.position.subarray(0, 24));
    });
    expect(broken).toBeGreaterThan(0);
    expect(jump).toBeLessThan(0.02);
    expect(s.bonds).toBeLessThan(8); expect(system.stats.loops).toBe(0);
    // The weld gives before the wire: joints break first.
    expect(system.stats.joints).toBeLessThan(system.stats.spans + 1);
    expect(s.count).toBe(before.count);
    expect(Array.from(s.f0.subarray(0, 8))).toEqual(before.f0); expect(Array.from(s.mass.subarray(0, 8))).toEqual(before.mass);
    for (let i = 0; i < 8; i++) expect(s.excitation[i]).toBeCloseTo(excitation[i], 1);
    expect(s.bonds).toBe(system.stats.formed + 8 - system.stats.fractures);
  });

  it('never exceed their bounds: a slot per element, a pool for all, however long and wild the run', { timeout: 60000 }, () => {
    const system = new StructuralSystem({ capacity: 96, seed: 5 }), s = system.state;
    const arrays = [s.position, s.velocity, s.roles, s.bondA, s.bondRest, s.bondModes, s.memPartner, s.loopCorners];
    const lengths = arrays.map((array) => array.length);
    expect(system.addPopulation(200, { id: 1, centre: 0.45, spread: 0.1 }, 0.2, 1)).toBe(96);
    expect(s.add(5, STRUCTURAL, 0, 0, 0, 0.4)).toBe(-1); expect(system.seedPolygon(4, 0.5)).toBe(-1);
    const w = world({ ...ORDERED, flow: shear(0.3) });
    w.ring(0.45);
    let most = 0;
    for (let cycle = 0; cycle < 6; cycle++) {
      Object.assign(w.env, cycle % 2 ? { coherence: 0.3, harmony: 0, turbulence: 0.9, release: 0.8, flow: shear(1.2) } : { ...ORDERED, release: 0, flow: shear(0.2) });
      w.run(system, 10, () => { most = Math.max(most, s.bonds); });
      expect(s.bonds).toBeLessThanOrEqual(s.bondCapacity);
      let alive = 0;
      for (let b = 0; b < s.bondCapacity; b++) alive += s.bondAlive[b];
      expect(alive).toBe(s.bonds); expect(s.bonds).toBe(system.stats.formed - system.stats.fractures);
      for (let i = 0; i < s.count; i++) {
        const held = (s.span[i] >= 0 ? 1 : 0) + s.joints[i];
        expect(held).toBeLessThanOrEqual(MAX_BONDS); expect(s.joints[i]).toBeLessThanOrEqual(system.config.maxJoints);
      }
      expect(finiteState(system)).toBe(true);
    }
    expect(most).toBeGreaterThan(10); expect(system.stats.fractures).toBeGreaterThan(0);
    expect(s.count).toBe(96);
    arrays.forEach((array, k) => expect(array.length).toBe(lengths[k]));
    // Polygons have at least three sides and at most the configured number.
    for (let L = 0; L < s.loops; L++) { expect(s.loopSize[L]).toBeGreaterThanOrEqual(3); expect(s.loopSize[L]).toBeLessThanOrEqual(system.config.maxSides); }
  });
});

describe('structural memory and fragments', () => {
  it('a fragment keeps what it was: identity, motion, resonance, and a memory of its partners', { timeout: 60000 }, () => {
    const system = new StructuralSystem({ capacity: 16, seed: 4 }), s = system.state, w = world({ ...ORDERED, flow: shear(0.5) });
    system.seedPolygon(4, 0.55, { bonded: true });
    w.ring(0.42); w.run(system, 2);
    const wire = s.span[0], joint = s.joint[1 * 3], partner = s.other(joint, 1), rest = s.bondTarget[joint], role = s.role[1];
    const velocity = [s.velocity[3], s.velocity[4], s.velocity[5]], pitch = s.f0[1], excitation = s.excitation[1];
    s.release(joint);
    expect(s.bondAlive[joint]).toBe(0); expect(s.bondAlive[wire]).toBe(1);
    // Topology changed; the element did not.
    expect([s.velocity[3], s.velocity[4], s.velocity[5]]).toEqual(velocity); expect(s.f0[1]).toBe(pitch); expect(s.excitation[1]).toBe(excitation);
    expect(s.memPartner[1 * MEMORY_SLOTS + JOINT]).toBe(partner); expect(s.memPartner[partner * MEMORY_SLOTS + JOINT]).toBe(1);
    expect(s.memRest[1 * MEMORY_SLOTS + JOINT]).toBe(rest); expect(s.memStrength[1 * MEMORY_SLOTS + JOINT]).toBe(1); expect(s.memRole[1]).toBe(role);
    expect(s.memPartner[1 * MEMORY_SLOTS + SPAN]).toBe(-1);
    // Released again it is a no-op; the pool hands the bond out again.
    s.release(joint);
    expect(s.bonds).toBe(7);
    // Still part of the same world: it goes on resonating at its pitch and is carried by the medium.
    const from = [s.position[3], s.position[4]];
    w.env.coherence = 0.1; w.run(system, 1);
    expect(s.excitation[1]).toBeGreaterThan(0.15);
    expect(Math.hypot(s.position[3] - from[0], s.position[4] - from[1])).toBeGreaterThan(0.02);
  });

  it('memory fades: slowly in cold matter, fast in hot matter, and is gone in the end', { timeout: 60000 }, () => {
    const cold = pair(), hot = pair();
    for (const system of [cold, hot]) {
      const s = system.state;
      s.memPartner[SPAN] = 1; s.memRest[SPAN] = 0.4; s.memStrength[SPAN] = 1;
    }
    hot.tuning.temperature = 1;
    const w = world({ coherence: 0.1 });
    w.run(cold, 10); w.run(hot, 10);
    const kept = cold.state.memStrength[SPAN], lost = hot.state.memStrength[SPAN];
    expect(kept).toBeLessThan(1); expect(kept).toBeGreaterThan(0.8);
    // Cold: 0.2 / τ per second.
    expect(kept).toBeCloseTo(Math.exp(-10 * 0.2 / (MEMORY_TAU * cold.state.persistence[0])), 2);
    expect(lost).toBeLessThan(0.5 * kept);
    w.run(hot, 60);
    expect(hot.state.memPartner[SPAN]).toBe(-1); expect(hot.state.memStrength[SPAN]).toBe(0);
  });
});

describe('regimes', () => {
  it('chaos → order: matter settles, cools, bonds and takes roles as the world becomes coherent', { timeout: 60000 }, () => {
    const system = new StructuralSystem({ capacity: 96, seed: 9 }), w = world({ coherence: 0.25, harmony: 0, energy: 0.8, turbulence: 0.9, flow: shear(1.2) });
    system.addPopulation(90, { id: 1, centre: 0.45, spread: 0.08 }, 0.2, 0.9);
    w.ring(0.45);
    w.run(system, 8);
    const chaos = { ...system.stats }, s = system.state;
    const weight = (role: number) => { let sum = 0; for (let i = 0; i < s.count; i++) sum += s.roles[i * ROLE_COUNT + role]; return sum / s.count; };
    const loose = weight(ROLE.free) + weight(ROLE.tracer);
    expect(chaos.order).toBeLessThan(0.25); expect(chaos.temperature).toBeGreaterThan(0.6); expect(chaos.bonds).toBeLessThan(5);
    expect(loose).toBeGreaterThan(0.8);
    Object.assign(w.env, ORDERED, { flow: shear(0.05) });
    const orders: number[] = [];
    w.run(system, 20, (t) => { if (Math.abs(t * 2 - Math.round(t * 2)) < 1e-6) orders.push(system.stats.order); });
    const order = system.stats;
    expect(order.order).toBeGreaterThan(chaos.order + 0.3); expect(order.temperature).toBeLessThan(0.3);
    expect(order.bonds).toBeGreaterThan(20); expect(order.structured).toBeGreaterThan(0.5);
    expect(weight(ROLE.edge) + weight(ROLE.node)).toBeGreaterThan(0.4); expect(weight(ROLE.free) + weight(ROLE.tracer)).toBeLessThan(0.5 * loose);
    // A continuous change of regime: order climbs over seconds, it does not switch.
    for (let k = 1; k < orders.length; k++) expect(Math.abs(orders[k] - orders[k - 1])).toBeLessThan(0.25);
    // Roles are weights that sum to one.
    for (let i = 0; i < s.count; i++) { let sum = 0; for (let r = 0; r < ROLE_COUNT; r++) sum += s.roles[i * ROLE_COUNT + r]; expect(sum).toBeCloseTo(1, 5); }
  });

  it('order → fracture: an ordered structure in a world that turns chaotic comes apart into fragments', { timeout: 60000 }, () => {
    const system = new StructuralSystem({ capacity: 96, seed: 9 }), w = world({ ...ORDERED, flow: shear(0.05) });
    system.addPopulation(90, { id: 1, centre: 0.45, spread: 0.08 }, 0.2, 0.9);
    w.ring(0.45); w.run(system, 20);
    const ordered = { ...system.stats };
    expect(ordered.bonds).toBeGreaterThan(20);
    Object.assign(w.env, { coherence: 0.2, harmony: 0, turbulence: 1, release: 1, tension: 0.8, flow: shear(1.5) });
    w.run(system, 1);
    expect(system.stats.fragments).toBeGreaterThan(5);
    w.run(system, 6);
    expect(system.stats.bonds).toBeLessThan(0.5 * ordered.bonds); expect(system.stats.fractures).toBeGreaterThan(ordered.fractures + 10);
    expect(system.stats.elements).toBe(ordered.elements); expect(system.stats.temperature).toBeGreaterThan(0.6);
    expect(finiteState(system)).toBe(true);
  });

  it('roles do not flicker: the leading role holds through small changes of condition', { timeout: 60000 }, () => {
    const system = new StructuralSystem({ capacity: 48, seed: 9 }), s = system.state, w = world({ ...ORDERED, flow: shear(0.05) });
    system.addPopulation(40, { id: 1, centre: 0.45, spread: 0.08 }, 0.2, 0.8);
    w.ring(0.45); w.run(system, 15);
    const roles = Array.from(s.role.subarray(0, s.count)), bonds = s.bonds;
    let changes = 0, k = 0;
    // The world's coherence trembles a little, far faster than any role follows.
    w.run(system, 6, () => {
      w.env.coherence = 0.9 + 0.04 * (k++ % 2 ? 1 : -1);
      for (let i = 0; i < s.count; i++) if (s.role[i] !== roles[i]) { changes++; roles[i] = s.role[i]; }
    });
    // At most a few elements change role once, where a bond formed or their state really moved.
    expect(changes).toBeLessThanOrEqual(6 + 2 * Math.abs(s.bonds - bonds));
  });
});

describe('limits', () => {
  it('silence creates nothing: a world never played does not move; a world gone silent comes to rest and stays', { timeout: 60000 }, () => {
    const fresh = new StructuralSystem({ capacity: 64, seed: 3 }), w = world();
    fresh.seedPolygon(4, 0.55); fresh.addPopulation(40, { id: 1, centre: 0.45, spread: 0.2 }, 0.2, 1);
    const start = Array.from(fresh.state.position);
    w.run(fresh, 10);
    expect(Array.from(fresh.state.position)).toEqual(start);
    expect(kinetic(fresh)).toBe(0); expect(fresh.state.bonds).toBe(0); expect(fresh.stats.formed).toBe(0);

    const played = new StructuralSystem({ capacity: 64, seed: 3 }), live = world({ ...ORDERED, flow: shear(0.6), turbulence: 0.3 });
    played.seedPolygon(4, 0.55, { bonded: true }); played.addPopulation(40, { id: 1, centre: 0.45, spread: 0.2 }, 0.2, 1);
    live.ring(0.42); live.run(played, 6);
    expect(kinetic(played)).toBeGreaterThan(0.01);
    // The music stops: the medium stills, nothing rings, the world is no longer alive.
    Object.assign(live.env, createStillEnvironment(), { resonance: live.field });
    live.ring(-1);
    let previous = kinetic(played), rose = 0;
    const energies: number[] = [];
    live.run(played, 12, (t) => {
      if (Math.abs(t * 4 - Math.round(t * 4)) < 1e-6) { const e = kinetic(played); if (e > previous * 1.05 + 1e-9) rose++; previous = e; energies.push(e); }
    });
    // Bonds settling to their rest length may pass a little energy back and forth; none is added.
    expect(rose).toBeLessThanOrEqual(3);
    expect(kinetic(played)).toBeLessThan(1e-6);
    expect(played.stats.temperature).toBeLessThan(0.05); expect(played.stats.excitation).toBe(0);
    const settled = { bonds: played.state.bonds, formed: played.stats.formed, fractures: played.stats.fractures, position: Array.from(played.state.position) };
    live.run(played, 10);
    expect(played.state.bonds).toBe(settled.bonds); expect(played.stats.formed).toBe(settled.formed); expect(played.stats.fractures).toBe(settled.fractures);
    for (let k = 0; k < settled.position.length; k++) expect(Math.abs(played.state.position[k] - settled.position[k])).toBeLessThan(1e-3);
  });

  it('stays finite and bounded whatever the environment does', { timeout: 60000 }, () => {
    const system = new StructuralSystem({ capacity: 64, seed: 3 }), s = system.state;
    system.seedPolygon(5, 0.5, { bonded: true }); system.addPopulation(40, { id: 1, centre: 0.45, spread: 0.3 }, 0.2, 1);
    const w = world({ ...ORDERED });
    w.ring(0.42);
    const wild: Partial<StructuralEnvironment>[] = [
      { flow: (_x, _y, _z, out) => { out[0] = 1e9; out[1] = -1e9; out[2] = 1e9; } },
      { flow: (_x, _y, _z, out) => { out[0] = NaN; out[1] = Infinity; out[2] = -Infinity; }, push: (_x, _y, _z, _a, out) => { out[0] = NaN; out[1] = 1e12; out[2] = -Infinity; } },
      { drag: NaN, coherence: NaN, harmony: Infinity, turbulence: -Infinity, tension: NaN, energy: NaN, release: 1e9 },
      { drag: 1e9, hold: (_x, _y, _z, _h, out) => { out[0] = out[1] = out[2] = -1e9; }, energy: 1 },
    ];
    for (const over of wild) {
      Object.assign(w.env, createStillEnvironment(), { resonance: w.field }, ORDERED, over);
      w.frame.macro.fill(NaN); w.frame.micro.fill(Infinity);
      w.run(system, 2);
      expect(finiteState(system)).toBe(true);
      for (let i = 0; i < s.count; i++) {
        expect(Math.hypot(s.position[i * 3], s.position[i * 3 + 1], s.position[i * 3 + 2])).toBeLessThanOrEqual(8.001);
        expect(Math.hypot(s.velocity[i * 3], s.velocity[i * 3 + 1], s.velocity[i * 3 + 2])).toBeLessThanOrEqual(12.001);
        for (const value of [s.order[i], s.temperature[i], s.excitation[i]]) { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1); }
      }
      for (const value of Object.values(system.stats)) expect(Number.isFinite(value)).toBe(true);
    }
    // Development overrides out of range, a clock that jumps, stalls or goes back.
    Object.assign(system.tuning, { fractureThreshold: -5, bondStrength: NaN, resonanceCoupling: Infinity, environmentCoupling: -1 });
    Object.assign(w.env, createStillEnvironment(), { resonance: w.field }, ORDERED);
    for (const now of [0, 0.01, 5, 5.02, NaN, 1, 1.5, Infinity, 2]) system.advance(now, w.env);
    expect(finiteState(system)).toBe(true); expect(system.stats.steps).toBeLessThanOrEqual(8);
  });

  it('is deterministic: the same seed, clock and world give the same life, bit for bit', { timeout: 60000 }, () => {
    const life = () => {
      const system = new StructuralSystem({ capacity: 64, seed: 21 }), w = world({ ...ORDERED, flow: shear(0.4) });
      system.seedPolygon(4, 0.55); system.addPopulation(40, { id: 1, centre: 0.45, spread: 0.2 }, 0.2, 1);
      w.ring(0.42); w.run(system, 6);
      Object.assign(w.env, { release: 1, turbulence: 0.8 }); w.run(system, 2);
      return { position: Array.from(system.state.position), bonds: Array.from(system.state.bondAlive), stats: { ...system.stats } };
    };
    const random = vi.spyOn(Math, 'random');
    const a = life(), b = life();
    expect(a).toEqual(b);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it('lives the same life at 30, 60 and 144 frames a second: topology follows the audio clock, not the frames', { timeout: 60000 }, () => {
    const life = (fps: number) => {
      const system = new StructuralSystem({ capacity: 64, seed: 21 }), w = world({ ...ORDERED, flow: shear(0.3) });
      system.seedPolygon(4, 0.55); system.addPopulation(40, { id: 1, centre: 0.45, spread: 0.2 }, 0.2, 1);
      w.ring(0.42);
      const events: [number, number, number][] = [];
      let bonds = 0;
      for (let f = 0; f <= 22 * fps; f++) {
        const t = f / fps;
        // The world changes at audio times; a frame only happens to fall near them.
        if (t >= 10 && t < 13) Object.assign(w.env, { release: 0.9, tension: 0.8, turbulence: 0.8, coherence: 0.4 });
        else Object.assign(w.env, ORDERED, { release: 0, tension: 0 });
        w.tick(1 / fps);
        system.advance(t, w.env);
        if (system.state.bonds !== bonds) { bonds = system.state.bonds; events.push([t, bonds, system.stats.fractures]); }
      }
      return { events, formed: system.stats.formed, fractures: system.stats.fractures, bonds: system.state.bonds, loops: system.stats.loops, position: Array.from(system.state.position.subarray(0, 24)), time: system.time };
    };
    const reference = life(60);
    expect(reference.fractures).toBeGreaterThan(0); expect(reference.formed).toBeGreaterThan(8);
    for (const fps of [30, 144]) {
      const other = life(fps);
      // The same structure at the end, made and broken about as often, at about the same times.
      expect(Math.abs(other.bonds - reference.bonds), `${fps} fps bonds`).toBeLessThanOrEqual(2);
      expect(Math.abs(other.formed - reference.formed), `${fps} fps formed`).toBeLessThanOrEqual(0.15 * reference.formed + 2);
      expect(Math.abs(other.fractures - reference.fractures), `${fps} fps fractures`).toBeLessThanOrEqual(0.2 * reference.fractures + 2);
      expect(Math.abs(other.events[0][0] - reference.events[0][0]), `${fps} fps first bond`).toBeLessThan(0.25);
      const firstBreak = (life: typeof reference) => life.events.find(([, , fractures]) => fractures > 0)![0];
      expect(Math.abs(firstBreak(other) - firstBreak(reference)), `${fps} fps first fracture`).toBeLessThan(0.25);
      expect(Math.abs(other.time - reference.time)).toBeLessThan(1 / 100);
    }
  });
});

describe('the square', () => {
  it('forms, resonates, is stressed, fractures, lives on as reactive fragments, and reforms', { timeout: 60000 }, () => {
    const system = new StructuralSystem({ capacity: 16, seed: 7 }), s = system.state, w = world(ORDERED);
    system.seedPolygon(4, 0.55, { turn: Math.PI / 4 });
    const stranger = s.add(7, FINE, 1.4, 1.4, 0, 0.4);
    const pitch = Array.from(s.f0.subarray(0, 8));
    w.ring(0.42);

    // 1. Formation is gradual: loose matter → settled matter → wires → an open chain → the closed square.
    const growth: number[] = [];
    w.run(system, 1);
    expect(s.bonds).toBe(0); expect(system.stats.loops).toBe(0);
    expect(s.cohesion[0]).toBeGreaterThan(0); expect(LIFECYCLES[s.lifecycle[0]]).not.toBe('bound');
    w.run(system, 9, () => { if (s.bonds !== growth[growth.length - 1]) growth.push(s.bonds); });
    expect(growth[growth.length - 1]).toBe(8);
    expect(growth.length).toBeGreaterThan(3);
    for (let k = 1; k < growth.length; k++) expect(growth[k] - growth[k - 1]).toBeLessThanOrEqual(2);
    expect(system.stats.loops).toBe(1); expect(s.loopSize[0]).toBe(4); expect(s.loopPlanarity[0]).toBeGreaterThan(0.95);
    expect(system.stats.spans).toBe(4); expect(system.stats.joints).toBe(4);
    for (let i = 0; i < 8; i++) expect(LIFECYCLES[s.lifecycle[i]]).toBe('bound');
    // Its sides are the length it was seeded with, its corners square.
    for (let k = 0; k < 4; k++) {
      const a = s.loopCorners[k], b = s.spanPartner(a), c = s.loopCorners[(k + 2) % 4];
      expect(Math.hypot(s.position[a * 3] - s.position[b * 3], s.position[a * 3 + 1] - s.position[b * 3 + 1])).toBeCloseTo(0.55 * Math.SQRT2 - 0.02, 1);
      expect(Math.hypot(s.position[a * 3] - s.position[c * 3], s.position[a * 3 + 1] - s.position[c * 3 + 1])).toBeCloseTo(1.1, 1);
    }

    // 2. It resonates with the sound at its pitch: corners swing, wires ring as strings; matter of another pitch does not.
    let swings = 0, last = s.vibration[0], strings = 0;
    for (let k = 0; k < 20; k++) {
      w.run(system, 0.05); system.advance(Number.isNaN(system.time) ? 0 : system.time + 1e-4, w.env);
      if (s.vibration[0] * last < 0) swings++;
      last = s.vibration[0]; strings = Math.max(strings, Math.abs(s.bondModes[s.span[0] * 3]));
    }
    expect(swings).toBeGreaterThan(2); expect(strings).toBeGreaterThan(0.1);
    expect(s.excitation[0]).toBeGreaterThan(0.15); expect(s.excitation[stranger]).toBeLessThan(0.1 * s.excitation[0]);
    const calm = system.stats.stress;
    expect(system.stats.fractures).toBe(0);

    // 3. Tension builds and the medium shears: stress accumulates before anything gives.
    Object.assign(w.env, { tension: 0.7, turbulence: 0.25, flow: shear(0.35) });
    let damage = 0, peak = 0;
    w.run(system, 1.2, () => { peak = Math.max(peak, system.stats.stress); for (let b = 0; b < s.bondCapacity; b++) if (s.bondAlive[b]) damage = Math.max(damage, s.bondDamage[b]); });
    expect(peak).toBeGreaterThan(calm + 0.15);
    expect(system.stats.fractures).toBe(0); expect(s.bonds).toBe(8);

    // 4. The release: it fractures. Bonds are gone, the matter is all there.
    Object.assign(w.env, { release: 1, tension: 0.9, turbulence: 0.7, flow: shear(0.8) });
    w.run(system, 2);
    expect(system.stats.fractures).toBeGreaterThanOrEqual(4); expect(system.stats.loops).toBe(0); expect(s.bonds).toBeLessThanOrEqual(4);
    expect(s.count).toBe(9);
    expect(system.stats.fragments).toBeGreaterThan(0);
    expect(Array.from(s.f0.subarray(0, 8))).toEqual(pitch);

    // 5. No piece is dead: the fragments still ring at their pitch, still swing, and are carried by the field.
    const from = Array.from(s.position.subarray(0, 24));
    swings = 0; last = s.vibration[2];
    w.run(system, 1.5, () => { if (s.vibration[2] * last < 0) swings++; last = s.vibration[2]; });
    expect(swings).toBeGreaterThan(2);
    for (let i = 0; i < 8; i++) {
      expect(s.excitation[i]).toBeGreaterThan(0.15);
      expect(Math.hypot(s.position[i * 3] - from[i * 3], s.position[i * 3 + 1] - from[i * 3 + 1], s.position[i * 3 + 2] - from[i * 3 + 2]), `fragment ${i} moves`).toBeGreaterThan(0.03);
    }
    // They remember what they were part of.
    let remembering = 0;
    for (let i = 0; i < 8; i++) for (let slot = 0; slot < MEMORY_SLOTS; slot++) if (s.memPartner[i * MEMORY_SLOTS + slot] >= 0) remembering++;
    expect(remembering).toBeGreaterThanOrEqual(8);
    const broken = s.bonds;

    // 6. The world calms and coheres: the pieces find each other and the square closes again.
    Object.assign(w.env, ORDERED, { release: 0, tension: 0, flow: still });
    w.run(system, 45);
    expect(s.bonds).toBeGreaterThan(broken);
    expect(s.bonds).toBe(8); expect(system.stats.loops).toBe(1); expect(s.loopSize[0]).toBe(4);
    expect(finiteState(system)).toBe(true);
  });

  it('is one of the polygons the same matter makes: triangle, square, pentagon, hexagon', { timeout: 60000 }, () => {
    for (const sides of [3, 4, 5, 6]) {
      const system = new StructuralSystem({ capacity: 16, seed: 7 }), s = system.state, w = world(ORDERED);
      expect(system.seedPolygon(sides, 0.5, { bonded: true })).toBe(0);
      expect(s.count).toBe(2 * sides); expect(s.bonds).toBe(2 * sides);
      w.ring(0.42); w.run(system, 3);
      expect(system.stats.loops, `${sides} sides`).toBe(1); expect(s.loopSize[0]).toBe(sides);
      expect(s.loopPlanarity[0]).toBeGreaterThan(0.95); expect(system.stats.fractures).toBe(0);
      // It keeps its shape: every corner stays on the circle it was laid out on.
      for (let k = 0; k < sides; k++) { const e = s.loopCorners[k]; expect(Math.hypot(s.position[e * 3], s.position[e * 3 + 1])).toBeCloseTo(0.5, 1); }
      // Left to form by itself it becomes the same figure.
      const loose = new StructuralSystem({ capacity: 16, seed: 7 });
      loose.seedPolygon(sides, 0.5);
      w.run(loose, 12);
      expect(loose.stats.loops, `${sides} sides, formed`).toBe(1); expect(loose.state.loopSize[0]).toBe(sides);
    }
  });
});
