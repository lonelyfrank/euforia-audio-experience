import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedBufferGeometry, LineSegments, Mesh, ShaderMaterial, Vector4, type Object3D } from 'three';
import type { QualityProfile } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';
import { barkGlsl, BLUE, forestLawGlsl, leafGlsl, MAX_FILAMENTS, MAX_LEAVES, MAX_TREES, treeDetail, type TreeDetail } from './forestLaw';
import { ForestField, TREE_PHASES, type ForestSettings } from './forestGrowth';
import { forestAirGlsl, forestLightGlsl, forestLook, glowPalette, rgb, type ForestLookSettings } from './forestLook';
import { terrainLawGlsl } from './terrainLaw';
import type { TerrainPrimitive } from './TerrainPrimitive';

/*
 * Resonant Forest's trees, drawn (docs/resonant-forest.md): every tree of the forest field (forestGrowth.ts) as closed,
 * faceted volumes in the ground's own space and from the ground's own uniforms — the same packed terrain law, the same
 * air — so a tree stands where the ground's vertex is and cannot drift from it.
 *
 *   bark        trunks, roots, limbs, branches: dark flat-shaded facets under a constant base light, some faces and the
 *               veins glowing with the structural emission; opaque, one draw call
 *   twigs       thin dark lines at the ends: one draw call
 *   blossoms    blossoms and junction nodes as small triangles, additive: one draw call
 *   filaments   lines between the crowns of trees that remember the same music: one draw call (none at Low)
 *
 * A tree's geometry is written into its slot's part of the buffers once, when it is seeded (a partial upload): the pool
 * is fixed (MAX_TREES slots of the detail's size), so there is nothing to allocate or rebuild while it plays. What
 * changes per frame is two small uniform arrays (growth, lean, light, decay; lean direction, resonance, blossoms, flush)
 * and the forest's emission.
 */

const barkVertex = /* glsl */ `
${terrainLawGlsl}
${forestLawGlsl}
${barkGlsl}
${forestAirGlsl}
uniform vec3 uGlow[5];
// x: colour, y: emission, z: brightness of this corner of the face, w: shade of the stone
attribute vec4 aGlow;
// x: colour, y: 1 on the vein's edge, z: intensity
attribute vec3 aVein;
varying vec3 vLocal;
varying vec3 vEmit;
varying vec3 vVein;
varying float vGrad;
varying float vEdge;
varying float vShade;
void main() {
  vec3 P = barkPoint();
  float light = uTrees[int(aTree.z + 0.5)].z;
  vEmit = uGlow[int(aGlow.x + 0.5)] * aGlow.y * light;
  vVein = mix(uGlow[int(aVein.x + 0.5)], vec3(1.0), 0.25) * aVein.z * light;
  vGrad = aGlow.z; vEdge = aVein.y; vShade = aGlow.w;
  vLocal = P;
  vec4 view = modelViewMatrix * vec4(P, 1.0);
  forestAir(P, view.xyz);
  gl_Position = projectionMatrix * view;
}
`;

const barkFragment = /* glsl */ `
${forestLightGlsl}
// x: the structural emission E
uniform vec4 uForest;
varying vec3 vLocal;
varying vec3 vEmit;
varying vec3 vVein;
varying float vGrad;
varying float vEdge;
varying float vShade;
void main() {
  // One normal per facet, from the facet itself (it faces the viewer): low-poly by construction.
  vec3 n = normalize(cross(dFdx(vLocal), dFdy(vLocal)));
  vec3 colour = mix(forestBase(n, vLocal, vShade), vFogColour, vFog);
  float e = uForest.x * (1.0 - 0.8 * vFog);
  // A glowing face is brightest at one corner and fades across it; a vein is a line along its edge, a pixel and a half at least.
  colour += vEmit * e * mix(0.18, 1.05, vGrad);
  colour += vVein * e * 1.2 * (1.0 - smoothstep(0.0, fwidth(vEdge) * 1.5 + 0.02, 1.0 - vEdge));
  gl_FragColor = forestOut(colour * vFade);
}
`;

const twigVertex = /* glsl */ `
${terrainLawGlsl}
${forestLawGlsl}
${barkGlsl}
${forestAirGlsl}
void main() {
  vec3 P = barkPoint();
  vec4 view = modelViewMatrix * vec4(P, 1.0);
  forestAir(P, view.xyz);
  gl_Position = projectionMatrix * view;
}
`;

const twigFragment = /* glsl */ `
${forestLightGlsl}
uniform vec3 uTwig;
void main() {
  gl_FragColor = forestOut(mix(uTwig, vFogColour, vFog) * vFade);
}
`;

