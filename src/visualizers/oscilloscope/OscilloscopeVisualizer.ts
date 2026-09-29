import { OrthographicCamera, Scene, type InterleavedBufferAttribute } from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { WAVEFORM_SIZE } from '../../audio/analysis/AudioAnalyzer';
import { SHAPE_SIZE } from '../../audio/analysis/VoiceTracker';
import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import type { PaletteColors, Visualizer, VisualizerContext, VisualizerPreset } from '../../types/visualizer';
import { disposeObject } from '../shared/dispose';
import { DIGITAL_STEPS } from '../shared/VoiceTextures';

export interface OscilloscopeParams {
  traceWidth: number;
  /** Height of the input channel (units of half-height). */
  amplitude: number;
  /** Vertical position of the input channel relative to the scene centre (units of half-height). */
  offsetY: number;
  /** Phosphor persistence (afterimage damping); hits lengthen it briefly. */
  persistence: number;
  /** Height of the bass line and lead channels. */
  voiceAmplitude: number;
  /** Distance of the voice channels from the input channel. */
  voiceSpacing: number;
  /** Brightness of the graticule (0 = off). */
  graticule: number;
  /** Sample-and-hold stepping of the voice channels, scaled by how percussive the style is. */
  digital: number;
}

/** Points per channel. */
const POINTS = 256;
/** Graticule: divisions across the height (the width gets as many as fit, square cells). */
const DIVISIONS = 8;

interface Channel {
  line: LineSegments2;
  material: LineMaterial;
  segments: InterleavedBufferAttribute;
  values: Float32Array;
}

/**
 * A three-channel digital oscilloscope stretched across the window, with
 * phosphor persistence and a graticule. CH1 (the protagonist) is the input
 * signal; CH2 and CH3 are the bass line and the lead, each one real cycle of
 * the voice (as the analysis averages it) repeated at a length set by its
 * pitch: a saw bass reads as a sawtooth, a square lead as a square.
 * Silence leaves three flat traces.
 * waveform → CH1, bass weight → trace width, lead/flow → CH3 height,
 * highs → brightness, hits → longer persistence, drop → flash.
 */
