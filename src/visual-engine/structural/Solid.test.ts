import { describe, expect, it, vi } from 'vitest';
import { createResonanceFrame } from '../../physics/MultiscaleResonance';
import { ResonanceField } from './ResonanceField';
import { createReadout, type SolidOptions } from './SolidDynamics';
import { SolidState } from './SolidState';
import { createShellCheck, shellVolume, solidMesh, verifyShell } from './SolidTopology';
import { BRACE, BROKEN, DEFAULT_SOLID_BUDGET, EDGE, FORM, FORMS, INTACT, LOST, SOLID_KINDS, SOLID_LIMITS, type SolidBudget, type SolidKind } from './SolidTypes';
import { StructuralSystem } from './StructuralDynamics';
import { StructuralState } from './StructuralState';
import { createStillEnvironment, DEFAULT_STRUCTURE, R_MAX, V_MAX, type StructuralEnvironment } from './StructuralTypes';

/** Vertices, edges, faces, cells, braces of each reference solid, and its volume for a unit circumradius. */
const FIGURES: Record<SolidKind, { v: number; e: number; f: number; cells: number; braces: number; valence: number; volume: number }> = {
  tetrahedron: { v: 4, e: 6, f: 4, cells: 1, braces: 0, valence: 3, volume: 8 / (9 * Math.sqrt(3)) },
  cube: { v: 8, e: 12, f: 6, cells: 5, braces: 6, valence: 3, volume: 8 / (3 * Math.sqrt(3)) },
  icosahedron: { v: 12, e: 30, f: 20, cells: 1, braces: 0, valence: 5, volume: (5 / 12) * (3 + Math.sqrt(5)) * (4 / Math.sqrt(10 + 2 * Math.sqrt(5))) ** 3 },
};
const RADIUS = 0.6;
/** Coherent, harmonic, alive and calm: what lets structure form. */
const ORDERED = { coherence: 0.9, harmony: 0.7, energy: 0.7, turbulence: 0.03 };
/** The world's potential, as a spring to the radius of each element's home layer. */
const hold: StructuralEnvironment['hold'] = (x, y, z, home, out) => {
  const r = Math.max(Math.hypot(x, y, z), 1e-4), k = -3 * (r - (0.3 + 0.95 * home)) / r;
  out[0] = x * k; out[1] = y * k; out[2] = z * k;
};
const living = (): StructuralEnvironment => ({ ...createStillEnvironment(), ...ORDERED, hold });

function make(kind: SolidKind, options: SolidOptions = {}, solids: Partial<SolidBudget> = {}, capacity = 32) {
  const system = new StructuralSystem({ capacity, seed: 7, solids });
  const body = system.seedSolid(kind, RADIUS, options);
  return { system, body, solids: system.solids!, state: system.solids!.state, matter: system.state };
}
type Made = ReturnType<typeof make>;
const run = (system: StructuralSystem, env: StructuralEnvironment, seconds: number, each?: (t: number) => void): void => {
  const h = system.config.step;
  for (let k = 0; k < Math.round(seconds / h); k++) { system.step(env); each?.((k + 1) * h); }
};
/** A blow beside the body's first vertex: from outside (`at` > 1) or from within. */
const blow = (m: Made, strength: number, at = 1.4): void => {
  const p = m.matter.position, first = m.state.bodyFirst[m.body] * 3;
  m.system.strike(p[first] * at, p[first + 1] * at, p[first + 2] * at, strength, RADIUS);
};
const finiteState = (m: Made): boolean => {
  for (const array of [m.matter.position, m.matter.velocity, m.matter.stress, m.matter.energy, m.state.linkStress, m.state.linkDamage, m.state.linkStrain, m.state.linkRest, m.state.linkMemory, m.state.cellVolume, m.state.cellRest]) {
    for (let k = 0; k < array.length; k++) if (!Number.isFinite(array[k])) return false;
  }
  return true;
};
/** Every face that holds and every cell that holds lies in one piece, and the pieces are what the links say. */
function validPieces(m: Made): void {
  const s = m.state, labels = new Set<number>();
  for (let i = s.bodyFirst[m.body]; i < s.bodyFirst[m.body] + s.bodyCount[m.body]; i++) labels.add(s.component[i]);
  expect(labels.size).toBe(s.bodyPieces[m.body]);
  for (let l = 0; l < s.links; l++) if (s.linkState[l] === INTACT) expect(s.component[s.linkA[l]]).toBe(s.component[s.linkB[l]]);
  for (let f = 0; f < s.faces; f++) {
    if (!s.faceHolds[f]) continue;
    for (let k = 0; k < 3; k++) { expect(s.linkState[s.faceLinks[f * 3 + k]]).toBe(INTACT); expect(s.component[s.faceCorners[f * 3 + k]]).toBe(s.component[s.faceCorners[f * 3]]); }
  }
  for (let c = 0; c < s.cells; c++) {
    if (!s.cellHolds[c]) continue;
    expect(s.closed(c)).toBe(true);
    for (let k = 0; k < s.cellVertexCount[c]; k++) expect(s.component[s.cellVertices[s.cellVertexStart[c] + k]]).toBe(s.component[s.cellVertices[s.cellVertexStart[c]]]);
  }
}
/** A tone at one place of the axis, the macro modes swinging, or the fine bands up: what the test lets ring. */
function sound(over: { meso?: number; macro?: number; micro?: number }) {
  const frame = createResonanceFrame(), field = new ResonanceField();
  let time = 0;
  const tick = (dt: number): void => {
    time += dt;
    frame.meso.fill(0); frame.mesoLevel.fill(0); frame.macro.fill(0); frame.micro.fill(0);
    const group = Math.floor(0.36 * frame.meso.length);
    if (over.meso) { frame.mesoLevel[group] = over.meso; frame.meso[group] = over.meso * Math.sin(2 * Math.PI * 2.5 * time); }
    // A field is live through what rings in it: the macro modes never sound alone.
    if (over.macro) { frame.mesoLevel[frame.meso.length - 1] = 0.01; for (let k = 0; k < frame.macro.length; k++) frame.macro[k] = over.macro * Math.sin(2 * Math.PI * (0.3 + 0.1 * k) * time + k); }
    if (over.micro) frame.micro.fill(over.micro);
    field.update(frame);
  };
  return { field, tick };
}

