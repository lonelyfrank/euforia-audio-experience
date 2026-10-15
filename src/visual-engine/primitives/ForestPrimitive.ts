import { AdditiveBlending, BufferAttribute, DoubleSide, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedBufferGeometry, LineSegments, Mesh, ShaderMaterial, type Object3D } from 'three';
import type { QualityProfile } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';
import { branchGlsl, BRANCH_VERTICES, forestLawGlsl, leafGlsl, MAX_FILAMENTS, MAX_LEAVES, MAX_SEGMENTS, MAX_TREES, SIDES } from './forestLaw';
import { ForestField, TREE_PHASES, type ForestSettings } from './forestGrowth';
import { terrainLawGlsl } from './terrainLaw';
import type { TerrainPrimitive } from './TerrainPrimitive';

/*
 * Resonant Forest's trees, drawn: every tree of the forest field (forestGrowth.ts) as instances of three templates
 * (forestLaw.ts), in the ground's own space and from the ground's own uniforms — the same packed terrain law, fronts,
 * light, air and colours the ground binds — so a tree stands where the ground's vertex is and cannot drift from it.
 *
 *   branches    every segment as the three edges of a thin prism, from its start to where it has grown: one draw call
 *   leaves      leaves and nodes as flat triangles, additive: one draw call
 *   filaments   lines between the crowns of trees that remember the same music: one draw call (none at Low)
 *
 * A tree's shape is written into its slot's part of the instance buffers once, when it is seeded (a partial upload);
 * what changes per frame is two small uniform arrays (growth, lean, light, decay; lean direction, resonance, leaves,
 * flush). Buffers are allocated once at the pool's size.
 */

const air = /* glsl */ `
uniform vec4 uLight;
uniform vec4 uAir;
uniform float uSpan;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
varying vec3 vColor;
float forestFog(vec3 P) {
  float d = -P.z;
  return exp(-max(d, 0.0) * uAir.y) * (1.0 - smoothstep(uAir.z * 0.75, uAir.z, d)) * (1.0 - smoothstep(0.85, 1.0, abs(P.x) / uSpan)) * uAir.w;
}
`;

const branchVertex = /* glsl */ `
${terrainLawGlsl}
${forestLawGlsl}
${branchGlsl}
${air}
void main() {
  int slot = int(aTree.z + 0.5);
  vec3 P = branchPoint(position.x, position.y);
  vec4 tree = uTrees[slot], look = uTreeLean[slot];
  float light = tree.z * (0.3 + 1.2 * uLight.x) * step(0.0, tree.x);
  // The trunk in the palette's first colour, the twigs in its second; resonance and a flush in the highlight.
  vColor = (mix(uColorA, uColorB, branchDepth / 3.0) * light + uColorC * (0.35 * look.y + 0.6 * look.w) * branchGrown) * forestFog(P);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(P, 1.0);
}
`;

const leafVertex = /* glsl */ `
${terrainLawGlsl}
${forestLawGlsl}
${leafGlsl}
${air}
void main() {
  int slot = int(aTree.z + 0.5);
  vec3 P = leafPoint(position.x);
  vec4 tree = uTrees[slot], look = uTreeLean[slot];
  float light = tree.z * step(0.0, tree.x) * leafOpen;
  // Leaves: the second colour, dimmer as they fall; nodes: the highlight, as far as the tree resonates (or buds).
  vec3 leaf = uColorB * light * (0.35 + 0.5 * uLight.x) * (1.0 - 0.7 * tree.w) + uColorC * look.w * 0.5 * light;
  vec3 node = uColorC * light * (0.15 + 1.4 * look.y);
  vColor = mix(leaf, node, leafNode) * forestFog(P);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(P, 1.0);
}
`;

