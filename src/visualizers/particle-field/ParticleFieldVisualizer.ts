import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial, type WebGLRenderer } from 'three';
import { SPECTRUM_BINS } from '../../audio/analysis/AudioAnalyzer';
import { hzToPosition, sampleSpectrumRange } from '../../audio/visual-response/spectrum';
import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import type { PaletteColors, VisualizerContext } from '../../types/visualizer';
import { BaseVisualizer } from '../shared/BaseVisualizer';
import { RollingTraces, traceGlsl, traceValue } from '../shared/RollingTraces';
import { SignalTexture } from '../shared/SignalTexture';
import { VoiceTextures, voiceGlsl } from '../shared/VoiceTextures';

export interface ParticleFieldParams {
  count: number;
  depth: number;
  spread: number;
  /** Distance flown per beat of the song (units). */
  beatDistance: number;
  size: number;
  swirl: number;
  /** Depth of the cross-section shaped by the voices (× radius). */
  shape: number;
  /** Radial push of the rings sent into the distance by kicks (× radius). */
  ringTrace: number;
  /** Sample-and-hold stepping of the drawn voices, scaled by how percussive the style is. */
  digital: number;
}

const WHITE = new Color(1, 1, 1);
const LOW_END = hzToPosition(250);
/** Kick rings reach this share of the field's depth. */
const TRACE_REACH = 0.7;
/** Concentric shells the particles gather on (each one a polar trace of a voice). */
const SHELLS = 6;

const vertexShader = /* glsl */ `
  ${voiceGlsl}
  ${traceGlsl}
  uniform sampler2D tSpectrum;
  uniform float uTravel;
  uniform float uSparkTravel;
  uniform float uSwirlPhase;
  uniform float uDepth;
  uniform float uSpread;
  uniform float uSize;
  uniform float uWeight;
  uniform float uShape;
  uniform float uLobes;
  uniform float uRing;
  uniform float uSparks;
  uniform float uDensity;
  uniform float uSwirl;
  uniform float uFlow;
  uniform float uDigital;
  uniform float uPixelRatio;

  attribute vec4 aSeed;

  varying float vMix;
  varying float vSpark;
  varying float vFade;
  varying float vGlow;

  // A voice wrapped around the axis: whole numbers of lobes (no seam), blended so the count can glide.
  float section(float row, float turn) {
    float lobes = floor(uLobes);
    return mix(voiceAt(row, turn * lobes, uDigital), voiceAt(row, turn * (lobes + 1.0), uDigital), fract(uLobes));
  }

  void main() {
    // seed.w > 0.8: "spark" particles, driven by hi-hats (smaller, faster).
    float spark = step(0.8, aSeed.w);
    float travel = mix(uTravel, uSparkTravel, spark);

    // Endless flight: z wraps around the field depth.
    float z = mod(aSeed.z * uDepth + travel, uDepth) - uDepth;

    // Each particle stands for a part of the spectrum: the core is the bass, the rim the highs.
    // Most gather on SHELLS concentric shells, so the voices' shapes read as clean polar traces;
    // the rest stay loose dust.
    float onShell = step(fract(aSeed.x * 97.13 + aSeed.z * 13.7), 0.6);
    float band = mix(pow(aSeed.y, 0.7), (floor(aSeed.y * ${SHELLS}.0) + 0.5) / ${SHELLS}.0, onShell);
    float level = texture2D(tSpectrum, vec2(band, 0.5)).r;

    // Polar layout around the flight axis, swirling with the mids (twist grows with depth).
    float turn = aSeed.x + uSwirlPhase + z * 0.0035 * uSwirl * uFlow;
    float angle = turn * 6.2831853;
    float radius = (0.08 + band) * uSpread;
    // The cross-section takes the voices' shape: bass line in the core, lead further out.
    radius *= 1.0 + uShape * section(band < 0.45 ? 0.0 : 1.0, turn);
    // Weight expands the cloud; kicks roll away as rings; each band breathes with its level.
    float age = -z / (uDepth * ${TRACE_REACH});
    radius *= 1.0 + uWeight * 0.25 + uRing * traceAt(0.0, 1.0, age) * step(age, 1.0) + level * 0.12;
    vec3 position = vec3(cos(angle) * radius, sin(angle) * radius, z);

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // Emission: a density-dependent share of the field; sparks fade in with the hi-hats.
    float visible = step(aSeed.w, uDensity) * (1.0 - spark) + spark * uSparks;
    float size = uSize * mix(1.0 + uWeight * 1.2 * (1.0 - band), 0.5 + uSparks * 1.5, spark);
    gl_PointSize = visible > 0.01 ? min(size * (300.0 / -mvPosition.z), 9.0) * uPixelRatio : 0.0;

    vMix = aSeed.x;
    vSpark = spark * uSparks;
    vGlow = 0.35 + level * 1.1;
    // Fade in from the far end, fade out right before the camera.
    vFade = smoothstep(-uDepth, -uDepth * 0.6, z) * smoothstep(0.0, -4.0, z);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uSparkColor;
  uniform float uEnergy;
  uniform float uFlash;

  varying float vMix;
  varying float vSpark;
  varying float vFade;
  varying float vGlow;

  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p);
    if (d > 0.5) discard;
    float glow = smoothstep(0.5, 0.0, d);
    vec3 color = mix(mix(uColorA, uColorB, vMix), uSparkColor, step(0.001, vSpark));
    gl_FragColor = vec4(color * glow * vFade * (0.4 + uEnergy * 0.6 + uFlash) * vGlow, 1.0);
  }
`;

