import { Color, Mesh, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Vector4 } from 'three';
import { SPECTRUM_BINS } from '../../audio/analysis/AudioAnalyzer';
import { Envelope } from '../../audio/visual-response/Envelope';
import { sampleSpectrumRange } from '../../audio/visual-response/spectrum';
import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import type { PaletteColors, Visualizer, VisualizerContext, VisualizerPreset } from '../../types/visualizer';
import { HORIZON, SCENE_CENTER } from '../../renderer/compositeShader';
import { disposeObject } from '../shared/dispose';
import { SignalTexture } from '../shared/SignalTexture';

export interface LiquidParams {
  /** Number of layered ribbons (max 8). */
  ribbons: number;
  amplitude: number;
  ripple: number;
  speed: number;
  /** Opacity of the body under each ribbon. */
  fill: number;
  /** Edge line width in device pixels. */
  lineWidth: number;
  /** How much each ribbon is shaped by its own band of the spectrum (× amplitude). */
  imprint: number;
  /** Waveform displacement of the middle ribbons (× amplitude). */
  waveDepth: number;
  /** Height of the shock ripples sent by impacts (× amplitude). */
  shock: number;
}

const MAX_RIBBONS = 8;
/** Waveform points sent to the GPU (averaged down from WAVEFORM_SIZE). */
const WAVE_POINTS = 128;
/** Shock ripples alive at once. */
const SHOCKS = 4;
/** Width of each ribbon's band of the spectrum (positions 0..1). */
const ZONE_WIDTH = 0.3;
/** An impact above this, rising, sends a shock ripple. */
const SHOCK_THRESHOLD = 0.5;
const SHOCK_MIN_INTERVAL = 0.15;

const vertexShader = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = (modelMatrix * vec4(position, 1.0)).xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/*
 * Everything that is the same for every pixel of a ribbon (phases,
 * amplitudes, colours) is computed on the CPU in update(); the shader only
 * sums the displacement terms per pixel. This keeps it light enough for
 * integrated GPUs (fewer live registers), which matters at 1080p+.
 */
const fragmentShader = /* glsl */ `
  #define MAX_RIBBONS ${MAX_RIBBONS}
  #define SHOCKS ${SHOCKS}
  uniform float uHalfWidth;
  uniform float uHorizonY;
  uniform int uRibbons;
  uniform float uLineWidth;
  uniform float uImprint;
  uniform float uShockGlow;
  uniform float uClock;
  uniform float uGlintRate;
  uniform vec3 uGlintColor;
  // Per ribbon: (base, frequency, phase, amplitude) of the macro swell.
  uniform vec4 uSwell[MAX_RIBBONS];
  // Per ribbon: (frequency, phase, amplitude) of the mid curvature, frequency of the fine ripple.
  uniform vec4 uCurve[MAX_RIBBONS];
  // Per ribbon: phase and amplitude of the fine ripple, waveform and shock amplitudes.
  uniform vec4 uDetailTerms[MAX_RIBBONS];
  // Per ribbon: spectrum band (start, width), glint amount.
  uniform vec4 uBand[MAX_RIBBONS];
  uniform vec3 uBody[MAX_RIBBONS];
  // Per ribbon: edge colour and glow.
  uniform vec4 uEdge[MAX_RIBBONS];
  // Per shock ring: (age, amplitude).
  uniform vec4 uShocks[SHOCKS];
  uniform sampler2D tSpectrum;
  uniform sampler2D tWave;
  varying vec2 vPos;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  // Rings expanding from the scene centre, one per recent impact.
  float shockwave(float x) {
    float s = 0.0;
    for (int i = 0; i < SHOCKS; i++) {
      if (uShocks[i].y < 0.002) continue;
      float d = abs(x) - uShocks[i].x * 1.1;
      s += uShocks[i].y * exp(-d * d * 40.0) * cos(d * 28.0);
    }
    return s;
  }

  void main() {
    float v = vPos.x / (2.0 * uHalfWidth) + 0.5;
    float taper = sin(clamp(v, 0.0, 1.0) * 3.14159265);
    float wave = (texture2D(tWave, vec2(v, 0.5)).r * 2.0 - 1.0) * taper;
    float shock = shockwave(vPos.x);
    float shockGlow = abs(shock) * uShockGlow;
    float mirror = abs(2.0 * v - 1.0);
    float px = fwidth(vPos.y) * uLineWidth;
    vec2 glintSeed = vec2(floor(v * 160.0), floor(uClock * 7.0));
    vec3 color = vec3(0.0);

    for (int k = 0; k < MAX_RIBBONS; k++) {
      if (k >= uRibbons) break;
      vec4 swell = uSwell[k];
      vec4 curve = uCurve[k];
      vec4 terms = uDetailTerms[k];
      vec4 band = uBand[k];
      // Spectrum imprint: the ribbon's own band, its low end at the centre.
      float spectrum = texture2D(tSpectrum, vec2(band.x + mirror * band.y, 0.5)).r;
      float y = swell.x
        + sin(v * swell.y + swell.z) * swell.w
        + sin(v * curve.x + curve.y) * curve.z
        + sin(v * curve.w + terms.x) * terms.y
        + spectrum * uImprint * taper
        + wave * terms.z
        + shock * terms.w;
      float d = vPos.y - y;
      // Body between the ribbon and the horizon.
      if (d < 0.0 && vPos.y > uHorizonY) color += uBody[k];
      // Bright edge, anti-aliased; glints only on the edge.
      float edge = 1.0 - smoothstep(0.0, px, abs(d));
      if (edge > 0.0) {
        vec4 e = uEdge[k];
        color += e.rgb * edge * (e.a + shockGlow);
        if (band.z > 0.0) {
          float r = hash(glintSeed + vec2(0.0, float(k) * 7.0));
          color += uGlintColor * step(1.0 - uGlintRate, r) * band.z * edge;
        }
      }
    }
    gl_FragColor = vec4(color, 1.0);
  }
`;

