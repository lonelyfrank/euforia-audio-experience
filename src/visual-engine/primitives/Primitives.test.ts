import { describe, expect, it } from 'vitest';
import { MODES, WAVES } from '../../physics/ResonantPhysics';
import { FIELD, FIELD_VALUES, layerRadius, packFields, packWaves } from '../../render-systems/fields/fieldLaw';
import { createFields, type SpatialFields } from '../../render-systems/fields/SpatialFields';
import { MAX_WAVES, WaveField } from '../../render-systems/waves/WaveField';
import { CAGE, jointReach, nodePoint, seedGraph, type GraphSeeds } from './ConnectionGraphPrimitive';
import { BRANCHES, filamentPoint, seedFilaments, stringLobes, type FilamentShape } from './FilamentPrimitive';
import { ringPoint, ringSides } from './ShockwavePrimitive';
import { MEMORY_RATE, ModalMemory } from './ModalMemory';
import { shellAge, shellBend, shellPoint, shellRadius, surfaceHeight, surfaceVertices, type SurfaceShape } from './WaveSurfacePrimitive';

const pack = (set: Partial<SpatialFields> = {}, phase = 0): Float32Array => packFields(new Float32Array(FIELD_VALUES), { ...createFields(), ...set }, phase);
const NO_WAVES = new Float32Array(MAX_WAVES * 4);
const point = (out: ArrayLike<number>): number[] => [out[0], out[1], out[2]];
const distance = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('filaments', () => {
  const seeds = seedFilaments(24, 16, 7);
  const still: FilamentShape = { step: 0, reach: 0, curvature: 0 };

  it('are the same for the same seed, trunks first, each with its branches', () => {
    expect(seeds.count).toBe(24 * (1 + BRANCHES));
    const again = seedFilaments(24, 16, 7), other = seedFilaments(24, 16, 8);
    expect(again.home).toEqual(seeds.home); expect(again.heading).toEqual(seeds.heading);
    expect(other.home).not.toEqual(seeds.home);
    for (let t = 0; t < 24; t++) {
      // A trunk does not leave anything; its branches leave it somewhere along its length, from the same place.
      expect(seeds.trunk[t * 4 + 3]).toBe(0);
      const branch = 24 + t * BRANCHES;
      expect(seeds.trunk[branch * 4 + 3]).toBeGreaterThanOrEqual(2); expect(seeds.trunk[branch * 4 + 3]).toBeLessThan(16);
      expect(Array.from(seeds.home.subarray(branch * 4, branch * 4 + 4))).toEqual(Array.from(seeds.home.subarray(t * 4, t * 4 + 4)));
      // Headings are unit vectors tangent to the shell.
      const h = [seeds.heading[t * 4], seeds.heading[t * 4 + 1], seeds.heading[t * 4 + 2]], d = [seeds.home[t * 4], seeds.home[t * 4 + 1], seeds.home[t * 4 + 2]];
      expect(Math.hypot(...h)).toBeCloseTo(1, 5); expect(h[0] * d[0] + h[1] * d[1] + h[2] * d[2]).toBeCloseTo(0, 5);
    }
  });

  it('have no length in a still, silent world', () => {
    const f = pack();
    for (const i of [0, 5, 30]) {
      const start = point(filamentPoint(seeds, i, 0, still, f));
      expect(distance(point(filamentPoint(seeds, i, 16, still, f)), start)).toBe(0);
    }
  });

  it('are carried by the same flow as the matter: a vortex winds them round the axis, more where it is stronger', () => {
    const angleOf = (p: number[]) => Math.atan2(p[1], p[0]);
    const swept = (vortex: number) => {
      const f = pack({ vortex });
      let total = 0;
      for (let i = 0; i < 24; i++) {
        let d = angleOf(point(filamentPoint(seeds, i, 12, { step: 0, reach: 0.02, curvature: 0 }, f))) - angleOf(point(filamentPoint(seeds, i, 0, still, f)));
        d = Math.atan2(Math.sin(d), Math.cos(d));
        total += d;
      }
      return total / 24;
    };
    expect(swept(1)).toBeGreaterThan(0.05); expect(swept(2)).toBeGreaterThan(1.5 * swept(1)); expect(swept(-1)).toBeCloseTo(-swept(1), 6);
  });

  it('keep to their shell as far as the geometry is curved, and leave it straight when it is angular', () => {
    const f = pack(), line: FilamentShape = { step: 0.05, reach: 0, curvature: 0 }, arc: FilamentShape = { step: 0.05, reach: 0, curvature: 1 };
    for (const i of [1, 9, 17]) {
      const start = Math.hypot(...point(filamentPoint(seeds, i, 0, still, f)));
      expect(Math.hypot(...point(filamentPoint(seeds, i, 14, arc, f)))).toBeCloseTo(start, 5);
      expect(Math.hypot(...point(filamentPoint(seeds, i, 14, line, f)))).toBeGreaterThan(start * 1.1);
      // A straight filament is a straight line: equal steps.
      const a = point(filamentPoint(seeds, i, 4, line, f)), b = point(filamentPoint(seeds, i, 8, line, f)), c = point(filamentPoint(seeds, i, 12, line, f));
      expect(distance(a, b)).toBeCloseTo(distance(b, c), 6); expect(distance(a, b)).toBeCloseTo(0.2, 6);
    }
  });

  it('a branch follows its trunk up to where it leaves it', () => {
    const f = pack({ vortex: 0.6, turbulence: 0.3 }, 2), shape: FilamentShape = { step: 0.03, reach: 0.02, curvature: 0.6 };
    for (let t = 0; t < 6; t++) {
      const branch = 24 + t * BRANCHES, at = seeds.trunk[branch * 4 + 3];
      expect(point(filamentPoint(seeds, branch, 0, shape, f))).toEqual(point(filamentPoint(seeds, t, at, shape, f)));
      expect(distance(point(filamentPoint(seeds, branch, 6, shape, f)), point(filamentPoint(seeds, t, at + 6, shape, f)))).toBeGreaterThan(0.02);
    }
  });

  it('stay finite and bounded under the strongest fields, and wind a voice by its pitch', () => {
    const f = pack({ vortex: 1.6, surge: 1.25, advection: 1.8, turbulence: 1.2, turbulenceScale: 3.5, drift: 0.6, radius: 1.7 }, 11);
    for (let i = 0; i < seeds.count; i++) {
      const p = point(filamentPoint(seeds, i, 16, { step: 0.05, reach: 0.031, curvature: 0.5 }, f));
      expect(Number.isFinite(p[0] + p[1] + p[2])).toBe(true); expect(Math.hypot(...p)).toBeLessThan(8);
    }
    expect(stringLobes(55)).toBe(2); expect(stringLobes(220)).toBe(4); expect(stringLobes(20000)).toBe(8);
    for (const none of [0, -1, NaN, Infinity]) expect(stringLobes(none)).toBe(2);
  });
});

