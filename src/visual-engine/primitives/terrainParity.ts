import { BufferAttribute, BufferGeometry, Camera, FloatType, InstancedBufferAttribute, InstancedBufferGeometry, Points, RGBAFormat, Scene, ShaderMaterial, Vector4, WebGLRenderer, WebGLRenderTarget } from 'three';
import { packWaves } from '../../render-systems/fields/fieldLaw';
import { MAX_WAVES, WaveField } from '../../render-systems/waves/WaveField';
import { emergenceLawGlsl, emergentPoint, groundVertex, packEmergent, PIECES, SHAPES, TEMPLATE_VERTICES, type Emergent } from './emergenceLaw';
import { createTerrain, packTerrain, TERRAIN_VALUES, terrainLawGlsl, type TerrainValues } from './terrainLaw';

/** What the terrain parity check found (units): the GPU's against the CPU reference, and on the GPU the structures' bases against the ground. */
export interface TerrainParityReport {
  grounds: number;
  /** Ground vertices compared: mean and largest distance GPU ↔ CPU. */
  ground: { points: number; mean: number; max: number; p50: number; p99: number };
  /** Vertices of structures compared: mean and largest distance GPU ↔ CPU. */
  structures: { points: number; mean: number; max: number; p50: number; p99: number };
  /** On the GPU, the base corners of raised cells against the ground's vertices there, as two programs compute them. */
  anchoring: { points: number; max: number };
  /** On the GPU, how far above the lowest of the ground's nine vertices round it the base of a standing solid is at most (≤ 0: buried). */
  standing: { points: number; highest: number };
  /** Per ground: points compared, beyond the tolerance, and the largest distance. */
  perGround: { points: number; beyond: number; max: number }[];
  /** The structure that differs most: its mode (0 raised cell, 1 standing), whether it is broken, and by how much. */
  worst: { mode: number; broken: boolean; shape: number; distance: number };
  /** Values not finite on either side. */
  invalid: number;
  tolerance: number;
  outcome: 'pass' | 'fail';
}

const W = 256;

const groundVertexShader = /* glsl */ `
${terrainLawGlsl}
attribute vec2 aPoint;
varying vec3 vValue;
void main() {
  float d = terrainDepth(aPoint.y);
  vValue = vec3(terrainAcross(aPoint.x, d), terrainHeight(aPoint.x, aPoint.y, d), -d);
  float pixel = float(gl_VertexID);
  gl_Position = vec4((mod(pixel, ${W}.0) + 0.5) / ${W}.0 * 2.0 - 1.0, (floor(pixel / ${W}.0) + 0.5) / ${W}.0 * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const emergentVertexShader = /* glsl */ `