describe('topology of the reference solids', () => {
  it('each has the vertices, edges, faces and cells of its figure, closed and oriented outward', { timeout: 60000 }, () => {
    for (const kind of SOLID_KINDS) {
      const mesh = solidMesh(kind), figure = FIGURES[kind], v = mesh.vertices, n = v.length / 3;
      expect([n, mesh.edges.length / 2, mesh.faces.length / mesh.faceSize, mesh.cells.length, mesh.braces.length / 2]).toEqual([figure.v, figure.e, figure.f, figure.cells, figure.braces]);
      // Euler: a closed surface without holes.
      expect(n - mesh.edges.length / 2 + mesh.faces.length / mesh.faceSize).toBe(2);
      const valence = new Array<number>(n).fill(0), lengths = new Set<string>(), pairs = new Set<number>();
      for (let k = 0; k < mesh.edges.length; k += 2) {
        const a = mesh.edges[k], b = mesh.edges[k + 1];
        valence[a]++; valence[b]++; pairs.add(Math.min(a, b) * 64 + Math.max(a, b));
        lengths.add(Math.hypot(v[a * 3] - v[b * 3], v[a * 3 + 1] - v[b * 3 + 1], v[a * 3 + 2] - v[b * 3 + 2]).toFixed(9));
      }
      // A regular figure: every vertex on the unit sphere, every edge the same length, the same number of edges at each vertex, no edge twice.
      for (let i = 0; i < n; i++) { expect(Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2])).toBeCloseTo(1, 12); expect(valence[i]).toBe(figure.valence); }
      expect(lengths.size).toBe(1); expect(pairs.size).toBe(figure.e);
      // A brace is never an edge of the figure, and the sides of every surface triangle are edges or braces.
      for (let k = 0; k < mesh.braces.length; k += 2) { const key = Math.min(mesh.braces[k], mesh.braces[k + 1]) * 64 + Math.max(mesh.braces[k], mesh.braces[k + 1]); expect(pairs.has(key)).toBe(false); pairs.add(key); }
      for (let t = 0; t < mesh.triangles.length; t += 3) {
        const [a, b, c] = [mesh.triangles[t], mesh.triangles[t + 1], mesh.triangles[t + 2]];
        for (const [i, j] of [[a, b], [b, c], [c, a]]) expect(pairs.has(Math.min(i, j) * 64 + Math.max(i, j))).toBe(true);
        // Outward: the normal of each triangle points away from the centre.
        const nx = (v[b * 3 + 1] - v[a * 3 + 1]) * (v[c * 3 + 2] - v[a * 3 + 2]) - (v[b * 3 + 2] - v[a * 3 + 2]) * (v[c * 3 + 1] - v[a * 3 + 1]);
        const ny = (v[b * 3 + 2] - v[a * 3 + 2]) * (v[c * 3] - v[a * 3]) - (v[b * 3] - v[a * 3]) * (v[c * 3 + 2] - v[a * 3 + 2]);
        const nz = (v[b * 3] - v[a * 3]) * (v[c * 3 + 1] - v[a * 3 + 1]) - (v[b * 3 + 1] - v[a * 3 + 1]) * (v[c * 3] - v[a * 3]);
        expect(nx * v[a * 3] + ny * v[a * 3 + 1] + nz * v[a * 3 + 2]).toBeGreaterThan(0);
        expect(mesh.triangleFace[t / 3]).toBeLessThan(figure.f);
      }
      expect(mesh.triangles.length / 3).toBe(figure.f * (mesh.faceSize - 2));
      // The surface is the boundary of a volume, and so is every cell; the cells fill the figure exactly.
      const surface = verifyShell(mesh.triangles, v);
      expect(surface).toMatchObject({ closed: true, oriented: true, connected: true, valid: true });
      expect(surface.volume).toBeCloseTo(figure.volume, 10);
      let filled = 0;
      for (const cell of mesh.cells) { const check = verifyShell(cell, v); expect(check.valid).toBe(true); filled += check.volume; }
      expect(filled).toBeCloseTo(figure.volume, 10);
    }
  });

  it('a set of triangles is a volume only if it is closed, oriented one way, in one piece and not flat', { timeout: 60000 }, () => {
    const mesh = solidMesh('tetrahedron'), v = mesh.vertices, whole = Array.from(mesh.triangles), check = createShellCheck();
    expect(verifyShell(whole, v, check).valid).toBe(true);
    // Open: a face is missing. Polygons side by side are not a solid.
    expect(verifyShell(whole.slice(3), v, check)).toMatchObject({ closed: false, valid: false });
    // One face turned over: closed, but with no consistent outside.
    const turned = [...whole]; [turned[1], turned[2]] = [turned[2], turned[1]];
    expect(verifyShell(turned, v, check)).toMatchObject({ closed: true, oriented: false, valid: false });
    // Inside out: closed and consistent, enclosing a negative volume.
    const inverted = whole.flatMap((_, k) => (k % 3 === 0 ? [whole[k], whole[k + 2], whole[k + 1]] : []));
    expect(verifyShell(inverted, v, check)).toMatchObject({ closed: true, oriented: true, valid: false });
    expect(check.volume).toBeCloseTo(-FIGURES.tetrahedron.volume, 12);
    // Flat: the four vertices in one plane.
    const flat = Float64Array.from(v); flat[2] = flat[5] = flat[8] = flat[11] = 0;
    expect(verifyShell(whole, flat, check)).toMatchObject({ closed: true, oriented: true, valid: false });
    // Two bodies that do not touch are not one volume; a triangle with a corner twice is not a triangle.
    const two = Float64Array.from([...v, ...Array.from(v, (x, k) => (k % 3 === 0 ? x + 5 : x))]);
    expect(verifyShell([...whole, ...whole.map((i) => i + 4)], two, check)).toMatchObject({ closed: true, connected: false, valid: false });
    expect(verifyShell([0, 0, 1, ...whole.slice(3)], v, check).valid).toBe(false);
    expect(shellVolume([], v)).toBe(0);
  });

  it('a seeded body is made of ordinary elements, held by links, faces and cells in fixed pools', { timeout: 60000 }, () => {
    for (const kind of SOLID_KINDS) {
      const m = make(kind), s = m.state, figure = FIGURES[kind], r = m.solids.read(m.body, null, createReadout());
      expect(m.matter.count).toBe(figure.v);
      expect(r).toMatchObject({ kind, vertices: figure.v, edges: figure.e, edgesIntact: figure.e, braces: figure.braces, bracesIntact: figure.braces, faces: figure.f, facesHolding: figure.f,
        cells: figure.cells, cellsHolding: figure.cells, broken: 0, lost: 0, pieces: 1, form: 'volume', sealed: true, integrity: 1 });
      expect(r.volume).toBeCloseTo(figure.volume * RADIUS ** 3, 6); expect(r.volumeReference).toBe(r.volume); expect(r.volumeRest).toBe(r.volume);
      // Elements with an identity of their own (no two alike), each a vertex of this body holding its links.
      const pitches = new Set<number>(), masses = new Set<number>();
      for (let i = 0; i < m.matter.count; i++) {
        pitches.add(m.matter.f0[i]); masses.add(m.matter.mass[i]);
        expect(m.matter.body[i]).toBe(m.body); expect(m.matter.links[i]).toBeGreaterThanOrEqual(figure.valence); expect(s.component[i]).toBe(0);
      }
      expect(pitches.size).toBe(figure.v); expect(masses.size).toBe(figure.v); expect(r.mass).toBeCloseTo([...masses].reduce((a, b) => a + b, 0), 5);
      let edges = 0, braces = 0;
      for (let l = 0; l < s.links; l++) { expect(s.linkState[l]).toBe(INTACT); expect(s.linkRest[l]).toBe(s.linkRest0[l]); if (s.linkKind[l] === EDGE) edges++; else if (s.linkKind[l] === BRACE) braces++; }
      expect([edges, braces, s.faces, s.cells]).toEqual([figure.e, figure.braces, figure.f * (solidMesh(kind).faceSize - 2), figure.cells]);
      validPieces(m);
    }
    // Its vertices take no wire and are nobody's partner: ten seconds of an ordered world make no bond among them or with free matter.
    const m = make('cube', {}, {}, 96), env = living();
    m.system.addPopulation(60, { id: 9, centre: 0.38, spread: 0.05 }, 0.3, 1.1);
    run(m.system, env, 10);
    for (let b = 0; b < m.matter.bondCapacity; b++) if (m.matter.bondAlive[b]) { expect(m.matter.body[m.matter.bondA[b]]).toBe(-1); expect(m.matter.body[m.matter.bondB[b]]).toBe(-1); }
    expect(m.system.stats.formed).toBeGreaterThan(0); expect(m.state.bodySealed[m.body]).toBe(1);
  });

  it('pools are a budget: what does not fit is refused and counted, and nothing grows', { timeout: 60000 }, () => {
    const m = make('tetrahedron', {}, { bodies: 2, links: 24, faces: 16, cells: 6 }, 16), s = m.state;
    const sizes = [s.linkA.length, s.faceCorners.length, s.cellRest.length, s.cellVertices.length, m.matter.position.length];
    // Room for a cube (8 elements, 18 links, 12 triangles, 5 cells) beside the tetrahedron; none for anything after it.
    expect(m.system.seedSolid('cube', 0.3)).toBe(1);
    expect(m.system.seedSolid('tetrahedron', 0.3)).toBe(-1);
    expect(m.solids.stats).toMatchObject({ bodies: 2, refused: 1, intact: 24 });
    for (const [kind, budget, capacity] of [['icosahedron', { links: 20 }, 32], ['icosahedron', { faces: 12 }, 32], ['cube', { cells: 4 }, 32], ['icosahedron', {}, 11]] as const) {
      const small = new StructuralSystem({ capacity, seed: 1, solids: budget });
      expect(small.seedSolid(kind, 0.5)).toBe(-1);
      expect([small.state.count, small.solids!.state.links, small.solids!.state.faces, small.solids!.stats.refused]).toEqual([0, 0, 0, 1]);
    }
    expect(m.system.seedSolid('cube', NaN)).toBe(-1);
    run(m.system, living(), 2);
    expect([s.linkA.length, s.faceCorners.length, s.cellRest.length, s.cellVertices.length, m.matter.position.length]).toEqual(sizes);
    // Iterations are a constant of the budget, within bounds; a system without the budget holds no bodies at all.
    expect(new StructuralSystem({ solids: { iterations: 99 } }).solids!.budget.iterations).toBe(8);
    expect(new StructuralSystem({ solids: { iterations: -3 } }).solids!.budget.iterations).toBe(1);
    expect(m.solids.budget.iterations).toBe(DEFAULT_SOLID_BUDGET.iterations);
    const plain = new StructuralSystem();
    expect(plain.solids).toBeNull(); expect(plain.seedSolid('cube', 0.5)).toBe(-1); expect(DEFAULT_STRUCTURE.solids).toBeUndefined();
    // Clearing empties the pools for reuse: the same body again, in the same slots.
    m.system.clear();
    expect([m.matter.count, s.bodies, s.links, s.faces, s.cells]).toEqual([0, 0, 0, 0, 0]);
    expect(m.system.seedSolid('icosahedron', 0.5)).toBe(-1);
    expect(m.system.seedSolid('cube', 0.5)).toBe(0); expect(s.bodySealed[0]).toBe(1);
  });

  it('a body can be built link by link, and a cell is refused until its shell is a volume', { timeout: 60000 }, () => {
    const matter = new StructuralState({ ...DEFAULT_STRUCTURE, capacity: 8 }), s = new SolidState(matter, DEFAULT_SOLID_BUDGET), population = { id: 1, centre: 0.4, spread: 0.05 };
    for (const [x, y, z] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]) matter.add(3, population, x, y, z, 0.4);
    const body = s.addBody('tetrahedron', 0, 4, 4), link = (i: number, j: number) => s.addLink(body, i, j, EDGE, 1 / 100, 0.2, 1, 0.5, true);
    const shell = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
    // Not enough links for a face; not a face of this body; the same link twice.
    expect(link(0, 1)).toBe(0); expect(link(1, 2)).toBe(1); expect(link(0, 1)).toBe(-1); expect(link(1, 1)).toBe(-1); expect(link(1, 7)).toBe(-1);
    expect(s.addFace(body, 0, 2, 1, 0)).toBe(-1);
    expect(link(2, 0)).toBe(2);
    expect(s.addFace(body, 0, 2, 1, 0)).toBe(0);
    s.book();
    // Three links and their face: a surface, not a solid.
    expect(FORMS[s.bodyForm[body]]).toBe('surface'); expect(s.bodyPieces[body]).toBe(2);
    expect(s.addCell(body, shell)).toBe(-1);
    for (const [i, j] of [[0, 3], [1, 3], [2, 3]]) link(i, j);
    // Every link is there now, but three faces are an open shell and a face turned over has no outside.
    expect(s.addCell(body, shell.slice(0, 9))).toBe(-1);
    expect(s.addCell(body, [0, 1, 2, ...shell.slice(3)])).toBe(-1);
    for (const [i, j, k, g] of [[0, 1, 3, 1], [0, 3, 2, 2], [1, 2, 3, 3]]) expect(s.addFace(body, i, j, k, g)).toBeGreaterThan(0);
    s.book();
    // A closed surface is a shell; it is a volume once a cell has been verified on it.
    expect(FORMS[s.bodyForm[body]]).toBe('shell');
    const cell = s.addCell(body, shell);
    expect(cell).toBe(0); expect(s.cellRest0[cell]).toBeCloseTo(1 / 6, 12); expect(s.cellVertexCount[cell]).toBe(4); expect(s.cellLinkCount[cell]).toBe(6);
    s.book();
    expect(FORMS[s.bodyForm[body]]).toBe('shell'); expect(s.bodySealed[body]).toBe(0);
    s.cellHolds[cell] = 1; s.book();
    expect(FORMS[s.bodyForm[body]]).toBe('volume'); expect(s.bodySealed[body]).toBe(1); expect(s.bodyPieces[body]).toBe(1);
    // A tetrahedron has no hinge (its far corners are already linked); the surface of a cube has one across each face.
    expect(s.addHinges(body)).toBe(0);
    expect(Array.from(make('cube').state.hingeA.subarray(0, 18)).filter((e) => e >= 0)).toHaveLength(6);
    expect(Array.from(make('icosahedron').state.hingeA.subarray(0, 30)).filter((e) => e >= 0)).toHaveLength(30);
  });
});

