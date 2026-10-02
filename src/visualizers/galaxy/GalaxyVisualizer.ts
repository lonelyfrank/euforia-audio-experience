import type { ModulationState } from '../../director/types';
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial, Vector3, type WebGLRenderer } from 'three';
import { SPECTRUM_BINS } from '../../audio/analysis/AudioAnalyzer';
import { hzToPosition, sampleSpectrumRange } from '../../audio/visual-response/spectrum';
import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import type { PaletteColors, VisualizerContext } from '../../types/visualizer';
import { audibleGlsl } from '../shared/audibleGlsl';
import { BaseVisualizer } from '../shared/BaseVisualizer';
import { RollingTraces, traceGlsl, traceValue } from '../shared/RollingTraces';
import { SignalTexture } from '../shared/SignalTexture';
import { VoiceTextures, voiceGlsl } from '../shared/VoiceTextures';

export interface GalaxyParams {
  count: number;
  radius: number;
  arms: number;
  /** Radians of spiral twist from the centre to the rim. */
  twist: number;
  thickness: number;
  size: number;
  /** Angular speed at full flow (inner stars turn faster). */
  spin: number;
  /** Camera elevation, radians. */
  tilt: number;
  /** How far the arms follow the lead's shape (radians). */
  armWave: number;
  /** Depth of the core shaped by the bass line (× radius). */
  coreShape: number;
  /** Height of the waves sent through the arms by kicks (× radius). */
  ringTrace: number;
  /** Sample-and-hold stepping of the drawn voices, scaled by how percussive the style is. */
  digital: number;
}

const LOW_END = hzToPosition(250);

const vertexShader = /* glsl */ `
  ${voiceGlsl}
  ${traceGlsl}
  ${audibleGlsl}
  uniform sampler2D tSpectrum;
  uniform float uSpin;
  uniform float uRadius;
  uniform float uSize;
  uniform float uWeight;
  uniform float uTension;
  uniform float uRelease;
  uniform float uArmWave;
  uniform float uArmCycles;
  uniform float uArmPhase;
  uniform float uCoreShape;
  uniform float uLobes;
  uniform float uRing;
  uniform float uTwinkle;
  uniform float uSeed;
  uniform float uEmission;
  uniform float uDigital;
  uniform float uPixelRatio;
  uniform vec3 uColors[3];

  // x: radius 0..1, y: base angle, z: arm index, w: size factor
  attribute vec4 aStar;
  attribute float aHeight;

  varying vec3 vColor;

  float hash(float n) {
    return fract(sin(n) * 43758.5453);
  }

  void main() {
    float r = aStar.x;
    // Differential rotation: the core turns faster than the rim.
    float angle = aStar.y + uTension * r * 2.4 + uSpin * (0.4 + 1.0 * (1.0 - r));
    // The arms follow the lead's shape along the radius.
    angle += voiceAt(1.0, r * uArmCycles + uArmPhase, uDigital) * uArmWave * r;
    // The core breathes with the bass and takes the bass line's shape (whole lobes: no seam).
    float core = 1.0 - smoothstep(0.0, 0.35, r);
    float turn = angle / 6.2831853;
    float lobes = floor(uLobes);
    float section = mix(voiceAt(0.0, turn * lobes, uDigital), voiceAt(0.0, turn * (lobes + 1.0), uDigital), fract(uLobes));
    float radius = r * (1.0 + core * (-uWeight * 0.18 + uCoreShape * section));
    // A section release travels from the core to the rim, rather than flashing the whole galaxy.
    float shock = max(0.0, 1.0 - abs(r - (1.0 - uRelease) * 1.4) * 9.0) * uRelease;
    radius += shock * 0.22;
    // Kicks travel out through the arms as a wave of height.
    float wave = traceAt(0.0, 1.0, r) * uRing;
    vec3 p = vec3(cos(angle) * radius, aHeight * (1.0 - r) + wave + shock * 0.12, sin(angle) * radius) * uRadius;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    // Each radius stands for a part of the spectrum: the core the bass, the rim the highs.
    float level = texture2D(tSpectrum, vec2(r, 0.5)).r;
    // Hi-hats make the stars twinkle (a new pattern on every hit).
    float twinkle = 1.0 + uTwinkle * step(0.9, hash(aStar.y * 91.7 + uSeed)) * 0.6;
    float size = uSize * aStar.w * (1.0 + uWeight * 0.6 * core) * twinkle;
    gl_PointSize = size * uPixelRatio * (300.0 / -mv.z);
    int arm = int(aStar.z);
    vec3 color = arm == 0 ? uColors[0] : arm == 1 ? uColors[1] : uColors[2];
    // Each radius vanishes with its band (core = bass, rim = highs).
    vColor = smoothstep(0.0, 0.12, uEmission - hash(aStar.y * 57.3)) * color * (1.0 + shock * 2.0) * (0.35 + 0.65 * (1.0 - r)) * (0.35 + 0.65 * level) * audibleAt(r);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uLevel;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    gl_FragColor = vec4(vColor * smoothstep(0.5, 0.0, d) * (0.45 + uLevel * 0.45), 1.0);
  }
`;

