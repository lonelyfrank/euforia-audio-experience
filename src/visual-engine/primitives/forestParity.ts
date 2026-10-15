import { BufferAttribute, Camera, FloatType, InstancedBufferAttribute, InstancedBufferGeometry, Points, RGBAFormat, Scene, ShaderMaterial, WebGLRenderer, WebGLRenderTarget, type BufferGeometry } from 'three';
import { packWaves } from '../../render-systems/fields/fieldLaw';
import { MAX_WAVES, WaveField } from '../../render-systems/waves/WaveField';
import { branchGlsl, branchPoint, BRANCH_VERTICES, createShape, forestLawGlsl, growTree, leafGlsl, leafPoint, MAX_TREES, SIDES, type TreeShape, type TreeState } from './forestLaw';
import { createTerrain, packTerrain, PERIOD, TERRAIN_VALUES, terrainLawGlsl, type TerrainValues } from './terrainLaw';

/** What the forest parity check found (units). */
export interface ForestParityReport {
  /** Branch and leaf vertices compared, GPU against the CPU reference. */
  branches: { points: number; p50: number; p99: number; max: number };
  leaves: { points: number; p50: number; p99: number; max: number };
  /** On the GPU: each trunk's root against the ground program's vertex at its lattice point (expected: SINK below, nothing aside). */
  anchoring: { points: number; max: number };
  invalid: number;
  tolerance: number;
  outcome: 'pass' | 'fail';
}

const W = 128;
const out = (body: string): string => /* glsl */ `
${terrainLawGlsl}
${forestLawGlsl}
${body}
varying vec3 vValue;
void main() {
  vValue = value();
  float pixel = float(gl_InstanceID * VERTICES + gl_VertexID);
  gl_Position = vec4((mod(pixel, ${W}.0) + 0.5) / ${W}.0 * 2.0 - 1.0, (floor(pixel / ${W}.0) + 0.5) / ${W}.0 * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;
const branchShader = out(`${branchGlsl}\n#define VERTICES ${BRANCH_VERTICES}\nvec3 value() { return branchPoint(position.x, position.y); }`);
const leafShader = out(`${leafGlsl}\n#define VERTICES 3\nvec3 value() { return leafPoint(position.x); }`);
const anchorShader = out(`attribute vec4 aTree;\n#define VERTICES 2\nvec3 value() {\n  float i = aTree.x - T_COL, k = mod(aTree.y - T_ROW, ${PERIOD}.0);\n  return position.x < 0.5 ? forestRoot(aTree.x, aTree.y) : vec3(terrainAcross(i, terrainDepth(k)), terrainHeight(i, k, terrainDepth(k)), -terrainDepth(k));\n}`);
const fragmentShader = /* glsl */ `
varying vec3 vValue;
void main() { gl_FragColor = vec4(vValue, 1.0); }
`;

/**
 * The GPU ↔ CPU parity check of the forest law: trees of several shapes, grown, half grown, leaning, decaying, over
 * grounds in several states, through the shaders on a real WebGL2 context and through the TypeScript references; and,
 * on the GPU, each trunk's root against the ground's own vertex at its lattice point (two programs, one law). A
 * development tool: from a page served by Vite,
 *
 *   (await import('/src/visual-engine/primitives/forestParity.ts')).runForestParity()
 *
 * The CPU's terrain hash differs from the GPU's in f32 on single lattice points (docs/scene-families.md §6): the
 * comparison against the CPU is held to the bulk of the points; the anchoring, all on the GPU, must be exact.
 */
