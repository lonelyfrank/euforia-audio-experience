import { Color, Mesh, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Vector4 } from 'three';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { SPECTRUM_BINS } from '../../audio/analysis/AudioAnalyzer';
import { Envelope } from '../../audio/visual-response/Envelope';
import { sampleSpectrumRange } from '../../audio/visual-response/spectrum';
import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import type { PaletteColors, SceneLayout, Visualizer, VisualizerContext, VisualizerPreset } from '../../types/visualizer';
import { HORIZON, SCENE_CENTER } from '../../renderer/compositeShader';
import { disposeObject } from '../shared/dispose';
import { RollingTraces, traceGlsl, traceValue } from '../shared/RollingTraces';
import { SignalTexture } from '../shared/SignalTexture';
import { AIR_ROW, BASS_ROW, LEAD_ROW, VoiceTextures, voiceGlsl } from '../shared/VoiceTextures';

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
  /** Height of each ribbon's rolling trace of its band (× amplitude). */
  trace: number;
  /** Sample-and-hold stepping of the drawn voices (0 = smooth … 1 = stepped), scaled by how percussive the style is. */
  digital: number;
  /** Brightness of the measuring grid behind the traces (0 = off). */
  graticule: number;
  /** Phosphor persistence (afterimage damping, 0 = off); High quality only. */
  phosphor: number;
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
  // Per ribbon: (base, cycles across the view, phase, amplitude) of its voice.
  uniform vec4 uSwell[MAX_RIBBONS];
  // Per ribbon: (frequency, phase, amplitude) of the mid curvature, frequency of the fine ripple.
  uniform vec4 uCurve[MAX_RIBBONS];
  // Per ribbon: phase and amplitude of the fine ripple, waveform and shock amplitudes.
  uniform vec4 uDetailTerms[MAX_RIBBONS];
  // Per ribbon: spectrum band (start, width), glint amount, trace height.
  uniform vec4 uBand[MAX_RIBBONS];
  uniform vec3 uBody[MAX_RIBBONS];
  // Per ribbon: edge colour and glow.
  uniform vec4 uEdge[MAX_RIBBONS];
  // Per shock ring: (age, amplitude).
  uniform vec4 uShocks[SHOCKS];
  uniform sampler2D tSpectrum;
  uniform sampler2D tWave;
  // Rolling traces (one row per ribbon) and voices (bass line, lead, air): each ribbon draws one voice.
  ${traceGlsl}
  ${voiceGlsl}
  uniform float uVoiceRow[MAX_RIBBONS];
  uniform float uDigital;
  uniform float uGraticule;
  // 1 without the water: the ground line is not an edge any more, so bodies and grid fade out above it.
  uniform float uOpen;
  uniform vec3 uGridColor;
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

    // Measuring grid, like an instrument's graticule: faint, only in the sky.
    float ground = mix(1.0, smoothstep(uHorizonY, uHorizonY + 0.35, vPos.y), uOpen);
    if (uGraticule > 0.0 && vPos.y > uHorizonY) {
      vec2 cell = vec2(vPos.x, vPos.y - uHorizonY) * 5.0;
      vec2 line = abs(fract(cell + 0.5) - 0.5) / fwidth(cell);
      float grid = 1.0 - min(min(line.x, line.y), 1.0);
      color += uGridColor * grid * uGraticule * ground;
    }

    for (int k = 0; k < MAX_RIBBONS; k++) {
      if (k >= uRibbons) break;
      vec4 swell = uSwell[k];
      vec4 curve = uCurve[k];
      vec4 terms = uDetailTerms[k];
      vec4 band = uBand[k];
      // Spectrum imprint: the ribbon's own band, its low end at the centre.
      float spectrum = texture2D(tSpectrum, vec2(band.x + mirror * band.y, 0.5)).r;
      // Rolling trace: what this band did, written at the centre and scrolling out to the edges.
      float trace = traceAt(float(k), float(MAX_RIBBONS), mirror);
      // The voice: one real cycle of the sound, repeated at a length set by its pitch; optionally stepped.
      float voice = voiceAt(uVoiceRow[k], v * swell.y + swell.z, uDigital);
      float y = swell.x
        + voice * swell.w
        + sin(v * curve.x + curve.y) * curve.z
        + sin(v * curve.w + terms.x) * terms.y
        + spectrum * uImprint * taper
        + wave * terms.z
        + shock * terms.w
        + trace * band.w * (1.0 - 0.55 * mirror);
      float d = vPos.y - y;
      // Body between the ribbon and the horizon.
      if (d < 0.0 && vPos.y > uHorizonY) color += uBody[k] * ground;
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
 *
 * Over seconds the scene follows the song (MusicContext): it moves at the
 * song's tempo with the lower swells breathing once per bar, ribbons whose
 * band is absent dim, builds tighten the ripples and drops flash and send a
 * big ring; each song gets its own wave lengths, stacking and flow.
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
  private readonly traces = new RollingTraces(MAX_RIBBONS);
  private readonly voices = new VoiceTextures();
  private readonly voiceRows = new Float32Array(MAX_RIBBONS);
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
  private readonly presenceEnvelopes: Envelope[] = [];
  private readonly swellPhase = new Float32Array(MAX_RIBBONS);
  private readonly curvePhase = new Float32Array(MAX_RIBBONS);
  private readonly ripplePhase = new Float32Array(MAX_RIBBONS);
  private clock = 0;

  constructor(private readonly preset: VisualizerPreset<LiquidParams>) {}

  init({ renderer, quality, addPass }: VisualizerContext): void {
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
      // Presence of the band over seconds: ribbons fade in quickly and out slowly.
      this.presenceEnvelopes.push(new Envelope(1.5, 4));
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
        tTrace: { value: this.traces.texture },
        uTraceShift: { value: 0 },
        tVoices: { value: this.voices.texture },
        uVoiceRow: { value: this.voiceRows },
        uDigital: { value: 0 },
        uGraticule: { value: p.graticule },
        uOpen: { value: 0 },
        uGridColor: { value: new Color() },
      },
    });
    // Phosphor: each frame fades into the next, like the persistence of a scope screen. A full-screen
    // pass (~7 ms at 1080p on an integrated GPU): High only, so Auto drops it when it steps down.
    if (p.phosphor > 0 && quality.density >= 0.9) addPass(new AfterimagePass(p.phosphor), 'pre-bloom');
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
    (this.material.uniforms.uGridColor.value as Color).copy(secondary).lerp(this.scratch.setRGB(1, 1, 1), 0.3);
    (this.material.uniforms.uGlintColor.value as Color).copy(highlight).lerp(this.scratch.setRGB(1, 1, 1), 0.5);
  }

  update(frame: AudioFrame, dt: number, _time: number, response: VisualResponseFrame): void {
    const p = this.preset.visual;
    const { weight, flow, detail, shimmer, density, music } = response;
    const { variation: vary, build, drop } = music;
    const amplitude = p.amplitude;
    this.clock += dt;
    const glints = this.detailQuality > 0.6;

    // Song character (fixed per song, see MusicContext.variation): wave lengths, stacking,
    // curvature, imprint, accent, ripple grain and whether the layers flow together or shear.
    const swellScale = 0.75 + 0.55 * vary[0];
    const stackHeight = 0.4 + 0.2 * vary[2];
    const curveRatio = 1.8 + 1.2 * vary[3];
    const imprint = 0.5 + 0.6 * vary[4];
    const accent = 0.25 + 0.35 * vary[5];
    const rippleGrain = 20 + 14 * vary[6];
    const shear = 2 * vary[7] - 1;

    // Like an oscilloscope, nothing moves on its own: every motion is driven by the sound
    // (silence leaves flat, still traces). Pace: the song's tempo, a little faster while building.
    const pace = music.pace * (1 + 0.25 * build);
    const drift = dt * p.speed * pace * 1.2 * density;
    const push = dt * p.speed * pace * 1.2 * flow;
    // Section and texture: shock rings need a kick pattern, glints need hats, the waveform needs tonal content.
    const shockGate = 0.4 + 0.6 * smoothstep(0.1, 0.4, music.lowPercussion);
    const glintGate = 0.4 + 0.6 * music.highPercussion;
    const waveGate = 0.4 + 0.6 * music.tonality;
    const flash = 0.35 * drop;

    for (let k = 0; k < this.ribbons; k++) {
      // t: 0 = top ribbon (highs, in the sky) … 1 = bottom ribbon (lows, on the horizon).
      const t = this.position(k);
      const lowness = t;
      const highness = 1 - t;
      const midness = 1 - Math.abs(2 * t - 1);
      const dir = k % 2 === 0 ? 1 : shear;
      const band = this.band[k];
      const zone = this.zoneEnvelopes[k].update(sampleSpectrumRange(frame.spectrum, band.x, band.x + band.y), dt);
      // A ribbon whose band has been absent for a while dims and calms; it comes back when its band does.
      const presence = 0.2 + 0.8 * smoothstep(0.08, 0.45, this.presenceEnvelopes[k].update(zone, dt));

      // Phases are integrated (rates may change with the song; phases never jump).
      this.swellPhase[k] += drift * (0.25 + 0.35 * highness) * (1 - lowness) + push * (0.35 + 0.65 * midness) * dir;
      this.curvePhase[k] -= push * 1.4 * dir;
      this.ripplePhase[k] += drift * 2.6 * dir;

      // The voice this ribbon draws: the bass line at the bottom, the lead in the middle, the air on top.
      // Its cycle repeats at a length set by the pitch (higher notes, tighter waves).
      const row = t >= 0.6 ? BASS_ROW : t >= 0.2 ? LEAD_ROW : AIR_ROW;
      this.voiceRows[k] = row;
      const octave = row === BASS_ROW ? Math.log2(music.bassPitch / 40) : Math.log2(music.leadPitch / 180);
      const cycles = (row === AIR_ROW ? 2 : (row === BASS_ROW ? 1.2 : 2.2) + 1.1 * Math.max(octave, 0)) * swellScale * (1 + 0.4 * (k % 2));
      // Amplitude from the ribbon's role: weight for the bass, flow for the lead, detail for the air.
      const drive =
        row === BASS_ROW ? 0.4 * zone + 1.1 * weight * lowness : row === LEAD_ROW ? 0.35 * zone + 0.9 * flow * (0.5 + 0.5 * music.leadVoice) : 0.2 * zone + 0.6 * detail;
      // The voice leads; the synthetic curvature and fine ripples stay only where no voice is drawn.
      const voiced = row === AIR_ROW ? 0 : 1;
      // Phase in cycles: travels with the music; the lower ribbons also advance one cycle per bar with the beat clock.
      this.swell[k].set(
        this.material.uniforms.uHorizonY.value + (1 - k / this.ribbons) * stackHeight,
        cycles,
        (this.swellPhase[k] + k * 1.3) / (2 * Math.PI) + lowness * (music.beats / 4),
        amplitude * presence * drive * (1 + 0.4 * drop * lowness),
      );
      const freq = (2 + 4.5 * highness) * swellScale;
      // MID: secondary curvature; with shear, neighbouring ribbons drift in opposite directions.
      this.curve[k].set(freq * curveRatio, this.curvePhase[k] + k * 2.1, amplitude * presence * 0.55 * flow * (0.35 + 0.65 * midness) * (1 - 0.8 * voiced), rippleGrain + 6 * k);
      this.detailTerms[k].set(
        // HIGH: fine ripples, mostly on the upper ribbons; tighter while building.
        this.ripplePhase[k] + k,
        p.ripple * presence * 1.2 * detail * (0.3 + 0.7 * highness) * (1 + 0.6 * build) * this.detailQuality * (1 - voiced),
        // Waveform: organic local shape on the middle ribbons, for tonal content (voice, pads).
        p.waveDepth * amplitude * midness * midness * (0.35 + 0.65 * flow) * waveGate * (1 - voiced),
        // TRANSIENT: shock rings, strongest near the horizon, when there is a kick pattern.
        p.shock * amplitude * (0.35 + 0.65 * lowness) * shockGate,
      );
      band.z = glints ? (0.5 * detail + shimmer) * highness * 1.6 * glintGate * presence : 0;
      // Trace height; with shear, every other ribbon draws downwards.
      band.w = p.trace * amplitude * (k % 2 === 0 ? 1 : 2 * vary[1] - 1);
      this.traces.record(k, traceValue(frame, response, t, zone));

      // The bass deepens the lower bodies; the highs pull the upper edges towards the highlight hue.
      const hue = this.hues[k];
      this.body[k].copy(hue).multiplyScalar(0.5 * presence * (p.fill * (0.7 + 0.6 * density) + 0.02 * weight * lowness));
      this.scratch.copy(hue).lerp(this.highlight, Math.min(accent * 1.3 * detail * highness + 0.3 * build * highness, 1));
      // A faint trace stays visible in silence, like an idle oscilloscope.
      this.edge[k].set(this.scratch.r, this.scratch.g, this.scratch.b, 0.06 + presence * (0.2 + 0.18 * density + 0.3 * zone) + flash);
    }

    this.material.uniforms.uImprint.value = p.imprint * amplitude * imprint;
    this.voices.update(frame, music, dt, p.digital);
    this.material.uniforms.uDigital.value = this.voices.digital;
    this.updateSpectrum(frame.spectrum);
    this.updateWave(frame.waveform, dt);
    this.updateShocks(response.impact, drop, dt);
    this.traces.update(music.tempo, dt);
    this.material.uniforms.uTraceShift.value = this.traces.shift;

    const u = this.material.uniforms;
    u.uClock.value = this.clock;
    u.uGlintRate.value = (0.02 * detail + 0.12 * shimmer) * glintGate + 0.06 * build;
  }

  /** The ribbons rest on the layout's horizon (the water's edge, or low in the open window). */
  setLayout(layout: SceneLayout): void {
    // Camera units: the scene centre is at y = 0, half-height = 1.
    this.material.uniforms.uHorizonY.value = (layout.centerY - layout.horizon) * 2;
    this.material.uniforms.uOpen.value = 1 - layout.reflection;
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
    this.traces.dispose();
    this.voices.dispose();
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

  /** A rising impact sends a new ring (oldest slot reused), a drop a big one; rings expand and fade. */
  private updateShocks(impact: number, drop: number, dt: number): void {
    this.sinceShock += dt;
    const hit = impact > SHOCK_THRESHOLD && this.lastImpact <= SHOCK_THRESHOLD && this.sinceShock > SHOCK_MIN_INTERVAL;
    if (hit || drop === 1) {
      this.shockAge[this.shockSlot] = 0;
      this.shockStrength[this.shockSlot] = drop === 1 ? 1.6 : impact;
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

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
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
