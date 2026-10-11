import type { SolidKind } from './SolidTypes';

/*
 * Reference topology of the first solids: where the vertices of a figure are
 * on the unit sphere, which pairs are its edges, which extra pairs the
 * simulation needs (braces), how its faces are triangulated and which closed
 * sets of triangles are its volumetric cells.
 *
 *   tetrahedron   4 vertices   6 edges   4 faces   1 cell  (itself)
 *   cube          8 vertices  12 edges   6 faces   5 cells (four corner tetrahedra and the one between them);
 *                 6 braces: one diagonal per face, the edges of the central cell
 *   icosahedron  12 vertices  30 edges  20 faces   1 cell  (its shell: a convex triangulated surface is rigid,
 *                 so it needs no interior)
 *
 * These are initial conditions, not animations: once seeded, a body is only
 * what the structural physics makes of its links and cells. A cell is defined
 * the same way for all of them (a closed, outward-oriented triangle set), so
 * one law conserves the volume of a tetrahedron and of a whole shell.
 */

export interface SolidMesh {
  kind: SolidKind;
  /** Vertices on the unit sphere (stride 3). */
  vertices: Float64Array;
  /** Geometric edges of the figure: pairs of vertices. */
  edges: Uint8Array;
  /** Internal links of the simulation: pairs of vertices. Never edges of the figure. */
  braces: Uint8Array;
  /** Corners of one geometric face, and the faces' corners in order (outward, counter-clockwise). */
  faceSize: number;
  faces: Uint8Array;
  /** Surface triangles (outward, stride 3) and the geometric face each is part of. */
  triangles: Uint8Array;
  triangleFace: Uint8Array;
  /** Volumetric cells: each a closed, outward-oriented set of triangles (stride 3). */
  cells: Uint8Array[];
}

/** What a verification of a triangle set as the boundary of a volume found. */
export interface ShellCheck {
  /** Every edge is shared by exactly two triangles. */
  closed: boolean;
  /** Every edge is walked once in each direction: one consistent side is the outside. */
  oriented: boolean;
  /** The triangles are one piece. */
  connected: boolean;
  /** Signed volume enclosed (positive: the orientation is outward). */
  volume: number;
  /** Closed, oriented, connected, and enclosing a volume that is neither flat nor inside out. */
  valid: boolean;
}

export const createShellCheck = (): ShellCheck => ({ closed: false, oriented: false, connected: false, volume: 0, valid: false });

/** A cell is degenerate below this share of the cube of its mean edge (a regular tetrahedron has 0.118). */
export const DEGENERATE = 1e-3;

/** Signed volume enclosed by an oriented triangle set (positive when the triangles face outward). */
export function shellVolume(triangles: ArrayLike<number>, positions: ArrayLike<number>): number {
  if (triangles.length < 3) return 0;
  // Relative to one of its own vertices: a closed surface encloses the same volume about any point, and this one loses no digits.
  const o = triangles[0] * 3, ox = positions[o], oy = positions[o + 1], oz = positions[o + 2];
  let volume = 0;
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = triangles[t] * 3, b = triangles[t + 1] * 3, c = triangles[t + 2] * 3;
    const ax = positions[a] - ox, ay = positions[a + 1] - oy, az = positions[a + 2] - oz;
    const bx = positions[b] - ox, by = positions[b + 1] - oy, bz = positions[b + 2] - oz;
    const cx = positions[c] - ox, cy = positions[c + 1] - oy, cz = positions[c + 2] - oz;
    volume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return volume / 6;
}

/**
 * Verifies a set of triangles as the boundary of a volume: closure, a consistent
 * orientation, connectivity and a volume that is neither flat nor inverted. Run
 * when a cell is defined (it allocates); a cell that passed needs only its
 * volume looked at again.
 */
