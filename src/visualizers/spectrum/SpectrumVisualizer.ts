import type { ModulationState } from '../../director/types';
import { REST_VIEW } from '../../world/WorldView';
import { Color, Mesh, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Vector3 } from 'three';
import { SPECTRUM_BINS } from '../../audio/analysis/AudioAnalyzer';
import { hzToPosition } from '../../audio/visual-response/spectrum';
import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import type { PaletteColors, SceneLayout, Visualizer, VisualizerContext, VisualizerPreset } from '../../types/visualizer';
import { audibleGlsl } from '../shared/audibleGlsl';
import { disposeObject } from '../shared/dispose';
import { SignalTexture } from '../shared/SignalTexture';
import { VoiceTextures, voiceGlsl } from '../shared/VoiceTextures';

export interface SpectrumParams {
  /** Radius of the bass line's core trace (units of half-height). */
  coreRadius: number;
  /** Radius of the lead's orbit. */
  leadRadius: number;
  /** Radius where the spectrum ring starts. */
  ringRadius: number;
  /** Length of the spectrum at full level. */
  ringLength: number;
  /** How far the echoes travel outwards before fading. */
  echoSpread: number;
  /** Line width in device pixels. */
  lineWidth: number;
  /** Opacity of the body under the spectrum contour. */
  fill: number;
  /** Depth of the voices' shapes on the core and the orbit (× radius). */
  voiceDepth: number;
  /** Brightness of the polar measuring grid (0 = off). */
  graticule: number;
  /** Sample-and-hold stepping of the drawn voices, scaled by how percussive the style is. */
  digital: number;
}

/** Spectrum rows: the live one and the echoes left behind as motion propagates. */
const MAX_ECHOES = 8;
const ROWS = MAX_ECHOES + 1;
const ECHO_BEATS = 0.5;
const LOW_END = hzToPosition(250);
const MID_END = hzToPosition(2000);
/**
 * Angle from the top (radians) where the spectrum reaches its low end: just
 * above the horizon with the water reflection, the bottom of the circle without it.
 */
const SPAN = 0.6 * Math.PI;
const OPEN_SPAN = Math.PI;
/** Base echo decay (s), lengthened by the trace captured with each event. */
const ECHO_FADE = 0.8;