/**
 * Layered undulating ribbons over the horizon, drawn analytically in one
 * full-screen fragment shader. Each ribbon plays a part of the music:
 * the bottom ones carry the lows (long heavy swells), the middle ones the
 * mids (curvature, shear, the waveform's local shape), the top ones the highs
 * (fine ripples, highlights, glints). Every ribbon is also shaped by its own
 * band of the spectrum, and impacts send shock rings out from the centre.
 */
export class LiquidVisualizer implements Visualizer {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, -1, 1);
  private material!: ShaderMaterial;
  private mesh!: Mesh;
  private ribbons = 0;
  private detailQuality = 1;
  private readonly spectrumTexture = new SignalTexture(SPECTRUM_BINS);
  private readonly waveTexture = new SignalTexture(WAVE_POINTS);
  private readonly wave = new Float32Array(WAVE_POINTS);
  /** Spectrum blurred along frequency, so a pure tone shapes a soft hill, not a spike. */
  private readonly softSpectrum = new Float32Array(SPECTRUM_BINS);
  private readonly blurScratch = new Float32Array(SPECTRUM_BINS);
  private readonly zoneEnvelopes: Envelope[] = [];
  private readonly swell = vec4s(MAX_RIBBONS);
  private readonly curve = vec4s(MAX_RIBBONS);
  private readonly detailTerms = vec4s(MAX_RIBBONS);
  private readonly band = vec4s(MAX_RIBBONS);
  private readonly edge = vec4s(MAX_RIBBONS);
  private readonly body = Array.from({ length: MAX_RIBBONS }, () => new Color());
  /** Palette hue of each ribbon: highlight in the sky, secondary in the middle, primary on the horizon. */
  private readonly hues = Array.from({ length: MAX_RIBBONS }, () => new Color());
  private readonly highlight = new Color();
  private readonly scratch = new Color();
  private readonly shocks = vec4s(SHOCKS);
  private readonly shockAge = new Float32Array(SHOCKS).fill(99);
  private readonly shockStrength = new Float32Array(SHOCKS);
  private shockSlot = 0;
  private sinceShock = 0;
  private lastImpact = 0;
  private time = 0;
  private flowPhase = 0;
  private clock = 0;

  constructor(private readonly preset: VisualizerPreset<LiquidParams>) {}

  init({ renderer, quality }: VisualizerContext): void {
    const p = this.preset.visual;
    this.ribbons = Math.min(p.ribbons, MAX_RIBBONS);
    // Lower quality trims the fine detail (ripples, glints), never the low/mid response.
    this.detailQuality = quality.density >= 0.9 ? 1 : quality.density >= 0.6 ? 0.8 : 0.5;
    for (let k = 0; k < MAX_RIBBONS; k++) {
      const t = this.position(k);
      // Top ribbon → top of the spectrum, bottom ribbon → its low end.
      this.band[k].x = Math.min(Math.max(1 - t - ZONE_WIDTH / 2, 0), 1 - ZONE_WIDTH);
      this.band[k].y = ZONE_WIDTH;
      // Lower bands settle more slowly (weight), higher ones stay quick.
      this.zoneEnvelopes.push(new Envelope(0.05, 0.12 + 0.35 * t));
    }
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uHalfWidth: { value: 1 },
        // Horizon in camera units: the scene centre is at y = 0, half-height = 1.
        uHorizonY: { value: (SCENE_CENTER.y - HORIZON) * 2 },
        uRibbons: { value: this.ribbons },
        uLineWidth: { value: p.lineWidth * renderer.getPixelRatio() },
        uImprint: { value: p.imprint * p.amplitude },
        uShockGlow: { value: 0.8 * p.shock },
        uClock: { value: 0 },
        uGlintRate: { value: 0 },
        uGlintColor: { value: new Color() },
        uSwell: { value: this.swell },
        uCurve: { value: this.curve },
        uDetailTerms: { value: this.detailTerms },
        uBand: { value: this.band },
        uBody: { value: this.body },
        uEdge: { value: this.edge },
        uShocks: { value: this.shocks },
        tSpectrum: { value: this.spectrumTexture.texture },
        tWave: { value: this.waveTexture.texture },
      },
    });
    // Scaled to twice the view in resize(), so it still covers it after the scene-centre offset.
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.scene.add(this.mesh);
  }

  setPalette([primary, secondary, highlight]: PaletteColors): void {
    for (let k = 0; k < MAX_RIBBONS; k++) {
      const t = this.position(k);
      if (t < 0.5) this.hues[k].copy(highlight).lerp(secondary, t * 2);
      else this.hues[k].copy(secondary).lerp(primary, t * 2 - 1);
    }
    this.highlight.copy(highlight);
    (this.material.uniforms.uGlintColor.value as Color).copy(highlight).lerp(this.scratch.setRGB(1, 1, 1), 0.5);
  }

  update(frame: AudioFrame, dt: number, _time: number, response: VisualResponseFrame): void {
    const p = this.preset.visual;
    const { weight, flow, detail, shimmer, density } = response;
    const amplitude = p.amplitude;
    // Drift never stops; the mids push the flow (lateral motion, shear).
    this.time += dt * p.speed * (0.7 + 0.3 * density);
    this.flowPhase += dt * p.speed * (0.1 + 1.2 * flow);
    this.clock += dt;
    const glints = this.detailQuality > 0.6;

    for (let k = 0; k < this.ribbons; k++) {
      // t: 0 = top ribbon (highs, in the sky) … 1 = bottom ribbon (lows, on the horizon).
      const t = this.position(k);
      const lowness = t;
      const highness = 1 - t;
      const midness = 1 - Math.abs(2 * t - 1);
      const dir = k % 2 === 0 ? 1 : -1;
      const band = this.band[k];
      const zone = this.zoneEnvelopes[k].update(sampleSpectrumRange(frame.spectrum, band.x, band.x + band.y), dt);

      // LOW: long heavy swells, deeper on the lower ribbons as the bass weighs in.
      const freq = 2 + 4.5 * highness;
      this.swell[k].set(
        this.material.uniforms.uHorizonY.value + (1 - k / this.ribbons) * 0.5,
        freq,
        this.time * (0.25 + 0.35 * highness) + k * 1.3 + this.flowPhase * (0.35 + 0.65 * midness) * dir,
        amplitude * (0.5 + 0.4 * zone + 1.2 * weight * lowness),
      );
      // MID: secondary curvature; neighbouring ribbons drift in opposite directions (shear).
      this.curve[k].set(freq * 2.3, -this.flowPhase * 1.4 * dir + k * 2.1, amplitude * 0.55 * flow * (0.35 + 0.65 * midness), 26 + 6 * k);
      this.detailTerms[k].set(
        // HIGH: fine ripples, mostly on the upper ribbons.
        this.time * 2.6 * dir + k,
        p.ripple * (0.1 + 1.1 * detail) * (0.3 + 0.7 * highness) * this.detailQuality,
        // Waveform: organic local shape on the middle ribbons.
        p.waveDepth * amplitude * midness * midness * (0.35 + 0.65 * flow),
        // TRANSIENT: shock rings, strongest near the horizon.
        p.shock * amplitude * (0.35 + 0.65 * lowness),
      );
      // Glints along the upper edges: sparse with sustained highs, denser on high transients.
      band.z = glints ? (0.5 * detail + shimmer) * highness * 1.6 : 0;

      // The bass deepens the lower bodies; the highs pull the upper edges towards the highlight hue.
      const hue = this.hues[k];
      this.body[k].copy(hue).multiplyScalar(0.5 * (p.fill * (0.7 + 0.6 * density) + 0.02 * weight * lowness));
      this.scratch.copy(hue).lerp(this.highlight, 0.45 * detail * highness);
      this.edge[k].set(this.scratch.r, this.scratch.g, this.scratch.b, 0.26 + 0.18 * density + 0.3 * zone);
    }

    this.updateSpectrum(frame.spectrum);
    this.updateWave(frame.waveform, dt);
    this.updateShocks(response.impact, dt);

    const u = this.material.uniforms;
    u.uClock.value = this.clock;
    u.uGlintRate.value = 0.02 * detail + 0.12 * shimmer;
  }

  resize(width: number, height: number): void {
    const halfWidth = width / height;
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.updateProjectionMatrix();
    this.mesh.scale.set(halfWidth * 2, 2, 1);
    this.material.uniforms.uHalfWidth.value = halfWidth;
  }

  dispose(): void {
    this.spectrumTexture.dispose();
    this.waveTexture.dispose();
    disposeObject(this.scene);
    this.scene.clear();
  }

  /** 0 = top ribbon … 1 = bottom ribbon. */
  private position(k: number): number {
    const n = Math.min(this.preset.visual.ribbons, MAX_RIBBONS);
    return n > 1 ? Math.min(k, n - 1) / (n - 1) : 1;
  }

  /** Two passes of a 9-tap binomial blur (about ±3 bins, a third of an octave). */
  private updateSpectrum(spectrum: Float32Array): void {
    blur(spectrum, this.blurScratch);
    blur(this.blurScratch, this.softSpectrum);
    this.spectrumTexture.write(this.softSpectrum);
  }

  /** Averages the waveform down and eases it, so it shapes the surface organically instead of flickering. */
  private updateWave(waveform: Float32Array, dt: number): void {
    const step = waveform.length / WAVE_POINTS;
    const follow = 1 - Math.exp(-dt * 12);
    for (let i = 0; i < WAVE_POINTS; i++) {
      let sum = 0;
      const from = Math.floor(i * step);
      for (let j = 0; j < step; j++) sum += waveform[from + j];
      this.wave[i] += (sum / step - this.wave[i]) * follow;
    }
    this.waveTexture.write(this.wave, true);
  }

  /** A rising impact sends a new ring (oldest slot reused); rings expand and fade. */
  private updateShocks(impact: number, dt: number): void {
    this.sinceShock += dt;
    if (impact > SHOCK_THRESHOLD && this.lastImpact <= SHOCK_THRESHOLD && this.sinceShock > SHOCK_MIN_INTERVAL) {
      this.shockAge[this.shockSlot] = 0;
      this.shockStrength[this.shockSlot] = impact;
      this.shockSlot = (this.shockSlot + 1) % SHOCKS;
      this.sinceShock = 0;
    }
    this.lastImpact = impact;
    for (let i = 0; i < SHOCKS; i++) {
      this.shockAge[i] += dt;
      this.shocks[i].set(this.shockAge[i], this.shockStrength[i] * Math.exp(-this.shockAge[i] * 2.5), 0, 0);
    }
  }
}

function vec4s(count: number): Vector4[] {
  return Array.from({ length: count }, () => new Vector4());
}

const BLUR_KERNEL = [1, 8, 28, 56, 70, 56, 28, 8, 1].map((w) => w / 256);
const BLUR_RADIUS = (BLUR_KERNEL.length - 1) / 2;

/** Binomial blur with clamped edges. */
function blur(input: Float32Array, output: Float32Array): void {
  const last = input.length - 1;
  for (let i = 0; i <= last; i++) {
    let sum = 0;
    for (let k = -BLUR_RADIUS; k <= BLUR_RADIUS; k++) {
      const j = i + k < 0 ? 0 : i + k > last ? last : i + k;
      sum += input[j] * BLUR_KERNEL[k + BLUR_RADIUS];
    }
    output[i] = sum;
  }
}