const filamentVertex = /* glsl */ `
${terrainLawGlsl}
${forestLawGlsl}
${air}
// x: J, y: R, z: slot, w: height of the crown (units) — of the tree at this end
attribute vec4 aEndA;
attribute vec4 aEndB;
void main() {
  vec4 e = position.x < 0.5 ? aEndA : aEndB;
  int slot = int(e.z + 0.5);
  vec3 P = forestRoot(e.x, e.y) + forestLean(vec3(0.0, e.w, 0.0), slot);
  vec4 a = uTreeLean[int(aEndA.z + 0.5)], b = uTreeLean[int(aEndB.z + 0.5)];
  vColor = uColorC * 0.35 * a.y * b.y * forestFog(P);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(P, 1.0);
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;

/** Draw calls at a quality: branches and leaves, and the filaments above Low. */
export const forestDrawCalls = (quality: QualityProfile): number => (quality.density >= 0.5 ? 3 : 2);

export class ForestPrimitive implements Primitive {
  readonly object: Object3D;
  readonly field: ForestField;
  readonly elements = MAX_TREES * (MAX_SEGMENTS * SIDES + MAX_LEAVES) + MAX_FILAMENTS;
  readonly vertices = MAX_TREES * (MAX_SEGMENTS * BRANCH_VERTICES + MAX_LEAVES * 3) + MAX_FILAMENTS * 2;
  readonly drawCalls: number;
  readonly debug: Record<string, number> = { trees: 0, spawned: 0, recycled: 0, decayed: 0, refused: 0, remembering: 0, match: 0, filaments: 0, density: 0, 'forest ms': 0 };
  private readonly inner = new Group();
  private readonly geometries: InstancedBufferGeometry[] = [];
  private readonly materials: ShaderMaterial[] = [];
  private readonly segFrom: InstancedBufferAttribute;
  private readonly segTo: InstancedBufferAttribute;
  private readonly segTree: InstancedBufferAttribute;
  private readonly leaf: InstancedBufferAttribute;
  private readonly leafLook: InstancedBufferAttribute;
  private readonly leafTree: InstancedBufferAttribute;
  private readonly endA: InstancedBufferAttribute | null = null;
  private readonly endB: InstancedBufferAttribute | null = null;
  private readonly filaments: InstancedBufferGeometry | null = null;

  constructor(context: PrimitiveContext, private readonly ground: TerrainPrimitive, params: ForestSettings, quality: QualityProfile) {
    const field = this.field = new ForestField(params, context.seed | 0);
    const shared = { ...ground.shared, uTrees: { value: field.trees }, uTreeLean: { value: field.treeLean } };
    const instanced = (size: number, count: number): InstancedBufferAttribute => new InstancedBufferAttribute(new Float32Array(count * size), size).setUsage(DynamicDrawUsage);
    const make = (template: Float32Array, index: Uint16Array | null, attributes: Record<string, InstancedBufferAttribute>, count: number): InstancedBufferGeometry => {
      const g = new InstancedBufferGeometry();
      g.setAttribute('position', new BufferAttribute(template, 3));
      for (const [name, attribute] of Object.entries(attributes)) g.setAttribute(name, attribute);
      if (index) g.setIndex(new BufferAttribute(index, 1));
      g.instanceCount = count;
      this.geometries.push(g);
      return g;
    };
    const material = (vertexShader: string): ShaderMaterial => {
      const m = new ShaderMaterial({ vertexShader, fragmentShader, uniforms: shared, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide });
      this.materials.push(m);
      return m;
    };

    // Branches: per corner of the prism, a start and an end; three lines (the prism's edges along the segment).
    const branch = new Float32Array(BRANCH_VERTICES * 3);
    for (let c = 0; c < SIDES; c++) { branch.set([c, 0, 0], c * 2 * 3); branch.set([c, 1, 0], (c * 2 + 1) * 3); }
    const branchIndex = Uint16Array.from({ length: BRANCH_VERTICES }, (_, i) => i);
    this.segFrom = instanced(4, MAX_TREES * MAX_SEGMENTS); this.segTo = instanced(4, MAX_TREES * MAX_SEGMENTS); this.segTree = instanced(4, MAX_TREES * MAX_SEGMENTS);
    const branches = new LineSegments(make(branch, branchIndex, { aFrom: this.segFrom, aTo: this.segTo, aTree: this.segTree }, MAX_TREES * MAX_SEGMENTS), material(branchVertex));

    // Leaves and nodes: one triangle each.
    const triangle = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    this.leaf = instanced(4, MAX_TREES * MAX_LEAVES); this.leafLook = instanced(4, MAX_TREES * MAX_LEAVES); this.leafTree = instanced(4, MAX_TREES * MAX_LEAVES);
    const leaves = new Mesh(make(triangle, null, { aLeaf: this.leaf, aLeafLook: this.leafLook, aTree: this.leafTree }, MAX_TREES * MAX_LEAVES), material(leafVertex));
    for (const drawable of [branches, leaves]) { drawable.frustumCulled = false; this.inner.add(drawable); }

    // Filaments: none at Low (the logic is the same; only what is drawn).
    const filaments = quality.density >= 0.5;
    if (filaments) {
      this.endA = instanced(4, MAX_FILAMENTS); this.endB = instanced(4, MAX_FILAMENTS);
      this.filaments = make(new Float32Array([0, 0, 0, 1, 0, 0]), null, { aEndA: this.endA, aEndB: this.endB }, 0);
      const lines = new LineSegments(this.filaments, material(filamentVertex));
      lines.frustumCulled = false;
      this.inner.add(lines);
    }
    this.drawCalls = filaments ? 3 : 2;
    // Laid out as the ground is: the same height under the viewer, the same pitch and bank (copied each frame).
    this.inner.position.y = -ground.params.height;
    const object = new Group();
    object.add(this.inner);
    this.object = object;
  }

  setPalette(): void {
    // The colours are the ground's own uniforms: nothing to copy.
  }

  update(frame: Readonly<WorldFrame>, presence: number): void {
    const started = import.meta.env.DEV ? performance.now() : 0;
    const ground = this.ground, motion = ground.motion, v = motion.values, p = ground.params, field = this.field;
    this.object.rotation.copy(ground.object.rotation);
    field.step(frame.dt, v, frame.view, frame.geometry, v.row + v.shift, p.rows, p.columns, frame.timed ? frame.snapshot?.cues : undefined, frame.time);
    // A tree seeded this frame: its slot's part of the buffers, once.
    for (let s = 0; s < MAX_TREES; s++) if (field.dirty[s]) { this.write(s); field.dirty[s] = 0; }
    if (this.filaments && this.endA && this.endB) {
      const a = this.endA.array as Float32Array, b = this.endB.array as Float32Array;
      for (let n = 0; n < field.links; n++) {
        const ta = field.linkA[n], tb = field.linkB[n];
        a[n * 4] = field.J[ta]; a[n * 4 + 1] = field.R[ta]; a[n * 4 + 2] = ta; a[n * 4 + 3] = 0.8 * field.shapes[ta].top;
        b[n * 4] = field.J[tb]; b[n * 4 + 1] = field.R[tb]; b[n * 4 + 2] = tb; b[n * 4 + 3] = 0.8 * field.shapes[tb].top;
      }
      this.upload(this.endA, field.links); this.upload(this.endB, field.links);
      this.filaments.instanceCount = presence > 0 ? field.links : 0;
    }
    this.inner.visible = presence > 0;
    if (import.meta.env.DEV) {
      const d = this.debug, s = field.stats;
      d.trees = field.live(); d.spawned = s.spawned; d.recycled = s.recycled; d.decayed = s.decayed; d.refused = s.refused;
      d.remembering = s.remembering; d.match = s.match; d.filaments = field.links; d.density = s.density;
      for (let i = 1; i < TREE_PHASES.length; i++) d[TREE_PHASES[i]] = s.phases[i];
      d['forest ms'] += (performance.now() - started - d['forest ms']) * 0.05;
    }
  }

  /** Writes slot `s`'s shape into its part of the instance buffers and marks only that part for upload. */
  private write(s: number): void {
    const field = this.field, shape = field.shapes[s], J = field.J[s], R = field.R[s];
    const from = this.segFrom.array as Float32Array, to = this.segTo.array as Float32Array, tree = this.segTree.array as Float32Array;
    for (let n = 0; n < MAX_SEGMENTS; n++) {
      const o = (s * MAX_SEGMENTS + n) * 4, used = n < shape.segments;
      for (let q = 0; q < 4; q++) { from[o + q] = used ? shape.from[n * 4 + q] : 0; to[o + q] = used ? shape.to[n * 4 + q] : 0; }
      // A segment the tree does not have is born after the tree is grown: it never grows.
      if (!used) to[o + 3] = 9;
      tree[o] = J; tree[o + 1] = R; tree[o + 2] = s; tree[o + 3] = used ? shape.radius[n] : 0;
    }
    const leaf = this.leaf.array as Float32Array, look = this.leafLook.array as Float32Array, leafTree = this.leafTree.array as Float32Array;
    for (let n = 0; n < MAX_LEAVES; n++) {
      const o = (s * MAX_LEAVES + n) * 4, used = n < shape.leaves;
      for (let q = 0; q < 4; q++) { leaf[o + q] = used ? shape.leaf[n * 4 + q] : 0; look[o + q] = used ? shape.leafLook[n * 4 + q] : 0; }
      if (!used) { look[o] = 0; leaf[o + 3] = 9; }
      leafTree[o] = J; leafTree[o + 1] = R; leafTree[o + 2] = s; leafTree[o + 3] = 0;
    }
    for (const [attribute, per] of [[this.segFrom, MAX_SEGMENTS], [this.segTo, MAX_SEGMENTS], [this.segTree, MAX_SEGMENTS], [this.leaf, MAX_LEAVES], [this.leafLook, MAX_LEAVES], [this.leafTree, MAX_LEAVES]] as const) {
      attribute.addUpdateRange(s * per * 4, per * 4);
      attribute.needsUpdate = true;
    }
  }

  private upload(attribute: InstancedBufferAttribute, count: number): void {
    attribute.clearUpdateRanges();
    if (count > 0) { attribute.addUpdateRange(0, count * 4); attribute.needsUpdate = true; }
  }

  /** A new audio session: the trees stay; what was read of the last session is forgotten. */
  reset(): void {
    this.field.reset();
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    (this.object as Group).clear();
  }
}
