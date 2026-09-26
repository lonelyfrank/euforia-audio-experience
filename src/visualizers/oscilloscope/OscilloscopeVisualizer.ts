import { OrthographicCamera, Scene, type InterleavedBufferAttribute } from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { WAVEFORM_SIZE } from '../../audio/analysis/AudioAnalyzer';
import type { AudioFrame } from '../../types/audio';
import type { PaletteColors, Visualizer, VisualizerContext, VisualizerPreset } from '../../types/visualizer';
import { disposeObject } from '../shared/dispose';

export interface OscilloscopeParams {
  traceWidth: number;
  amplitude: number;
  /** Vertical position of the traces relative to the scene centre (units of half-height). */
  offsetY: number;
  /** Phosphor persistence (afterimage damping). */
  persistence: number;
  /** How much each following trace keeps of the previous one (echo). */
  echo: number;
}

const TRACES = 3;
/** Points per trace (the waveform is resampled to this). */
const POINTS = 256;

interface Trace {
  material: LineMaterial;
  segments: InterleavedBufferAttribute;
  /** Displayed samples, eased towards the target each frame. */
  values: Float32Array;
}

/**
 * Three luminous waveform lines in the preset's hues, stretched across the
 * window with tapered ends and phosphor persistence. The first trace follows
 * the signal closely, the next ones lag behind as softer echoes.
 * waveform → shape, volume → amplitude, treble → detail, beat → brightness.
 */
export class OscilloscopeVisualizer implements Visualizer {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, -1, 1);
  private readonly traces: Trace[] = [];
  private halfWidth = 1;

  constructor(private readonly preset: VisualizerPreset<OscilloscopeParams>) {}

  init({ addPass }: VisualizerContext): void {
    for (let k = 0; k < TRACES; k++) {
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(new Float32Array((POINTS - 1) * 6));
      const material = new LineMaterial({ linewidth: this.preset.visual.traceWidth * (1 - k * 0.2), transparent: true });
      const line = new LineSegments2(geometry, material);
      line.frustumCulled = false;
      this.scene.add(line);
      this.traces.push({ material, segments: geometry.attributes.instanceStart as InterleavedBufferAttribute, values: new Float32Array(POINTS) });
    }
    addPass(new AfterimagePass(this.preset.visual.persistence), 'pre-bloom');
  }

  setPalette(colors: PaletteColors): void {
    this.traces.forEach((trace, k) => trace.material.color.copy(colors[k]));
  }

  update(frame: AudioFrame, dt: number): void {
    const p = this.preset.visual;
    const { waveform } = frame;
    const amp = p.amplitude * (0.5 + frame.volume * 0.8);
    const stride = WAVEFORM_SIZE / POINTS;

    for (let k = 0; k < TRACES; k++) {
      const trace = this.traces[k];
      // Trace 0 snaps to the signal; the echoes ease towards the previous trace.
      const follow = k === 0 ? 1 : 1 - Math.exp(-dt * (6 / k) * p.echo);
      const source = k === 0 ? null : this.traces[k - 1].values;
      for (let i = 0; i < POINTS; i++) {
        const target = source ? source[i] * p.echo : waveform[Math.floor(i * stride)];
        trace.values[i] += (target - trace.values[i]) * follow;
      }
      this.writeSegments(trace, amp * (1 - k * 0.18), p.offsetY);
      trace.material.opacity = (0.85 - k * 0.2) * (0.7 + frame.beatPulse * 0.3 + frame.treble * 0.2);
    }
  }

  resize(width: number, height: number): void {
    this.halfWidth = width / height;
    this.camera.left = -this.halfWidth;
    this.camera.right = this.halfWidth;
    this.camera.updateProjectionMatrix();
    for (const trace of this.traces) trace.material.resolution.set(width, height);
  }

  dispose(): void {
    disposeObject(this.scene);
    this.scene.clear();
  }

  /** Writes segment endpoints straight into the GPU buffer (no allocation). */
  private writeSegments(trace: Trace, amp: number, offsetY: number): void {
    const data = trace.segments.data.array as Float32Array;
    const w = this.halfWidth;
    let x0 = 0;
    let y0 = 0;
    for (let i = 0; i < POINTS; i++) {
      const v = i / (POINTS - 1);
      // Tapered ends: the trace fades into the horizon line at both edges.
      const envelope = Math.sin(v * Math.PI);
      const x1 = -w + v * 2 * w;
      const y1 = offsetY + trace.values[i] * amp * envelope;
      if (i > 0) {
        const o = (i - 1) * 6;
        data[o] = x0;
        data[o + 1] = y0;
        data[o + 3] = x1;
        data[o + 4] = y1;
      }
      x0 = x1;
      y0 = y1;
    }
    trace.segments.data.needsUpdate = true;
  }
}