export function verifyShell(triangles: ArrayLike<number>, positions: ArrayLike<number>, out: ShellCheck = createShellCheck()): ShellCheck {
  const count = Math.floor(triangles.length / 3);
  out.closed = out.oriented = out.connected = out.valid = false; out.volume = 0;
  if (count < 4 || triangles.length % 3 !== 0) return out;
  // Each edge: the triangles on it and the first of them; each walk of an edge in one direction.
  const shared = new Map<number, number>(), first = new Map<number, number>(), walked = new Set<number>(), group = new Int32Array(count).map((_, t) => t);
  const find = (t: number): number => { while (group[t] !== t) t = group[t] = group[group[t]]; return t; };
  let oriented = true, length = 0;
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t * 3 + k], b = triangles[t * 3 + (k + 1) % 3];
      // A triangle with a corner twice is a line.
      if (a === b || !(a >= 0) || !(b >= 0)) return out;
      const edge = Math.min(a, b) * 65536 + Math.max(a, b), walk = a * 65536 + b;
      // An edge walked twice the same way: the two triangles on it disagree about which side is out.
      if (walked.has(walk)) oriented = false;
      walked.add(walk);
      shared.set(edge, (shared.get(edge) ?? 0) + 1);
      const other = first.get(edge);
      if (other === undefined) first.set(edge, t); else group[find(t)] = find(other);
      const dx = positions[a * 3] - positions[b * 3], dy = positions[a * 3 + 1] - positions[b * 3 + 1], dz = positions[a * 3 + 2] - positions[b * 3 + 2];
      length += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }
  let closed = true, connected = true;
  for (const triangles of shared.values()) if (triangles !== 2) closed = false;
  for (let t = 1; t < count; t++) if (find(t) !== find(0)) connected = false;
  out.closed = closed; out.oriented = closed && oriented; out.connected = connected;
  out.volume = shellVolume(triangles, positions);
  const edge = length / (count * 3);
  out.valid = out.closed && out.oriented && out.connected && Number.isFinite(out.volume) && out.volume > DEGENERATE * edge * edge * edge;
  return out;
}

/** Writes the triangle (a, b, c) so that it faces away from the point (x, y, z). */
function outward(vertices: Float64Array, a: number, b: number, c: number, x: number, y: number, z: number, out: number[]): void {
  const ax = vertices[a * 3], ay = vertices[a * 3 + 1], az = vertices[a * 3 + 2];
  const ux = vertices[b * 3] - ax, uy = vertices[b * 3 + 1] - ay, uz = vertices[b * 3 + 2] - az;
  const vx = vertices[c * 3] - ax, vy = vertices[c * 3 + 1] - ay, vz = vertices[c * 3 + 2] - az;
  const side = (uy * vz - uz * vy) * (ax - x) + (uz * vx - ux * vz) * (ay - y) + (ux * vy - uy * vx) * (az - z);
  if (side >= 0) out.push(a, b, c); else out.push(a, c, b);
}

/** The four outward triangles of the tetrahedron on these vertices. */
function tetrahedronOf(vertices: Float64Array, v: readonly [number, number, number, number]): Uint8Array {
  let x = 0, y = 0, z = 0;
  for (const i of v) { x += vertices[i * 3] / 4; y += vertices[i * 3 + 1] / 4; z += vertices[i * 3 + 2] / 4; }
  const out: number[] = [];
  for (let skip = 0; skip < 4; skip++) {
    const [a, b, c] = v.filter((_, k) => k !== skip);
    outward(vertices, a, b, c, x, y, z, out);
  }
  return Uint8Array.from(out);
}

function tetrahedron(): SolidMesh {
  const t = 1 / Math.sqrt(3);
  const vertices = Float64Array.from([t, t, t, t, -t, -t, -t, t, -t, -t, -t, t]);
  const triangles = tetrahedronOf(vertices, [0, 1, 2, 3]);
  return {
    kind: 'tetrahedron', vertices, edges: Uint8Array.from([0, 1, 0, 2, 0, 3, 1, 2, 1, 3, 2, 3]), braces: new Uint8Array(0),
    faceSize: 3, faces: triangles, triangles, triangleFace: Uint8Array.from([0, 1, 2, 3]), cells: [triangles],
  };
}

const bits = (i: number): number => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1);