describe('connection graph', () => {
  const seeds = seedGraph(96, 7);
  /** Joints that hold: both nodes closer than the reach. */
  const held = (g: GraphSeeds, order: number, fracture: number, connectionRadius: number, f: Float32Array, a = NO_WAVES, b = NO_WAVES): number => {
    const reach = jointReach(g, connectionRadius, f[FIELD.radius]);
    let n = 0;
    for (let e = 0; e < g.edges.length / 2; e++) {
      const p = point(nodePoint(g, g.edges[e * 2], order, fracture, f, a, b)), q = point(nodePoint(g, g.edges[e * 2 + 1], order, fracture, f, a, b));
      if (distance(p, q) < reach) n++;
    }
    return n;
  };

  it('is the same lattice for the same seed: nodes spread over two shells, candidate joints shortest first', () => {
    const again = seedGraph(96, 7);
    expect(again.home).toEqual(seeds.home); expect(again.edges).toEqual(seeds.edges);
    const joints = seeds.edges.length / 2;
    expect(joints).toBeGreaterThan(96 * 2); expect(joints).toBeLessThanOrEqual(1200);
    const seen = new Set<number>();
    for (let e = 0; e < joints; e++) {
      const a = seeds.edges[e * 2], b = seeds.edges[e * 2 + 1];
      expect(a).toBeLessThan(b); expect(b).toBeLessThan(96);
      seen.add(a * 1000 + b);
    }
    expect(seen.size).toBe(joints);
    const layers = new Set(Array.from({ length: 96 }, (_, i) => Math.round(Math.hypot(seeds.home[i * 4], seeds.home[i * 4 + 1], seeds.home[i * 4 + 2]) * 100)));
    expect(layers.size).toBe(2);
  });

  it('joins nothing without a connection radius and closes into a cage as it grows', () => {
    const f = pack();
    expect(held(seeds, 1, 0, 0, f)).toBe(0);
    let previous = 0;
    for (const radius of [0.3, 0.6, 1]) {
      const n = held(seeds, 1, 0, radius, f);
      expect(n).toBeGreaterThan(previous);
      previous = n;
    }
    expect(previous).toBe(seeds.edges.length / 2);
    // A node sits outside the matter of its layer.
    const outer = Math.hypot(seeds.home[0], seeds.home[1], seeds.home[2]);
    expect(Math.hypot(...point(nodePoint(seeds, 0, 1, 0, f, NO_WAVES, NO_WAVES)))).toBeCloseTo(CAGE * layerRadius(outer, 1, 0), 5);
  });

  it('lets go where the world carries the nodes apart: disorder, turbulence, a release', () => {
    const calm = pack(), whole = held(seeds, 1, 0, 0.45, calm);
    expect(whole).toBeGreaterThan(50);
    // Nodes off the lattice.
    expect(held(seeds, 0, 0, 0.45, calm)).toBeLessThan(whole);
    // The disordered flow, at the same phase for every node.
    expect(held(seeds, 1, 0, 0.45, pack({ turbulence: 1.2, turbulenceScale: 3.5 }, 3))).toBeLessThan(whole);
    // A release throws each node out by its own share; the cage closes again as it fades.
    const open = held(seeds, 1, 1, 0.45, calm);
    expect(open).toBeLessThan(0.7 * whole);
    expect(held(seeds, 1, 0.3, 0.45, calm)).toBeGreaterThan(open);
    // A tighter world is a tighter cage: the joints scale with the matter's radius.
    expect(held(seeds, 1, 0, 0.45, pack({ radius: 0.6 }))).toBe(whole);
  });

  it('a passing front pushes the nodes it meets and lights them', () => {
    const waves = new WaveField(), a = new Float32Array(MAX_WAVES * 4), b = new Float32Array(MAX_WAVES * 4), f = pack();
    waves.update(0, undefined); waves.spawn(0, 1.5, -1, 2, 0.3, 0.5);
    const rest = point(nodePoint(seeds, 0, 1, 0, f, NO_WAVES, NO_WAVES)), r = Math.hypot(...rest);
    packWaves(a, b, waves, r / 2);
    const struck = nodePoint(seeds, 0, 1, 0, f, a, b);
    expect(struck[3]).toBeGreaterThan(0.5);
    expect(Math.hypot(...point(struck))).toBeGreaterThan(r + 0.05);
    packWaves(a, b, waves, 0.05);
    expect(nodePoint(seeds, 0, 1, 0, f, a, b)[3]).toBeLessThan(1e-3);
  });
});

