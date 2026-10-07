import type { ModulationState } from '../../director/types';
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial, Vector3, Vector4, type WebGLRenderer } from 'three';
import { SPECTRUM_BINS } from '../../audio/analysis/AudioAnalyzer';
import { hzToPosition, sampleSpectrumRange } from '../../audio/visual-response/spectrum';
import { wellsGlsl } from '../../render-systems/fields/wells';
import { Rng, seedOf } from '../../show/rng';
import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import type { PaletteColors, VisualizerContext } from '../../types/visualizer';
import { audibleGlsl } from '../shared/audibleGlsl';
import { Reorganization } from '../../world/Reorganization';
import { REST_VIEW } from '../../world/WorldView';
import { BaseVisualizer } from '../shared/BaseVisualizer';
import { RollingTraces, traceGlsl, traceValue } from '../shared/RollingTraces';
import { SignalTexture } from '../shared/SignalTexture';
import { VoiceTextures, voiceGlsl } from '../shared/VoiceTextures';
import { createRegimes, ORDERS, particleRegimes } from './regimes';

export interface ParticleFieldParams {
  count: number;
  depth: number;
  spread: number;
  /** Reference travel distance at 120 BPM (units); scaled by musical motion. */
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
/** Width of an impact's front (units along the flight axis) and how far it draws the particles it passes into itself (< 1: none crosses it). */
const FRONT_WIDTH = 7;
const FRONT_PULL = 0.7;

const vertexShader = /* glsl */ `
  ${voiceGlsl}
  ${traceGlsl}
  ${audibleGlsl}
  ${wellsGlsl}
  uniform sampler2D tSpectrum;
  uniform float uTravel;
  uniform float uSparkTravel;
  uniform float uSwirlPhase;
  uniform float uDepth;
  uniform float uSpread;
  uniform float uSize;
  uniform float uWeight;
  uniform float uTension;
  uniform float uRelease;
  uniform float uShape;
  uniform float uLobes;
  uniform float uRing;
  uniform float uSparks;
  uniform float uDensity;
  uniform float uSwirl;
  uniform float uFlow;
  uniform float uDisorder;
  uniform float uLateral;
  uniform float uDigital;
  uniform float uPixelRatio;
  // The standing potential the particles float in (regimes.ts).
  // x: how firmly the shells hold, y: depth of the wells round the axis, z: depth of the wells along it,
  // w: 0 = the structure before the last release … 1 = the one after it
  uniform vec4 uWells;
  // Wells round the axis (x after the last release, y before it) and along the field's depth (z after, w before)
  uniform vec4 uOrders;
  // x: where the last impact's front is (0..1 of the depth), y: its strength, z: turns the core leads the rim by, w: fine instability of the rim
  uniform vec4 uFront;

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

  // Where a particle seeded at x (0..1) rests among \`wells\` wells of this depth. The potential acts twice (the rest
  // of the rest): shallow wells only lean the particles, deep ones draw them into thin lines.
  float gather(float x, float wells, float depth) {
    return wellRest(wellRest(x * wells, depth), depth) / wells;
  }

  void main() {
    // seed.w > 0.8: "spark" particles, driven by hi-hats (smaller, faster).
    float spark = step(0.8, aSeed.w);
    float travel = mix(uTravel, uSparkTravel, spark);

    // The wells hold what belongs to the structure; sparks stay free tracers.
    float bound = 1.0 - spark;
    // Along the axis the particles gather into planes that travel with the flow (sheets, and with the other wells a
    // lattice). After a release they move from the planes they had to the ones the new structure has.
    float along = mix(gather(aSeed.z, uOrders.w, uWells.z * bound), gather(aSeed.z, uOrders.z, uWells.z * bound), uWells.w);
    // Endless flight: z wraps around the field depth.
    float z = mod(along * uDepth + travel, uDepth) - uDepth;
    // An impact is a front that runs into the field: it draws the particles it passes into itself, a wave of density
    // (geometry only: what it adds in light is the particles it gathers, never a flash of its own).
    float fromFront = (z + uFront.x * uDepth) / ${FRONT_WIDTH}.0;
    float front = exp(-fromFront * fromFront) * uFront.y * bound;
    z -= ${FRONT_PULL} * ${FRONT_WIDTH}.0 * fromFront * front;

    // Each particle stands for a part of the spectrum: the core is the bass, the rim the highs.
    // Most gather on SHELLS concentric shells, so the voices' shapes read as clean polar traces;
    // the rest stay loose dust.
    // A world that does not hold together lets the shells go: the same particles are a cloud.
    float onShell = step(fract(aSeed.x * 97.13 + aSeed.z * 13.7), 0.6);
    float cluster = uWells.x * mix(onShell, 1.0, uTension * 0.85);
    float band = mix(pow(aSeed.y, 0.7), (floor(aSeed.y * ${SHELLS}.0) + 0.5) / ${SHELLS}.0, cluster);
    float level = texture2D(tSpectrum, vec2(band, 0.5)).r;

    // Polar layout around the flight axis, swirling with the mids (twist grows with depth).
    // The vortex winds with the world's angular momentum; turbulence scatters each particle locally.
    // Round the axis they gather into spokes: with the flight these are filaments, with the twist helices, and the
    // vortex winds them (the core leads the rim). The rim trembles finely with the shimmer field.
    float around = mix(gather(aSeed.x, uOrders.y, uWells.y * bound), gather(aSeed.x, uOrders.x, uWells.y * bound), uWells.w);
    float turn = around + uSwirlPhase + z * 0.0035 * uSwirl * uFlow + (fract(aSeed.w * 31.3) - 0.5) * uDisorder * 0.08
      + uFront.z * (1.0 - band) + (fract(aSeed.w * 17.7) - 0.5) * 0.03 * uFront.w * band * band * sin(uSparkTravel * 0.9 + aSeed.x * 40.0);
    float angle = turn * 6.2831853;
    float radius = (0.08 + band) * uSpread;
    // The cross-section takes the voices' shape: bass line in the core, lead further out.
    radius *= 1.0 + uShape * section(band < 0.45 ? 0.0 : 1.0, turn);
    // Weight compresses the core; kicks roll away as rings; each band breathes with its level.
    float age = -z / (uDepth * ${TRACE_REACH});
    radius *= 1.0 - uWeight * 0.12 * (1.0 - band) + uRing * traceAt(0.0, 1.0, age) * step(age, 1.0) + level * 0.12 + 0.12 * front;
    // Compressed shells release by different distances: explosion, then a gradual reorganisation.
    float burst = sin((1.0 - uRelease) * 3.14159265) * uRelease;
    radius += uSpread * burst * (0.3 + band * 0.6);
    radius *= 1.0 + (fract(aSeed.z * 57.1) - 0.5) * uDisorder * 0.5;
    // The flow leans towards where the world is pushed from, more with depth.
    vec3 position = vec3(cos(angle) * radius + uLateral * -z * 0.06, sin(angle) * radius, z);

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // Emission: a density-dependent share of the field; sparks fade in with the hi-hats.
    float visible = step(aSeed.w, uDensity) * (1.0 - spark) + spark * uSparks;
    // Each particle vanishes with its band.
    float heard = audibleAt(band);
    float size = uSize * mix(1.0 + uWeight * 1.2 * (1.0 - band), 0.5 + uSparks * 1.5, spark) * heard;
    gl_PointSize = visible > 0.01 ? min(size * (300.0 / -mvPosition.z), 9.0) * uPixelRatio : 0.0;

    vMix = aSeed.x;
    vSpark = spark * uSparks;
    vGlow = (0.35 + level * 1.1) * heard;
    // Fade in from the far end, fade out right before the camera.
    vFade = smoothstep(-uDepth, -uDepth * 0.6, z) * smoothstep(0.0, -4.0, z);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uSparkColor;
  uniform float uEnergy;

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
    gl_FragColor = vec4(color * glow * vFade * (0.4 + uEnergy * 0.6) * vGlow, 1.0);
  }
`;

/**
 * GPU particle flight: every particle's position is computed in the vertex
 * shader from a static seed and a few uniforms, so the CPU only integrates
 * travel distance each frame. Nothing moves without sound.
 * Particles stand for parts of the spectrum (core = bass, rim = highs) and
 * light up with them; the cross-section takes the shape of the bass line and
 * the lead; motion drives the flight; kicks roll away as rings;
 * mids swirl; hi-hats bring sparks; energy sets how much of the field glows.
 *
 * The particles organise themselves (regimes.ts): they float in one standing
 * potential whose wells the world deepens and flattens, so the same set is a
 * cloud, shells, filaments, helices, sheets or a lattice; an impact crosses
 * them as a wave of density, a release melts the structure and lets it set
 * again with other orders.
 */
export class ParticleFieldVisualizer extends BaseVisualizer<ParticleFieldParams> {
  private material!: ShaderMaterial;
  private renderer!: WebGLRenderer;
  private readonly voices = new VoiceTextures();
  private readonly traces = new RollingTraces(1);
  private readonly spectrum = new SignalTexture(SPECTRUM_BINS);
  /** Which wells of the standing potential are deep right now, and which orders the releases have left it with. */
  readonly regimes = createRegimes();
  private readonly structure = new Reorganization(ORDERS.length, 0x706172);
  private travel = 0;
  private sparkTravel = 0;
  private swirlPhase = 0;
  private drift = 0;
  private density = 0.25;