describe('volume', () => {
  it('a compressed body pushes back to its volume, and gives up less of it the stiffer its cells', { timeout: 60000 }, () => {
    for (const kind of SOLID_KINDS) {
      const m = make(kind), p = m.matter.position, c = Array.from(m.solids.centroid(m.body)), env = createStillEnvironment(), r = createReadout();
      // Squeezed towards its centre by hand (a test condition, not a tool): it stores energy and comes back.
      for (let i = 0; i < m.matter.count; i++) for (let k = 0; k < 3; k++) p[i * 3 + k] = c[k] + (p[i * 3 + k] - c[k]) * 0.94;
      m.system.step(env);
      m.solids.read(m.body, env, r);
      expect(r.volume / r.volumeReference).toBeLessThan(0.9); expect(r.elastic).toBeGreaterThan(0.05);
      run(m.system, env, 4);
      m.solids.read(m.body, env, r);
      expect(r.volume / r.volumeReference).toBeGreaterThan(0.995); expect(r.volume / r.volumeReference).toBeLessThan(1.005);
      expect(r.sealed).toBe(true); expect(m.solids.stats.fractures).toBe(0); expect(r.kinetic + r.elastic).toBeLessThan(1e-4);
    }
    const least = (compliance: number): number => {
      const m = make('tetrahedron'), env = createStillEnvironment(), r = createReadout();
      m.solids.tuning.volumeCompliance = compliance;
      blow(m, 5);
      let volume = 1;
      run(m.system, env, 2, () => { m.solids.read(m.body, env, r); volume = Math.min(volume, r.volume / r.volumeReference); });
      expect(m.solids.stats.fractures).toBe(0);
      return volume;
    };
    const stiff = least(SOLID_LIMITS.volumeCompliance[0]), normal = least(1), soft = least(SOLID_LIMITS.volumeCompliance[1]);
    expect(stiff).toBeGreaterThan(normal); expect(normal).toBeGreaterThan(soft);
    // Approximately conserved within the product's compliance, not rigidly; an override outside its bounds is held to them.
    expect(normal).toBeGreaterThan(0.9); expect(normal).toBeLessThan(0.99); expect(stiff).toBeGreaterThan(0.95); expect(soft).toBeGreaterThan(0.7);
    expect(least(1e9)).toBe(soft); expect(least(NaN)).toBe(normal);
  });

  it('an inverted cell is turned back the right way out, and a crushed body stays a finite set of pieces', { timeout: 60000 }, () => {
    const m = make('tetrahedron'), p = m.matter.position, env = createStillEnvironment(), r = createReadout();
    // Strong enough not to break while it is turned: this is about the cell, not about fracture.
    Object.assign(m.system.tuning, { bondStrength: 3, fractureThreshold: 3 });
    // The first vertex mirrored through the plane of the other three: every link at its length, the volume negative.
    const a = [p[3], p[4], p[5]], u = [p[6] - a[0], p[7] - a[1], p[8] - a[2]], w = [p[9] - a[0], p[10] - a[1], p[11] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], size = Math.hypot(n[0], n[1], n[2]);
    const out = ((p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1] + (p[2] - a[2]) * n[2]) / size;
    for (let k = 0; k < 3; k++) p[k] -= 2 * out * n[k] / size;
    expect(m.state.measure(0)).toBeCloseTo(-m.state.cellRest0[0], 5);
    m.system.step(env);
    expect(m.solids.stats.inverted).toBe(1);
    let turnedAt = -1;
    run(m.system, env, 6, (t) => { if (turnedAt < 0 && m.state.cellVolume[0] > 0.5 * m.state.cellRest0[0]) turnedAt = t; });
    m.solids.read(m.body, env, r);
    expect(turnedAt).toBeGreaterThan(0); expect(turnedAt).toBeLessThan(2);
    expect(r.volume / r.volumeReference).toBeGreaterThan(0.99); expect(r.volume / r.volumeReference).toBeLessThan(1.01);
    expect(m.solids.stats).toMatchObject({ inverted: 0, fractures: 0, repairs: 0 }); expect(r.strain).toBeLessThan(1e-3);

    for (const kind of SOLID_KINDS) {
      // Every vertex in one place: no direction, no volume, no gradient. Nothing divides by zero; what cannot hold breaks.
      const crushed = make(kind), q = crushed.matter.position;
      q.fill(0.1, 0, crushed.matter.count * 3);
      run(crushed.system, env, 3);
      expect(finiteState(crushed)).toBe(true); expect(crushed.solids.stats.repairs).toBe(0);
      expect(crushed.matter.count).toBe(FIGURES[kind].v); expect(crushed.solids.stats.fractures).toBeGreaterThan(0);
      validPieces(crushed);
      for (let i = 0; i < crushed.matter.count; i++) expect(Math.hypot(q[i * 3] - 0.1, q[i * 3 + 1] - 0.1, q[i * 3 + 2] - 0.1)).toBeGreaterThan(1e-3);
    }
  });
});

