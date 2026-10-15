import { BufferAttribute, BufferGeometry, Camera, FloatType, Points, RGBAFormat, Scene, ShaderMaterial, WebGLRenderer, WebGLRenderTarget } from 'three';
import { packWaves } from '../../render-systems/fields/fieldLaw';
import { MAX_WAVES, WaveField } from '../../render-systems/waves/WaveField';
import { createOcean, OCEAN_VALUES, oceanHeight, oceanLawGlsl, packOcean, WAVES, type OceanValues } from './oceanLaw';
import { WAVE_SHAPES } from './oceanMotion';

/** What the ocean parity check found (units): the GPU's heights against the CPU reference's. */
export interface OceanParityReport {
  seas: number;
  points: number;
  mean: number;
  p50: number;
  p99: number;
  max: number;
  invalid: number;
  tolerance: number;
  outcome: 'pass' | 'fail';
}

const W = 128;

const vertexShader = /* glsl */ `
${oceanLawGlsl}
attribute vec2 aPoint;
varying vec3 vValue;
void main() {
  vValue = vec3(oceanHeight(aPoint.x, aPoint.y), oceanCrest, oceanFront);
  float pixel = float(gl_VertexID);
  gl_Position = vec4((mod(pixel, ${W}.0) + 0.5) / ${W}.0 * 2.0 - 1.0, (floor(pixel / ${W}.0) + 0.5) / ${W}.0 * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vValue;
void main() { gl_FragColor = vec4(vValue, 1.0); }
`;

/**
 * The GPU ↔ CPU parity check of the ocean law: the same seas (calm, a groove with peaked crests, a release and fronts
 * passing, phases far into a long session) through the shader on a real WebGL2 context and through the TypeScript
 * reference, height by height. A development tool: from a page served by Vite,
 *
 *   (await import('/src/visual-engine/primitives/oceanParity.ts')).runOceanParity()
 *
 * Expect differences around 1e-5 units (heights reach ±5).
 */
export function runOceanParity(sharedRenderer?: WebGLRenderer): OceanParityReport {
  const renderer = sharedRenderer ?? new WebGLRenderer({ canvas: document.createElement('canvas') });
  const previous = renderer.getRenderTarget();
  const target = new WebGLRenderTarget(W, W, { type: FloatType, format: RGBAFormat });
  const scene = new Scene(), camera = new Camera(), out = new Float32Array(W * W * 4);
  const uOcean = new Float32Array(OCEAN_VALUES), uSwell = new Float32Array(WAVES * 4), uWaveA = new Float32Array(MAX_WAVES * 4), uWaveB = new Float32Array(MAX_WAVES * 4);
  const material = new ShaderMaterial({ vertexShader, fragmentShader, uniforms: { uOcean: { value: uOcean }, uSwell: { value: uSwell }, uWaveA: { value: uWaveA }, uWaveB: { value: uWaveB } } });
  const waves = new WaveField();
  waves.spawn(5, 1, 0, 1.6, 0.22, 1.4); waves.spawn(5.2, 0.8, 0.3, 1.2, 0.18, 0.6, -0.4);
  const swell = (amplitudes: readonly number[], phase: number): Float32Array => {
    WAVE_SHAPES.forEach(([length, angle], n) => {
      const k = (2 * Math.PI) / length;
      uSwell.set([k * Math.sin(angle), -k * Math.cos(angle), (phase * (n + 1)) % (2 * Math.PI), amplitudes[n]], n * 4);
    });
    return uSwell;
  };
  const seas: { o: OceanValues; amplitudes: number[]; phase: number; fronts: boolean }[] = [
    { o: { ...createOcean(), cell: 1.6, shift: 0.3, seed: 11, row: 10 }, amplitudes: [0.4, 0.2, 0, 0, 0, 0, 0], phase: 0.4, fronts: false },
    { o: { ...createOcean(), cell: 1.6, shift: 0.7, chop: 0.8, seed: 40, row: 3001, wave: 0.9 }, amplitudes: [1.5, 0.8, 0.9, 0.5, 0.4, 0.2, 0.15], phase: 5.9, fronts: true },
    { o: { ...createOcean(), cell: 1.6, shift: 0.1, chop: 0.3, seed: 3, row: 4095, release: 0.9, bulge: 3.8, front: 40, wave: 0.9 }, amplitudes: [2.4, 2.4, 1, 1, 1, 0.22, 0.22], phase: 3.3, fronts: true },
  ];
  const report: OceanParityReport = { seas: 0, points: 0, mean: 0, p50: 0, p99: 0, max: 0, invalid: 0, tolerance: 2e-3, outcome: 'pass' };
  const distances: number[] = [], points: [number, number][] = [];
  for (let k = 0; k <= 150; k += 2) for (let i = -50; i <= 50; i += 2) points.push([i, k]);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points.length * 3), 3));
  geometry.setAttribute('aPoint', new BufferAttribute(Float32Array.from(points.flat()), 2));
  try {
    for (const sea of seas) {
      packOcean(uOcean, sea.o);
      swell(sea.amplitudes, sea.phase);
      if (sea.fronts) packWaves(uWaveA, uWaveB, waves, 5.5); else { uWaveA.fill(0); uWaveB.fill(0); }
      scene.clear(); scene.add(new Points(geometry, material));
      renderer.setRenderTarget(target); renderer.setClearColor(0, 0); renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, W, W, out);
      report.seas++;
      points.forEach(([i, k], n) => {
        const cpu = oceanHeight(sea.o, uSwell, i, k, sea.fronts ? uWaveA : undefined, sea.fronts ? uWaveB : undefined), d = Math.abs(out[n * 4] - cpu);
        if (!Number.isFinite(d)) { report.invalid++; return; }
        distances.push(d); report.mean += d; report.max = Math.max(report.max, d); report.points++;
      });
    }
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose(); material.dispose(); geometry.dispose();
    if (!sharedRenderer) renderer.dispose();
  }
  report.mean /= Math.max(1, report.points);
  distances.sort((a, b) => a - b);
  report.p50 = distances[Math.floor(0.5 * distances.length)] ?? 0; report.p99 = distances[Math.floor(0.99 * distances.length)] ?? 0;
  report.outcome = report.invalid === 0 && report.max < report.tolerance ? 'pass' : 'fail';
  return report;
}
