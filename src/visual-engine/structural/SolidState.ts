import { createShellCheck, verifyShell } from './SolidTopology';
import { BROKEN, FORM, INTACT, LOST, MAX_CELL_VERTICES, type SolidBudget, type SolidKind } from './SolidTypes';
import type { StructuralState } from './StructuralState';

/*
 * The topology of the volumetric bodies of a structural system: fixed pools of
 * links, surface triangles, cells and bodies over the system's own elements.
 * Nothing here grows and nothing is removed while a body lives: a fracture
 * changes the state of a link, and everything else is read off the links.
 *
 *   a face holds          while its three links are intact
 *   a cell holds          while every link on its boundary is intact and its volume has been verified
 *   a fragment            is a connected component of intact links
 *
 * So a face never spans two fragments, a cell never holds an open shell, and
 * one broken edge opens a face and a cell without making a fragment: a piece
 * comes off only when nothing ties it to the rest any more.
 */

const check = createShellCheck();

export class SolidState {
  readonly linkCapacity: number;
  readonly faceCapacity: number;
  readonly cellCapacity: number;
  readonly bodyCapacity: number;

  // ---- links ----
  links = 0;
  readonly linkA: Int32Array;
  readonly linkB: Int32Array;
  /** EDGE (an edge of the figure) or BRACE (an internal link of the simulation). */
  readonly linkKind: Uint8Array;
  /** INTACT, BROKEN (remembered by its ends) or LOST (forgotten). */
  readonly linkState: Uint8Array;
  readonly linkBody: Int32Array;
  /** The length it holds its ends at now, and the one it was made with and settles to (units). */
  readonly linkRest: Float64Array;
  readonly linkRest0: Float64Array;
  /** 1 / stiffness (length per unit force), damping ratio, strength, and how much of its ends' resonance it carries. */
  readonly linkCompliance: Float64Array;
  readonly linkDamping: Float32Array;
  readonly linkStrength: Float32Array;
  readonly linkCoupling: Float32Array;
  /** Load now (a share of what it bears), accumulated damage 0..1, signed strain against its driven rest, and its age (s). */
  readonly linkStress: Float32Array;
  readonly linkDamage: Float32Array;
  readonly linkStrain: Float32Array;
  readonly linkAge: Float32Array;
  /** How strongly its two ends still remember it once broken (1 at the break, fading). */
  readonly linkMemory: Float32Array;
  /** Surface triangles holding on it: two on a closed surface, one on a rim. */
  readonly linkFaces: Uint8Array;
  /**
   * The hinge of the two surface triangles that meet on it: their two far corners (−1: none) and the distance between
   * those at rest. It is the bending stiffness of the surface across this link, there for as long as both triangles hold.
   */
  readonly hingeA: Int32Array;
  readonly hingeB: Int32Array;
  readonly hingeRest: Float64Array;

  // ---- faces: the triangles of the surface ----
  faces = 0;
  /** Corners (elements, outward), the links of its three sides, the geometric face it is part of, and its body. */
  readonly faceCorners: Int32Array;
  readonly faceLinks: Int32Array;
  readonly faceGroup: Int32Array;
  readonly faceBody: Int32Array;
  readonly faceHolds: Uint8Array;

  // ---- cells: closed, outward-oriented triangle sets with a rest volume ----
  cells = 0;
  readonly cellBody: Int32Array;
  /** Its vertices (a range of `cellVertices`), its triangles as numbers of those vertices (a range of `cellCorners`) and its links. */
  readonly cellVertexStart: Int32Array;
  readonly cellVertexCount: Int32Array;
  readonly cellTriangleStart: Int32Array;
  readonly cellTriangleCount: Int32Array;
  readonly cellLinkStart: Int32Array;
  readonly cellLinkCount: Int32Array;
  readonly cellVertices: Int32Array;
  readonly cellCorners: Uint8Array;
  readonly cellLinks: Int32Array;
  /** The volume it holds now, and the one it was made with and settles to. */
  readonly cellRest: Float64Array;
  readonly cellRest0: Float64Array;
  /** Signed volume as last measured. */
  readonly cellVolume: Float64Array;
  readonly cellHolds: Uint8Array;
  private cellVertexTop = 0;
  private cellCornerTop = 0;
  private cellLinkTop = 0;