const vertexShader = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = (modelMatrix * vec4(position, 1.0)).xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  #define MAX_ECHOES ${MAX_ECHOES}
  ${voiceGlsl}
  ${audibleGlsl}
  uniform sampler2D tHistory;
  uniform int uEchoes;
  uniform float uProgress;
  uniform float uRotation;
  uniform float uSpan;
  uniform float uCoreRadius;
  uniform float uLeadRadius;
  uniform float uRingRadius;
  uniform float uRingLength;
  uniform float uEchoSpread;
  uniform float uLineWidth;
  uniform float uFill;
  uniform float uGraticule;
  uniform float uCoreShape;
  uniform float uCoreLobes;
  uniform float uCorePhase;
  uniform float uLeadShape;
  uniform float uLeadLobes;
  uniform float uLeadPhase;
  uniform float uWeight;
  uniform float uDensity;
  uniform float uRelease;
  uniform vec3 uEchoAudible[MAX_ECHOES + 1];
  uniform float uSparks;
  uniform float uSparkSeed;
  uniform float uDigital;
  uniform vec3 uColors[3];
  varying vec2 vPos;

  float spectrumAt(float row, float pos) {
    return texture2D(tHistory, vec2(pos, (row + 0.5) / ${ROWS}.0)).r;
  }

  // Low, mid and high regions in the palette's three hues, blended at the borders.
  vec3 regionColor(float pos) {
    vec3 lowMid = mix(uColors[0], uColors[1], smoothstep(${LOW_END.toFixed(4)} - 0.04, ${LOW_END.toFixed(4)} + 0.04, pos));
    return mix(lowMid, uColors[2], smoothstep(${MID_END.toFixed(4)} - 0.04, ${MID_END.toFixed(4)} + 0.04, pos));
  }

  // A voice wrapped around the circle: whole lobes (no seam), blended so the count can glide.
  float polarVoice(float row, float turn, float lobes, float phase) {
    float whole = floor(lobes);
    return mix(voiceAt(row, turn * whole + phase, uDigital), voiceAt(row, turn * (whole + 1.0) + phase, uDigital), fract(lobes));
  }

  float line(float distance, float px) {
    return 1.0 - smoothstep(0.0, px, abs(distance));
  }

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  void main() {
    float r = length(vPos);
    float angle = atan(vPos.x, vPos.y);
    // Frequency position, mirrored left/right: highs at the top (the sky), lows down at the
    // horizon on both sides (the lower half of the view is the reflective floor).
    float pos = 1.0 - clamp(abs(angle) / uSpan, 0.0, 1.0);
    float turn = angle / 6.2831853 + uRotation;
    float px = fwidth(r) * uLineWidth;
    // Each part of the ring (and its echoes) vanishes with its band.
    vec3 hue = regionColor(pos) * audibleAt(pos);
    vec3 color = vec3(0.0);

    // Polar graticule: rings and spokes, like a radar screen.
    if (uGraticule > 0.0) {
      float rings = line(fract(r * 5.0 + 0.5) - 0.5, fwidth(r * 5.0));
      float spokes = line(fract(angle / 6.2831853 * 12.0 + 0.5) - 0.5, fwidth(angle / 6.2831853 * 12.0)) * step(0.1, r);
      color += mix(uColors[1], vec3(1.0), 0.3) * max(rings, spokes) * uGraticule;
    }

    // The live spectrum: a continuous contour with its body.
    float level = spectrumAt(0.0, pos);
    float contour = uRingRadius + uRingLength * level;
    if (r > uRingRadius && r < contour) color += hue * uFill * (0.3 + level) * (r - uRingRadius) / max(contour - uRingRadius, 1e-3);
    color += hue * line(r - contour, px) * (0.35 + 0.65 * level);
    color += hue * line(r - uRingRadius, px) * 0.15;

    // Echoes: the spectrum as it was, travelling outwards at the pace of motion.
    for (int i = 1; i <= MAX_ECHOES; i++) {
      if (i > uEchoes) break;
      float age = (float(i) - 1.0 + uProgress) / float(uEchoes);
      float echo = spectrumAt(float(i), pos);
      float radius = uRingRadius + uRingLength * echo * (1.0 - 0.4 * age) + uEchoSpread * age;
      float fade = (1.0 - age) * (1.0 - age);
      vec3 heard = uEchoAudible[i];
      float lowMid = mix(heard.x, heard.y, smoothstep(${LOW_END.toFixed(4)} - 0.05, ${LOW_END.toFixed(4)} + 0.05, pos));
      float memory = mix(lowMid, heard.z, smoothstep(${MID_END.toFixed(4)} - 0.05, ${MID_END.toFixed(4)} + 0.05, pos));
      color += regionColor(pos) * memory * line(r - radius, px) * (0.1 + 0.5 * echo) * fade;
    }

    // The same section release as the other worlds, drawn as a sonar front.
    float releaseRadius = uRingRadius + (1.0 - uRelease) * uEchoSpread * 2.0;
    color += regionColor(pos) * line(r - releaseRadius, px * 2.0) * uRelease * 0.8;

    // The lead's orbit and the bass line's core: polar traces of the voices' real shapes.
    float lead = uLeadRadius * (1.0 + uLeadShape * polarVoice(1.0, turn, uLeadLobes, uLeadPhase));
    color += uColors[1] * line(r - lead, px) * (0.2 + 0.5 * min(uLeadShape * 8.0, 1.0) + 0.2 * uDensity) * uAudible.y;
    float core = uCoreRadius * (1.0 + 0.25 * uWeight + uCoreShape * polarVoice(0.0, turn, uCoreLobes, uCorePhase));
    color += uColors[0] * (line(r - core, px) * (0.4 + 0.6 * uWeight) + step(r, core) * 0.05 * uWeight) * uAudible.x;

    // Sparks beyond the ring with the hi-hats (a new scatter on every hit).
    if (uSparks > 0.0 && r > uRingRadius && r < uRingRadius + uRingLength + uEchoSpread) {
      vec2 cell = floor(vPos * 90.0);
      float h = hash(cell + uSparkSeed);
      float d = length(fract(vPos * 90.0) - 0.5);
      color += mix(uColors[2], vec3(1.0), 0.5) * step(1.0 - 0.008 * uSparks, h) * smoothstep(0.5, 0.1, d) * uSparks * uAudible.z;
    }

    gl_FragColor = vec4(color * (0.75 + 0.35 * uDensity), 1.0);
  }