describe('shockwaves', () => {
  it('draw each front where it is now: a ring of radius speed × age round its origin, turned with the structure', () => {
    const waves = new WaveField(), a = new Float32Array(MAX_WAVES * 4), b = new Float32Array(MAX_WAVES * 4);
    waves.update(0, undefined); waves.spawn(1, 1, 0.5, 1.8, 0.2, 1, 0.3, 0.1, -0.2);
    packWaves(a, b, waves, 1.5);
    const f = pack();
    for (const turn of [0, 0.13, 0.5, 0.77]) {
      const inPlane = point(ringPoint(a, b, 0, 0, turn, 0, f)), across = point(ringPoint(a, b, 0, 1, turn, 0, f));
      expect(distance(inPlane, [0.3, 0.1, -0.2])).toBeCloseTo(0.9, 5); expect(inPlane[2]).toBeCloseTo(-0.2, 6);
      expect(distance(across, [0.3, 0.1, -0.2])).toBeCloseTo(0.9, 5); expect(across[1]).toBeCloseTo(0.1, 6);
    }
    const turned = point(ringPoint(a, b, 0, 0, 0, 0, pack({ turn: Math.PI / 2 / 0.15 })));
    expect(turned[0]).toBeCloseTo(0.3, 5); expect(turned[1]).toBeCloseTo(1, 5);
  });

  it('are round when the geometry is smooth and a polygon when it has edges, with more sides for higher fronts', () => {
    const waves = new WaveField(), a = new Float32Array(MAX_WAVES * 4), b = new Float32Array(MAX_WAVES * 4), f = pack();
    waves.update(0, undefined); waves.spawn(0, 1, 0, 2, 0.2, 0.1); waves.spawn(0.2, 1, 1, 2, 0.2, 0.1);
    packWaves(a, b, waves, 1);
    const corners = (wave: number, polygon: number) => new Set(Array.from({ length: 96 }, (_, k) => point(ringPoint(a, b, wave, 0, k / 96, polygon, f)).map((v) => Math.round(v * 1e4) + 0).join())).size;
    const low = ringSides(b, 0, 0), high = ringSides(b, 1, 0);
    expect(low).toBe(3); expect(high).toBe(7); expect(ringSides(b, 0, 1)).toBe(4);
    expect(corners(0, 0)).toBe(96);
    expect(corners(0, 1)).toBe(low); expect(corners(1, 1)).toBe(high);
    // In between, the points stay on the circle and gather towards the corners.
    expect(Math.hypot(...point(ringPoint(a, b, 0, 0, 0.21, 0.5, f)))).toBeCloseTo(2, 5);
  });
});

