import { BufferAttribute, BufferGeometry, Camera, FloatType, InstancedBufferAttribute, InstancedBufferGeometry, Points, RGBAFormat, Scene, ShaderMaterial, WebGLRenderer, WebGLRenderTarget } from 'three';
import { packWaves } from '../../render-systems/fields/fieldLaw';
import { MAX_WAVES, WaveField } from '../../render-systems/waves/WaveField';
import { barkGlsl, barkPoint, createShape, forestLawGlsl, growTree, leafGlsl, leafPoint, MAX_TREES, TREE_DETAIL, twigPoint, type TreeShape, type TreeState } from './forestLaw';
import { createTerrain, packTerrain, PERIOD, TERRAIN_VALUES, terrainLawGlsl, type TerrainValues } from './terrainLaw';

/** What the forest parity check found (units). */
export interface ForestParityReport {
  /** Bark, twig and leaf vertices compared, GPU against the CPU reference. */
  branches: { points: number; p50: number; p99: number; max: number };
  twigs: { points: number; p50: number; p99: number; max: number };
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
const barkShader = out(`${barkGlsl}\n#define VERTICES 0\nvec3 value() { return barkPoint(); }`);
const leafShader = out(`${leafGlsl}\n#define VERTICES 3\nvec3 value() { return leafPoint(position.x); }`);
const anchorShader = out(`attribute vec4 aTree;\n#define VERTICES 2\nvec3 value() {\n  float i = aTree.x - T_COL, k = mod(aTree.y - T_ROW, ${PERIOD}.0);\n  return position.x < 0.5 ? forestRoot(aTree.x, aTree.y) : vec3(terrainAcross(i, terrainDepth(k)), terrainHeight(i, k, terrainDepth(k)), -terrainDepth(k));\n}`);
const fragmentShader = /* glsl */ `
varying vec3 vValue;
void main() { gl_FragColor = vec4(vValue, 1.0); }
`;

/**
 * The GPU ↔ CPU parity check of the forest law: trees of several shapes and details, grown, half grown, leaning, decaying, over
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
  const materials = [barkShader, leafShader, anchorShader].map((vertexShader) => new ShaderMaterial({ vertexShader, fragmentShader, uniforms }));
  const report: ForestParityReport = { branches: { points: 0, p50: 0, p99: 0, max: 0 }, twigs: { points: 0, p50: 0, p99: 0, max: 0 }, leaves: { points: 0, p50: 0, p99: 0, max: 0 }, anchoring: { points: 0, max: 0 }, invalid: 0, tolerance: 2e-3, outcome: 'pass' };
  const branchGaps: number[] = [], twigGaps: number[] = [], leafGaps: number[] = [], disposable: BufferGeometry[] = [];
  const waves = new WaveField();
  waves.spawn(5, 1, 0, 1.6, 0.22, 1.4);
  const grounds: { t: TerrainValues; fronts: boolean }[] = [
    { t: { ...createTerrain(), cell: 1.5, relief: 5, rough: 0.3, valley: 6, seedX: 7, seedY: 11, row: 10, shift: 0.3, col: 2, shiftX: 0.4 }, fronts: false },
    { t: { ...createTerrain(), cell: 1.5, relief: 6, rough: 0.3, valley: 6, seedX: 19, seedY: 3, row: 700, shift: 0.7, col: -1, shiftX: 0.9, terrace: 1, lift: 0.8, wave: 0.8 }, fronts: true },
  ];
  const render = (geometry: BufferGeometry, material: ShaderMaterial): void => {
    // Never culled: where a vertex lands is the pixel it writes, not where three would expect the geometry to be.
    const points = new Points(geometry, material);
    points.frustumCulled = false;
    scene.clear(); scene.add(points);
    renderer.setRenderTarget(target); renderer.setClearColor(0, 0); renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, W, W, pixels);
  };
  try {
    for (const { t, fronts } of grounds) {
      packTerrain(uTerrain, t);
      if (fronts) packWaves(uWaveA, uWaveB, waves, 5.5); else { uWaveA.fill(0); uWaveB.fill(0); }
      // Six trees: grown, half grown, leaning, decaying, beside the valley on both sides (detail of the six varies with them;
      // their bark fits the target: 6 × 2 556 < 128²).
      const trees: { state: TreeState; shape: TreeShape }[] = [];
      for (let n = 0; n < 6; n++) {
        const detail = [TREE_DETAIL.high, TREE_DETAIL.medium, TREE_DETAIL.low][n % 3];
        const shape = growTree(1000 + n * 77, { branching: (n % 3) / 2, spread: 0.6 + 0.1 * n, upright: (n % 4) / 4, height: 10 + n, foliage: 0.75 }, detail, createShape(detail));
        const state: TreeState = { J: t.col + (n % 2 ? 1 : -1) * (8 + 2 * n), R: (t.row + 12 + 9 * n) % PERIOD, growth: [1.25, 0.6, 1.25, 1.1, 1.25, 0.9][n], lean: [0, 0, 0.06, -0.05, 0.03, 0][n], around: Math.PI / 2, light: 1, decay: n === 3 ? 0.7 : 0, resonance: 0, leaves: 1, flush: 0 };
        trees.push({ state, shape });
        uTrees.set([state.growth, state.lean, 1, state.decay], n * 4); uTreeLean.set([state.around, 0, state.leaves, 0], n * 4);
      }
      // Bark and twigs: every vertex, as the primitive writes them (one pixel per vertex).
      const vertices = (count: (x: TreeShape) => number, point: (x: TreeShape) => Float32Array, base: (x: TreeShape) => Float32Array, gaps: number[], cpu: (state: TreeState, shape: TreeShape, v: number) => [number, number, number]): void => {
        const total = trees.reduce((sum, x) => sum + count(x.shape), 0);
        const position = new Float32Array(total * 3), start = new Float32Array(total * 4), owner = new Float32Array(total * 3);
        let at = 0;
        trees.forEach(({ state, shape }, slot) => { for (let v = 0; v < count(shape); v++, at++) { position.set(point(shape).subarray(v * 3, v * 3 + 3), at * 3); start.set(base(shape).subarray(v * 4, v * 4 + 4), at * 4); owner.set([state.J, state.R, slot], at * 3); } });
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(position, 3)); g.setAttribute('aBase', new BufferAttribute(start, 4)); g.setAttribute('aTree', new BufferAttribute(owner, 3));
        disposable.push(g);
        render(g, materials[0]);
        at = 0;
        for (const { state, shape } of trees) for (let v = 0; v < count(shape); v++, at++) {
          const q = at * 4, c = cpu(state, shape, v);
          const d = Math.hypot(pixels[q] - c[0], pixels[q + 1] - c[1], pixels[q + 2] - c[2]);
          if (!Number.isFinite(d)) { report.invalid++; continue; }
          gaps.push(d);
        }
      };
      vertices((x) => x.bark, (x) => x.point, (x) => x.base, branchGaps, (state, shape, v) => barkPoint(t, state, shape, v));
      vertices((x) => x.twigs, (x) => x.twigPoint, (x) => x.twigBase, twigGaps, (state, shape, v) => twigPoint(t, state, shape, v));
      let at = 0;
      // Leaves and nodes.
      const count = trees.reduce((sum, x) => sum + x.shape.leaves, 0);
      const leaf = new Float32Array(count * 4), look = new Float32Array(count * 4), owner = new Float32Array(count * 4);
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
  summary(branchGaps, report.branches); summary(twigGaps, report.twigs); summary(leafGaps, report.leaves);
  report.outcome = report.invalid === 0 && report.anchoring.max <= 1e-5 && report.branches.p50 < report.tolerance && report.twigs.p50 < report.tolerance && report.leaves.p50 < report.tolerance ? 'pass' : 'fail';
  return report;
}