  init({ quality, renderer }: VisualizerContext): void {
    const p = this.preset.visual;
    this.renderer = renderer;
    const count = Math.round(p.count * quality.density);
    const seeds = new Float32Array(count * 4);
    const rng = new Rng(seedOf(count, 0x706172));
    for (let i = 0; i < seeds.length; i++) seeds[i] = rng.next();
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
        uTension: { value: 0 },
        uRelease: { value: 0 },
        uShape: { value: 0 },
        uLobes: { value: 3 },
        uRing: { value: 0 },
        uSparks: { value: 0 },
        uEnergy: { value: 0 },
        uDensity: { value: 0.25 },
        uSwirl: { value: p.swirl },
        uFlow: { value: 0 },
        uDisorder: { value: 0 },
        uLateral: { value: 0 },
        uDigital: { value: 0 },
        uPixelRatio: { value: renderer.getPixelRatio() },
        uWells: { value: new Vector4(1, 0, 0, 1) },
        uOrders: { value: new Vector4(ORDERS[0][0], ORDERS[0][0], ORDERS[0][1], ORDERS[0][1]) },
        uFront: { value: new Vector4(1, 0, 0, 0) },
        uAudible: { value: new Vector3() },
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

  update(frame: AudioFrame, dt: number, _time: number, response: VisualResponseFrame, modulation?: ModulationState): void {
    const p = this.preset.visual;
    const u = this.material.uniforms;
    const { weight, flow, detail, density, music, trace } = response;
    const vary = music.variation;

    // A flow field in the shared world: the particles travel with the world's momentum (bass inertia
    // is the world's mass), the field turns with its angular momentum. Emission stays the Director's.
    const world = modulation?.world ?? REST_VIEW;
    const advance = world.dTravel * 2 * p.beatDistance;
    this.travel += advance;
    this.sparkTravel += advance * 2 + dt * world.shimmer * 12;
    this.swirlPhase += world.dTurn * 0.05 * (vary[7] < 0.5 ? -1 : 1);
    this.drift += world.dTravel * 0.5;
    this.density += ((modulation ? 0.05 + 0.8 * modulation.particleEmission : 0.25 + density * 0.6) - this.density) * (1 - Math.exp(-dt * 2));

    this.traces.record(0, traceValue(frame, response, 1, sampleSpectrumRange(frame.spectrum, 0, LOW_END)));
    this.traces.update(music.tempo / (modulation ? 0.4 + 2 * modulation.persistence : 1), dt);
    this.voices.update(frame, music, dt, p.digital);
    this.spectrum.write(frame.spectrum);

    u.uTravel.value = this.travel;
    u.uSparkTravel.value = this.sparkTravel;
    u.uSwirlPhase.value = this.swirlPhase;
    u.uTraceShift.value = this.traces.shift;
    u.uDigital.value = this.voices.digital;
    // Openness disperses matter; tension clusters it onto the existing spectrum shells.
    // Pressure disperses matter; stored tension and coherence gather it onto the spectrum shells.
    // The standing potential: which wells are deep is the world's doing; a release carries the particles from the
    // orders they had to the ones it leaves.
    const r = particleRegimes(this.regimes, world, p.depth), structure = this.structure;
    structure.update(world);
    const after = ORDERS[structure.current], before = ORDERS[structure.previous];
    (u.uWells.value as Vector4).set(r.shell, r.spokes, r.planes, r.reform);
    (u.uOrders.value as Vector4).set(after[0], before[0], after[1], before[1]);
    (u.uFront.value as Vector4).set(r.front, r.pulse, r.wind, world.shimmer);
    u.uSpread.value = p.spread * (0.7 + 0.5 * world.openness) * Math.max(0.5, 1 + 0.35 * world.pressure) * (1 - r.collapse);
    u.uTension.value = Math.min(1, world.tension + 0.4 * Math.max(0, world.coherence - 0.5));
    u.uRelease.value = Math.min(1, world.releaseStrength * 2) * Math.exp(-world.releaseAge / 1.2);
    u.uWeight.value = modulation?.scale ?? weight;
    u.uShape.value = p.shape * (modulation ? 1.7 * modulation.distortion : 0.3 * weight + 0.7 * flow);
    u.uLobes.value = (2 + 4 * vary[0]) * (1 + 0.4 * Math.max(Math.log2(music.bassPitch / 40), 0));
    u.uRing.value = p.ringTrace * (0.5 + 0.4 * trace + 0.6 * world.excitation);
    u.uSparks.value = detail * (0.2 + 0.8 * music.highPercussion);
    u.uFlow.value = world.spin * 3 + world.disorder * 0.5;
    u.uDisorder.value = world.disorder;
    u.uLateral.value = world.lateral;
    u.uEnergy.value = world.light;
    u.uDensity.value = this.density;
    (u.uAudible.value as Vector3).set(response.lowAudible, response.midAudible, response.highAudible);

    if (modulation) this.camera.position.z = this.preset.camera.distance * (1.15 - 0.3 * modulation.depth);
    // The camera sways with the mids only.
    const sway = this.preset.camera.drift * (modulation ? 2 * modulation.cameraMotion : 1);
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
