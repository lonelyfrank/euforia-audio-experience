/*
 * The mesh of a ground that slides over a fixed lattice (Generative Terrain, Monolith Desert, Pulse Ocean): a vertex
 * per lattice point of the mesh (x the column from the middle, z the row from the viewer), the lines of the grid, the
 * facets of its cells (two triangles each, the diagonal alternating so they do not all lean one way) and, if asked,
 * each cell's diagonal as a line of two vertices of its own (y = 1 on them: a shader may fade them on their own).
 * Built once; what a vertex is where is the law's.
 */

export interface LatticeMesh {
  /** Vertices: the lattice first (`lattice` of them), then two per diagonal. */
  position: Float32Array;
  /** Line indices: the rows' segments, the columns', then the diagonals'. */
  lines: Uint16Array | Uint32Array;
  /** Triangle indices of the facets. */
  faces: Uint16Array | Uint32Array;
  lattice: number;
}

export function latticeMesh(columns: number, rows: number, diagonals = true): LatticeMesh {
  const across = columns + 1, along = rows + 1, lattice = across * along, cells = columns * rows;
  const total = lattice + (diagonals ? cells * 2 : 0), Index = total > 65535 ? Uint32Array : Uint16Array;
  const position = new Float32Array(total * 3);
  for (let k = 0; k < along; k++) for (let i = 0; i < across; i++) position.set([i - columns / 2, 0, k], (k * across + i) * 3);
  const lines = new Index((columns * along + rows * across + (diagonals ? cells : 0)) * 2), faces = new Index(cells * 6);
  let l = 0, t = 0, extra = lattice;
  for (let k = 0; k < along; k++) for (let i = 0; i < columns; i++) { lines[l++] = k * across + i; lines[l++] = k * across + i + 1; }
  for (let k = 0; k < rows; k++) for (let i = 0; i < across; i++) { lines[l++] = k * across + i; lines[l++] = (k + 1) * across + i; }
  for (let k = 0; k < rows; k++) {
    for (let i = 0; i < columns; i++) {
      const a = k * across + i, b = a + 1, c = a + across, d = c + 1;
      const flip = (i + k) % 2 === 1, from = flip ? b : a, to = flip ? c : d;
      if (diagonals) {
        position.set([from % across - columns / 2, 1, Math.floor(from / across)], extra * 3); lines[l++] = extra++;
        position.set([to % across - columns / 2, 1, Math.floor(to / across)], extra * 3); lines[l++] = extra++;
      }
      if (flip) { faces[t++] = a; faces[t++] = c; faces[t++] = b; faces[t++] = b; faces[t++] = c; faces[t++] = d; }
      else { faces[t++] = a; faces[t++] = c; faces[t++] = d; faces[t++] = a; faces[t++] = d; faces[t++] = b; }
    }
  }
  return { position, lines, faces, lattice };
}
