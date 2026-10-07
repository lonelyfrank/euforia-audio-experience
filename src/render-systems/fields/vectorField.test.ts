import { describe, expect, it } from 'vitest';
import { fieldLinePoint, LINE_SPREAD, seedFieldLines, type FieldLineShape } from '../../visual-engine/primitives/FieldLinePrimitive';
import { Rng } from '../../show/rng';
import { FIELD_VALUES, packFields } from './fieldLaw';
import { flowAt, settle } from './flowLaw';
import { createFields, type SpatialFields } from './SpatialFields';
import { deriveTopology, EDDIES, fieldAt, FIELD_SPAN, TOPOLOGY, TOPOLOGY_VALUES } from './vectorField';
import { WELL_DEPTH, wellPull, wellRest } from './wells';

const pack = (set: Partial<SpatialFields> = {}, phase = 0): Float32Array => packFields(new Float32Array(FIELD_VALUES), { ...createFields(), ...set }, phase);
const topology = (eddy = 0, eddies = 0, well = 0): Float32Array => Float32Array.of(eddy, eddies, well, 0);
const REST = topology();
/** Points spread through the space of the field (inside its wall). */
const points = (n: number, seed = 3, reach = FIELD_SPAN): number[][] => {
  const rng = new Rng(seed), out: number[][] = [];
  while (out.length < n) {
    const p = [2 * rng.next() - 1, 2 * rng.next() - 1, 2 * rng.next() - 1].map((x) => x * reach);
    if (Math.hypot(...p) < reach) out.push(p);
  }
  return out;
};
const at = (p: number[], f: Float32Array, t: ArrayLike<number>): number[] => Array.from(fieldAt(p[0], p[1], p[2], f, t));

describe('potential wells', () => {
  it('pull towards the nearest well and vanish in it and on the ridge between two', () => {
    for (const well of [-2, 0, 3]) {
      expect(wellPull(well)).toBeCloseTo(0, 12); expect(wellPull(well + 0.5)).toBeCloseTo(0, 12);
      expect(wellPull(well + 0.2)).toBeLessThan(0); expect(wellPull(well - 0.2)).toBeGreaterThan(0);
    }
  });

  it('gather what floats in them without ever letting two elements cross, and leave it alone when flat', () => {
    const xs = Array.from({ length: 2001 }, (_, i) => i / 500);
    expect(xs.map((x) => wellRest(x, 0))).toEqual(xs);
    for (const depth of [0.3, 0.7, WELL_DEPTH]) {
      const rest = xs.map((x) => wellRest(x, depth));
      for (let i = 1; i < rest.length; i++) expect(rest[i]).toBeGreaterThan(rest[i - 1]);
      // Whole numbers are the wells: nothing leaves one, and the elements of a cell end up nearer it.
      for (const well of [0, 1, 4]) expect(wellRest(well, depth)).toBeCloseTo(well, 12);
      const near = (values: number[]) => values.filter((x) => Math.abs(x - Math.round(x)) < 0.1).length;
      expect(near(rest)).toBeGreaterThan(near(xs) * (1 + depth));
    }
  });
});

