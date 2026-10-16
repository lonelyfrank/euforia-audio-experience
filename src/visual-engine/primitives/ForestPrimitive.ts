import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedBufferGeometry, LineSegments, Mesh, ShaderMaterial, Vector4, type Object3D } from 'three';
import type { QualityProfile } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';
import { barkGlsl, crystalField, forestHash, forestLawGlsl, GROUND_SLOT, leafGlsl, linkGlsl, MAX_FILAMENTS, MAX_LEAVES, MAX_TREES, treeDetail, type CrystalField, type TreeDetail } from './forestLaw';
import { ForestField, MAX_PULSES, TREE_PHASES, type ForestSettings } from './forestGrowth';
import { forestAirGlsl, forestLightGlsl, forestLook, glowPalette, rgb, type ForestLookSettings } from './forestLook';
import { terrainLawGlsl } from './terrainLaw';
import type { TerrainPrimitive } from './TerrainPrimitive';

/*
 * Resonant Forest's trees, drawn (docs/resonant-forest.md): every tree of the forest field (forestGrowth.ts) as closed,
 * faceted volumes in the ground's own space and from the ground's own uniforms — the same packed terrain law, the same
 * air — so a tree stands where the ground's vertex is and cannot drift from it.
 *
 *   bark        trunks, roots, limbs, branches and the root shards: dark flat-shaded facets under a constant base light,
 *               some faces and the veins glowing with the structural emission; opaque
 *   twigs       thin dark lines at the ends, and the glowing threads crystals hang from
 *   blossoms    blossoms and junction nodes as small triangles, additive
 *   crystals    translucent bipyramids: the trees' (forks, threads, resonance) and the crystal field floating over the
 *               forest (on the ground's slot), additive, bright on their edges
 *   filaments   the resonance network: catenaries between crown anchors (not at Low)
 *   hanging     crystals hanging from some filaments (not at Low)
 *   pulses      light running along filaments on what was heard: a trail and a head (not at Low)
 *
 * A tree's geometry is written into its slot's part of the buffers once, when it is seeded (a partial upload); the crystal
 * field once, when the forest is made. The pools are fixed, so nothing is allocated or rebuilt while it plays. Per frame:
 * two small uniform arrays (growth, lean, light, decay; lean direction, resonance, blossoms, flush), the forest's emission,
 * the filaments' light, and the pulses when one starts or ends.
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
uniform vec3 uGlow[5];
uniform vec3 uTwig;
uniform vec4 uForest;
// x: colour (-1: a dark twig), y: emission (a crystal's thread)
attribute vec2 aLine;
varying vec3 vTwig;
void main() {
  vec3 P = barkPoint();
  vec4 view = modelViewMatrix * vec4(P, 1.0);
  forestAir(P, view.xyz);
  vTwig = aLine.x < 0.0 ? uTwig : uTwig + uGlow[int(aLine.x + 0.5)] * aLine.y * uForest.y;
  gl_Position = projectionMatrix * view;
}
`;

const twigFragment = /* glsl */ `
${forestLightGlsl}
varying vec3 vTwig;
void main() {
  gl_FragColor = forestOut(mix(vTwig, vFogColour, vFog) * vFade);
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

/** What a crystal's fragment reads, whichever law placed it. */
const crystalVaryings = /* glsl */ `
varying vec3 vView;
varying vec3 vBary;
varying vec3 vHue;
varying float vInten;
`;

const crystalVertex = /* glsl */ `
${terrainLawGlsl}
${forestLawGlsl}
${barkGlsl}
${forestAirGlsl}
${crystalVaryings}
uniform vec3 uGlow[5];
uniform vec4 uForest;
// x: colour, y: intensity, z: scale (0: the emission E, 1: the nodes), w: corner of its triangle
attribute vec4 aGem;
void main() {
  vec3 P = barkPoint();
  int slot = int(aTree.z + 0.5);
  float scale = aGem.z > 0.5 ? uForest.y : 0.45 + 0.55 * uForest.x;
  // A tree's crystal answers its tree (resonance, flush, a pulse arriving); the field's stand on the ground's slot, at rest.
  vInten = aGem.y * scale * (0.6 + 0.4 * uTrees[slot].z) * (1.0 + 0.8 * uTreeLean[slot].y);
  vHue = uGlow[int(aGem.x + 0.5)];
  vBary = vec3(aGem.w < 0.5 ? 1.0 : 0.0, abs(aGem.w - 1.0) < 0.5 ? 1.0 : 0.0, aGem.w > 1.5 ? 1.0 : 0.0);
  vec4 view = modelViewMatrix * vec4(P, 1.0);
  vView = view.xyz;
  forestAir(P, view.xyz);
  gl_Position = projectionMatrix * view;
}
`;

const hangingVertex = /* glsl */ `
${terrainLawGlsl}
${forestLawGlsl}
${linkGlsl}
${forestAirGlsl}
${crystalVaryings}
uniform vec3 uGlow[5];
uniform vec4 uForest;
// x: where along the filament, y: size (units), z: colour, w: 1 when this filament carries one
attribute vec4 aHang;
// The corner of its triangle (the template is a unit bipyramid).
attribute float aCorner;
void main() {
  vec3 at = linkPoint(aHang.x);
  float size = aHang.y * linkShown * aHang.w;
  vec3 P = at + vec3(position.x * size, (position.y * 1.4 - 1.6) * size, position.z * size);
  vInten = 0.9 * uForest.y * min(1.5, aLinkB.w);
  vHue = uGlow[int(aHang.z + 0.5)];
  vBary = vec3(aCorner < 0.5 ? 1.0 : 0.0, abs(aCorner - 1.0) < 0.5 ? 1.0 : 0.0, aCorner > 1.5 ? 1.0 : 0.0);
  vec4 view = modelViewMatrix * vec4(P, 1.0);
  vView = view.xyz;
  forestAir(P, view.xyz);
  gl_Position = projectionMatrix * view;
}
`;

const crystalFragment = /* glsl */ `
${forestLightGlsl}
${crystalVaryings}
void main() {
  // Translucent: lit by how squarely a facet faces the eye, a bright rim along its edges, a glow of its own colour.
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
  float facing = abs(dot(n, normalize(-vView))), inten = min(1.0, vInten);
  vec3 base = mix(vHue * (0.35 + 0.5 * facing), vec3(0.92, 0.88, 1.0), 0.08 + 0.18 * facing * inten);
  vec3 fill = mix(base, vFogColour, 0.75 * vFog) * (0.28 + 0.5 * inten) * (1.0 - 0.5 * vFog);
  float b = min(min(vBary.x, vBary.y), vBary.z), edge = 1.0 - smoothstep(0.0, fwidth(b) * 1.5, b);
  vec3 rim = mix(mix(vHue, vec3(1.0), 0.45), vFogColour, 0.7 * vFog) * min(1.0, 0.35 + 0.6 * vInten) * (1.0 - 0.6 * vFog);
  gl_FragColor = forestOut((fill + rim * edge + vHue * min(1.2, vInten) * 0.3) * vFade);
}
`;

const filamentVertex = /* glsl */ `
${terrainLawGlsl}
${forestLawGlsl}
${linkGlsl}
${forestAirGlsl}
uniform vec3 uGlow[5];
uniform vec4 uForest;
varying vec3 vColour;
void main() {
  vec3 P = linkPoint(position.x);
  vec4 view = modelViewMatrix * vec4(P, 1.0);
  forestAir(P, view.xyz);
  vec3 hue = uGlow[int(aAnchorA.w + 0.5)];
  vColour = pow(hue * min(1.4, 0.45 + 0.8 * aLinkB.w * uForest.x) * linkShown * (1.0 - 0.75 * vFog) * vFade, vec3(2.2));
  gl_Position = projectionMatrix * view;
}
`;

const pulseVertex = /* glsl */ `
${terrainLawGlsl}
${forestLawGlsl}
${linkGlsl}
${forestAirGlsl}
uniform vec3 uGlow[5];
uniform float uNow;
// x: start (the audio time of its event), y: duration (s), z: direction (1: from A), w: strength
attribute vec4 aPulse;
varying vec3 vColour;
// The template: a trail (z 0; x along it, tail 0 to head 1; y its side) and a head (z 1; xy its offset in the view).
void main() {
  float age = uNow - aPulse.x, head = clamp(age / aPulse.y, 0.0, 1.0), tail = max(0.0, head - 0.07);
  float alive = step(0.0, age) * (1.0 - smoothstep(aPulse.y, aPulse.y * 1.15 + 0.1, age)) * aPulse.w;
  float along = position.z < 0.5 ? mix(tail, head, position.x) : head;
  float s = aPulse.z > 0.0 ? along : 1.0 - along, ahead = aPulse.z > 0.0 ? min(s + 0.01, 1.0) : max(s - 0.01, 0.0);
  vec3 P = linkPoint(s), Q = linkPoint(ahead) + vec3(1e-4, 0.0, 0.0);
  vec4 view = modelViewMatrix * vec4(P, 1.0);
  vec3 dir = normalize((modelViewMatrix * vec4(Q - P, 0.0)).xyz), side = normalize(cross(dir, vec3(0.0, 0.0, 1.0)) + vec3(0.0, 1e-5, 0.0));
  view.xyz += position.z < 0.5 ? side * position.y * 0.09 * position.x : vec3(position.xy * 0.26, 0.0);
  forestAir(P, view.xyz);
  vec3 hue = mix(uGlow[int(aAnchorA.w + 0.5)], vec3(1.0), 0.4);
  vColour = pow(hue * 1.6 * (position.z < 0.5 ? position.x : 1.2) * alive * linkShown * (1.0 - 0.7 * vFog) * vFade, vec3(2.2));
  gl_Position = projectionMatrix * view;
}
`;

const additiveFragment = /* glsl */ `
varying vec3 vColour;
void main() {
  gl_FragColor = vec4(vColour, 1.0);
}
`;

/** Filament template: segments of the catenary (as line pairs), and the share of filaments a crystal hangs from. */
const SEGMENTS = 16;
const HANGING = 0.45;

/** Draw calls at a quality: bark, twigs, blossoms and crystals; above Low the network, its crystals and its pulses. */
export const forestDrawCalls = (quality: QualityProfile): number => (quality.density >= 0.5 ? 7 : 4);

export class ForestPrimitive implements Primitive {
  readonly object: Object3D;
  readonly field: ForestField;
  readonly detail: Readonly<TreeDetail>;
  /** The crystals floating over the forest (in the first part of the crystal buffers). */
  readonly floating: CrystalField;
  readonly elements: number;
  readonly vertices: number;
  readonly drawCalls: number;
  readonly debug: Record<string, number> = { trees: 0, spawned: 0, recycled: 0, decayed: 0, refused: 0, remembering: 0, match: 0, filaments: 0, remembered: 0, pulses: 0, density: 0, emission: 0, nodes: 0, 'forest ms': 0 };
  private readonly inner = new Group();
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: ShaderMaterial[] = [];
  private readonly uForest = new Vector4();
  private readonly uNow = { value: 0 };
  private readonly bark: { position: BufferAttribute; base: BufferAttribute; tree: BufferAttribute; glow: BufferAttribute; vein: BufferAttribute };
  private readonly twig: { position: BufferAttribute; base: BufferAttribute; tree: BufferAttribute; line: BufferAttribute };
  private readonly gem: { position: BufferAttribute; base: BufferAttribute; tree: BufferAttribute; look: BufferAttribute };
  private readonly leaf: InstancedBufferAttribute;
  private readonly leafLook: InstancedBufferAttribute;
  private readonly leafTree: InstancedBufferAttribute;
  /** The network (above Low): each filament's ends, its hanging crystal, and the pulses' copies of their filaments. */
  private readonly network: {
    link: InstancedBufferAttribute[]; hang: InstancedBufferAttribute; filaments: InstancedBufferGeometry; hanging: InstancedBufferGeometry;
    pulse: InstancedBufferAttribute[]; timing: InstancedBufferAttribute; pulses: InstancedBufferGeometry;
  } | null = null;
  private topology = -1;
  private pulses = -1;

  constructor(context: PrimitiveContext, private readonly ground: TerrainPrimitive, params: ForestSettings, quality: QualityProfile, lookSettings?: ForestLookSettings) {
    const detail = this.detail = treeDetail(quality);
    const field = this.field = new ForestField(params, context.seed | 0, detail);
    const gp = ground.params;
    this.floating = crystalField(context.seed | 0, detail, gp.cell, (gp.columns / 2 - 1) * gp.cell * 0.85, field.params.corridor);
    const look = forestLook(lookSettings);
    const vec3 = (hex: string): Float32Array => rgb(hex, new Float32Array(3));
    const shared = {
      ...ground.shared, uTrees: { value: field.trees }, uTreeLean: { value: field.treeLean }, uForest: { value: this.uForest }, uNow: this.uNow,
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
    const unborn = (base: BufferAttribute): void => { const a = base.array as Float32Array; for (let v = 3; v < a.length; v += 4) a[v] = 9; };
    const drawables: Object3D[] = [];

    // Bark: every slot's triangles, in place; a vertex a tree does not use never grows (it stays on its start).
    const barkCount = MAX_TREES * detail.bark;
    this.bark = { position: dynamic(3, barkCount), base: dynamic(4, barkCount), tree: dynamic(3, barkCount), glow: dynamic(4, barkCount), vein: dynamic(3, barkCount) };
    unborn(this.bark.base);
    drawables.push(new Mesh(geometry(new BufferGeometry(), { position: this.bark.position, aBase: this.bark.base, aTree: this.bark.tree, aGlow: this.bark.glow, aVein: this.bark.vein }), material(barkVertex, barkFragment, false)));

    const twigCount = MAX_TREES * detail.twig;
    this.twig = { position: dynamic(3, twigCount), base: dynamic(4, twigCount), tree: dynamic(3, twigCount), line: dynamic(2, twigCount) };
    unborn(this.twig.base);
    drawables.push(new LineSegments(geometry(new BufferGeometry(), { position: this.twig.position, aBase: this.twig.base, aTree: this.twig.tree, aLine: this.twig.line }), material(twigVertex, twigFragment, false)));

    // Blossoms and nodes: one triangle each.
    this.leaf = instanced(4, MAX_TREES * MAX_LEAVES); this.leafLook = instanced(4, MAX_TREES * MAX_LEAVES); this.leafTree = instanced(4, MAX_TREES * MAX_LEAVES);
    const leafGeometry = geometry(new InstancedBufferGeometry(), { position: new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), 3), aLeaf: this.leaf, aLeafLook: this.leafLook, aTree: this.leafTree });
    leafGeometry.instanceCount = MAX_TREES * MAX_LEAVES;
    drawables.push(new Mesh(leafGeometry, material(leafVertex, additiveFragment, true)));

    // Crystals: the field first (written once, on the ground's slot), then every slot's.
    const fieldCount = this.floating.count, gemCount = fieldCount + MAX_TREES * detail.gem;
    this.gem = { position: dynamic(3, gemCount), base: dynamic(4, gemCount), tree: dynamic(3, gemCount), look: dynamic(4, gemCount) };
    unborn(this.gem.base);
    {
      const f = this.floating, position = this.gem.position.array as Float32Array, base = this.gem.base.array as Float32Array, tree = this.gem.tree.array as Float32Array, gemLook = this.gem.look.array as Float32Array;
      position.set(f.point.subarray(0, fieldCount * 3)); base.set(f.base.subarray(0, fieldCount * 4)); gemLook.set(f.look.subarray(0, fieldCount * 4));
      for (let v = 0; v < fieldCount; v++) { tree[v * 3] = f.lattice[v * 2]; tree[v * 3 + 1] = f.lattice[v * 2 + 1]; tree[v * 3 + 2] = GROUND_SLOT; }
    }
    drawables.push(new Mesh(geometry(new BufferGeometry(), { position: this.gem.position, aBase: this.gem.base, aTree: this.gem.tree, aGem: this.gem.look }), material(crystalVertex, crystalFragment, true)));

    // The network: none at Low (the logic is the same; only what is drawn).
    const network = quality.density >= 0.5;
    if (network) {
      const link = [instanced(4, MAX_FILAMENTS), instanced(4, MAX_FILAMENTS), instanced(4, MAX_FILAMENTS), instanced(4, MAX_FILAMENTS)];
      const linkAttributes = (a: InstancedBufferAttribute[]): Record<string, InstancedBufferAttribute> => ({ aLinkA: a[0], aAnchorA: a[1], aLinkB: a[2], aAnchorB: a[3] });
      const strip = new Float32Array(SEGMENTS * 2 * 3);
      for (let k = 0; k < SEGMENTS; k++) { strip[k * 6] = k / SEGMENTS; strip[k * 6 + 3] = (k + 1) / SEGMENTS; }
      const filaments = geometry(new InstancedBufferGeometry(), { position: new BufferAttribute(strip, 3), ...linkAttributes(link) });
      // A hanging crystal: a unit bipyramid of four sides, with the corner of each triangle for its rim.
      const hang = instanced(4, MAX_FILAMENTS), unit: number[] = [], corners: number[] = [];
      for (let j = 0; j < 4; j++) {
        const a = (j / 4) * 2 * Math.PI + 0.3, b = ((j + 1) / 4) * 2 * Math.PI + 0.3;
        unit.push(0, 1, 0, Math.cos(a), 0, Math.sin(a), Math.cos(b), 0, Math.sin(b), 0, -1.2, 0, Math.cos(b), 0, Math.sin(b), Math.cos(a), 0, Math.sin(a));
        corners.push(0, 1, 2, 0, 1, 2);
      }
      const hanging = geometry(new InstancedBufferGeometry(), { position: new BufferAttribute(new Float32Array(unit), 3), aCorner: new BufferAttribute(new Float32Array(corners), 1), ...linkAttributes(link), aHang: hang });
      // A pulse: a trail (two triangles, tail to head) and a head (a diamond in the view).
      const pulseTemplate = new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, -1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1, 0, 1, -1, 0, 1, 0, -1, 1, -1, 0, 1, 1, 0, 1]);
      const pulse = [instanced(4, MAX_PULSES), instanced(4, MAX_PULSES), instanced(4, MAX_PULSES), instanced(4, MAX_PULSES)], timing = instanced(4, MAX_PULSES);
      const pulses = geometry(new InstancedBufferGeometry(), { position: new BufferAttribute(pulseTemplate, 3), ...linkAttributes(pulse), aPulse: timing });
      filaments.instanceCount = hanging.instanceCount = MAX_FILAMENTS; pulses.instanceCount = MAX_PULSES;
      this.network = { link, hang, filaments, hanging, pulse, timing, pulses };
      drawables.push(new LineSegments(filaments, material(filamentVertex, additiveFragment, true)));
      drawables.push(new Mesh(hanging, material(hangingVertex, crystalFragment, true)));
      drawables.push(new Mesh(pulses, material(pulseVertex, additiveFragment, true)));
    }
    for (const drawable of drawables) { drawable.frustumCulled = false; this.inner.add(drawable); }
    this.drawCalls = drawables.length;
    this.elements = MAX_TREES * (detail.bark / 3 + detail.twig / 2 + MAX_LEAVES + detail.gem / 3) + fieldCount / 3 + (network ? MAX_FILAMENTS * (SEGMENTS + 8) + MAX_PULSES * 4 : 0);
    this.vertices = barkCount + twigCount + MAX_TREES * MAX_LEAVES * 3 + gemCount + (network ? MAX_FILAMENTS * (SEGMENTS * 2 + 24) + MAX_PULSES * 12 : 0);
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
    field.step(frame.dt, v, frame.view, frame.geometry, v.row + v.shift, p.rows, p.columns, frame.timed ? frame.snapshot?.cues : undefined, frame.time, frame.timed ? frame.clock?.events : undefined);
    // A tree seeded this frame: its slot's part of the buffers, once.
    for (let s = 0; s < MAX_TREES; s++) if (field.dirty[s]) { this.write(s); field.dirty[s] = 0; }
    this.uForest.set(field.emission, field.nodes, 0, 0);
    this.uNow.value = frame.time;
    if (this.network) this.writeNetwork();
    this.inner.visible = presence > 0;
    if (import.meta.env.DEV) {
      const d = this.debug, s = field.stats;
      d.trees = field.live(); d.spawned = s.spawned; d.recycled = s.recycled; d.decayed = s.decayed; d.refused = s.refused;
      d.remembering = s.remembering; d.match = s.match; d.filaments = field.links; d.remembered = s.remembered; d.pulses = s.pulses;
      d.density = s.density; d.emission = field.emission; d.nodes = field.nodes;
      for (let i = 1; i < TREE_PHASES.length; i++) d[TREE_PHASES[i]] = s.phases[i];
      d['forest ms'] += (performance.now() - started - d['forest ms']) * 0.05;
    }
  }

  /** The filaments' ends (when the network changed) and their light (each frame); the pulses when one starts or ends. */
  private writeNetwork(): void {
    const field = this.field, net = this.network!;
    const [linkA, anchorA, linkB, anchorB] = net.link.map((a) => a.array as Float32Array);
    const end = (n: number, into: Float32Array[], at: number): void => {
      const a = field.linkA[n], b = field.linkB[n], sa = field.shapes[a], sb = field.shapes[b], ea = field.anchorA[n] * 3, eb = field.anchorB[n] * 3, o = at * 4;
      into[0][o] = field.J[a]; into[0][o + 1] = field.R[a]; into[0][o + 2] = a; into[0][o + 3] = field.sag[n];
      into[1][o] = sa.anchor[ea]; into[1][o + 1] = sa.anchor[ea + 1]; into[1][o + 2] = sa.anchor[ea + 2]; into[1][o + 3] = field.colour[n];
      into[2][o] = field.J[b]; into[2][o + 1] = field.R[b]; into[2][o + 2] = b; into[2][o + 3] = field.linkLight[n];
      into[3][o] = sb.anchor[eb]; into[3][o + 1] = sb.anchor[eb + 1]; into[3][o + 2] = sb.anchor[eb + 2]; into[3][o + 3] = 0;
    };
    const ends = [linkA, anchorA, linkB, anchorB];
    if (this.topology !== field.topology) {
      this.topology = field.topology;
      const hang = net.hang.array as Float32Array;
      for (let n = 0; n < MAX_FILAMENTS; n++) {
        const a = field.linkA[n], o = n * 4;
        if (a < 0) { for (const into of ends) into.fill(0, o, o + 4); hang[o + 3] = 0; continue; }
        end(n, ends, n);
        // Some filaments carry a crystal, somewhere along their middle, drawn from the trees' seeds.
        const key = field.seeds[a] ^ Math.imul(field.seeds[field.linkB[n]], 31);
        hang[o] = 0.25 + 0.5 * forestHash(key, n + 31); hang[o + 1] = 0.15 + 0.28 * forestHash(key, n + 32); hang[o + 2] = [3, 2, 0, 4][Math.floor(forestHash(key, n + 33) * 4)];
        hang[o + 3] = a !== field.linkB[n] && forestHash(key, n + 34) < HANGING * this.detail.crystals ? 1 : 0;
      }
      for (const attribute of [...net.link, net.hang]) { attribute.clearUpdateRanges(); attribute.needsUpdate = true; }
    } else {
      // Only their light changes.
      for (let n = 0; n < MAX_FILAMENTS; n++) linkB[n * 4 + 3] = field.linkA[n] < 0 ? 0 : field.linkLight[n];
      net.link[2].clearUpdateRanges(); net.link[2].needsUpdate = true;
    }
    if (this.pulses !== field.pulses) {
      this.pulses = field.pulses;
      const copies = net.pulse.map((a) => a.array as Float32Array), timing = net.timing.array as Float32Array;
      for (let q = 0; q < MAX_PULSES; q++) {
        const n = field.pulseLink[q], o = q * 4;
        if (n < 0 || field.linkA[n] < 0) { timing[o + 3] = 0; continue; }
        end(n, copies, q);
        // The start as audio time: a float holds it (and the shader's `uNow`) to a few milliseconds for hours.
        timing[o] = field.pulseStart[q]; timing[o + 1] = field.pulseDuration[q]; timing[o + 2] = field.pulseDirection[q]; timing[o + 3] = field.pulseStrength[q];
      }
      for (const attribute of [...net.pulse, net.timing]) { attribute.clearUpdateRanges(); attribute.needsUpdate = true; }
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
      // On its own lattice point when it is a root crystal.
      tree[v * 3] = J + (used ? shape.site[n * 2] : 0); tree[v * 3 + 1] = R + (used ? shape.site[n * 2 + 1] : 0); tree[v * 3 + 2] = s;
    }
    const t = this.twig, tPosition = t.position.array as Float32Array, tBase = t.base.array as Float32Array, tTree = t.tree.array as Float32Array, tLine = t.line.array as Float32Array;
    for (let n = 0; n < detail.twig; n++) {
      const v = s * detail.twig + n, used = n < shape.twigs;
      for (let q = 0; q < 3; q++) tPosition[v * 3 + q] = used ? shape.twigPoint[n * 3 + q] : 0;
      for (let q = 0; q < 4; q++) tBase[v * 4 + q] = used ? shape.twigBase[n * 4 + q] : 0;
      if (!used) tBase[v * 4 + 3] = 9;
      tLine[v * 2] = used ? shape.twigLook[n * 2] : -1; tLine[v * 2 + 1] = used ? shape.twigLook[n * 2 + 1] : 0;
      tTree[v * 3] = J; tTree[v * 3 + 1] = R; tTree[v * 3 + 2] = s;
    }
    const g = this.gem, gems = shape.crystals, first = this.floating.count + s * detail.gem;
    const gPosition = g.position.array as Float32Array, gBase = g.base.array as Float32Array, gTree = g.tree.array as Float32Array, gLook = g.look.array as Float32Array;
    for (let n = 0; n < detail.gem; n++) {
      const v = first + n, used = n < gems.count;
      for (let q = 0; q < 3; q++) gPosition[v * 3 + q] = used ? gems.point[n * 3 + q] : 0;
      for (let q = 0; q < 4; q++) { gBase[v * 4 + q] = used ? gems.base[n * 4 + q] : 0; gLook[v * 4 + q] = used ? gems.look[n * 4 + q] : 0; }
      if (!used) gBase[v * 4 + 3] = 9;
      gTree[v * 3] = J; gTree[v * 3 + 1] = R; gTree[v * 3 + 2] = s;
    }
    const leaf = this.leaf.array as Float32Array, look = this.leafLook.array as Float32Array, leafTree = this.leafTree.array as Float32Array;
    for (let n = 0; n < MAX_LEAVES; n++) {
      const o = (s * MAX_LEAVES + n) * 4, used = n < shape.leaves;
      for (let q = 0; q < 4; q++) { leaf[o + q] = used ? shape.leaf[n * 4 + q] : 0; look[o + q] = used ? shape.leafLook[n * 4 + q] : 0; }
      if (!used) { look[o] = 0; leaf[o + 3] = 9; }
      leafTree[o] = J; leafTree[o + 1] = R; leafTree[o + 2] = s; leafTree[o + 3] = 0;
    }
    const ranges: [BufferAttribute, number, number][] = [
      [b.position, s * detail.bark, detail.bark], [b.base, s * detail.bark, detail.bark], [b.tree, s * detail.bark, detail.bark], [b.glow, s * detail.bark, detail.bark], [b.vein, s * detail.bark, detail.bark],
      [t.position, s * detail.twig, detail.twig], [t.base, s * detail.twig, detail.twig], [t.tree, s * detail.twig, detail.twig], [t.line, s * detail.twig, detail.twig],
      [g.position, first, detail.gem], [g.base, first, detail.gem], [g.tree, first, detail.gem], [g.look, first, detail.gem],
      [this.leaf, s * MAX_LEAVES, MAX_LEAVES], [this.leafLook, s * MAX_LEAVES, MAX_LEAVES], [this.leafTree, s * MAX_LEAVES, MAX_LEAVES],
    ];
    for (const [attribute, from, count] of ranges) {
      attribute.addUpdateRange(from * attribute.itemSize, count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
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