const leafVertex = /* glsl */ `
${terrainLawGlsl}
${forestLawGlsl}
${leafGlsl}
${forestAirGlsl}
uniform vec3 uGlow[5];
uniform vec4 uForest;
varying vec3 vColour;
void main() {
  int slot = int(aTree.z + 0.5);
  vec3 P = leafPoint(position.x);
  vec4 tree = uTrees[slot], look = uTreeLean[slot];
  vec3 hue = uGlow[int(aLeafLook.w + 0.5)];
  vec4 view = modelViewMatrix * vec4(P, 1.0);
  forestAir(P, view.xyz);
  // Blossoms: their colour lifted to white, dimmer as they fall; nodes: as far as the tree resonates (or buds), on the node scale.
  float light = tree.z * step(0.0, tree.x) * leafOpen;
  vec3 blossom = mix(hue, vec3(1.0), 0.35) * min(1.0, 0.25 + 0.75 * uForest.x * light) * (1.0 - 0.7 * tree.w) + hue * look.w * 0.5 * light;
  vec3 node = hue * light * uForest.y * (0.15 + 1.4 * look.y);
  vColour = pow(mix(blossom, node, leafNode) * (1.0 - 0.7 * vFog) * vFade, vec3(2.2));
  gl_Position = projectionMatrix * view;
}
`;

const filamentVertex = /* glsl */ `
${terrainLawGlsl}
${forestLawGlsl}
${forestAirGlsl}
uniform vec3 uGlow[5];
// x: J, y: R, z: slot, w: height of the crown (units) — of the tree at this end
attribute vec4 aEndA;
attribute vec4 aEndB;
varying vec3 vColour;
void main() {
  vec4 e = position.x < 0.5 ? aEndA : aEndB;
  int slot = int(e.z + 0.5);
  vec3 P = forestRoot(e.x, e.y) + forestLean(vec3(0.0, e.w, 0.0), slot);
  vec4 a = uTreeLean[int(aEndA.z + 0.5)], b = uTreeLean[int(aEndB.z + 0.5)];
  vec4 view = modelViewMatrix * vec4(P, 1.0);
  forestAir(P, view.xyz);
  vColour = pow(uGlow[${BLUE}] * 0.6 * a.y * b.y * (1.0 - 0.7 * vFog) * vFade, vec3(2.2));
  gl_Position = projectionMatrix * view;
}
`;

const additiveFragment = /* glsl */ `
varying vec3 vColour;
void main() {
  gl_FragColor = vec4(vColour, 1.0);
}
`;

/** Draw calls at a quality: bark, twigs and blossoms, and the filaments above Low. */
export const forestDrawCalls = (quality: QualityProfile): number => (quality.density >= 0.5 ? 4 : 3);

export class ForestPrimitive implements Primitive {
  readonly object: Object3D;
  readonly field: ForestField;
  readonly detail: Readonly<TreeDetail>;
  readonly elements: number;
  readonly vertices: number;
  readonly drawCalls: number;
  readonly debug: Record<string, number> = { trees: 0, spawned: 0, recycled: 0, decayed: 0, refused: 0, remembering: 0, match: 0, filaments: 0, density: 0, emission: 0, nodes: 0, 'forest ms': 0 };
  private readonly inner = new Group();
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: ShaderMaterial[] = [];
  private readonly uForest = new Vector4();
  /** Bark: position, segment start + birth, owner, glow, vein; twigs: position, segment start + birth, owner. */
  private readonly bark: { position: BufferAttribute; base: BufferAttribute; tree: BufferAttribute; glow: BufferAttribute; vein: BufferAttribute };
  private readonly twig: { position: BufferAttribute; base: BufferAttribute; tree: BufferAttribute };
  private readonly leaf: InstancedBufferAttribute;
  private readonly leafLook: InstancedBufferAttribute;
  private readonly leafTree: InstancedBufferAttribute;
  private readonly endA: InstancedBufferAttribute | null = null;
  private readonly endB: InstancedBufferAttribute | null = null;
  private readonly filaments: InstancedBufferGeometry | null = null;