describe('the vector field', () => {
  it('is zero everywhere in a world at rest: nothing moves on its own', () => {
    const f = pack();
    for (const p of points(200)) expect(Math.hypot(...at(p, f, REST))).toBe(0);
    // The disorder phase alone moves nothing.
    for (const p of points(50)) expect(Math.hypot(...at(p, pack({}, 7.3), REST))).toBe(0);
  });

  it('is the flow that carries the matter and the filaments of Matter Field, as long as it has no topology of its own', () => {
    const f = pack({ surge: 0.4, vortex: -0.9, advection: 0.6, drift: 0.2, lateral: 0.15, turbulence: 0.5, turbulenceScale: 2.2, radius: 1.2 }, 3.1);
    for (const p of points(100)) {
      const flow = Array.from(flowAt(p[0], p[1], p[2], f, false));
      const field = at(p, f, REST);
      for (let k = 0; k < 3; k++) expect(field[k]).toBeCloseTo(flow[k], 12);
    }
  });

  it('reads the world: the radial velocity is a source or a sink, the spin a vortex about the axis', () => {
    const outward = (f: Float32Array) => points(200).reduce((sum, p) => { const u = at(p, f, REST); return sum + (u[0] * p[0] + u[1] * p[1] + u[2] * p[2]) / Math.hypot(...p); }, 0) / 200;
    const circulation = (f: Float32Array) => points(200).reduce((sum, p) => { const u = at(p, f, REST); return sum + (p[0] * u[1] - p[1] * u[0]) / Math.max(p[0] * p[0] + p[1] * p[1], 1e-6); }, 0) / 200;
    expect(outward(pack({ surge: 0.6 }))).toBeGreaterThan(0.3); expect(outward(pack({ surge: -0.6 }))).toBeLessThan(-0.3);
    expect(circulation(pack({ vortex: 1 }))).toBeGreaterThan(0.2); expect(circulation(pack({ vortex: -1 }))).toBeCloseTo(-circulation(pack({ vortex: 1 })), 10);
    expect(Math.abs(circulation(pack({ surge: 0.6 })))).toBeLessThan(1e-9);
  });

  it('shells: an ordered field converges on the three shells of the body, and only there', () => {
    const f = pack({ radius: 1.1 }), t = topology(0, 0, 2);
    const radial = (r: number) => at([r * 1.1, 0, 0], f, t)[0];
    for (const shell of [0.55, 0.85, 1.15]) {
      expect(Math.abs(radial(shell))).toBeLessThan(1e-6);
      expect(radial(shell + 0.06)).toBeLessThan(-0.01); expect(radial(shell - 0.06)).toBeGreaterThan(0.01);
    }
    // Outside the body the shells do nothing: the field is a space, the body its centre.
    expect(radial(1.8)).toBe(0); expect(radial(0.2)).toBe(0);
    // The pull is radial about the centre of the forces, wherever that is.
    const off = pack({ radius: 1.1, lateral: 0.3 });
    expect(at([0.3, 1.1 * 0.91, 0], off, t)[1]).toBeLessThan(-0.01); expect(Math.abs(at([0.3, 1.1 * 0.91, 0], off, t)[0])).toBeLessThan(1e-6);
  });

  it('eddies: local vortices that add no source and wake one by one', () => {
    const f = pack({ radius: 1 });
    const divergence = (p: number[], t: Float32Array) => {
      const h = 1e-4;
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        const a = [...p], b = [...p];
        a[k] += h; b[k] -= h;
        sum += (at(a, f, t)[k] - at(b, f, t)[k]) / (2 * h);
      }
      return sum;
    };
    const all = topology(1, EDDIES, 0);
    for (const p of points(60, 5, 1.4)) expect(Math.abs(divergence(p, all))).toBeLessThan(1e-4);
    // Each one turns the field about its own axis (corner of a tetrahedron, 0.6 radii out), alternately one way and the other.
    const energy = (t: Float32Array) => points(300, 9, 1.5).reduce((sum, p) => sum + Math.hypot(...at(p, f, t)) ** 2, 0);
    let last = 0;
    for (let awake = 0.5; awake <= EDDIES; awake += 0.5) {
      const now = energy(topology(1, awake, 0));
      expect(now).toBeGreaterThan(last);
      last = now;
    }
    // Waking is continuous: a little more disorder is a little more field, never a switch.
    const a = points(100, 4, 1.5).map((p) => at(p, f, topology(1, 1.99, 0))), b = points(100, 4, 1.5).map((p) => at(p, f, topology(1, 2.01, 0)));
    for (let i = 0; i < a.length; i++) expect(Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1], a[i][2] - b[i][2])).toBeLessThan(0.05);
    // Their speed is bounded by the topology's own.
    for (const p of points(300, 11, 1.6)) expect(Math.hypot(...at(p, f, topology(1.6, EDDIES, 0)))).toBeLessThan(2 * 1.6);
    // They turn with the structure.
    const turned = packFields(new Float32Array(FIELD_VALUES), { ...createFields(), turn: Math.PI / 2 / 0.15 }, 0);
    const u = at([0.5, 0.2, 0.3], f, topology(1, 1, 0)), v = at([-0.2, 0.5, 0.3], turned, topology(1, 1, 0));
    expect(v[0]).toBeCloseTo(-u[1], 5); expect(v[1]).toBeCloseTo(u[0], 5); expect(v[2]).toBeCloseTo(u[2], 5);
  });

  it('is bounded by a soft wall far outside the body', () => {
    const f = pack({ radius: 1.2 }), wall = 2.6 * 1.2;
    expect(Math.hypot(...at([wall - 0.1, 0, 0], f, REST))).toBe(0);
    expect(at([wall + 0.5, 0, 0], f, REST)[0]).toBeLessThan(-1);
    expect(at([0, -(wall + 0.5), 0], f, REST)[1]).toBeGreaterThan(1);
  });

  it('takes its topology from the world: nothing at rest, eddies with disorder, shells with order while the world is alive', () => {
    const out = new Float32Array(TOPOLOGY_VALUES), fields = { ...createFields(), gather: 0.8 };
    const rest = { disorder: 0, coherence: 1, fragmentation: 0, energy: 0 };
    expect(Array.from(deriveTopology(out, rest, fields))).toEqual([0, 0, 0, 0]);
    // Order alone does not organise a silent field.
    expect(deriveTopology(out, { ...rest, energy: 0.6 }, fields)[TOPOLOGY.well]).toBeGreaterThan(1);
    expect(deriveTopology(out, { ...rest, energy: 0.6 }, { ...fields, gather: 0 })[TOPOLOGY.well]).toBe(0);
    const calm = Array.from(deriveTopology(out, { disorder: 0.2, coherence: 0.8, fragmentation: 0, energy: 0.5 }, fields));
    const wild = Array.from(deriveTopology(out, { disorder: 0.9, coherence: 0.2, fragmentation: 0.6, energy: 0.5 }, fields));
    expect(wild[TOPOLOGY.eddies]).toBeGreaterThan(calm[TOPOLOGY.eddies] + 2); expect(wild[TOPOLOGY.eddy]).toBeGreaterThan(3 * calm[TOPOLOGY.eddy]);
    for (const bad of [NaN, Infinity, -Infinity, 1e9, -5]) {
      const t = deriveTopology(out, { disorder: bad, coherence: bad, fragmentation: bad, energy: bad }, { ...fields, gather: bad });
      for (const value of t) expect(Number.isFinite(value)).toBe(true);
      expect(t[TOPOLOGY.eddies]).toBeLessThanOrEqual(EDDIES); expect(t[TOPOLOGY.eddy]).toBeLessThanOrEqual(1.6); expect(t[TOPOLOGY.well]).toBeLessThanOrEqual(2.2001);
    }
  });
});