`;

/**
 * Radial spectrogram, drawn analytically in one full-screen fragment shader.
 * The spectrum is a continuous ring (highs at the top, lows down at the
 * horizon on both sides, each region in its own palette hue); motion propagates echoes
 * outwards while tension packs them together. Inside, the lead's
 * orbit and the bass line's core are polar traces of the voices' real
 * shapes. Nothing moves without sound: silence leaves still circles.
 */
export class SpectrumVisualizer implements Visualizer {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, -1, 1);
  private material!: ShaderMaterial;
  private mesh!: Mesh;
  private readonly voices = new VoiceTextures();
  private readonly history = new SignalTexture(SPECTRUM_BINS, ROWS);
  private readonly rows = new Float32Array(SPECTRUM_BINS * ROWS);
  private readonly echoAudible = Array.from({ length: ROWS }, () => new Vector3());
  private readonly echoDecay = new Float32Array(ROWS).fill(ECHO_FADE);
  private progress = 0;
  private rotation = 0;
  private corePhase = 0;
  private leadPhase = 0;
  private sparkSeed = 0;
  private lastHighFlux = 0;

  constructor(private readonly preset: VisualizerPreset<SpectrumParams>) {}

  init({ renderer, quality }: VisualizerContext): void {
    const p = this.preset.visual;
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        tVoices: { value: this.voices.texture },
        tHistory: { value: this.history.texture },
        // Fewer echoes at lower quality: less detail, same response.
        uEchoes: { value: quality.density >= 0.9 ? MAX_ECHOES : quality.density >= 0.6 ? 6 : 4 },
        uProgress: { value: 0 },
        uRotation: { value: 0 },
        uSpan: { value: SPAN },
        uCoreRadius: { value: p.coreRadius },
        uLeadRadius: { value: p.leadRadius },
        uRingRadius: { value: p.ringRadius },
        uRingLength: { value: p.ringLength },
        uEchoSpread: { value: p.echoSpread },
        uLineWidth: { value: p.lineWidth * renderer.getPixelRatio() },
        uFill: { value: p.fill },
        uGraticule: { value: p.graticule },
        uCoreShape: { value: 0 },
        uCoreLobes: { value: 3 },
        uCorePhase: { value: 0 },
        uLeadShape: { value: 0 },
        uLeadLobes: { value: 5 },
        uLeadPhase: { value: 0 },
        uWeight: { value: 0 },
        uDensity: { value: 0 },
        uRelease: { value: 0 },
        uEchoAudible: { value: this.echoAudible },
        uSparks: { value: 0 },
        uSparkSeed: { value: 0 },
        uDigital: { value: 0 },
        uAudible: { value: new Vector3() },
        uColors: { value: [new Color(), new Color(), new Color()] },
      },
    });
    // Scaled to twice the view in resize(), so it still covers it after the scene-centre offset.
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.scene.add(this.mesh);
  }

  setPalette(colors: PaletteColors): void {
    const target = this.material.uniforms.uColors.value as Color[];
    for (let i = 0; i < 3; i++) target[i].copy(colors[i]);
  }

  update(frame: AudioFrame, dt: number, _time: number, response: VisualResponseFrame, modulation?: ModulationState): void {
    const p = this.preset.visual;
    const { weight, flow, detail, music, trace } = response;
    const vary = music.variation;
    const u = this.material.uniforms;
    // The spectrogram as a view of the shared world: echoes travel outwards with the world's travel,
    // the disc turns with its rotation, pressure and tension size it, turbulence scatters the echoes.
    const world = modulation?.world ?? REST_VIEW;

    // Store the audibility of each event with its spectrum. A cut cannot erase the past.
    const rows = this.rows;
    rows.set(frame.spectrum, 0);
    this.echoAudible[0].set(response.lowAudible, response.midAudible, response.highAudible);
    this.echoDecay[0] = (ECHO_FADE + 1.4 * trace) * (modulation ? 0.3 + 2.5 * modulation.persistence : 1);
    let remembered = 0;
    for (let i = 1; i < ROWS; i++) {
      this.echoAudible[i].multiplyScalar(Math.exp(-dt / this.echoDecay[i]));
      remembered = Math.max(remembered, this.echoAudible[i].lengthSq());
    }
    // Motion owns propagation. During a cut the last echoes finish travelling and fading.
    const activity = response.audible > 0.01 || remembered > 0.0001 ? 1 : 0;
    this.progress += (world.dTravel + dt * 0.1 * activity) / ECHO_BEATS;
    if (this.progress >= 1) {
      this.progress -= Math.floor(this.progress);
      rows.copyWithin(SPECTRUM_BINS, 0, SPECTRUM_BINS * MAX_ECHOES);
      for (let row = MAX_ECHOES; row >= 1; row--) {
        this.echoAudible[row].copy(this.echoAudible[row - 1]);
        this.echoDecay[row] = this.echoDecay[row - 1];
        this.history.write(rows, false, row, row * SPECTRUM_BINS, SPECTRUM_BINS);
      }
    }
    this.history.write(rows, false, 0, 0, SPECTRUM_BINS);

    // Rotation and the voices' drift follow the mids; busy music (MESO motion) turns faster.
    this.rotation += world.dTurn * 0.12 * (vary[7] < 0.5 ? -1 : 1);
    this.corePhase += world.dTravel * weight * 0.06;
    this.leadPhase -= world.dTravel * flow * 0.12;
    if (frame.highFlux > 0.5 && this.lastHighFlux <= 0.5) this.sparkSeed = (this.sparkSeed + 7.31) % 100;
    this.lastHighFlux = frame.highFlux;
    this.voices.update(frame, music, dt, p.digital);

    u.uProgress.value = this.progress;
    u.uRotation.value = this.rotation;
    u.uDigital.value = this.voices.digital;
    u.uCoreShape.value = p.voiceDepth * (modulation?.scale ?? weight);
    u.uCoreLobes.value = (3 + 3 * vary[0]) * (1 + 0.4 * Math.max(Math.log2(music.bassPitch / 40), 0));
    u.uCorePhase.value = this.corePhase;
    u.uLeadShape.value = p.voiceDepth * 0.6 * (modulation?.distortion ?? flow) * (0.4 + 0.6 * music.leadVoice);
    u.uLeadLobes.value = (4 + 4 * vary[3]) * (1 + 0.4 * Math.max(Math.log2(music.leadPitch / 180), 0));
    u.uLeadPhase.value = this.leadPhase;
    u.uWeight.value = weight;
    u.uRingRadius.value = p.ringRadius * (0.85 + 0.3 * world.openness) * Math.max(0.5, 1 + 0.25 * world.pressure) * (1 - 0.15 * world.tension);
    u.uEchoSpread.value = p.echoSpread * (0.6 + 0.5 * world.openness) * (1 - 0.6 * world.tension) * (0.8 + 0.6 * world.disorder);
    u.uDensity.value = world.light;
    u.uRelease.value = Math.min(1, world.releaseStrength * 2) * Math.exp(-world.releaseAge / 1.2);
    u.uSparks.value = detail * music.highPercussion * (0.5 + world.shimmer);
    u.uSparkSeed.value = this.sparkSeed;
    (u.uAudible.value as Vector3).set(response.lowAudible, response.midAudible, response.highAudible);
  }

  setLayout(layout: SceneLayout): void {
    this.material.uniforms.uSpan.value = OPEN_SPAN + (SPAN - OPEN_SPAN) * layout.reflection;
  }

  resize(width: number, height: number): void {
    const halfWidth = width / height;
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.updateProjectionMatrix();
    this.mesh.scale.set(halfWidth * 2, 2, 1);
  }

  dispose(): void {
    this.voices.dispose();
    this.history.dispose();
    disposeObject(this.scene);
    this.scene.clear();
  }
}