describe('stability', () => {
  it('a body at rest does not move at all, in silence or in a living world with no medium', { timeout: 60000 }, () => {
    for (const kind of SOLID_KINDS) for (const env of [createStillEnvironment(), { ...createStillEnvironment(), ...ORDERED }]) {
      const m = make(kind, { tilt: 0.5, turn: 0.4, x: 0.1 }), start = Array.from(m.matter.position);
      run(m.system, env, 10);
      // Bit for bit: rest lengths and volumes are measured exactly as the solver measures them.
      expect(Array.from(m.matter.position)).toEqual(start);
      expect(m.solids.stats).toMatchObject({ kinetic: 0, elastic: 0, fractures: 0, repairs: 0, inverted: 0 }); expect(m.solids.stats.stress).toBeLessThan(0.01);
    }
  });

  it('loses the energy it is given and gains none: a struck or twisted body rings down to rest and stays', { timeout: 60000 }, () => {
    const env = createStillEnvironment(), r = createReadout();
    for (const kind of SOLID_KINDS) for (const act of ['blow', 'twist'] as const) {
      const m = make(kind);
      if (act === 'blow') blow(m, 5); else m.solids.twist(m.body, 3);
      let before = Infinity, first = 0, rise = 0, deformed = 0;
      run(m.system, env, 8, () => {
        m.solids.read(m.body, env, r);
        const energy = r.kinetic + r.elastic;
        first ||= energy; rise = Math.max(rise, energy - before); before = energy; deformed = Math.max(deformed, r.response);
      });
      expect(first).toBeGreaterThan(0.5); expect(deformed).toBeGreaterThan(0.01);
      // Without a source the mechanical energy never goes up, step after step.
      expect(rise).toBeLessThanOrEqual(1e-9 * first);
      expect(before).toBeLessThan(1e-3 * first); expect(m.solids.stats.fractures).toBe(0);
      const at = Array.from(m.matter.position);
      run(m.system, env, 20);
      m.solids.read(m.body, env, r);
      expect(r.kinetic + r.elastic).toBeLessThan(1e-7 * first); expect(r.volume / r.volumeReference).toBeCloseTo(1, 4); expect(r.sealed).toBe(true);
      for (let k = 0; k < at.length; k++) expect(Math.abs(m.matter.position[k] - at[k])).toBeLessThan(1e-2);
    }
  });

  it('a torsion turns the two ends against each other and leaves the body no spin; a blow is an impulse', { timeout: 60000 }, () => {
    for (const kind of SOLID_KINDS) {
      const m = make(kind), p = m.matter.position, v = m.matter.velocity, start = Array.from(p), c = Array.from(m.solids.centroid(m.body));
      m.solids.twist(m.body, 3);
      expect(Array.from(p)).toEqual(start);
      let spin = 0, up = 0, down = 0, momentum = 0;
      for (let i = 0; i < m.matter.count; i++) {
        const x = p[i * 3] - c[0], y = p[i * 3 + 1] - c[1], turn = m.matter.mass[i] * (x * v[i * 3 + 1] - y * v[i * 3]);
        spin += turn; momentum += Math.abs(turn);
        if (p[i * 3 + 2] > c[2]) up += turn; else down += turn;
        expect(v[i * 3 + 2]).toBe(0);
      }
      expect(up).toBeGreaterThan(0); expect(down).toBeLessThan(0);
      expect(Math.abs(spin)).toBeLessThan(0.15 * momentum);
      blow(m, 2);
      expect(Array.from(p)).toEqual(start);
      // Nonsense is ignored.
      m.solids.twist(7, 3); m.solids.twist(m.body, NaN); m.solids.twist(m.body, 3, 0, 0, 0);
      expect(finiteState(m)).toBe(true);
    }
  });

  it('stays finite and bounded whatever the environment and the tools do', { timeout: 60000 }, () => {
    for (const kind of SOLID_KINDS) {
      const m = make(kind), s = m.state, sizes = [s.links, s.faces, s.cells, m.matter.count];
      let n = 0;
      const env: StructuralEnvironment = {
        ...createStillEnvironment(), coherence: NaN, harmony: Infinity, turbulence: -4, tension: 9, energy: NaN, release: Infinity, drag: -1,
        flow: (x, _y, _z, out) => { out[0] = n++ % 7 === 0 ? NaN : 40 * Math.sin(n); out[1] = Infinity; out[2] = -30 * x; },
        push: (_x, _y, _z, _a, out) => { out[0] = 1e9; out[1] = n % 5 === 0 ? NaN : -1e9; out[2] = 5; },
        hold: (_x, _y, _z, _h, out) => { out[0] = out[1] = out[2] = NaN; },
      };
      Object.assign(m.solids.tuning, { mass: -5, stiffness: 1e12, damping: NaN, volumeCompliance: 0 });
      Object.assign(m.system.tuning, { fractureThreshold: 1e6, bondStrength: 1e6, resonanceCoupling: Infinity });
      for (let k = 0; k < 2400; k++) {
        if (k % 300 === 0) { m.system.strike(Math.sin(k), 0.2, -0.1, 400); m.solids.twist(m.body, 1e6, Math.cos(k), 1, 0.3); }
        m.system.step(env);
      }
      expect(finiteState(m)).toBe(true);
      for (let i = 0; i < m.matter.count; i++) {
        expect(Math.hypot(m.matter.position[i * 3], m.matter.position[i * 3 + 1], m.matter.position[i * 3 + 2])).toBeLessThanOrEqual(R_MAX + 1e-4);
        expect(Math.hypot(m.matter.velocity[i * 3], m.matter.velocity[i * 3 + 1], m.matter.velocity[i * 3 + 2])).toBeLessThanOrEqual(V_MAX + 1e-3);
        expect(m.matter.mass[i]).toBeCloseTo(s.mass0[i] * SOLID_LIMITS.mass[0], 6);
      }
      expect([s.links, s.faces, s.cells, m.matter.count]).toEqual(sizes);
      validPieces(m);
      // A clock that jumps, stalls or is not a number steps a bounded number of times or not at all.
      const still = createStillEnvironment();
      expect(m.system.advance(NaN, still)).toBe(0); m.system.advance(10, still);
      expect(m.system.advance(10 + 600, still)).toBeLessThanOrEqual(8); expect(m.system.advance(3, still)).toBe(0);
      expect(finiteState(m)).toBe(true);
    }
  });
});