  // ---- bodies ----
  bodies = 0;
  readonly bodyKind: SolidKind[] = [];
  /** Its elements (a contiguous range of the system's), links, faces and cells. */
  readonly bodyFirst: Int32Array;
  readonly bodyCount: Int32Array;
  readonly bodyLinkStart: Int32Array;
  readonly bodyLinkCount: Int32Array;
  readonly bodyFaceStart: Int32Array;
  readonly bodyFaceCount: Int32Array;
  readonly bodyCellStart: Int32Array;
  readonly bodyCellCount: Int32Array;
  /** Geometric faces (groups of triangles). */
  readonly bodyGroups: Int32Array;
  /** Connected components it is in now (1: whole), the form of the largest, and whether nothing of it is open. */
  readonly bodyPieces: Int32Array;
  readonly bodyForm: Uint8Array;
  readonly bodySealed: Uint8Array;

  // ---- per element ----
  /** The component it is in: the lowest-numbered element of it (−1: not a vertex of a body). Stable while the topology is. */
  readonly component: Int32Array;
  /** The form of that component (FORM). */
  readonly form: Uint8Array;
  /** Its mass as its identity gives it, before any development factor. */
  readonly mass0: Float32Array;

  /** The topology changed since the last `book`. */
  dirty = false;
  /** Pieces that are not whole bodies: components of every body in more than one piece. */
  fragments = 0;
  private readonly size: Int32Array;
  private readonly held: Int32Array;
  private readonly surface: Int32Array;
  private readonly volumes: Int32Array;
  private readonly rim: Int32Array;

  constructor(readonly matter: StructuralState, budget: Readonly<SolidBudget>) {
    const n = matter.capacity;
    const links = this.linkCapacity = Math.max(1, Math.floor(budget.links)), faces = this.faceCapacity = Math.max(1, Math.floor(budget.faces));
    const cells = this.cellCapacity = Math.max(1, Math.floor(budget.cells)), bodies = this.bodyCapacity = Math.max(1, Math.floor(budget.bodies));
    this.linkA = new Int32Array(links); this.linkB = new Int32Array(links); this.linkKind = new Uint8Array(links); this.linkState = new Uint8Array(links);
    this.linkBody = new Int32Array(links); this.linkRest = new Float64Array(links); this.linkRest0 = new Float64Array(links);
    this.linkCompliance = new Float64Array(links); this.linkDamping = new Float32Array(links); this.linkStrength = new Float32Array(links);
    this.linkCoupling = new Float32Array(links); this.linkStress = new Float32Array(links); this.linkDamage = new Float32Array(links);
    this.linkStrain = new Float32Array(links); this.linkAge = new Float32Array(links); this.linkMemory = new Float32Array(links); this.linkFaces = new Uint8Array(links);
    this.hingeA = new Int32Array(links).fill(-1); this.hingeB = new Int32Array(links).fill(-1); this.hingeRest = new Float64Array(links);
    this.faceCorners = new Int32Array(faces * 3); this.faceLinks = new Int32Array(faces * 3); this.faceGroup = new Int32Array(faces);
    this.faceBody = new Int32Array(faces); this.faceHolds = new Uint8Array(faces);
    this.cellBody = new Int32Array(cells); this.cellVertexStart = new Int32Array(cells); this.cellVertexCount = new Int32Array(cells);
    this.cellTriangleStart = new Int32Array(cells); this.cellTriangleCount = new Int32Array(cells);
    this.cellLinkStart = new Int32Array(cells); this.cellLinkCount = new Int32Array(cells);
    // A tetrahedral cell has four vertices, four triangles and six links; a shell has as many as its surface.
    this.cellVertices = new Int32Array(cells * 4 + n); this.cellCorners = new Uint8Array((cells * 4 + faces) * 3); this.cellLinks = new Int32Array(cells * 6 + links);
    this.cellRest = new Float64Array(cells); this.cellRest0 = new Float64Array(cells); this.cellVolume = new Float64Array(cells); this.cellHolds = new Uint8Array(cells);
    this.bodyFirst = new Int32Array(bodies); this.bodyCount = new Int32Array(bodies); this.bodyLinkStart = new Int32Array(bodies); this.bodyLinkCount = new Int32Array(bodies);
    this.bodyFaceStart = new Int32Array(bodies); this.bodyFaceCount = new Int32Array(bodies); this.bodyCellStart = new Int32Array(bodies); this.bodyCellCount = new Int32Array(bodies);
    this.bodyGroups = new Int32Array(bodies); this.bodyPieces = new Int32Array(bodies); this.bodyForm = new Uint8Array(bodies); this.bodySealed = new Uint8Array(bodies);
    this.component = new Int32Array(n).fill(-1); this.form = new Uint8Array(n); this.mass0 = new Float32Array(n);
    this.size = new Int32Array(n); this.held = new Int32Array(n); this.surface = new Int32Array(n); this.volumes = new Int32Array(n); this.rim = new Int32Array(n);
  }