function cube(): SolidMesh {
  const t = 1 / Math.sqrt(3), vertices = new Float64Array(24);
  // Vertex i has its bits as coordinates: bit 0 → x, bit 1 → y, bit 2 → z.
  for (let i = 0; i < 8; i++) for (let axis = 0; axis < 3; axis++) vertices[i * 3 + axis] = (i >> axis) & 1 ? t : -t;
  const edges: number[] = [], braces: number[] = [], faces: number[] = [], triangles: number[] = [], triangleFace: number[] = [];
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
    if (bits(i ^ j) === 1) edges.push(i, j);
    // The four vertices no edge joins to each other: their six diagonals, one per face, are the braces.
    else if (bits(i) % 2 === 0 && bits(j) % 2 === 0) braces.push(i, j);
  }
  for (let axis = 0; axis < 3; axis++) for (let side = 0; side < 2; side++) {
    const b = (axis + 1) % 3, c = (axis + 2) % 3, at = (u: number, v: number): number => (side << axis) | (u << b) | (v << c);
    const ring = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)], quad: number[] = [];
    outward(vertices, ring[0], ring[1], ring[2], 0, 0, 0, quad);
    // Round the face the same way as its first triangle.
    const q = quad[1] === ring[1] ? ring : [ring[0], ring[3], ring[2], ring[1]], face = faces.length / 4;
    faces.push(...q);
    // Split along the diagonal that is a brace: between its two vertices of even parity.
    const s = bits(q[0]) % 2 === 0 ? 0 : 1;
    triangles.push(q[s], q[s + 1], q[s + 2], q[s], q[s + 2], q[(s + 3) % 4]);
    triangleFace.push(face, face);
  }
  const cells = [tetrahedronOf(vertices, [0, 3, 5, 6])];
  for (const corner of [1, 2, 4, 7]) cells.push(tetrahedronOf(vertices, [corner, corner ^ 1, corner ^ 2, corner ^ 4]));
  return {
    kind: 'cube', vertices, edges: Uint8Array.from(edges), braces: Uint8Array.from(braces), faceSize: 4, faces: Uint8Array.from(faces),
    triangles: Uint8Array.from(triangles), triangleFace: Uint8Array.from(triangleFace), cells,
  };
}

function icosahedron(): SolidMesh {
  const phi = (1 + Math.sqrt(5)) / 2, scale = 1 / Math.sqrt(1 + phi * phi), vertices = new Float64Array(36);
  let n = 0;
  // The corners of three golden rectangles at right angles.
  for (let axis = 0; axis < 3; axis++) for (const a of [-1, 1]) for (const b of [-phi, phi]) {
    vertices[n * 3 + axis] = 0; vertices[n * 3 + (axis + 1) % 3] = a * scale; vertices[n * 3 + (axis + 2) % 3] = b * scale;
    n++;
  }
  const side = 2 * scale, near = (i: number, j: number): boolean =>
    Math.abs(Math.hypot(vertices[i * 3] - vertices[j * 3], vertices[i * 3 + 1] - vertices[j * 3 + 1], vertices[i * 3 + 2] - vertices[j * 3 + 2]) - side) < 1e-6;
  const edges: number[] = [], triangles: number[] = [];
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
    if (!near(i, j)) continue;
    edges.push(i, j);
    for (let k = j + 1; k < 12; k++) if (near(i, k) && near(j, k)) outward(vertices, i, j, k, 0, 0, 0, triangles);
  }
  const faces = Uint8Array.from(triangles);
  return {
    kind: 'icosahedron', vertices, edges: Uint8Array.from(edges), braces: new Uint8Array(0), faceSize: 3, faces, triangles: faces,
    triangleFace: Uint8Array.from({ length: faces.length / 3 }, (_, t) => t), cells: [faces],
  };
}

const meshes: Partial<Record<SolidKind, SolidMesh>> = {};

/** The reference mesh of a kind of solid: built once, read-only. */
export function solidMesh(kind: SolidKind): SolidMesh {
  return meshes[kind] ??= kind === 'cube' ? cube() : kind === 'icosahedron' ? icosahedron() : tetrahedron();
}
