import { describe, expect, it } from 'vitest';
import { WaveField } from '../waves/WaveField';
import { FIELD, FIELD_VALUES, fieldLaw, layerRadius, packFields, packWaves } from './fieldLaw';
import { flowAt, FRONT_SHIFT, frontsAt, settle, TURBULENCE_SHIFT } from './flowLaw';
import { createFields, type SpatialFields } from './SpatialFields';
import { MAX_WAVES } from '../waves/WaveField';

const pack = (set: Partial<SpatialFields>, phase = 0): Float32Array => packFields(new Float32Array(FIELD_VALUES), { ...createFields(), ...set }, phase);
const NO_WAVES = new Float32Array(MAX_WAVES * 4);
const POINTS = [[0.7, 0.2, -0.3], [-0.4, 0.9, 0.5], [0.05, -0.02, 1.1], [1.3, -0.6, 0.2]];

describe('the fields as read by what is not simulated matter', () => {
  it('flowAt is the field law\'s own flows: the same vortex, travel, surge, drift and turbulence that carry the matter', () => {
    // With every force off, the law's acceleration is drag × flow for free matter of middle affinity.
    const set = { stiffness: 0, cohesion: 0, clumping: 0, bond: 0, flatten: 0, shimmer: 0, form: 0, surge: 0.7, vortex: -1.1, advection: 0.6, drift: 0.2, turbulence: 0.8, turbulenceScale: 2.3, lateral: 0.2, drag: 3 };
    for (const detail of [false, true]) {
      const f = pack(set, 4.2);
      for (const [x, y, z] of POINTS) {
        const law = fieldLaw(x, y, z, 0.5, 0.3, 0.1, 0.5, 0.37, new Float32Array(4), -1, -1, f, NO_WAVES, NO_WAVES, detail);
        const flow = flowAt(x, y, z, f, detail);
        for (let k = 0; k < 3; k++) expect(flow[k]).toBeCloseTo(law[k] / f[FIELD.drag], 10);
      }
    }
  });

  it('nothing flows in a world at rest', () => {
    const flow = flowAt(0.6, -0.3, 0.4, pack({}), true);
    expect(Array.from(flow)).toEqual([0, 0, 0]);
  });

  it('a held point rests where the fields hold the matter of its layer: radius, shells, squash, turn and stereo centre', () => {
    const home = [0.36, 0.48, 0.64], layer = Math.hypot(...home);
    const at = (set: Partial<SpatialFields>, spread = 1) => Array.from(settle(home[0], home[1], home[2], spread, pack(set)));
    const rest = at({});
    expect(Math.hypot(...rest)).toBeCloseTo(layerRadius(layer, 1, 0), 6);
    // The world's pressure moves it out, gathering puts it on a shell.
    expect(Math.hypot(...at({ radius: 1.4 }))).toBeCloseTo(1.4 * layerRadius(layer, 1, 0), 6);
    expect(Math.hypot(...at({ gather: 1 }))).toBeCloseTo(layerRadius(layer, 1, 1), 6);
    // Rotation squashes it towards the plane without moving it sideways.
    const flat = at({ flatten: 0.9 });
    expect(Math.abs(flat[2])).toBeLessThan(0.3 * Math.abs(rest[2])); expect(flat[0]).toBeCloseTo(rest[0], 6);
    // The structure's turn carries it round the axis; the stereo centre shifts it.
    const turned = at({ turn: Math.PI / 2 / 0.15 });
    expect(turned[0]).toBeCloseTo(-rest[1], 5); expect(turned[1]).toBeCloseTo(rest[0], 5); expect(turned[2]).toBeCloseTo(rest[2], 6);
    expect(at({ lateral: 0.3 })[0]).toBeCloseTo(rest[0] + 0.3, 6);
    expect(Math.hypot(...at({}, 1.5))).toBeCloseTo(1.5 * layerRadius(layer, 1, 0), 6);
  });

  it('turbulence displaces a held point by a bounded amount that grows with it, and is still when nothing evolves', () => {
    const calm = Array.from(settle(0.5, 0.5, 0.5, 1, pack({})));
    let previous = 0;
    for (const turbulence of [0.3, 0.6, 1.2]) {
      const moved = Array.from(settle(0.5, 0.5, 0.5, 1, pack({ turbulence }, 1.7)));
      const shift = Math.hypot(moved[0] - calm[0], moved[1] - calm[1], moved[2] - calm[2]);
      expect(shift).toBeGreaterThan(previous);
      expect(shift).toBeLessThanOrEqual(turbulence * TURBULENCE_SHIFT * 0.6 * 2 * Math.sqrt(3) + 1e-9);
      previous = shift;
    }
    // The same phase is the same place: the disorder only moves while the world is active.
    expect(Array.from(settle(0.5, 0.5, 0.5, 1, pack({ turbulence: 0.6 }, 1.7)))).toEqual(Array.from(settle(0.5, 0.5, 0.5, 1, pack({ turbulence: 0.6 }, 1.7))));
  });

  it('a front pushes what it passes away from its origin, by its amplitude, and nothing else', () => {
    const waves = new WaveField(), a = new Float32Array(MAX_WAVES * 4), b = new Float32Array(MAX_WAVES * 4);
    waves.update(0, undefined);
    waves.spawn(0, 1, -1, 2, 0.2, 1);
    packWaves(a, b, waves, 0.5);
    // The front is at radius 1 now, with amplitude e^-0.5.
    const on = Array.from(frontsAt(1, 0, 0, 0.5, a, b));
    expect(on[3]).toBeCloseTo(Math.exp(-0.5), 5);
    expect(on[0]).toBeCloseTo(FRONT_SHIFT * Math.exp(-0.5), 5); expect(on[1]).toBeCloseTo(0, 9); expect(on[2]).toBeCloseTo(0, 9);
    expect(Array.from(frontsAt(0, -1, 0, 0.5, a, b))[1]).toBeLessThan(0);
    // Far behind and far ahead of the front nothing is pushed.
    expect(frontsAt(0.2, 0, 0, 0.5, a, b)[3]).toBeLessThan(1e-6);
    expect(frontsAt(2.2, 0, 0, 0.5, a, b)[3]).toBeLessThan(1e-6);
    expect(Array.from(frontsAt(1, 0, 0, 0.5, NO_WAVES, NO_WAVES))).toEqual([0, 0, 0, 0]);
    // A front of one band moves the matter of that band most.
    waves.reset(); waves.update(0, undefined); waves.spawn(0, 1, 0.9, 2, 0.2, 1); packWaves(a, b, waves, 0.5);
    expect(frontsAt(1, 0, 0, 0.9, a, b)[3]).toBeGreaterThan(2 * frontsAt(1, 0, 0, 0.1, a, b)[3]);
  });
});