describe('time', () => {
  /** A life told step by step: what the body is after each number of steps, whatever frames they were taken in. */
  const life = (fps: number, seconds: number) => {
    const m = make('cube'), env = living(), told = new Map<number, string>();
    let steps = 0;
    m.system.advance(0, env);
    blow(m, 11, 0.5);
    for (let f = 1; f <= seconds * fps; f++) {
      steps += m.system.advance(f / fps, env);
      told.set(steps, `${Array.from(m.matter.position.subarray(0, 24)).join()}|${Array.from(m.state.linkState.subarray(0, 18)).join('')}|${m.solids.stats.fractures}/${m.solids.stats.reforms}`);
    }
    return { told, stats: m.solids.stats, alpha: m.system.alpha };
  };

  it('is deterministic: the same seed, clock and world give the same life, bit for bit, without Math.random', { timeout: 60000 }, () => {
    const random = vi.spyOn(Math, 'random');
    const a = life(60, 14), b = life(60, 14);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
    expect([...a.told]).toEqual([...b.told]);
    // A life with something in it: links broke and formed again.
    expect(a.stats.fractures).toBeGreaterThan(0); expect(a.stats.reforms).toBeGreaterThan(0);
  });

  it('lives the same life at 30, 60 and 144 frames a second: its steps are counted on the clock, not on the frames', { timeout: 60000 }, () => {
    const slow = life(30, 14), normal = life(60, 14), fast = life(144, 14);
    let shared = 0;
    for (const [steps, state] of normal.told) {
      const a = slow.told.get(steps), b = fast.told.get(steps);
      if (a !== undefined) expect(a).toBe(state);
      if (b !== undefined) expect(b).toBe(state);
      if (a !== undefined && b !== undefined) shared++;
    }
    expect(shared).toBeGreaterThan(200);
    // What is presented between two steps is carried by less than a step.
    for (const run of [slow, normal, fast]) { expect(run.alpha).toBeGreaterThanOrEqual(0); expect(run.alpha).toBeLessThan(1 / 120 + 1e-9); }
  });
});

describe('fracture', () => {
  it('changes the topology, not the matter: one broken edge opens a face and a cell and makes no fragment', { timeout: 60000 }, () => {
    for (const kind of SOLID_KINDS) {
      const m = make(kind), s = m.state, figure = FIGURES[kind], r = createReadout();
      expect(m.solids.sever(0)).toBe(true); expect(m.solids.sever(0)).toBe(false); expect(m.solids.sever(999)).toBe(false);
      s.book();
      m.solids.read(m.body, null, r);
      expect(r).toMatchObject({ pieces: 1, sealed: false, broken: 1, lost: 0, edgesIntact: figure.e - 1, vertices: figure.v });
      // Both triangles on that edge are gone, and with them the cell they bounded; the other cells of a cube still hold.
      expect(s.faces - Array.from(s.faceHolds.subarray(0, s.faces)).reduce((a, b) => a + b, 0)).toBe(2);
      expect(r.cellsHolding).toBe(kind === 'cube' ? 4 : 0); expect(r.form).toBe(kind === 'cube' ? 'volume' : 'surface');
      expect(r.integrity).toBeCloseTo(1 - 1 / (figure.e + figure.braces), 6);
      validPieces(m);
    }
  });

  it('pieces are read off the links: a free vertex, a chain, a ring, a surface, each made of the elements it had', { timeout: 60000 }, () => {
    const tetra = make('tetrahedron'), t = tetra.state, between = (m: Made, i: number, j: number) => m.state.linkOf(m.body, i, j);
    // All the links of one vertex: it comes off alone, and a triangle with its face is left.
    for (const j of [1, 2, 3]) tetra.solids.sever(between(tetra, 0, j));
    t.book();
    expect([t.bodyPieces[0], FORMS[t.form[0]], FORMS[t.form[1]], FORMS[t.bodyForm[0]]]).toEqual([2, 'free', 'surface', 'surface']);
    expect([t.component[0], t.component[1], t.component[2], t.component[3]]).toEqual([0, 1, 1, 1]); expect(t.fragments).toBe(2);
    validPieces(tetra);
    // Two opposite edges left: two chains.
    const pair = make('tetrahedron'), p = pair.state;
    for (const [i, j] of [[0, 2], [0, 3], [1, 2], [1, 3]]) pair.solids.sever(between(pair, i, j));
    p.book();
    expect([p.bodyPieces[0], FORMS[p.form[0]], FORMS[p.form[2]], p.component[1], p.component[3]]).toEqual([2, 'chain', 'chain', 0, 2]);
    // A face of the cube cut loose from the rest and from its own diagonal: four edges in a ring, no face.
    const cube = make('cube'), c = cube.state, top = [4, 5, 6, 7];
    for (let l = 0; l < c.links; l++) {
      const inA = top.includes(c.linkA[l]), inB = top.includes(c.linkB[l]);
      if (inA !== inB || inA && inB && c.linkKind[l] === BRACE) cube.solids.sever(l);
    }
    c.book();
    expect(FORMS[c.form[4]]).toBe('polygon'); expect(c.bodyPieces[0]).toBe(2); expect(new Set(top.map((i) => c.component[i])).size).toBe(1);
    expect(FORMS[c.form[0]]).toBe('surface');
    validPieces(cube);
    // Nothing was added or removed, and the pools did not move.
    expect([tetra.matter.count, pair.matter.count, cube.matter.count, c.links]).toEqual([4, 4, 8, 18]);
  });

  it('a blow from within breaks links by their load: the pieces keep their place, their motion and their identity', { timeout: 60000 }, () => {
    for (const kind of SOLID_KINDS) {
      const m = make(kind), s = m.state, env = createStillEnvironment(), identity = [m.matter.f0, m.matter.q, m.matter.coupling, m.matter.resistance, m.matter.phase, s.mass0].map((a) => Array.from(a));
      blow(m, 11, 0.5);
      let brokeAt = -1, jump = 0, slowed = 0, speed = 0;
      const before = m.matter.position.slice(0, m.matter.count * 3), moving = m.matter.velocity.slice(0, m.matter.count * 3);
      run(m.system, env, 2, (t) => {
        if (brokeAt < 0 && m.solids.stats.fractures > 0) {
          brokeAt = t;
          // The step in which links gave way moved nothing further than its own velocity takes it, and stopped nothing.
          for (let i = 0; i < m.matter.count; i++) {
            const d = Math.hypot(m.matter.position[i * 3] - before[i * 3], m.matter.position[i * 3 + 1] - before[i * 3 + 1], m.matter.position[i * 3 + 2] - before[i * 3 + 2]);
            const was = Math.hypot(moving[i * 3], moving[i * 3 + 1], moving[i * 3 + 2]), is = Math.hypot(m.matter.velocity[i * 3], m.matter.velocity[i * 3 + 1], m.matter.velocity[i * 3 + 2]);
            jump = Math.max(jump, d); speed = Math.max(speed, is); slowed = Math.max(slowed, was - is);
          }
        }
        before.set(m.matter.position.subarray(0, before.length)); moving.set(m.matter.velocity.subarray(0, moving.length));
      });
      expect(brokeAt).toBeGreaterThan(0); expect(brokeAt).toBeLessThan(0.5);
      expect(jump).toBeLessThanOrEqual(V_MAX / 120 + 1e-6); expect(speed).toBeGreaterThan(1); expect(slowed).toBeLessThan(0.5 * speed);
      const r = m.solids.read(m.body, env, createReadout());
      expect(r.pieces).toBeGreaterThan(1); expect(r.broken).toBeGreaterThan(0); expect(r.sealed).toBe(false); expect(r.vertices).toBe(FIGURES[kind].v);
      expect(m.matter.count).toBe(FIGURES[kind].v);
      expect([m.matter.f0, m.matter.q, m.matter.coupling, m.matter.resistance, m.matter.phase, s.mass0].map((a) => Array.from(a))).toEqual(identity);
      // The ends of what broke are fragments for a while (a shock, their cohesion spent), and remember each other.
      let marked = 0;
      for (let l = 0; l < s.links; l++) if (s.linkState[l] === BROKEN) { marked++; expect(s.linkMemory[l]).toBeGreaterThan(0.6); expect(m.matter.shock[s.linkA[l]]).toBeGreaterThan(0.3); expect(m.matter.cohesion[s.linkA[l]]).toBeLessThan(1); }
      expect(marked).toBe(m.solids.stats.fractures);
      validPieces(m);
      expect(finiteState(m)).toBe(true);
    }
  });

  it('follows the strength of the material: the same blow breaks a weak body and not a strong one', { timeout: 60000 }, () => {
    const broken = (threshold: number, strength: number): number => {
      const m = make('cube');
      m.system.tuning.fractureThreshold = threshold;
      blow(m, strength, 0.5);
      run(m.system, createStillEnvironment(), 2);
      return m.solids.stats.fractures;
    };
    expect(broken(1, 5)).toBe(0); expect(broken(0.3, 5)).toBeGreaterThan(0);
    expect(broken(1, 11)).toBeGreaterThan(0); expect(broken(3, 11)).toBe(0);
  });
});