${terrainLawGlsl}
${emergenceLawGlsl}
varying vec3 vValue;
void main() {
  vValue = emergentPoint(position.x, position.y, position.z);
  float pixel = float(gl_InstanceID * ${TEMPLATE_VERTICES} + gl_VertexID);
  gl_Position = vec4((mod(pixel, ${W}.0) + 0.5) / ${W}.0 * 2.0 - 1.0, (floor(pixel / ${W}.0) + 0.5) / ${W}.0 * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vValue;
void main() { gl_FragColor = vec4(vValue, 1.0); }
`;

/**
 * The GPU ↔ CPU parity check of the terrain law and the emergence law: the same grounds (travelled, terraced, plates
 * lifted, a release and wave fronts passing) and the same structures through the shaders on a real WebGL2 context and
 * through the TypeScript references, compared point by point; and, on the GPU, the base corners of raised cells against
 * the ground's vertices at the same lattice points (two programs, one law). A development tool: from a page served by Vite,
 *
 *   (await import('/src/visual-engine/primitives/terrainParity.ts')).runTerrainParity()
 *
 * Expect distances around 1e-5 units (heights reach ±15).
 */
export function runTerrainParity(sharedRenderer?: WebGLRenderer): TerrainParityReport {
  const renderer = sharedRenderer ?? new WebGLRenderer({ canvas: document.createElement('canvas') });
  const previous = renderer.getRenderTarget();
  const target = new WebGLRenderTarget(W, W, { type: FloatType, format: RGBAFormat });
  const scene = new Scene(), camera = new Camera(), out = new Float32Array(W * W * 4);
  const uTerrain = new Float32Array(TERRAIN_VALUES), uWaveA = new Float32Array(MAX_WAVES * 4), uWaveB = new Float32Array(MAX_WAVES * 4);
  const uniforms = { uTerrain: { value: uTerrain }, uWaveA: { value: uWaveA }, uWaveB: { value: uWaveB }, uShapes: { value: SHAPES.map((s) => new Vector4(s.sides, s.taper, 0, 0)) } };
  const groundMaterial = new ShaderMaterial({ vertexShader: groundVertexShader, fragmentShader, uniforms });
  const emergentMaterial = new ShaderMaterial({ vertexShader: emergentVertexShader, fragmentShader, uniforms });
  const report: TerrainParityReport = { grounds: 0, ground: { points: 0, mean: 0, max: 0, p50: 0, p99: 0 }, structures: { points: 0, mean: 0, max: 0, p50: 0, p99: 0 }, anchoring: { points: 0, max: 0 }, standing: { points: 0, highest: -Infinity }, perGround: [], worst: { mode: -1, broken: false, shape: -1, distance: 0 }, invalid: 0, tolerance: 2e-3, outcome: 'pass' };
  const render = (object: Points): void => {
    scene.clear(); scene.add(object);
    renderer.setRenderTarget(target); renderer.setClearColor(0, 0); renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, W, W, out);
  };
  const waves = new WaveField();
  waves.spawn(5, 1, 0, 1.6, 0.22, 1.4); waves.spawn(5.2, 0.8, 0.3, 1.2, 0.18, 0.6, -0.4);
  const grounds: { t: TerrainValues; waves: boolean }[] = [
    { t: { ...createTerrain(), cell: 1.1, relief: 9, rough: 0.5, valley: 5, seedX: 7, seedY: 11, row: 10, shift: 0.3, col: 2, shiftX: 0.4 }, waves: false },
    { t: { ...createTerrain(), cell: 1.1, relief: 11, rough: 0.5, valley: 5, seedX: 19, seedY: 3, row: 400, shift: 0.7, col: -1, shiftX: 0.9, terrace: 1, throat: 0.6, lift: 1.1, ridge: 0.8, crest: 1.4, wave: 1.1 }, waves: true },
    { t: { ...createTerrain(), cell: 1.1, relief: 8, rough: 0.4, valley: 5, seedX: 40, seedY: 90, row: 1021, shift: 0.1, col: 5, shiftX: 0.2, release: 0.8, bulge: 3, front: 30, quake: 0.3, lean: -0.8, plateAfter: 16, stepsAfter: 4, wave: 1.1 }, waves: true },
  ];
  const disposable: (BufferGeometry | InstancedBufferGeometry)[] = [];
  const groundDistances: number[] = [], structureDistances: number[] = [];
  try {
    for (const { t, waves: crossing } of grounds) {
      packTerrain(uTerrain, t);
      if (crossing) packWaves(uWaveA, uWaveB, waves, 5.5); else { uWaveA.fill(0); uWaveB.fill(0); }
      const a = crossing ? uWaveA : undefined, b = crossing ? uWaveB : undefined;
      report.grounds++;
      const mine = { points: 0, beyond: 0, max: 0 };
      report.perGround.push(mine);
      // The ground: a block of lattice points round the valley.
      const points: [number, number][] = [];
      for (let k = 0; k <= 140; k += 2) for (let i = -30; i <= 30; i += 3) points.push([i, k]);
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(points.length * 3), 3));
      g.setAttribute('aPoint', new BufferAttribute(Float32Array.from(points.flat()), 2));
      disposable.push(g);
      render(new Points(g, groundMaterial));
      points.forEach(([i, k], n) => {
        const cpu = groundVertex(t, i, k, a, b), d = Math.hypot(out[n * 4] - cpu[0], out[n * 4 + 1] - cpu[1], out[n * 4 + 2] - cpu[2]);
        if (!Number.isFinite(d)) { report.invalid++; return; }
        groundDistances.push(d);
        report.ground.mean += d; report.ground.max = Math.max(report.ground.max, d); report.ground.points++;
        mine.points++; mine.max = Math.max(mine.max, d); if (d > report.tolerance) mine.beyond++;
      });
      // Structures of every shape and mode, whole, pulsing and broken, at lattice points the ground block holds.
      const structures: Emergent[] = [];
      for (let s = 0; s < 24; s++) {
        structures.push({
          J: t.col + (s % 2 ? 1 : -1) * (6 + (s % 5) * 3), R: (t.row + 12 + s * 5) % 1024, mode: s % 3 === 0 ? 0 : 1, shape: s % SHAPES.length,
          height: 2 + (s % 7), width: 0.3 + 0.09 * (s % 7), rise: s % 4 === 1 ? 0.4 : 1, pulse: s % 6 === 2 ? 0.06 : 0, age: s % 5 === 3 ? 0.15 * s : -1,
          seed: (s * 0.618) % 1, light: 1, turn: s * 0.7,
        });
      }
      const template = new BufferAttribute(new Float32Array(TEMPLATE_VERTICES * 3), 3);
      for (let p = 0; p < PIECES; p++) for (let l = 0; l < 2; l++) for (let c = 0; c < 6; c++) template.setXYZ((p * 2 + l) * 6 + c, c, l, p);
      const anchor = new Float32Array(structures.length * 4), body = new Float32Array(structures.length * 4), brk = new Float32Array(structures.length * 4);
      structures.forEach((e, n) => packEmergent(e, anchor, body, brk, n));
      const geometry = new InstancedBufferGeometry();
      geometry.setAttribute('position', template);
      geometry.setAttribute('aAnchor', new InstancedBufferAttribute(anchor, 4)); geometry.setAttribute('aBody', new InstancedBufferAttribute(body, 4)); geometry.setAttribute('aBreak', new InstancedBufferAttribute(brk, 4));
      geometry.instanceCount = structures.length;
      disposable.push(geometry);
      render(new Points(geometry, emergentMaterial));
      const gpu = Float32Array.from(out);
      structures.forEach((e, n) => {
        for (let p = 0; p < PIECES; p++) for (let l = 0; l < 2; l++) for (let c = 0; c < 6; c++) {
          const at = (n * TEMPLATE_VERTICES + (p * 2 + l) * 6 + c) * 4, cpu = emergentPoint(t, e, c, l, p, a, b);
          const d = Math.hypot(gpu[at] - cpu[0], gpu[at + 1] - cpu[1], gpu[at + 2] - cpu[2]);
          if (!Number.isFinite(d)) { report.invalid++; continue; }
          structureDistances.push(d);
          if (d > report.worst.distance) report.worst = { mode: e.mode, broken: e.age >= 0, shape: e.shape, distance: d };
          report.structures.mean += d; report.structures.max = Math.max(report.structures.max, d); report.structures.points++;
        }
      });
      // On the GPU: the base corners of each raised cell against the ground program's vertex at the same lattice point.
      const cells = structures.filter((e) => e.mode === 0 && e.age < 0), standing = structures.filter((e) => e.mode === 1 && e.age < 0), corners: [number, number][] = [];
      for (const e of cells) { const i = e.J - t.col, k = ((e.R - t.row) % 1024 + 1024) % 1024; corners.push([i, k], [i + 1, k], [i + 1, k + 1], [i, k + 1]); }
      for (const e of standing) { const i = e.J - t.col, k = ((e.R - t.row) % 1024 + 1024) % 1024; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) corners.push([i + a, k + b]); }
      const cg = new BufferGeometry();
      cg.setAttribute('position', new BufferAttribute(new Float32Array(corners.length * 3), 3));
      cg.setAttribute('aPoint', new BufferAttribute(Float32Array.from(corners.flat()), 2));
      disposable.push(cg);
      render(new Points(cg, groundMaterial));
      cells.forEach((e) => {
        const n = structures.indexOf(e), m = cells.indexOf(e);
        for (let c = 0; c < 4; c++) {
          const at = (n * TEMPLATE_VERTICES + c) * 4, q = (m * 4 + c) * 4;
          report.anchoring.max = Math.max(report.anchoring.max, Math.hypot(gpu[at] - out[q], gpu[at + 1] - out[q + 1], gpu[at + 2] - out[q + 2]));
          report.anchoring.points++;
        }
      });
      standing.forEach((e, m) => {
        const n = structures.indexOf(e), first = cells.length * 4 + m * 9;
        let low = Infinity;
        for (let q = 0; q < 9; q++) low = Math.min(low, out[(first + q) * 4 + 1]);
        for (let c = 0; c < 6; c++) {
          report.standing.highest = Math.max(report.standing.highest, gpu[(n * TEMPLATE_VERTICES + c) * 4 + 1] - low);
          report.standing.points++;
        }
      });
    }
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose(); groundMaterial.dispose(); emergentMaterial.dispose();
    for (const g of disposable) g.dispose();
    if (!sharedRenderer) renderer.dispose();
  }
  report.ground.mean /= Math.max(1, report.ground.points); report.structures.mean /= Math.max(1, report.structures.points);
  const at = (x: number[], q: number): number => { const sorted = [...x].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0; };
  report.ground.p50 = at(groundDistances, 0.5); report.ground.p99 = at(groundDistances, 0.99);
  report.structures.p50 = at(structureDistances, 0.5); report.structures.p99 = at(structureDistances, 0.99);
  // What anchoring needs is exact: on the GPU a structure's base is the ground's vertex. The CPU reference only decides
  // (where to stand, which shape): it is held to the bulk of the points; single vertices may differ (see docs: the hash).
  report.outcome = report.invalid === 0 && report.anchoring.max <= 1e-5 && report.standing.highest <= 0 && report.ground.p50 < report.tolerance && report.structures.p50 < report.tolerance ? 'pass' : 'fail';
  return report;
}