  constructor(context: PrimitiveContext, private readonly ground: TerrainPrimitive, params: ForestSettings, quality: QualityProfile, lookSettings?: ForestLookSettings) {
    const detail = this.detail = treeDetail(quality);
    const field = this.field = new ForestField(params, context.seed | 0, detail);
    const look = forestLook(lookSettings);
    const vec3 = (hex: string): Float32Array => rgb(hex, new Float32Array(3));
    const shared = {
      ...ground.shared, uTrees: { value: field.trees }, uTreeLean: { value: field.treeLean }, uForest: { value: this.uForest },
      uGlow: { value: glowPalette(look) }, uObsidian: { value: vec3(look.obsidian) }, uTwig: { value: vec3(look.twig) },
      uFogLow: { value: vec3(look.fogLow) }, uFogHigh: { value: vec3(look.fogHigh) }, uFog: { value: new Vector4(look.fog, look.lift, look.ceiling, 0) },
    };
    const dynamic = (size: number, count: number): BufferAttribute => new BufferAttribute(new Float32Array(count * size), size).setUsage(DynamicDrawUsage);
    const instanced = (size: number, count: number): InstancedBufferAttribute => new InstancedBufferAttribute(new Float32Array(count * size), size).setUsage(DynamicDrawUsage);
    const geometry = <G extends BufferGeometry>(g: G, attributes: Record<string, BufferAttribute>): G => {
      for (const [name, attribute] of Object.entries(attributes)) g.setAttribute(name, attribute);
      this.geometries.push(g);
      return g;
    };
    const material = (vertexShader: string, fragmentShader: string, additive: boolean): ShaderMaterial => {
      const m = additive
        ? new ShaderMaterial({ vertexShader, fragmentShader, uniforms: shared, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide })
        : new ShaderMaterial({ vertexShader, fragmentShader, uniforms: shared, side: DoubleSide });
      this.materials.push(m);
      return m;
    };

    // Bark: every slot's triangles, in place; a vertex a tree does not use never grows (it stays on its start).
    const barkCount = MAX_TREES * detail.bark;
    this.bark = { position: dynamic(3, barkCount), base: dynamic(4, barkCount), tree: dynamic(3, barkCount), glow: dynamic(4, barkCount), vein: dynamic(3, barkCount) };
    for (let v = 0; v < barkCount; v++) (this.bark.base.array as Float32Array)[v * 4 + 3] = 9;
    const bark = new Mesh(geometry(new BufferGeometry(), { position: this.bark.position, aBase: this.bark.base, aTree: this.bark.tree, aGlow: this.bark.glow, aVein: this.bark.vein }), material(barkVertex, barkFragment, false));

    const twigCount = MAX_TREES * detail.twig;
    this.twig = { position: dynamic(3, twigCount), base: dynamic(4, twigCount), tree: dynamic(3, twigCount) };
    for (let v = 0; v < twigCount; v++) (this.twig.base.array as Float32Array)[v * 4 + 3] = 9;
    const twigs = new LineSegments(geometry(new BufferGeometry(), { position: this.twig.position, aBase: this.twig.base, aTree: this.twig.tree }), material(twigVertex, twigFragment, false));

    // Blossoms and nodes: one triangle each.
    this.leaf = instanced(4, MAX_TREES * MAX_LEAVES); this.leafLook = instanced(4, MAX_TREES * MAX_LEAVES); this.leafTree = instanced(4, MAX_TREES * MAX_LEAVES);
    const leafGeometry = geometry(new InstancedBufferGeometry(), { position: new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), 3), aLeaf: this.leaf, aLeafLook: this.leafLook, aTree: this.leafTree });
    leafGeometry.instanceCount = MAX_TREES * MAX_LEAVES;
    const leaves = new Mesh(leafGeometry, material(leafVertex, additiveFragment, true));
    for (const drawable of [bark, twigs, leaves]) { drawable.frustumCulled = false; this.inner.add(drawable); }

    // Filaments: none at Low (the logic is the same; only what is drawn).
    const filaments = quality.density >= 0.5;
    if (filaments) {
      this.endA = instanced(4, MAX_FILAMENTS); this.endB = instanced(4, MAX_FILAMENTS);
      this.filaments = geometry(new InstancedBufferGeometry(), { position: new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0]), 3), aEndA: this.endA, aEndB: this.endB });
      this.filaments.instanceCount = 0;
      const lines = new LineSegments(this.filaments, material(filamentVertex, additiveFragment, true));
      lines.frustumCulled = false;
      this.inner.add(lines);
    }
    this.drawCalls = filaments ? 4 : 3;
    this.elements = MAX_TREES * (detail.bark / 3 + detail.twig / 2 + MAX_LEAVES) + (filaments ? MAX_FILAMENTS : 0);
    this.vertices = barkCount + twigCount + MAX_TREES * MAX_LEAVES * 3 + (filaments ? MAX_FILAMENTS * 2 : 0);
    // Laid out as the ground is: the same height under the viewer, the same pitch and bank (copied each frame).
    this.inner.position.y = -ground.params.height;
    const object = new Group();
    object.add(this.inner);
    this.object = object;
  }

  setPalette(): void {
    // The forest's colours are its own (forestLook.ts): nothing to copy.
  }

  update(frame: Readonly<WorldFrame>, presence: number): void {
    const started = import.meta.env.DEV ? performance.now() : 0;
    const ground = this.ground, motion = ground.motion, v = motion.values, p = ground.params, field = this.field;
    this.object.rotation.copy(ground.object.rotation);
    field.step(frame.dt, v, frame.view, frame.geometry, v.row + v.shift, p.rows, p.columns, frame.timed ? frame.snapshot?.cues : undefined, frame.time);
    // A tree seeded this frame: its slot's part of the buffers, once.
    for (let s = 0; s < MAX_TREES; s++) if (field.dirty[s]) { this.write(s); field.dirty[s] = 0; }
    this.uForest.set(field.emission, field.nodes, 0, 0);
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
      d.remembering = s.remembering; d.match = s.match; d.filaments = field.links; d.density = s.density; d.emission = field.emission; d.nodes = field.nodes;
      for (let i = 1; i < TREE_PHASES.length; i++) d[TREE_PHASES[i]] = s.phases[i];
      d['forest ms'] += (performance.now() - started - d['forest ms']) * 0.05;
    }
  }

  /** Writes slot `s`'s shape into its part of the buffers and marks only that part for upload. */
  private write(s: number): void {
    const field = this.field, shape = field.shapes[s], J = field.J[s], R = field.R[s], detail = this.detail;
    const b = this.bark, position = b.position.array as Float32Array, base = b.base.array as Float32Array, tree = b.tree.array as Float32Array;
    const glow = b.glow.array as Float32Array, vein = b.vein.array as Float32Array;
    for (let n = 0; n < detail.bark; n++) {
      const v = s * detail.bark + n, used = n < shape.bark;
      for (let q = 0; q < 3; q++) { position[v * 3 + q] = used ? shape.point[n * 3 + q] : 0; vein[v * 3 + q] = used ? shape.vein[n * 3 + q] : 0; }
      for (let q = 0; q < 4; q++) { base[v * 4 + q] = used ? shape.base[n * 4 + q] : 0; glow[v * 4 + q] = used ? shape.glow[n * 4 + q] : 0; }
      // A vertex the tree does not have is born after the tree is grown: it never grows.
      if (!used) base[v * 4 + 3] = 9;
      tree[v * 3] = J; tree[v * 3 + 1] = R; tree[v * 3 + 2] = s;
    }
    const t = this.twig, tPosition = t.position.array as Float32Array, tBase = t.base.array as Float32Array, tTree = t.tree.array as Float32Array;
    for (let n = 0; n < detail.twig; n++) {
      const v = s * detail.twig + n, used = n < shape.twigs;
      for (let q = 0; q < 3; q++) tPosition[v * 3 + q] = used ? shape.twigPoint[n * 3 + q] : 0;
      for (let q = 0; q < 4; q++) tBase[v * 4 + q] = used ? shape.twigBase[n * 4 + q] : 0;
      if (!used) tBase[v * 4 + 3] = 9;
      tTree[v * 3] = J; tTree[v * 3 + 1] = R; tTree[v * 3 + 2] = s;
    }
    const leaf = this.leaf.array as Float32Array, look = this.leafLook.array as Float32Array, leafTree = this.leafTree.array as Float32Array;
    for (let n = 0; n < MAX_LEAVES; n++) {
      const o = (s * MAX_LEAVES + n) * 4, used = n < shape.leaves;
      for (let q = 0; q < 4; q++) { leaf[o + q] = used ? shape.leaf[n * 4 + q] : 0; look[o + q] = used ? shape.leafLook[n * 4 + q] : 0; }
      if (!used) { look[o] = 0; leaf[o + 3] = 9; }
      leafTree[o] = J; leafTree[o + 1] = R; leafTree[o + 2] = s; leafTree[o + 3] = 0;
    }
    for (const [attribute, per] of [[b.position, detail.bark], [b.base, detail.bark], [b.tree, detail.bark], [b.glow, detail.bark], [b.vein, detail.bark],
      [t.position, detail.twig], [t.base, detail.twig], [t.tree, detail.twig], [this.leaf, MAX_LEAVES], [this.leafLook, MAX_LEAVES], [this.leafTree, MAX_LEAVES]] as const) {
      attribute.addUpdateRange(s * per * attribute.itemSize, per * attribute.itemSize);
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