describe('recomposition', () => {
  it('the pieces of a broken body find each other again in a living, ordered world, one link at a time', { timeout: 120000 }, () => {
    for (const kind of ['tetrahedron', 'cube'] as const) {
      const m = make(kind), s = m.state, env = living(), r = createReadout();
      blow(m, 11, 0.5);
      run(m.system, env, 1.5);
      m.solids.read(m.body, env, r);
      const broke = m.solids.stats.fractures;
      expect(r.pieces).toBe(2); expect(broke).toBeGreaterThanOrEqual(3);
      let intact = m.solids.stats.intact, most = 0, scarred = false, uprightAlways = true;
      run(m.system, env, 40, () => {
        const now = m.solids.stats.intact;
        if (now > intact) {
          most = Math.max(most, now - intact);
          // What forms again is not new: it carries what the break left in it, and starts at the length it was found at.
          for (let l = 0; l < s.links; l++) if (s.linkState[l] === INTACT && s.linkAge[l] < 0.02 && s.linkDamage[l] >= 0.24) scarred = true;
          // … and only with the cells it bounds the right way out.
          for (let c = 0; c < s.cells; c++) if (s.closed(c) && !(s.measure(c) > 0.25 * s.cellRest0[c])) uprightAlways = false;
        }
        intact = now;
      });
      m.solids.read(m.body, env, r);
      expect(r).toMatchObject({ pieces: 1, sealed: true, broken: 0, lost: 0, form: 'volume', cellsHolding: FIGURES[kind].cells });
      expect(m.solids.stats.reforms).toBe(broke); expect(scarred).toBe(true); expect(uprightAlways).toBe(true);
      // Step by step: each link costs its two ends part of what they had settled.
      expect(most).toBeLessThanOrEqual(2);
      expect(r.volume / r.volumeReference).toBeGreaterThan(0.98); expect(r.volume / r.volumeReference).toBeLessThan(1.02);
      for (let l = 0; l < s.links; l++) expect(s.linkRest[l] / s.linkRest0[l]).toBeCloseTo(1, 2);
      expect(m.matter.count).toBe(FIGURES[kind].v);
      validPieces(m);
    }
  });

  it('not in silence, not in a hot or incoherent world, not across a gap: only when physics allows', { timeout: 120000 }, () => {
    const apart = (over: Partial<StructuralEnvironment>, tuning: Partial<StructuralSystem['tuning']> = {}, shift = 0): Made => {
      const m = make('tetrahedron');
      for (const j of [1, 2, 3]) m.solids.sever(m.state.linkOf(m.body, 0, j));
      Object.assign(m.system.tuning, tuning);
      // The free vertex set down further out along its own direction.
      for (let k = 0; k < 3; k++) m.matter.position[k] *= 1 + shift;
      run(m.system, { ...createStillEnvironment(), ...over }, 25);
      return m;
    };
    // Where it was, in an ordered living world: it forms again (the control).
    expect(apart(ORDERED).state.bodySealed[0]).toBe(1);
    // Silence forms nothing, and pulls nothing: the vertex stays exactly where it was left.
    const silent = apart({ coherence: 0.9, harmony: 0.7 }, {}, 0.5), left = RADIUS * 1.5;
    expect(silent.solids.stats.reforms).toBe(0); expect(Math.hypot(silent.matter.position[0], silent.matter.position[1], silent.matter.position[2])).toBeCloseTo(left, 5);
    // A hot world, an incoherent one: the ends never settle.
    expect(apart(ORDERED, { temperature: 0.9 }).solids.stats.reforms).toBe(0);
    expect(apart({ ...ORDERED, coherence: 0.05 }).solids.stats.reforms).toBe(0);
    expect(apart(ORDERED, { coherence: 0.05 }).solids.stats.reforms).toBe(0);
    // Further off than its memory reaches, with nothing else to bring it back: no link across the gap.
    const far = apart(ORDERED, {}, 9);
    expect(far.solids.stats.reforms).toBe(0); expect(far.state.bodyPieces[0]).toBe(2);
    // Near, but passing: ends moving against each other faster than a link can take do not join while they do.
    const passing = make('tetrahedron');
    for (const j of [1, 2, 3]) passing.solids.sever(passing.state.linkOf(passing.body, 0, j));
    const moved = { ...createStillEnvironment(), ...ORDERED, drag: 0.2 };
    let joinedFast = false;
    for (let k = 0; k < 1200; k++) {
      // Kept in motion by hand: a test condition.
      passing.matter.velocity[0] = 1.2; passing.matter.cohesion[0] = 1.5;
      const had = passing.solids.stats.reforms;
      passing.system.step(moved);
      if (passing.solids.stats.reforms > had) joinedFast = true;
    }
    expect(joinedFast).toBe(false);
  });

  it('a tumbled piece is turned the right way out before it is taken back: lengths alone are not enough', { timeout: 120000 }, () => {
    const m = make('tetrahedron'), s = m.state, p = m.matter.position, env = living();
    for (const j of [1, 2, 3]) m.solids.sever(s.linkOf(m.body, 0, j));
    // The free vertex at its mirror image: at every remembered length from the others, and inside out.
    const a = [p[3], p[4], p[5]], u = [p[6] - a[0], p[7] - a[1], p[8] - a[2]], w = [p[9] - a[0], p[10] - a[1], p[11] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], size = Math.hypot(n[0], n[1], n[2]);
    const out = ((p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1] + (p[2] - a[2]) * n[2]) / size;
    for (let k = 0; k < 3; k++) p[k] -= 2 * out * n[k] / size;
    for (const j of [1, 2, 3]) expect(Math.hypot(p[0] - p[j * 3], p[1] - p[j * 3 + 1], p[2] - p[j * 3 + 2]) / s.linkRest0[s.linkOf(m.body, 0, j)]).toBeCloseTo(1, 4);
    expect(s.measure(0)).toBeLessThan(0);
    let wrong = false, firstAt = -1;
    run(m.system, env, 40, (t) => {
      if (m.solids.stats.reforms > 0 && firstAt < 0) { firstAt = t; if (!(s.measure(0) > 0.25 * s.cellRest0[0])) wrong = true; }
    });
    expect(firstAt).toBeGreaterThan(1); expect(wrong).toBe(false);
    expect(s.bodySealed[0]).toBe(1); expect(s.cellVolume[0] / s.cellRest0[0]).toBeGreaterThan(0.98);
  });

  it('memory fades: what is forgotten does not form again', { timeout: 120000 }, () => {
    const m = make('tetrahedron'), s = m.state, env = living(), r = createReadout();
    for (const j of [1, 2, 3]) m.solids.sever(s.linkOf(m.body, 0, j));
    // A hot world: the ends never settle, and forget fast.
    m.system.tuning.temperature = 1;
    let lostAt = -1;
    run(m.system, env, 60, (t) => { if (lostAt < 0 && m.solids.stats.lost === 3) lostAt = t; });
    expect(lostAt).toBeGreaterThan(20); expect(lostAt).toBeLessThan(50);
    expect(m.solids.stats).toMatchObject({ reforms: 0, broken: 0, lost: 3 });
    // The world turns ordered again: nothing is left to remember, the vertex stays a free element of the same matter.
    m.system.tuning.temperature = null;
    run(m.system, env, 20);
    m.solids.read(m.body, env, r);
    expect(r).toMatchObject({ pieces: 2, lost: 3, broken: 0, cellsHolding: 0, sealed: false }); expect(m.solids.stats.reforms).toBe(0);
    for (const j of [1, 2, 3]) expect(s.linkState[s.linkOf(m.body, 0, j)]).toBe(LOST);
    expect(m.matter.count).toBe(4); expect(FORMS[s.form[0]]).toBe('free');
    // Cold, the same memory lasts: after the same minute most of it is still there.
    const cold = make('tetrahedron');
    for (const j of [1, 2, 3]) cold.solids.sever(cold.state.linkOf(cold.body, 0, j));
    for (let k = 0; k < 3; k++) cold.matter.position[k] *= 5;
    run(cold.system, createStillEnvironment(), 60);
    expect(cold.state.linkMemory[cold.state.linkOf(cold.body, 0, 1)]).toBeGreaterThan(0.4);
  });
});