  /** Whether the pools have room for a body of these sizes. */
  fits(links: number, faces: number, cells: number, cellTriangles: number, cellVertices: number): boolean {
    return this.bodies < this.bodyCapacity && this.links + links <= this.linkCapacity && this.faces + faces <= this.faceCapacity
      && this.cells + cells <= this.cellCapacity && this.cellCornerTop + cellTriangles * 3 <= this.cellCorners.length
      // A closed surface of T triangles has 3T / 2 edges.
      && this.cellVertexTop + cellVertices <= this.cellVertices.length && this.cellLinkTop + cellTriangles * 1.5 <= this.cellLinks.length;
  }

  /** Opens a body over the elements `first … first + count − 1`. Returns its number, or −1 when no body is free. */
  addBody(kind: SolidKind, first: number, count: number, groups: number): number {
    if (this.bodies >= this.bodyCapacity) return -1;
    const b = this.bodies++, matter = this.matter;
    this.bodyKind[b] = kind; this.bodyFirst[b] = first; this.bodyCount[b] = count; this.bodyGroups[b] = groups;
    this.bodyLinkStart[b] = this.links; this.bodyFaceStart[b] = this.faces; this.bodyCellStart[b] = this.cells;
    this.bodyLinkCount[b] = this.bodyFaceCount[b] = this.bodyCellCount[b] = 0;
    this.bodyPieces[b] = count; this.bodyForm[b] = FORM.free; this.bodySealed[b] = 0;
    for (let i = first; i < first + count; i++) { matter.body[i] = b; matter.links[i] = 0; this.component[i] = i; this.form[i] = FORM.free; this.mass0[i] = matter.mass[i]; }
    this.dirty = true;
    return b;
  }

  /** The link of body `b` between two elements, or −1. */
  linkOf(b: number, i: number, j: number): number {
    for (let l = this.bodyLinkStart[b], end = l + this.bodyLinkCount[b]; l < end; l++) {
      if (this.linkA[l] === i && this.linkB[l] === j || this.linkA[l] === j && this.linkB[l] === i) return l;
    }
    return -1;
  }

