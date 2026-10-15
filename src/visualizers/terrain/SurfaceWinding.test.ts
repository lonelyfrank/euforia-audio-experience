import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { emergenceTemplate, emergentPoint, SHAPES, type Emergent } from '../../visual-engine/primitives/emergenceLaw';
import { createTerrain } from '../../visual-engine/primitives/terrainLaw';

describe('opaque emergence faces seen from outside', () => {
  it.each([0, 1])('mode %s: every nondegenerate face points out of its rigid piece', mode => {
    const t = { ...createTerrain(), cell: 2, rough: 0, valley: 100 };
    const mesh = emergenceTemplate();
    for (let shape = 0; shape < SHAPES.length; shape++) {
      const e: Emergent = { J: 0, R: 12, mode, shape, height: 9, width: 0.7, rise: 1, pulse: 0.04, age: -1, seed: 0.3, light: 1, turn: 0.3 };
      const vertices = Array.from({ length: mesh.position.length / 3 }, (_, n) => new Vector3(...emergentPoint(t, e, mesh.position[n * 3], mesh.position[n * 3 + 1], mesh.position[n * 3 + 2])));
      let checked = 0;
      for (let n = 0; n < mesh.faces.length; n += 3) {
        const ids = Array.from(mesh.faces.subarray(n, n + 3)), [a, b, c] = ids.map(i => vertices[i]);
        const normal = b.clone().sub(a).cross(c.clone().sub(a));
        if (normal.lengthSq() < 1e-12) continue;
        const piece = mesh.position[ids[0] * 3 + 2], center = new Vector3();
        // Bounds' centre stays inside each convex piece, including templates with duplicate corners.
        const points = vertices.slice(piece * 12, piece * 12 + 12);
        for (const axis of ['x', 'y', 'z'] as const) center[axis] = (Math.min(...points.map(p => p[axis])) + Math.max(...points.map(p => p[axis]))) / 2;
        const outward = a.clone().add(b).add(c).multiplyScalar(1 / 3).sub(center);
        expect(normal.dot(outward), `${SHAPES[shape].name}, face ${n / 3}`).toBeGreaterThan(0);
        checked++;
      }
      expect(checked).toBeGreaterThan(12);
    }
  });
});