describe('formation', () => {
  it('a seeded body forms by its links: free matter, chains, a surface, and a volume only once its shell has closed', { timeout: 120000 }, () => {
    for (const kind of SOLID_KINDS) {
      const m = make(kind, { bonded: false, scatter: 0.3 }), s = m.state, env = living(), figure = FIGURES[kind], r = createReadout();
      m.solids.read(m.body, env, r);
      // Its matter is there, apart, and nothing holds: no link, no face, no cell.
      expect(r).toMatchObject({ pieces: figure.v, form: 'free', edgesIntact: 0, facesHolding: 0, cellsHolding: 0, sealed: false, broken: figure.e + figure.braces });
      expect(Math.hypot(m.matter.position[0], m.matter.position[1], m.matter.position[2])).toBeCloseTo(RADIUS * 1.3, 5);
      const seen: string[] = [];
      let highest = 0, fell = false, early = false;
      run(m.system, env, 30, () => {
        const form = s.bodyForm[m.body];
        if (FORMS[form] !== seen[seen.length - 1]) seen.push(FORMS[form]);
        if (form < highest) fell = true;
        highest = Math.max(highest, form);
        // A cell holds only on a closed shell, the right way out.
        for (let c = 0; c < s.cells; c++) if (s.cellHolds[c] && !(s.closed(c) && s.cellVolume[c] > 0)) early = true;
      });
      m.solids.read(m.body, env, r);
      expect(seen[0]).toBe('free'); expect(seen).toContain('chain'); expect(seen[seen.length - 1]).toBe('volume');
      // Something open came before the volume: a ring or a surface, after the chains.
      expect(['polygon', 'surface']).toContain(seen[seen.length - 2]); expect(seen.indexOf(seen[seen.length - 2])).toBeGreaterThan(seen.indexOf('chain'));
      expect(fell).toBe(false); expect(early).toBe(false);
      expect(r).toMatchObject({ pieces: 1, sealed: true, form: 'volume', cellsHolding: figure.cells, facesHolding: figure.f, broken: 0 });
      expect(m.solids.stats.reforms).toBe(figure.e + figure.braces); expect(m.solids.stats.fractures).toBe(0);
      // It came together to the figure's size and volume: nothing was put there.
      expect(r.volume / r.volumeReference).toBeGreaterThan(0.98); expect(r.volume / r.volumeReference).toBeLessThan(1.02);
      expect(r.volumeReference).toBeCloseTo(figure.volume * RADIUS ** 3, 3);
      expect(m.matter.count).toBe(figure.v);
    }
    // In silence the same seed stays loose matter, exactly where it was put.
    const quiet = make('cube', { bonded: false, scatter: 0.3 }), start = Array.from(quiet.matter.position);
    run(quiet.system, createStillEnvironment(), 20);
    expect(quiet.solids.stats.reforms).toBe(0); expect(Array.from(quiet.matter.position)).toEqual(start); expect(FORMS[quiet.state.bodyForm[0]]).toBe('free');
    expect(FORM.volume).toBeGreaterThan(FORM.shell);
  });
});