/**
 * GPU particle flight: every particle's position is computed in the vertex
 * shader from a static seed and a few uniforms, so the CPU only integrates
 * travel distance each frame. Nothing moves without sound.
 * Particles stand for parts of the spectrum (core = bass, rim = highs) and
 * light up with them; the cross-section takes the shape of the bass line and
 * the lead; the flight advances with the beats; kicks roll away as rings;
 * mids swirl; hi-hats bring sparks; energy sets how much of the field glows.
 */
export class ParticleFieldVisualizer extends BaseVisualizer<ParticleFieldParams> {
  private material!: ShaderMaterial;
  private renderer!: WebGLRenderer;
  private readonly voices = new VoiceTextures();
  private readonly traces = new RollingTraces(1);
  private readonly spectrum = new SignalTexture(SPECTRUM_BINS);
  private travel = 0;
  private sparkTravel = 0;
  private swirlPhase = 0;
  private drift = 0;
  private lastBeats = -1;
  private density = 0.25;

  init({ quality, renderer }: VisualizerContext): void {
    const p = this.preset.visual;
    this.renderer = renderer;
    const count = Math.round(p.count * quality.density);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const geometry = new BufferGeometry();
    // Positions are generated in the shader; the attribute only sets the draw count.
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 4));

    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        tVoices: { value: this.voices.texture },
        tTrace: { value: this.traces.texture },
        tSpectrum: { value: this.spectrum.texture },
        uTraceShift: { value: 0 },
        uTravel: { value: 0 },
        uSparkTravel: { value: 0 },
        uSwirlPhase: { value: 0 },
        uDepth: { value: p.depth },
        uSpread: { value: p.spread },
        uSize: { value: p.size },
        uWeight: { value: 0 },
        uShape: { value: 0 },
        uLobes: { value: 3 },
        uRing: { value: 0 },
        uSparks: { value: 0 },
        uEnergy: { value: 0 },
        uFlash: { value: 0 },
        uDensity: { value: 0.25 },
        uSwirl: { value: p.swirl },
        uFlow: { value: 0 },
        uDigital: { value: 0 },
        uPixelRatio: { value: renderer.getPixelRatio() },
        uColorA: { value: new Color() },
        uColorB: { value: new Color() },
        uSparkColor: { value: new Color() },
      },
    });
    const points = new Points(geometry, this.material);
    points.frustumCulled = false;
    this.scene.add(points);
    this.camera.position.set(0, 0, 0);
  }

  setPalette([primary, secondary, highlight]: PaletteColors): void {
    const u = this.material.uniforms;
    (u.uColorA.value as Color).copy(primary);
    (u.uColorB.value as Color).copy(secondary);
    // Sparks: the highlight hue pushed towards white.
    (u.uSparkColor.value as Color).copy(highlight).lerp(WHITE, 0.5);
  }

  update(frame: AudioFrame, dt: number, _time: number, response: VisualResponseFrame): void {
    const p = this.preset.visual;
    const u = this.material.uniforms;
    const { weight, flow, detail, density, music } = response;
    const vary = music.variation;

    // The flight advances with the beats while music plays; still in silence.
    const stepBeats = this.lastBeats < 0 ? 0 : Math.max(music.beats - this.lastBeats, 0);
    this.lastBeats = music.beats;
    const advance = stepBeats * p.beatDistance * smoothstep(0.02, 0.3, density) * (1 + 0.3 * music.build);
    this.travel += advance;
    this.sparkTravel += advance * 2 + dt * detail * music.highPercussion * 12;
    this.swirlPhase += dt * flow * music.pace * 0.02 * p.swirl * (vary[7] < 0.5 ? -1 : 1);
    this.drift += dt * flow * music.pace;
    // Emission eases towards the current energy so the field swells and recedes (a faint rest in silence).
    this.density += (0.25 + density * 0.55 - this.density) * Math.min(dt * 2, 1);

    this.traces.record(0, traceValue(frame, response, 1, sampleSpectrumRange(frame.spectrum, 0, LOW_END)));
    this.traces.update(music.tempo, dt);
    this.voices.update(frame, music, dt, p.digital);
    this.spectrum.write(frame.spectrum);

    u.uTravel.value = this.travel;
    u.uSparkTravel.value = this.sparkTravel;
    u.uSwirlPhase.value = this.swirlPhase;
    u.uTraceShift.value = this.traces.shift;
    u.uDigital.value = this.voices.digital;
    u.uWeight.value = weight;
    u.uShape.value = p.shape * (0.3 * weight + 0.7 * flow);
    u.uLobes.value = (2 + 4 * vary[0]) * (1 + 0.4 * Math.max(Math.log2(music.bassPitch / 40), 0));
    u.uRing.value = p.ringTrace * (1 + music.drop);
    u.uSparks.value = detail * (0.2 + 0.8 * music.highPercussion);
    u.uFlow.value = flow;
    u.uEnergy.value = density;
    u.uFlash.value = 0.6 * music.drop;
    u.uDensity.value = this.density;

    // The camera sways with the mids only.
    const sway = this.preset.camera.drift;
    this.camera.rotation.z = Math.sin(this.drift * 0.05) * 0.3 * sway;
    this.camera.position.x = Math.sin(this.drift * 0.13) * 1.5 * sway;
    this.camera.position.y = Math.cos(this.drift * 0.11) * 1.5 * sway;
  }

  override resize(width: number, height: number): void {
    super.resize(width, height);
    // Point sizes are in device pixels; the ratio changes with quality/resolution.
    this.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
  }

  override dispose(): void {
    this.voices.dispose();
    this.traces.dispose();
    this.spectrum.dispose();
    super.dispose();
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