  /**
   * A link of the last body opened, between two of its elements, at the length they are apart: intact, or (when not
   * `intact`) only remembered by its ends, to form when they can. Returns it, or −1 (pool full, not this body's
   * elements, the same element twice, already linked, no length).
   */
  addLink(b: number, i: number, j: number, kind: number, compliance: number, damping: number, strength: number, coupling: number, intact: boolean, rest = NaN): number {
    const matter = this.matter, p = matter.position;
    if (b !== this.bodies - 1 || i === j || matter.body[i] !== b || matter.body[j] !== b || this.links >= this.linkCapacity || this.linkOf(b, i, j) >= 0) return -1;
    const dx = p[j * 3] - p[i * 3], dy = p[j * 3 + 1] - p[i * 3 + 1], dz = p[j * 3 + 2] - p[i * 3 + 2];
    const length = Number.isFinite(rest) ? rest : Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(length > 1e-6) || !(compliance > 0)) return -1;
    const l = this.links++;
    this.linkA[l] = i; this.linkB[l] = j; this.linkKind[l] = kind; this.linkBody[l] = b;
    this.linkRest[l] = this.linkRest0[l] = length; this.linkCompliance[l] = compliance; this.linkDamping[l] = damping;
    this.linkStrength[l] = strength; this.linkCoupling[l] = coupling;
    this.linkStress[l] = this.linkDamage[l] = this.linkStrain[l] = this.linkAge[l] = 0; this.linkFaces[l] = 0;
    this.linkState[l] = intact ? INTACT : BROKEN; this.linkMemory[l] = intact ? 0 : 1;
    this.hingeA[l] = this.hingeB[l] = -1; this.hingeRest[l] = 0;
    if (intact) { matter.links[i]++; matter.links[j]++; }
    this.bodyLinkCount[b]++;
    this.dirty = true;
    return l;
  }

  /** A surface triangle of the last body opened (corners outward). Its three sides must be links of the body. Returns it, or −1. */
  addFace(b: number, i: number, j: number, k: number, group: number): number {
    if (b !== this.bodies - 1 || this.faces >= this.faceCapacity) return -1;
    const ij = this.linkOf(b, i, j), jk = this.linkOf(b, j, k), ki = this.linkOf(b, k, i);
    if (ij < 0 || jk < 0 || ki < 0) return -1;
    const f = this.faces++;
    this.faceCorners[f * 3] = i; this.faceCorners[f * 3 + 1] = j; this.faceCorners[f * 3 + 2] = k;
    this.faceLinks[f * 3] = ij; this.faceLinks[f * 3 + 1] = jk; this.faceLinks[f * 3 + 2] = ki;
    this.faceGroup[f] = group; this.faceBody[f] = b; this.faceHolds[f] = 0;
    this.bodyFaceCount[b]++;
    this.dirty = true;
    return f;
  }

  /**
   * Gives the surface of the last body opened its bending stiffness, once its faces are there: where exactly two
   * triangles meet on a link and no link already ties their far corners, those corners are a hinge, at the distance
   * (× `scale`) they are apart now. Returns the hinges made.
   */
  addHinges(b: number, scale = 1): number {
    if (b !== this.bodies - 1) return 0;
    const p = this.matter.position;
    let made = 0;
    for (let l = this.bodyLinkStart[b], end = l + this.bodyLinkCount[b]; l < end; l++) {
      let first = -1, second = -1, more = false;
      for (let f = this.bodyFaceStart[b], last = f + this.bodyFaceCount[b]; f < last; f++) {
        for (let k = 0; k < 3; k++) {
          if (this.faceLinks[f * 3 + k] !== l) continue;
          // The corner of the triangle that is not on this side.
          const far = this.faceCorners[f * 3 + (k + 2) % 3];
          if (first < 0) first = far; else if (second < 0) second = far; else more = true;
        }
      }
      if (first < 0 || second < 0 || more || first === second || this.linkOf(b, first, second) >= 0) continue;
      const dx = p[second * 3] - p[first * 3], dy = p[second * 3 + 1] - p[first * 3 + 1], dz = p[second * 3 + 2] - p[first * 3 + 2];
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz) * scale;
      if (!(length > 1e-6)) continue;
      this.hingeA[l] = first; this.hingeB[l] = second; this.hingeRest[l] = length;
      made++;
    }
    return made;
  }

  /**
   * A volumetric cell of the last body opened: `triangles` (elements, stride 3) must be the boundary of a volume
   * (closed, consistently oriented outward, one piece, neither flat nor inside out where the elements are now), and
   * every side must be a link of the body. Anything less is refused: polygons near each other are not a solid.
   * Returns the cell, or −1.
   */
  addCell(b: number, triangles: ArrayLike<number>): number {
    const count = Math.floor(triangles.length / 3);
    if (b !== this.bodies - 1 || this.cells >= this.cellCapacity || this.cellCornerTop + count * 3 > this.cellCorners.length) return -1;
    if (!verifyShell(triangles, this.matter.position, check).valid) return -1;
    const c = this.cells, vertices = this.cellVertexTop, links = this.cellLinkTop;
    let nv = 0, nl = 0;
    for (let k = 0; k < count * 3; k++) {
      const e = triangles[k], next = triangles[k - (k % 3) + (k % 3 + 1) % 3];
      let local = 0;
      while (local < nv && this.cellVertices[vertices + local] !== e) local++;
      if (local === nv) {
        if (nv >= MAX_CELL_VERTICES || vertices + nv >= this.cellVertices.length) return -1;
        this.cellVertices[vertices + nv++] = e;
      }
      this.cellCorners[this.cellCornerTop + k] = local;
      const l = this.linkOf(b, e, next);
      if (l < 0) return -1;
      let seen = 0;
      while (seen < nl && this.cellLinks[links + seen] !== l) seen++;
      if (seen === nl) {
        if (links + nl >= this.cellLinks.length) return -1;
        this.cellLinks[links + nl++] = l;
      }
    }
    this.cells++;
    this.cellBody[c] = b; this.cellVertexStart[c] = vertices; this.cellVertexCount[c] = nv;
    this.cellTriangleStart[c] = this.cellCornerTop; this.cellTriangleCount[c] = count; this.cellLinkStart[c] = links; this.cellLinkCount[c] = nl;
    this.cellVertexTop += nv; this.cellCornerTop += count * 3; this.cellLinkTop += nl;
    this.cellRest[c] = this.cellRest0[c] = this.cellVolume[c] = this.measure(c);
    this.cellHolds[c] = 0;
    this.bodyCellCount[b]++;
    this.dirty = true;
    return c;
  }

  /** Signed volume of cell `c` where its elements are now (the same sum, in the same order, as its rest volume was taken with). */
  measure(c: number, positions: ArrayLike<number> = this.matter.position): number {
    const vertices = this.cellVertexStart[c], corners = this.cellTriangleStart[c], count = this.cellTriangleCount[c], verts = this.cellVertices;
    const o = verts[vertices] * 3, ox = positions[o], oy = positions[o + 1], oz = positions[o + 2];
    let volume = 0;
    for (let t = 0; t < count; t++) {
      const a = verts[vertices + this.cellCorners[corners + t * 3]] * 3, b = verts[vertices + this.cellCorners[corners + t * 3 + 1]] * 3, d = verts[vertices + this.cellCorners[corners + t * 3 + 2]] * 3;
      const ax = positions[a] - ox, ay = positions[a + 1] - oy, az = positions[a + 2] - oz;
      const bx = positions[b] - ox, by = positions[b + 1] - oy, bz = positions[b + 2] - oz;
      const cx = positions[d] - ox, cy = positions[d + 1] - oy, cz = positions[d + 2] - oz;
      volume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    }
    return volume / 6;
  }

  /** Whether every link on the boundary of cell `c` is intact: its shell is closed. */
  closed(c: number): boolean {
    for (let k = this.cellLinkStart[c], end = k + this.cellLinkCount[c]; k < end; k++) if (this.linkState[this.cellLinks[k]] !== INTACT) return false;
    return true;
  }

  /**
   * Breaks link `l`: the topology changes, the matter does not. Its ends stay where they are, moving as they were,
   * and remember each other.
   */
  sever(l: number): boolean {
    if (this.linkState[l] !== INTACT) return false;
    this.linkState[l] = BROKEN; this.linkMemory[l] = 1; this.linkStress[l] = 0;
    this.matter.links[this.linkA[l]]--; this.matter.links[this.linkB[l]]--;
    this.dirty = true;
    return true;
  }

  /** Makes a remembered link hold again, at the length its ends are apart now (nothing jumps); it settles to its own. */
  restore(l: number, length: number, damage: number): boolean {
    if (this.linkState[l] !== BROKEN || !(length > 1e-6)) return false;
    this.linkState[l] = INTACT; this.linkMemory[l] = 0; this.linkRest[l] = length; this.linkAge[l] = 0; this.linkStress[l] = 0; this.linkDamage[l] = damage;
    this.matter.links[this.linkA[l]]++; this.matter.links[this.linkB[l]]++;
    this.dirty = true;
    return true;
  }

  /** A broken link nobody remembers any more: it will not form again. */
  forget(l: number): void {
    if (this.linkState[l] !== BROKEN) return;
    this.linkState[l] = LOST; this.linkMemory[l] = 0;
    this.dirty = true;
  }

  /**
   * Reads the topology off the links: which faces hold, which cells no longer do, which elements are one piece, and
   * what each piece is. Sparse work, done when something changed, never per element pair. A cell that has just closed
   * again is not made to hold here: its volume has to be verified first (`SolidSystem`).
   */
  book(): void {
    const component = this.component;
    this.dirty = false; this.fragments = 0;
    for (let l = 0; l < this.links; l++) this.linkFaces[l] = 0;
    for (let f = 0; f < this.faces; f++) {
      const a = this.faceLinks[f * 3], b = this.faceLinks[f * 3 + 1], c = this.faceLinks[f * 3 + 2];
      const holds = this.linkState[a] === INTACT && this.linkState[b] === INTACT && this.linkState[c] === INTACT;
      this.faceHolds[f] = holds ? 1 : 0;
      if (holds) { this.linkFaces[a]++; this.linkFaces[b]++; this.linkFaces[c]++; }
    }
    for (let c = 0; c < this.cells; c++) if (this.cellHolds[c] && !this.closed(c)) this.cellHolds[c] = 0;
    for (let b = 0; b < this.bodies; b++) {
      const first = this.bodyFirst[b], last = first + this.bodyCount[b];
      for (let i = first; i < last; i++) { component[i] = i; this.size[i] = this.held[i] = this.surface[i] = this.volumes[i] = this.rim[i] = 0; }
      const links = this.bodyLinkStart[b], linkEnd = links + this.bodyLinkCount[b];
      // Union by the lower number: the name of a piece is its first element, the same whatever order its links broke in.
      for (let l = links; l < linkEnd; l++) {
        if (this.linkState[l] !== INTACT) continue;
        const ra = this.root(this.linkA[l]), rb = this.root(this.linkB[l]);
        if (ra < rb) component[rb] = ra; else if (rb < ra) component[ra] = rb;
      }
      let pieces = 0, sealed = 1, largest = first;
      for (let i = first; i < last; i++) { const r = component[i] = this.root(i); this.size[r]++; if (r === i) pieces++; }
      for (let l = links; l < linkEnd; l++) {
        if (this.linkState[l] !== INTACT) { sealed = 0; continue; }
        const r = component[this.linkA[l]];
        this.held[r]++;
        if (this.linkFaces[l] === 1) this.rim[r]++;
      }
      for (let f = this.bodyFaceStart[b], end = f + this.bodyFaceCount[b]; f < end; f++) if (this.faceHolds[f]) this.surface[component[this.faceCorners[f * 3]]]++;
      for (let c = this.bodyCellStart[b], end = c + this.bodyCellCount[b]; c < end; c++) {
        if (this.cellHolds[c]) this.volumes[component[this.cellVertices[this.cellVertexStart[c]]]]++; else sealed = 0;
      }
      for (let i = first; i < last; i++) {
        const r = component[i];
        // The highest structure the piece holds: a verified volume, a closed surface, a surface, a ring, a chain, nothing.
        this.form[i] = this.volumes[r] > 0 ? FORM.volume : this.surface[r] > 0 ? (this.rim[r] === 0 ? FORM.shell : FORM.surface)
          : this.held[r] >= this.size[r] ? FORM.polygon : this.size[r] > 1 ? FORM.chain : FORM.free;
        if (this.size[r] > this.size[component[largest]]) largest = i;
      }
      this.bodyPieces[b] = pieces; this.bodyForm[b] = this.form[largest]; this.bodySealed[b] = sealed;
      if (pieces > 1) this.fragments += pieces;
    }
  }

  /** Empties the pools: no bodies, links, faces or cells. The elements are the system's to clear. */
  clear(): void {
    this.links = this.faces = this.cells = this.bodies = this.fragments = 0;
    this.cellVertexTop = this.cellCornerTop = this.cellLinkTop = 0;
    this.bodyKind.length = 0;
    this.component.fill(-1); this.form.fill(0);
    this.dirty = false;
  }

  private root(i: number): number {
    const component = this.component;
    while (component[i] !== i) i = component[i] = component[component[i]];
    return i;
  }
}