describe('field lines', () => {
  const seeds = seedFieldLines(48, 7);
  const shape: FieldLineShape = { reach: 0.05, step: 0.1 };
  const point = (out: ArrayLike<number>): number[] => [out[0], out[1], out[2]];

  it('are the same for the same seed and start where a point of the body rests, spread through the field', () => {
    expect(seedFieldLines(48, 7).home).toEqual(seeds.home); expect(seedFieldLines(48, 8).home).not.toEqual(seeds.home);
    const f = pack({ radius: 1.1, gather: 0.3 });
    for (const i of [0, 7, 40]) {
      const start = point(fieldLinePoint(seeds, i, 0, shape, f, REST));
      const rest = point(settle(seeds.home[i * 4], seeds.home[i * 4 + 1], seeds.home[i * 4 + 2], LINE_SPREAD, f));
      expect(start).toEqual(rest);
    }
  });

  it('have no length where the field is zero', () => {
    const f = pack();
    for (let i = 0; i < seeds.count; i++) {
      const start = point(fieldLinePoint(seeds, i, 0, shape, f, REST)), end = point(fieldLinePoint(seeds, i, 20, shape, f, REST));
      expect(end).toEqual(start);
    }
  });

  it('follow the field downstream: round the axis in a vortex, outwards in a surge, and never further than the longest step', () => {
    const vortex = pack({ vortex: 1.2 }), surge = pack({ surge: 0.8 });
    let swept = 0, opened = 0;
    for (let i = 0; i < seeds.count; i++) {
      const a = point(fieldLinePoint(seeds, i, 0, shape, vortex, REST)), b = point(fieldLinePoint(seeds, i, 12, shape, vortex, REST));
      let d = Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0]);
      d = Math.atan2(Math.sin(d), Math.cos(d));
      swept += d;
      // A vortex about the axis keeps a line at its height and (nearly) at its distance from the axis.
      expect(b[2]).toBeCloseTo(a[2], 9);
      const c = point(fieldLinePoint(seeds, i, 12, shape, surge, REST));
      opened += Math.hypot(...c) - Math.hypot(...point(fieldLinePoint(seeds, i, 0, shape, surge, REST)));
      for (let k = 1; k <= 12; k++) {
        const step = fieldLinePoint(seeds, i, k, shape, pack({ vortex: 2.4, surge: 1.25, turbulence: 1.2 }, 2), topology(1.6, EDDIES, 2));
        const length = Math.hypot(step[3], step[4], step[5]);
        expect(Number.isFinite(length)).toBe(true); expect(length).toBeLessThanOrEqual(shape.step);
      }
    }
    expect(swept / seeds.count).toBeGreaterThan(0.1); expect(opened / seeds.count).toBeGreaterThan(0.1);
  });
});
