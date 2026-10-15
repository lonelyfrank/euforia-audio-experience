import { describe, expect, it } from 'vitest';
import { QUALITY_PROFILES } from '../../renderer/quality';
import preset from '../../visualizers/terrain/preset.json';
import { latticeMesh } from './lattice';
import { TerrainPrimitive, terrainQuality } from './TerrainPrimitive';
import type { TerrainParams } from './terrainMotion';

/** FNV-1a over the bits of every number. */
function fnv(arrays: ArrayLike<number>[]): string {
  let h = 0x811c9dc5;
  const view = new DataView(new ArrayBuffer(8));
  for (const a of arrays) for (let i = 0; i < a.length; i++) { view.setFloat64(0, a[i]); for (let b = 0; b < 8; b++) h = Math.imul(h ^ view.getUint8(b), 0x01000193) >>> 0; }
  return h.toString(16);
}

describe('the lattice a ground slides over', () => {
  it('Generative Terrain\'s mesh is the one it had before the lattice was shared (digests recorded on the code before the extraction)', () => {
    const recorded = { low: '2cb08fc2 18821 11346', medium: 'e1b7cc0 35269 21234', high: '8b5c2d08 54222 32623' };
    for (const q of ['low', 'medium', 'high'] as const) {
      const p = terrainQuality(preset.visual as unknown as TerrainParams, QUALITY_PROFILES[q]);
      const t = new TerrainPrimitive({ uWaveA: new Float32Array(64), uWaveB: new Float32Array(64) } as never, p);
      const [facets, edges] = t.object.children[0].children as unknown as { geometry: { attributes: { position: { array: Float32Array } }; index: { array: ArrayLike<number> } } }[];
      expect(`${fnv([facets.geometry.attributes.position.array, facets.geometry.index.array, edges.geometry.index.array])} ${t.elements} ${t.vertices}`, q).toBe(recorded[q]);
      t.dispose();
    }
  });

  it('without diagonals: the lattice and its grid only, the same facets', () => {
    const full = latticeMesh(8, 6), grid = latticeMesh(8, 6, false);
    expect(grid.position.length).toBe(9 * 7 * 3);
    expect(grid.lines.length).toBe((8 * 7 + 6 * 9) * 2);
    expect(Array.from(grid.faces)).toEqual(Array.from(full.faces));
    expect(Array.from(grid.lines)).toEqual(Array.from(full.lines.subarray(0, grid.lines.length)));
  });
});