describe('resonance and environment', () => {
  it('the sound deforms the body through what its links and cells tend to; without sound, or with the coupling at zero, nothing', { timeout: 120000 }, () => {
    const hear = (kind: SolidKind, over: Parameters<typeof sound>[0], coupling = 1) => {
      const m = make(kind), s = sound(over), env: StructuralEnvironment = { ...createStillEnvironment(), ...ORDERED, resonance: s.field }, r = createReadout(), h = m.system.config.step;
      const start = Array.from(m.matter.position), c = Array.from(m.solids.centroid(m.body));
      m.system.tuning.resonanceCoupling = coupling;
      let deformed = 0, low = 1, high = 1, meso = 0, micro = 0, signs = 0, last = 0;
      for (let k = 0; k < 8 * 120; k++) {
        s.tick(h); m.system.step(env);
        m.solids.read(m.body, env, r);
        deformed = Math.max(deformed, r.response); low = Math.min(low, r.volume / r.volumeReference); high = Math.max(high, r.volume / r.volumeReference);
        meso = Math.max(meso, r.meso); micro = Math.max(micro, r.micro);
        const strain = m.state.linkStrain[0];
        if (strain * last < 0) signs++;
        if (strain !== 0) last = strain;
      }
      const moved = Array.from(m.solids.centroid(m.body)).map((x, k) => Math.abs(x - c[k]));
      return { m, deformed, breath: high - low, meso, micro, signs, moved: Math.max(...moved), still: Array.from(m.matter.position).every((x, k) => x === start[k]), env };
    };
    for (const kind of SOLID_KINDS) {
      // A tone at the body's pitch, at the level music reaches: its links vibrate (their strain changes sign again and again), observably.
      const tone = hear(kind, { meso: 2.4 });
      expect(tone.meso).toBeGreaterThan(0.5); expect(tone.deformed).toBeGreaterThan(0.008); expect(tone.signs).toBeGreaterThan(10);
      // The slow modes: the whole body breathes and leans, further than it vibrates (slow motion carries more amplitude for the same speed).
      const slow = hear(kind, { macro: 0.6 });
      expect(slow.breath).toBeGreaterThan(0.05); expect(slow.deformed).toBeGreaterThan(tone.deformed);
      // The fine bands: local, and smaller than either.
      const fine = hear(kind, { micro: 0.8 });
      expect(fine.micro).toBeGreaterThan(0.05); expect(fine.deformed).toBeGreaterThan(1e-4); expect(fine.deformed).toBeLessThan(0.5 * tone.deformed);
      // All of it is internal: the body as a whole goes nowhere, and nothing breaks at these levels.
      for (const run of [tone, slow, fine]) { expect(run.moved).toBeLessThan(2e-3); expect(run.m.solids.stats.fractures).toBe(0); expect(run.m.solids.stats.repairs).toBe(0); }
      // Deaf matter, or a silent field: not one position changes.
      expect(hear(kind, { meso: 2.4, macro: 0.6, micro: 0.8 }, 0).still).toBe(true);
      expect(hear(kind, {}).still).toBe(true);
      // The sound stops: what it put into the body is lost again.
      const after = createReadout(), quiet = { ...tone.env, resonance: null };
      run(tone.m.system, quiet, 8);
      tone.m.solids.read(tone.m.body, quiet, after);
      expect(after.kinetic + after.elastic).toBeLessThan(1e-6); expect(after.response).toBeLessThan(1e-4);
    }
  });

  it('the world moves it: a vortex turns it, a front strikes it, its potential holds it, and the coupling scales all three', { timeout: 120000 }, () => {
    const vortex: StructuralEnvironment['flow'] = (x, y, _z, out) => { out[0] = -1.2 * y; out[1] = 1.2 * x; out[2] = 0; };
    const front: StructuralEnvironment['push'] = (x, _y, _z, _a, out) => { out[0] = x < 0 ? 30 : 0; out[1] = out[2] = 0; };
    const spin = (m: Made): number => {
      let turn = 0;
      for (let i = 0; i < m.matter.count; i++) turn += m.matter.mass[i] * (m.matter.position[i * 3] * m.matter.velocity[i * 3 + 1] - m.matter.position[i * 3 + 1] * m.matter.velocity[i * 3]);
      return turn;
    };
    for (const kind of SOLID_KINDS) {
      // Rotation is not given to a body: the medium drags its elements round, and it turns as one.
      const turned = make(kind), r = createReadout(), start = Math.atan2(turned.matter.position[1], turned.matter.position[0]);
      const medium = { ...createStillEnvironment(), ...ORDERED, flow: vortex };
      run(turned.system, medium, 3);
      turned.solids.read(turned.body, medium, r);
      expect(spin(turned)).toBeGreaterThan(0.5); expect(Math.abs(Math.atan2(turned.matter.position[1], turned.matter.position[0]) - start)).toBeGreaterThan(0.5);
      expect(r.sealed).toBe(true); expect(r.volume / r.volumeReference).toBeCloseTo(1, 1); expect(r.response).toBeLessThan(0.02);
      // … and in a still medium it does not turn.
      const rest = make(kind);
      run(rest.system, { ...createStillEnvironment(), ...ORDERED }, 3);
      expect(spin(rest)).toBe(0);
      // A front from one side: an impulse that enters there, deforms the body and carries it.
      const struck = make(kind), impact = { ...createStillEnvironment(), ...ORDERED, push: front }, c = struck.solids.centroid(struck.body)[0];
      let deformed = 0;
      run(struck.system, impact, 0.2, () => { deformed = Math.max(deformed, struck.solids.read(struck.body, impact, r).response); });
      expect(struck.solids.centroid(struck.body)[0]).toBeGreaterThan(c + 0.02); expect(deformed).toBeGreaterThan(0.005);
      // The world's potential holds its matter at its own layer: pushed out by the world's pressure, it swells against its volume.
      const pressed = make(kind), wide: StructuralEnvironment = { ...createStillEnvironment(), ...ORDERED, hold: (x, y, z, home, out) => hold(x, y, z, home + 0.3, out) };
      run(pressed.system, wide, 4);
      pressed.solids.read(pressed.body, wide, r);
      expect(r.volume / r.volumeReference).toBeGreaterThan(1.002); expect(r.sealed).toBe(true);
      // With the environment coupling at zero none of it reaches the body.
      for (const env of [medium, impact, wide]) {
        const deaf = make(kind), at = Array.from(deaf.matter.position);
        deaf.system.tuning.environmentCoupling = 0;
        run(deaf.system, env, 1);
        expect(Array.from(deaf.matter.position)).toEqual(at);
      }
    }
  });

  it('a chaotic world tires and breaks what an ordered one holds, and the sound alone can break a body at its own pitch', { timeout: 120000 }, () => {
    const churn: StructuralEnvironment['flow'] = (x, y, z, out) => {
      const r = Math.hypot(x, y, z), wall = -2.5 * Math.max(0, r - 1.4) / Math.max(r, 1e-6);
      out[0] = 2.2 * Math.sin(3 * y) + x * wall; out[1] = 2.2 * Math.sin(3 * x + 1) + y * wall; out[2] = 2.2 * Math.sin(2 * x + 3 * y) + z * wall;
    };
    const calm = make('cube'), wild = make('cube');
    run(calm.system, { ...createStillEnvironment(), ...ORDERED, flow: churn, tension: 0.1 }, 12);
    run(wild.system, { ...createStillEnvironment(), coherence: 0.1, harmony: 0, energy: 0.9, turbulence: 0.9, tension: 0.9, release: 0.8, flow: churn }, 12);
    expect(calm.solids.stats.fractures).toBe(0); expect(calm.state.bodySealed[0]).toBe(1);
    expect(wild.solids.stats.fractures).toBeGreaterThan(0); expect(wild.matter.count).toBe(8); expect(finiteState(wild)).toBe(true);
    validPieces(wild);
    // A weak body in a loud field at its pitch: the swing its links are driven to is what breaks them.
    const loud = make('tetrahedron'), s = sound({ meso: 2.4, macro: 1.4 }), env: StructuralEnvironment = { ...createStillEnvironment(), ...ORDERED, resonance: s.field };
    Object.assign(loud.system.tuning, { fractureThreshold: 0.25, resonanceCoupling: 3 });
    for (let k = 0; k < 10 * 120; k++) { s.tick(loud.system.config.step); loud.system.step(env); }
    expect(loud.solids.stats.fractures).toBeGreaterThan(0);
  });
});