describe('wave surface', () => {
  const flat: SurfaceShape = { modal: 1, pulse: 0.28, bow: 0, rim: 0, ripple: 0, frequency: 12, phase: 0, terraces: 0 };
  const modes = new Float32Array(MODES), pulses = new Float32Array(WAVES * 4);
  const height = (x: number, y: number, shape: SurfaceShape, m = modes, p = pulses, time = 0) => surfaceHeight(x, y, shape, m, p, time)[0];

  it('lies flat without sound, and takes the shape of the membrane\'s modes when they ring', () => {
    for (const [x, y] of [[0, 0], [0.4, -0.7], [-0.9, 0.2]]) expect(height(x, y, flat)).toBe(0);
    const first = new Float32Array(MODES); first[0] = 0.5;
    expect(height(0, 0, flat, first)).toBeCloseTo(0.5, 6);
    // Held at its four sides.
    for (const edge of [[-1, 0.3], [1, -0.2], [0.5, 1], [-0.4, -1]]) expect(height(edge[0], edge[1], flat, first)).toBeCloseTo(0, 6);
    // The (1,2) mode has a nodal line through the middle and opposite signs on its two sides.
    const second = new Float32Array(MODES); second[1] = 0.5;
    expect(height(0.3, 0, flat, second)).toBeCloseTo(0, 6);
    expect(height(0, 0.5, flat, second)).toBeCloseTo(-height(0, -0.5, flat, second), 6);
    expect(surfaceHeight(0, 0.5, flat, second, pulses, 0)[1]).toBeCloseTo(height(0, 0.5, flat, second), 6);
  });

  it('carries causal pulses: nothing before the event and nothing ahead of the front', () => {
    const p = new Float32Array(WAVES * 4);
    p[0] = 0; p[1] = 0; p[2] = 10; p[3] = 1;
    expect(height(0.2, 0, flat, modes, p, 9.9)).toBe(0);
    expect(height(0.8, 0, flat, modes, p, 10.2)).toBe(0);
    expect(Math.abs(height(0.2, 0, flat, modes, p, 10.2))).toBeGreaterThan(0.001);
    // It dies away.
    expect(Math.abs(height(0.2, 0, flat, modes, p, 20))).toBeLessThan(1e-4);
  });

  it('is shaped by the geometry: a bow, ripples of the given length, terraces, a held rim', () => {
    const first = new Float32Array(MODES); first[0] = 0.4;
    // Sustained pressure bows it, most in the middle.
    expect(height(0, 0, { ...flat, bow: 0.2 })).toBeCloseTo(0.2, 6); expect(height(0.9, 0, { ...flat, bow: 0.2 })).toBeLessThan(0.05);
    // Ripples: bounded by their height, finer with a higher frequency.
    const crossings = (frequency: number) => {
      let n = 0, previous = 0;
      for (let x = -1; x <= 1; x += 0.002) { const h = height(x, 0.31, { ...flat, ripple: 0.05, frequency }); if (h * previous < 0) n++; if (h !== 0) previous = h; }
      return n;
    };
    expect(crossings(22)).toBeGreaterThan(2 * crossings(7));
    for (let x = -1; x <= 1; x += 0.05) expect(Math.abs(height(x, 0.3, { ...flat, ripple: 0.05, phase: 2 }))).toBeLessThanOrEqual(0.05 + 1e-9);
    // Terraces: a stepped surface takes few distinct heights.
    const levels = (terraces: number) => new Set(Array.from({ length: 200 }, (_, i) => height(-0.99 + i * 0.0099, 0.1, { ...flat, terraces }, first).toFixed(5))).size;
    expect(levels(0)).toBeGreaterThan(100); expect(levels(1)).toBeLessThan(10);
    // A disc is held at its rim; the grid is not (its modes already vanish at its sides).
    expect(height(0.71, 0.71, { ...flat, rim: 1 }, first)).toBeCloseTo(0, 6);
    expect(height(0.71, 0.71, flat, first)).toBeGreaterThan(0.01);
    expect(height(0.2, 0.1, { ...flat, rim: 1 }, first)).toBeCloseTo(height(0.2, 0.1, flat, first), 6);
  });

  it('samples a grid or a disc, as points or as the two ends of each wire segment, inside its square', () => {
    const count = (topology: 'grid' | 'polar', style: 'points' | 'wire', resolution: number) => surfaceVertices({ topology, style }, resolution).length / 3;
    expect(count('grid', 'points', 10)).toBe(121);
    expect(count('grid', 'wire', 10)).toBe(2 * 2 * 10 * 11);
    expect(count('polar', 'points', 10)).toBe(10 * 40);
    expect(count('polar', 'wire', 10)).toBeGreaterThan(2 * 10 * 40);
    expect(count('polar', 'wire', 20)).toBeGreaterThan(count('polar', 'wire', 10));
    for (const v of surfaceVertices({ topology: 'polar', style: 'wire' }, 12)) expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-6);
    const disc = surfaceVertices({ topology: 'polar', style: 'points' }, 12);
    for (let i = 0; i < disc.length; i += 3) expect(Math.hypot(disc[i], disc[i + 1])).toBeLessThanOrEqual(1 + 1e-6);
  });
});