export class OscilloscopeVisualizer implements Visualizer {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, -1, 1);
  private readonly channels: Channel[] = [];
  private grid!: LineSegments2;
  private gridMaterial!: LineMaterial;
  private afterimage!: AfterimagePass;
  private halfWidth = 1;
  private bassPhase = 0;
  private leadPhase = 0;

  constructor(private readonly preset: VisualizerPreset<OscilloscopeParams>) {}

  init({ addPass }: VisualizerContext): void {
    const p = this.preset.visual;
    for (let k = 0; k < 3; k++) {
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(new Float32Array((POINTS - 1) * 6));
      const material = new LineMaterial({ linewidth: p.traceWidth * (k === 0 ? 1 : 0.7), transparent: true });
      const line = new LineSegments2(geometry, material);
      line.frustumCulled = false;
      this.scene.add(line);
      this.channels.push({ line, material, segments: geometry.attributes.instanceStart as InterleavedBufferAttribute, values: new Float32Array(POINTS) });
    }
    this.gridMaterial = new LineMaterial({ linewidth: 1, transparent: true, opacity: p.graticule });
    this.grid = new LineSegments2(new LineSegmentsGeometry(), this.gridMaterial);
    this.grid.frustumCulled = false;
    this.grid.visible = p.graticule > 0;
    this.scene.add(this.grid);
    this.afterimage = new AfterimagePass(p.persistence);
    addPass(this.afterimage, 'pre-bloom');
  }

  setPalette(colors: PaletteColors): void {
    this.channels.forEach((channel, k) => channel.material.color.copy(colors[k]));
    this.gridMaterial.color.copy(colors[1]).lerp(colors[2], 0.3);
  }

  update(frame: AudioFrame, dt: number, _time: number, response: VisualResponseFrame): void {
    const p = this.preset.visual;
    const { weight, flow, detail, density, music, motion, openness, tension, trace } = response;
    const [input, bass, lead] = this.channels;

    // CH1: the input, resampled; it flattens to a line as the sound goes (a bare noise floor included).
    const stride = WAVEFORM_SIZE / POINTS;
    for (let i = 0; i < POINTS; i++) input.values[i] = frame.waveform[Math.floor(i * stride)];
    this.write(input, p.offsetY, p.amplitude * (0.5 + 0.8 * frame.volume) * response.presence);

    // CH2 and CH3: one real cycle of each voice, repeated; they drift only with the music.
    // Tension (build-ups) makes the voices more stepped, more "digital".
    const digital = Math.min(1, p.digital * (0.3 + 0.7 * music.stylePercussion) * (1 + 0.5 * tension));
    // MESO: busy music scrolls the voices; a held note stands still on the screen.
    const scroll = 0.6 + 0.7 * motion;
    this.bassPhase += dt * weight * music.pace * 0.2 * scroll;
    this.leadPhase += dt * flow * music.pace * 0.3 * scroll;
    const bassCycles = 2 + 1.5 * Math.max(Math.log2(music.bassPitch / 40), 0);
    const leadCycles = 4 + 2 * Math.max(Math.log2(music.leadPitch / 180), 0);
    fillVoice(bass.values, music.bassLine, bassCycles, this.bassPhase, digital);
    fillVoice(lead.values, music.leadLine, leadCycles, this.leadPhase, digital);
    // Each channel flattens and fades with its region (slowly on a fade, at once on a cut).
    const { lowAudible, midAudible, audible } = response;
    // MACRO: a full sound spreads the channels apart; a lone voice keeps them close.
    const spacing = p.voiceSpacing * (0.85 + 0.3 * openness);
    this.write(bass, p.offsetY - spacing, p.voiceAmplitude * weight * lowAudible);
    this.write(lead, p.offsetY + spacing, p.voiceAmplitude * flow * (0.4 + 0.6 * music.leadVoice) * midAudible);

    // Bass → trace width, highs → brightness, drop → flash.
    const flash = 0.3 * music.drop;
    input.material.linewidth = p.traceWidth * (1 + 0.6 * weight);
    input.material.opacity = Math.min(1, 0.75 + 0.25 * detail + flash) * audible;
    bass.material.opacity = Math.min(1, 0.45 + 0.4 * weight + flash) * lowAudible;
    lead.material.opacity = Math.min(1, 0.45 + 0.4 * flow + flash) * midAudible;
    this.gridMaterial.opacity = p.graticule * (0.8 + 0.4 * density);

    // Hits lengthen the phosphor's persistence for a moment (the impacts' afterimage).
    this.afterimage.uniforms.damp.value = Math.min(0.95, p.persistence + 0.12 * trace);
  }

  resize(width: number, height: number): void {
    this.halfWidth = width / height;
    this.camera.left = -this.halfWidth;
    this.camera.right = this.halfWidth;
    this.camera.updateProjectionMatrix();
    for (const channel of this.channels) channel.material.resolution.set(width, height);
    this.gridMaterial.resolution.set(width, height);
    this.buildGrid();
  }

  dispose(): void {
    disposeObject(this.scene);
    this.scene.clear();
  }

  /** Writes a channel's segment endpoints straight into the GPU buffer (no allocation). */
  private write(channel: Channel, offsetY: number, amp: number): void {
    const data = channel.segments.data.array as Float32Array;
    const w = this.halfWidth;
    let x0 = 0;
    let y0 = 0;
    for (let i = 0; i < POINTS; i++) {
      const v = i / (POINTS - 1);
      // Tapered ends: the trace fades into the horizon line at both edges.
      const envelope = Math.sin(v * Math.PI);
      const x1 = -w + v * 2 * w;
      const y1 = offsetY + channel.values[i] * amp * envelope;
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
    channel.segments.data.needsUpdate = true;
  }

  /** Square graticule cells around the input channel, centre lines a little brighter. Built on resize only. */
  private buildGrid(): void {
    if (!this.grid) return;
    const { offsetY } = this.preset.visual;
    const cell = 2 / DIVISIONS;
    const positions: number[] = [];
    for (let y = -1; y <= 1 + 1e-6; y += cell) positions.push(-this.halfWidth, offsetY + y * 0.5, 0, this.halfWidth, offsetY + y * 0.5, 0);
    for (let x = 0; x <= this.halfWidth + 1e-6; x += cell) {
      positions.push(x, offsetY - 0.5, 0, x, offsetY + 0.5, 0);
      if (x > 0) positions.push(-x, offsetY - 0.5, 0, -x, offsetY + 0.5, 0);
    }
    (this.grid.geometry as LineSegmentsGeometry).setPositions(positions);
  }
}

/** Fills `out` with `cycles` repetitions of one voice cycle from `phase`, optionally stepped (sample-and-hold). */
function fillVoice(out: Float32Array, cycle: Float32Array, cycles: number, phase: number, digital: number): void {
  for (let i = 0; i < out.length; i++) {
    let x = (i / (out.length - 1)) * cycles + phase;
    x += (Math.floor(x * DIGITAL_STEPS) / DIGITAL_STEPS - x) * digital;
    x = (x - Math.floor(x)) * SHAPE_SIZE;
    const j = Math.floor(x);
    const t = x - j;
    out[i] = cycle[j] * (1 - t) + cycle[(j + 1) % SHAPE_SIZE] * t;
  }
}