export function runForestParity(sharedRenderer?: WebGLRenderer): ForestParityReport {
  const renderer = sharedRenderer ?? new WebGLRenderer({ canvas: document.createElement('canvas') });
  const previous = renderer.getRenderTarget();
  const target = new WebGLRenderTarget(W, W, { type: FloatType, format: RGBAFormat });
  const scene = new Scene(), camera = new Camera(), pixels = new Float32Array(W * W * 4);
  const uTerrain = new Float32Array(TERRAIN_VALUES), uWaveA = new Float32Array(MAX_WAVES * 4), uWaveB = new Float32Array(MAX_WAVES * 4);
  const uTrees = new Float32Array(MAX_TREES * 4), uTreeLean = new Float32Array(MAX_TREES * 4);
  const uniforms = { uTerrain: { value: uTerrain }, uWaveA: { value: uWaveA }, uWaveB: { value: uWaveB }, uTrees: { value: uTrees }, uTreeLean: { value: uTreeLean } };
  const materials = [branchShader, leafShader, anchorShader].map((vertexShader) => new ShaderMaterial({ vertexShader, fragmentShader, uniforms }));
  const report: ForestParityReport = { branches: { points: 0, p50: 0, p99: 0, max: 0 }, leaves: { points: 0, p50: 0, p99: 0, max: 0 }, anchoring: { points: 0, max: 0 }, invalid: 0, tolerance: 2e-3, outcome: 'pass' };
  const branchGaps: number[] = [], leafGaps: number[] = [], disposable: BufferGeometry[] = [];
  const waves = new WaveField();
  waves.spawn(5, 1, 0, 1.6, 0.22, 1.4);
  const grounds: { t: TerrainValues; fronts: boolean }[] = [
    { t: { ...createTerrain(), cell: 1.5, relief: 5, rough: 0.3, valley: 6, seedX: 7, seedY: 11, row: 10, shift: 0.3, col: 2, shiftX: 0.4 }, fronts: false },
    { t: { ...createTerrain(), cell: 1.5, relief: 6, rough: 0.3, valley: 6, seedX: 19, seedY: 3, row: 700, shift: 0.7, col: -1, shiftX: 0.9, terrace: 1, lift: 0.8, wave: 0.8 }, fronts: true },
  ];
  const render = (geometry: BufferGeometry, material: ShaderMaterial): void => {
    scene.clear(); scene.add(new Points(geometry, material));
    renderer.setRenderTarget(target); renderer.setClearColor(0, 0); renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, W, W, pixels);
  };
  try {
    for (const { t, fronts } of grounds) {
      packTerrain(uTerrain, t);
      if (fronts) packWaves(uWaveA, uWaveB, waves, 5.5); else { uWaveA.fill(0); uWaveB.fill(0); }
      // Six trees: grown, half grown, leaning, decaying, beside the valley on both sides.
      const trees: { state: TreeState; shape: TreeShape }[] = [];
      for (let n = 0; n < 6; n++) {
        const shape = growTree(1000 + n * 77, { branching: (n % 3) / 2, spread: 0.6 + 0.1 * n, upright: (n % 4) / 4, height: 6 + n, foliage: 0.75 }, createShape());
        const state: TreeState = { J: t.col + (n % 2 ? 1 : -1) * (8 + 2 * n), R: (t.row + 12 + 9 * n) % PERIOD, growth: [1.25, 0.6, 1.25, 1.1, 1.25, 0.9][n], lean: [0, 0, 0.06, -0.05, 0.03, 0][n], around: Math.PI / 2, light: 1, decay: n === 3 ? 0.7 : 0, resonance: 0, leaves: 1, flush: 0 };
        trees.push({ state, shape });
        uTrees.set([state.growth, state.lean, 1, state.decay], n * 4); uTreeLean.set([state.around, 0, state.leaves, 0], n * 4);
      }
      // Branches: one instance per segment, as the primitive writes them.
      const segments = trees.reduce((sum, x) => sum + x.shape.segments, 0);
      const from = new Float32Array(segments * 4), to = new Float32Array(segments * 4), tree = new Float32Array(segments * 4);
      let at = 0;
      trees.forEach(({ state, shape }, slot) => { for (let s = 0; s < shape.segments; s++, at++) { from.set(shape.from.subarray(s * 4, s * 4 + 4), at * 4); to.set(shape.to.subarray(s * 4, s * 4 + 4), at * 4); tree.set([state.J, state.R, slot, shape.radius[s]], at * 4); } });
      const template = new Float32Array(BRANCH_VERTICES * 3);
      for (let c = 0; c < SIDES; c++) { template.set([c, 0, 0], c * 2 * 3); template.set([c, 1, 0], (c * 2 + 1) * 3); }
      const bg = new InstancedBufferGeometry();
      bg.setAttribute('position', new BufferAttribute(template, 3));
      bg.setAttribute('aFrom', new InstancedBufferAttribute(from, 4)); bg.setAttribute('aTo', new InstancedBufferAttribute(to, 4)); bg.setAttribute('aTree', new InstancedBufferAttribute(tree, 4));
      bg.instanceCount = segments; disposable.push(bg);
      render(bg, materials[0]);
      at = 0;
      for (const { state, shape } of trees) for (let s = 0; s < shape.segments; s++, at++) for (let c = 0; c < SIDES; c++) for (let e = 0; e < 2; e++) {
        const q = (at * BRANCH_VERTICES + c * 2 + e) * 4, cpu = branchPoint(t, state, shape, s, c, e);
        const d = Math.hypot(pixels[q] - cpu[0], pixels[q + 1] - cpu[1], pixels[q + 2] - cpu[2]);
        if (!Number.isFinite(d)) { report.invalid++; continue; }
        branchGaps.push(d);
      }
      // Leaves and nodes.
      const count = trees.reduce((sum, x) => sum + x.shape.leaves, 0);
      const leaf = new Float32Array(count * 4), look = new Float32Array(count * 4), owner = new Float32Array(count * 4);
      at = 0;
      trees.forEach(({ state, shape }, slot) => { for (let l = 0; l < shape.leaves; l++, at++) { leaf.set(shape.leaf.subarray(l * 4, l * 4 + 4), at * 4); look.set(shape.leafLook.subarray(l * 4, l * 4 + 4), at * 4); owner.set([state.J, state.R, slot, 0], at * 4); } });
      const lg = new InstancedBufferGeometry();
      lg.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), 3));
      lg.setAttribute('aLeaf', new InstancedBufferAttribute(leaf, 4)); lg.setAttribute('aLeafLook', new InstancedBufferAttribute(look, 4)); lg.setAttribute('aTree', new InstancedBufferAttribute(owner, 4));
      lg.instanceCount = count; disposable.push(lg);
      render(lg, materials[1]);
      at = 0;
      for (const { state, shape } of trees) for (let l = 0; l < shape.leaves; l++, at++) for (let c = 0; c < 3; c++) {
        const q = (at * 3 + c) * 4, cpu = leafPoint(t, state, shape, l, c);
        const d = Math.hypot(pixels[q] - cpu[0], pixels[q + 1] - cpu[1], pixels[q + 2] - cpu[2]);
        if (!Number.isFinite(d)) { report.invalid++; continue; }
        leafGaps.push(d);
      }
      // Anchoring, all on the GPU: the root against the ground's vertex at the same lattice point.
      const roots = new Float32Array(trees.length * 4);
      trees.forEach(({ state }, n) => roots.set([state.J, state.R, n, 0], n * 4));
      const ag = new InstancedBufferGeometry();
      ag.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0]), 3));
      ag.setAttribute('aTree', new InstancedBufferAttribute(roots, 4));
      ag.instanceCount = trees.length; disposable.push(ag);
      render(ag, materials[2]);
      for (let n = 0; n < trees.length; n++) {
        const r = n * 2 * 4, g = (n * 2 + 1) * 4;
        report.anchoring.max = Math.max(report.anchoring.max, Math.abs(pixels[r] - pixels[g]), Math.abs(pixels[r + 2] - pixels[g + 2]), Math.abs(pixels[g + 1] - pixels[r + 1] - 0.08));
        report.anchoring.points++;
      }
    }
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose(); for (const m of materials) m.dispose(); for (const g of disposable) g.dispose();
    if (!sharedRenderer) renderer.dispose();
  }
  const summary = (gaps: number[], into: ForestParityReport['branches']): void => {
    gaps.sort((x, y) => x - y);
    into.points = gaps.length; into.p50 = gaps[Math.floor(0.5 * gaps.length)] ?? 0; into.p99 = gaps[Math.floor(0.99 * gaps.length)] ?? 0; into.max = gaps.at(-1) ?? 0;
  };
  summary(branchGaps, report.branches); summary(leafGaps, report.leaves);
  report.outcome = report.invalid === 0 && report.anchoring.max <= 1e-5 && report.branches.p50 < report.tolerance && report.leaves.p50 < report.tolerance ? 'pass' : 'fail';
  return report;
}