describe('shells of a membrane', () => {
  it('a shell that is not bent is the membrane itself, larger: its points, its height along its normal', () => {
    for (const [x, y] of [[0, 0], [0.3, -0.5], [-0.8, 0.1], [0, 1]]) {
      const p = point(shellPoint(x, y, 0.07, 1.4, 0, 1));
      expect(distance(p, [1.4 * x, 1.4 * y, 0.07])).toBeLessThan(2e-3);
    }
    // The other side of the membrane is its mirror image.
    const above = point(shellPoint(0.3, -0.5, 0.07, 1.4, 0.9, 1)), below = point(shellPoint(0.3, -0.5, 0.07, 1.4, 0.9, -1));
    expect(below).toEqual([above[0], above[1], -above[2]]);
  });

  it('bends into the cap of a sphere through its rim: the rim stays in the membrane\'s plane, the pole rises off it', () => {
    for (const bend of [0.2, 0.8, Math.PI / 2]) {
      // The rim: a circle of the shell's radius, in the plane, whatever the bend.
      for (let k = 0; k < 8; k++) {
        const angle = k * Math.PI / 4, rim = point(shellPoint(Math.cos(angle), Math.sin(angle), 0, 1.3, bend, 1));
        expect(Math.hypot(rim[0], rim[1])).toBeCloseTo(1.3, 6); expect(rim[2]).toBeCloseTo(0, 6);
      }
      expect(point(shellPoint(0, 0, 0, 1.3, bend, 1))).toEqual([0, 0, expect.closeTo(1.3 * Math.tan(bend / 2), 6)]);
      // Every point lies on one sphere; a height moves it along the radius of that sphere, by that much.
      const centre = [0, 0, -1.3 * Math.cos(bend) / Math.sin(bend)], radius = 1.3 / Math.sin(bend);
      for (const [x, y] of [[0.2, 0.1], [-0.6, 0.5], [0.1, -0.9]]) {
        expect(distance(point(shellPoint(x, y, 0, 1.3, bend, 1)), centre)).toBeCloseTo(radius, 6);
        expect(distance(point(shellPoint(x, y, 0.1, 1.3, bend, 1)), centre)).toBeCloseTo(radius + 0.1, 6);
      }
    }
    // Fully closed, the oldest shell is a hemisphere round the membrane's centre.
    expect(distance(point(shellPoint(0.4, 0.3, 0, 2, Math.PI / 2, 1)), [0, 0, 0])).toBeCloseTo(2, 6);
  });

  it('older shells are larger and more bent, so they nest; their ages run from the membrane\'s present to the span', () => {
    const shape = { spread: 0.6, bend: 1.1, reach: 1 };
    let pole = 0, age = 0;
    for (let k = 1; k <= 4; k++) {
      const share = k / 4, top = shellPoint(0, 0, 0, shellRadius(shape, share), shellBend(shape, share), 1)[2];
      expect(top).toBeGreaterThan(pole); expect(shellAge(k, 4, 1.4)).toBeGreaterThan(age);
      pole = top; age = shellAge(k, 4, 1.4);
    }
    expect(shellAge(0, 4, 1.4)).toBe(0); expect(shellAge(4, 4, 1.4)).toBeCloseTo(1.4, 9); expect(shellAge(0, 0, 1.4)).toBe(0);
    expect(shellRadius(shape, 0)).toBe(1); expect(shellBend(shape, 1)).toBeCloseTo(1.1, 9);
    // The first shells follow the membrane closely.
    expect(shellAge(1, 4, 1.4)).toBeLessThan(0.2);
    // Each vertex says which layer it belongs to.
    const vertices = surfaceVertices({ topology: 'polar', style: 'wire' }, 12, 3);
    for (let i = 2; i < vertices.length; i += 3) expect(vertices[i]).toBe(3);
  });

  it('remembers the modes on the audio clock: the same past at any frame rate, flat before anything was heard', () => {
    const modesAt = (t: number, out = new Float32Array(MODES)) => { for (let i = 0; i < MODES; i++) out[i] = Math.sin((0.7 + 0.4 * i) * t) * 0.3; return out; };
    const past = (fps: number, delay: number) => {
      const memory = new ModalMemory(1.4), live = new Float32Array(MODES), out = new Float32Array(MODES);
      let t = 5;
      for (let i = 0; i < 4 * fps; i++) { t += 1 / fps; memory.record(t, modesAt(t, live)); }
      memory.read(delay, out);
      return { out, t };
    };
    for (const delay of [0, 0.011, 0.11, 0.53, 1.4]) {
      const reference = past(60, delay), truth = modesAt(reference.t - delay);
      for (const fps of [30, 60, 144]) {
        const { out, t } = past(fps, delay);
        expect(t).toBeCloseTo(reference.t, 6);
        // Linear interpolation between ticks a thirtieth of a second apart, of modes that turn at up to 5 rad/s.
        for (let i = 0; i < MODES; i++) expect(Math.abs(out[i] - truth[i]), `${fps} fps, ${delay} s, mode ${i}`).toBeLessThan(0.004);
      }
    }
    // Nothing older than the span is kept: a longer delay reads the oldest state there is.
    const a = past(60, 1.4).out, b = past(60, 9).out;
    expect(Array.from(b)).toEqual(Array.from(a));
    // What sounded before the memory began was a flat membrane.
    const memory = new ModalMemory(1.4), out = new Float32Array(MODES).fill(9);
    memory.read(0.5, out);
    expect(Array.from(out)).toEqual(new Array(MODES).fill(0));
    memory.record(3, modesAt(3)); memory.record(3 + 1 / 60, modesAt(3 + 1 / 60));
    memory.read(0.5, out);
    expect(Array.from(out)).toEqual(new Array(MODES).fill(0));
    memory.read(0, out);
    expect(Array.from(out)).toEqual(Array.from(modesAt(3 + 1 / 60)));
  });

  it('keeps a bounded memory through stalls, a hesitating clock, a new session and broken input', () => {
    const memory = new ModalMemory(1), out = new Float32Array(MODES), ring = new Float32Array(MODES).fill(0.5);
    memory.record(10, ring); memory.record(10.5, ring);
    // A long stall: everything the memory can hold now happened during it.
    memory.record(100, ring);
    memory.read(1, out);
    expect(out[0]).toBeCloseTo(0.5, 6);
    // A clock that hesitates changes nothing.
    memory.record(99.99, new Float32Array(MODES).fill(-1));
    memory.read(0, out);
    expect(out[0]).toBe(0.5);
    // A clock that starts again is another session: its past is flat.
    memory.record(2, ring);
    memory.read(0.5, out);
    expect(out[0]).toBe(0);
    memory.read(0, out);
    expect(out[0]).toBe(0.5);
    // Broken input never reaches the shells.
    memory.record(2.1, [NaN, Infinity, ...new Array(MODES - 2).fill(0.2)]); memory.record(NaN, ring);
    for (const delay of [0, 0.05, 0.5]) { memory.read(delay, out); for (const value of out) expect(Number.isFinite(value)).toBe(true); }
    expect(MEMORY_RATE).toBeGreaterThanOrEqual(30);
  });
});