/**
 * A three-armed spiral galaxy seen at a low angle. Positions are computed on
 * the GPU from per-star seeds; the CPU only integrates the spin. Nothing
 * moves without sound.
 * Radius = spectrum (core = bass, rim = highs, each glows with its band);
 * the core breathes with the bass and takes the bass line's shape; the arms
 * follow the lead's shape; the mids spin it; kicks send waves out through the
 * arms; hi-hats make the stars twinkle; energy sets the overall glow.
 */
export class GalaxyVisualizer extends BaseVisualizer<GalaxyParams> {
  private material!: ShaderMaterial;
  private renderer!: WebGLRenderer;
  private readonly voices = new VoiceTextures();
  private readonly traces = new RollingTraces(1);
  private readonly spectrum = new SignalTexture(SPECTRUM_BINS);
  private spin = 0;
  private armPhase = 0;
  private drift = 0;
  private twinkleSeed = 0;
  private lastHighFlux = 0;

  init({ quality, renderer }: VisualizerContext): void {
    const p = this.preset.visual;
    this.renderer = renderer;
    const count = Math.round(p.count * quality.density);
    const stars = new Float32Array(count * 4);
    const heights = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = Math.random() ** 0.7;
      const arm = i % p.arms;
      const spread = (Math.random() - 0.5) * 0.44 * (0.4 + r);
      stars[i * 4] = r;
      stars[i * 4 + 1] = (arm * Math.PI * 2) / p.arms + r * p.twist + spread;
      stars[i * 4 + 2] = arm % 3;
      stars[i * 4 + 3] = 0.8 + Math.random() * 1.4;
      heights[i] = (Math.random() - 0.5) * p.thickness * 0.2;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aStar', new BufferAttribute(stars, 4));
    geometry.setAttribute('aHeight', new BufferAttribute(heights, 1));

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
        uSpin: { value: 0 },
        uRadius: { value: p.radius },
        uSize: { value: p.size },
        uWeight: { value: 0 },
        uTension: { value: 0 },
        uRelease: { value: 0 },
        uArmWave: { value: 0 },
        uArmCycles: { value: 2 },
        uArmPhase: { value: 0 },
        uCoreShape: { value: 0 },
        uLobes: { value: 3 },
        uRing: { value: 0 },
        uTwinkle: { value: 0 },
        uSeed: { value: 0 },
        uEmission: { value: 1 },
        uLevel: { value: 0 },
        uDigital: { value: 0 },
        uPixelRatio: { value: renderer.getPixelRatio() },
        uAudible: { value: new Vector3() },
        uColors: { value: [new Color(), new Color(), new Color()] },
      },
    });
    const points = new Points(geometry, this.material);
    points.frustumCulled = false;
    this.scene.add(points);
  }

  setPalette(colors: PaletteColors): void {
    const target = this.material.uniforms.uColors.value as Color[];
    for (let i = 0; i < 3; i++) target[i].copy(colors[i]);
  }

  update(frame: AudioFrame, dt: number, _time: number, response: VisualResponseFrame, modulation?: ModulationState): void {
    const p = this.preset.visual;
    const { weight, flow, detail, density, music, motion, openness, tension, trace } = response;
    const vary = music.variation;
    // MESO: busy music turns the galaxy; a held chord leaves it almost still.
    const turning = (modulation ? 0.02 + 2.4 * modulation.rotation : 0.04 + 1.4 * motion) * response.audible;
    this.spin += dt * p.spin * flow * music.pace * 1.5 * turning;
    this.armPhase -= dt * flow * music.pace * 0.3 * turning;
    this.drift += dt * flow * turning;
    if (frame.highFlux > 0.5 && this.lastHighFlux <= 0.5) this.twinkleSeed = (this.twinkleSeed + 17.13) % 1000;
    this.lastHighFlux = frame.highFlux;

    this.traces.record(0, traceValue(frame, response, 1, sampleSpectrumRange(frame.spectrum, 0, LOW_END)));
    this.traces.update(music.tempo / (modulation ? 0.4 + 2 * modulation.persistence : 1), dt);
    this.voices.update(frame, music, dt, p.digital);
    this.spectrum.write(frame.spectrum);

    const u = this.material.uniforms;
    u.uSpin.value = this.spin;
    u.uTraceShift.value = this.traces.shift;
    u.uDigital.value = this.voices.digital;
    // Bass is mass; trace belongs to the outward travelling memory, not to mass.
    u.uWeight.value = modulation?.scale ?? weight;
    u.uTension.value = tension;
    u.uRelease.value = music.drop;
    // MACRO: a full sound spreads the galaxy out; a lone voice draws it in.
    u.uRadius.value = p.radius * (0.78 + 0.4 * openness) * (1 - 0.24 * tension);
    // The lead shapes the arms independently of their macro compression.
    u.uArmWave.value = p.armWave * (modulation ? 0.1 + 3 * modulation.distortion : flow) * (0.4 + 0.6 * music.leadVoice);
    u.uArmCycles.value = (1.5 + 2 * vary[3]) * (1 + 0.4 * Math.max(Math.log2(music.leadPitch / 180), 0));
    u.uArmPhase.value = this.armPhase;
    u.uCoreShape.value = p.coreShape * (modulation ? 0.2 * weight + modulation.distortion : weight);
    u.uLobes.value = (3 + 3 * vary[0]) * (1 + 0.4 * Math.max(Math.log2(music.bassPitch / 40), 0));
    u.uRing.value = p.ringTrace * (0.7 + 0.6 * trace) * (modulation ? 0.3 + 2 * modulation.impact : 1);
    u.uTwinkle.value = modulation ? modulation.particleEmission * (0.3 + modulation.turbulence) : detail * music.highPercussion;
    u.uSeed.value = this.twinkleSeed;
    u.uEmission.value = modulation ? 0.25 + 0.85 * modulation.particleEmission : 1;
    u.uLevel.value = density;
    (u.uAudible.value as Vector3).set(response.lowAudible, response.midAudible, response.highAudible);

    const distance = this.preset.camera.distance * (modulation ? 1.12 - 0.25 * modulation.depth : 1);
    const drift = this.preset.camera.drift * (modulation ? 2 * modulation.cameraMotion : 1);
    const tilt = p.tilt + Math.sin(this.drift * 0.06) * 0.06 * drift;
    const yaw = Math.sin(this.drift * 0.04) * 0.3 * drift;
    this.camera.position.set(Math.sin(yaw) * Math.cos(tilt) * distance, Math.sin(tilt) * distance, Math.cos(yaw) * Math.cos(tilt) * distance);
    this.camera.lookAt(0, 0, 0);
  }

  override resize(width: number, height: number): void {
    super.resize(width, height);
    this.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
  }

  override dispose(): void {
    this.voices.dispose();
    this.traces.dispose();
    this.spectrum.dispose();
    super.dispose();
  }
}
