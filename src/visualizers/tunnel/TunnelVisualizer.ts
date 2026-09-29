import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Mesh,
  Points,
  ShaderMaterial,
  type WebGLRenderer,
} from 'three';
import { hzToPosition, sampleSpectrumRange } from '../../audio/visual-response/spectrum';
import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import type { PaletteColors, VisualizerContext } from '../../types/visualizer';
import { BaseVisualizer } from '../shared/BaseVisualizer';
import { RollingTraces, traceGlsl, traceValue } from '../shared/RollingTraces';
import { VoiceTextures, voiceGlsl } from '../shared/VoiceTextures';

export interface TunnelParams {
  radius: number;
  length: number;
  radialSegments: number;
  lengthSegments: number;
  ringDensity: number;
  segments: number;
  bend: number;
  /** Depth of the wall section shaped by the bass line (× radius). */
  deform: number;
  /** Height of the rings sent down the tunnel by hits (× radius). */
  ringTrace: number;
  /** How far the ring lines follow the lead's shape (world units along the tunnel). */
  leadWobble: number;
  fog: number;
  sparkCount: number;
  /** Sample-and-hold stepping of the drawn voices, scaled by how percussive the style is. */
  digital: number;
}

/** Trace rows: what the low, mid and high parts of the spectrum did over the last 8 beats. */
const LOW = 0;
const MID = 1;
const HIGH = 2;
/** The traces span this share of the tunnel's length (from the camera into the distance). */
const TRACE_REACH = 0.6;
const LOW_END = hzToPosition(250);
const MID_END = hzToPosition(2000);

/** Tunnel centerline offset at depth d; relative to the camera so the near end stays centered. */
const bendChunk = /* glsl */ `
  uniform float uTravel;
  uniform float uBend;
  vec2 curve(float s) {
    return vec2(sin(s * 0.013) + 0.5 * sin(s * 0.029), cos(s * 0.011) + 0.5 * sin(s * 0.023)) * uBend;
  }
  vec2 bendAt(float d) {
    return curve(d + uTravel) - curve(uTravel);
  }
`;

const tunnelVertex = /* glsl */ `
  ${bendChunk}
  ${voiceGlsl}
  ${traceGlsl}
  uniform float uRadius;
  uniform float uLength;
  uniform float uShape;
  uniform float uLobes;
  uniform float uShapePhase;
  uniform float uRing;
  uniform float uDigital;

  varying float vDepth;
  varying float vCoord;
  varying float vAngle;
  varying float vAge;

  void main() {
    float d = -position.z;
    float angle = uv.x * 6.2831853;
    // The section is the bass line's cycle wrapped around the wall (a saw bass makes a cog,
    // a sub a soft lobe); hits roll away from the camera as swelling rings.
    float age = d / (uLength * ${TRACE_REACH});
    // Whole numbers of lobes (no seam where the wall closes), blended so the count can glide.
    float lobes = floor(uLobes);
    float section = mix(
      voiceAt(0.0, uv.x * lobes + uShapePhase, uDigital),
      voiceAt(0.0, uv.x * (lobes + 1.0) + uShapePhase, uDigital),
      fract(uLobes)
    );
    float ring = traceAt(${LOW}.0, 3.0, age) * step(age, 1.0);
    float r = uRadius * (1.0 + uShape * section * smoothstep(2.0, 12.0, d) + uRing * ring);
    vec2 offset = bendAt(d);
    // Same (sin, cos) orientation as CylinderGeometry so BackSide keeps the inner faces.
    vec3 p = vec3(sin(angle) * r + offset.x, cos(angle) * r + offset.y, -d);
    vDepth = d;
    vCoord = d + uTravel;
    vAngle = uv.x;
    vAge = age;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const tunnelFragment = /* glsl */ `
  ${voiceGlsl}
  ${traceGlsl}
  uniform float uRingDensity;
  uniform float uSegments;
  uniform float uFog;
  uniform float uDetail;
  uniform float uDensity;
  uniform float uFlash;
  uniform float uLeadWobble;
  uniform float uLeadCycles;
  uniform float uLeadPhase;
  uniform float uTwist;
  uniform float uDigital;
  uniform vec3 uColor0;
  uniform vec3 uColor1;
  uniform vec3 uColor2;

  varying float vDepth;
  varying float vCoord;
  varying float vAngle;
  varying float vAge;

  float gridLine(float coord, float width) {
    float w = fwidth(coord) * width;
    return 1.0 - smoothstep(0.0, w, abs(fract(coord - 0.5) - 0.5));
  }

  // Smooth loop through the preset's three hues, along the tunnel (it only moves as the tunnel does).
  vec3 palette(float t) {
    float x = fract(t) * 3.0;
    vec3 a = x < 1.0 ? uColor0 : x < 2.0 ? uColor1 : uColor2;
    vec3 b = x < 1.0 ? uColor1 : x < 2.0 ? uColor2 : uColor0;
    return mix(a, b, smoothstep(0.0, 1.0, fract(x)));
  }

  void main() {
    // Ring lines follow the lead's shape around the wall; the long lines twist with the mids.
    float cycles = floor(uLeadCycles);
    float lead = mix(
      voiceAt(1.0, vAngle * cycles + uLeadPhase, uDigital),
      voiceAt(1.0, vAngle * (cycles + 1.0) + uLeadPhase, uDigital),
      fract(uLeadCycles)
    ) * uLeadWobble;
    float rings = gridLine((vCoord + lead) * uRingDensity, 1.5);
    float lines = gridLine((vAngle + vDepth * uTwist) * uSegments, 1.2);
    // Highs reveal a finer secondary grid.
    float detail = max(gridLine(vCoord * uRingDensity * 4.0, 1.0), gridLine(vAngle * uSegments * 4.0, 1.0)) * uDetail;
    float intensity = max(rings, lines * 0.5) + detail * 0.18;

    // Snares and hats light the stretch of tunnel they are rolling through.
    float inReach = step(vAge, 1.0);
    float hits = (traceAt(${MID}.0, 3.0, vAge) * 0.5 + traceAt(${HIGH}.0, 3.0, vAge) * 0.35 * uDetail) * inReach;

    vec3 color = palette(vCoord * 0.004);
    float fog = exp(-vDepth * uFog);
    vec3 base = color * 0.015;
    vec3 outColor = (base + color * intensity * (0.22 + uDensity * 0.35 + hits + uFlash)) * fog;
    gl_FragColor = vec4(outColor, 1.0);
  }
`;

const sparkVertex = /* glsl */ `
  ${bendChunk}
  uniform float uSparkTravel;
  uniform float uLength;
  uniform float uRadius;
  uniform float uSparks;
  uniform float uPixelRatio;
  attribute vec3 aSeed;
  varying float vFade;

  void main() {
    float d = uLength - mod(aSeed.z * uLength + uSparkTravel, uLength);
    float angle = aSeed.x * 6.2831853;
    float r = uRadius * (0.3 + 0.6 * aSeed.y);
    vec2 offset = bendAt(d);
    vec4 mv = modelViewMatrix * vec4(cos(angle) * r + offset.x, sin(angle) * r + offset.y, -d, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = min((1.0 + uSparks * 2.0) * (14.0 / -mv.z), 6.0) * uPixelRatio;
    vFade = uSparks * smoothstep(uLength, uLength * 0.5, d) * smoothstep(0.0, 3.0, d);
  }
`;

const sparkFragment = /* glsl */ `
  varying float vFade;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    gl_FragColor = vec4(vec3(1.0) * smoothstep(0.5, 0.0, d) * vFade, 1.0);
  }
`;

/**
 * Endless geometric tunnel. The camera stays still: the grid scrolls and the
 * centerline bends relative to the viewer, which reads as forward motion.
 * Nothing moves without sound: the tunnel advances one ring per beat of the
 * song while music plays and stops in silence.
 * bass line → shape of the wall section, kicks → rings rolling down the
 * tunnel, lead → shape of the ring lines, mids → bend and twist,
 * highs → fine grid and sparks (with hi-hats), drop → flash.
 */
export class TunnelVisualizer extends BaseVisualizer<TunnelParams> {
  private tunnelMaterial!: ShaderMaterial;
  private sparkMaterial!: ShaderMaterial;
  private renderer!: WebGLRenderer;
  private readonly voices = new VoiceTextures();
  private readonly traces = new RollingTraces(3);
  private travel = 0;
  private sparkTravel = 0;
  private lastBeats = -1;
  private roll = 0;
  private shapePhase = 0;
  private leadPhase = 0;

  init({ quality, renderer }: VisualizerContext): void {
    const p = this.preset.visual;
    this.renderer = renderer;
    const shared = {
      uTravel: { value: 0 },
      uBend: { value: p.bend },
      uRadius: { value: p.radius },
      uLength: { value: p.length },
      tVoices: { value: this.voices.texture },
      tTrace: { value: this.traces.texture },
      uTraceShift: { value: 0 },
      uDigital: { value: 0 },
    };

    const geometry = new CylinderGeometry(
      p.radius,
      p.radius,
      p.length,
      Math.max(24, Math.round(p.radialSegments * quality.density)),
      Math.max(64, Math.round(p.lengthSegments * quality.density)),
      true,
    )
      .rotateX(-Math.PI / 2)
      .translate(0, 0, -p.length / 2);
    this.tunnelMaterial = new ShaderMaterial({
      vertexShader: tunnelVertex,
      fragmentShader: tunnelFragment,
      side: BackSide,
      uniforms: {
        ...shared,
        uShape: { value: 0 },
        uLobes: { value: 4 },
        uShapePhase: { value: 0 },
        uRing: { value: 0 },
        uRingDensity: { value: p.ringDensity },
        uSegments: { value: p.segments },
        uFog: { value: p.fog },
        uDetail: { value: 0 },
        uDensity: { value: 0 },
        uFlash: { value: 0 },
        uLeadWobble: { value: 0 },
        uLeadCycles: { value: 3 },
        uLeadPhase: { value: 0 },
        uTwist: { value: 0 },
        uColor0: { value: new Color() },
        uColor1: { value: new Color() },
        uColor2: { value: new Color() },
      },
    });
    const tunnel = new Mesh(geometry, this.tunnelMaterial);
    tunnel.frustumCulled = false;
    this.scene.add(tunnel);

    const count = Math.round(p.sparkCount * quality.density);
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const sparkGeometry = new BufferGeometry();
    sparkGeometry.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    sparkGeometry.setAttribute('aSeed', new BufferAttribute(seeds, 3));
    this.sparkMaterial = new ShaderMaterial({
      vertexShader: sparkVertex,
      fragmentShader: sparkFragment,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        // Same uniform objects: bending stays in sync with the tunnel.
        uTravel: shared.uTravel,
        uBend: shared.uBend,
        uRadius: shared.uRadius,
        uLength: shared.uLength,
        uSparkTravel: { value: 0 },
        uSparks: { value: 0 },
        uPixelRatio: { value: renderer.getPixelRatio() },
      },
    });
    const sparks = new Points(sparkGeometry, this.sparkMaterial);
    sparks.frustumCulled = false;
    this.scene.add(sparks);
  }

  setPalette(colors: PaletteColors): void {
    const u = this.tunnelMaterial.uniforms;
    for (let i = 0; i < 3; i++) (u[`uColor${i}`].value as Color).copy(colors[i]);
  }

  update(frame: AudioFrame, dt: number, _time: number, response: VisualResponseFrame): void {
    const p = this.preset.visual;
    const { weight, flow, detail, density, music, motion, openness, tension, trace } = response;
    const vary = music.variation;

    // One ring per beat of the song while music plays; still in silence.
    const beats = music.beats;
    const stepBeats = this.lastBeats < 0 ? 0 : Math.max(beats - this.lastBeats, 0);
    this.lastBeats = beats;
    const activity = smoothstep(0.02, 0.3, density);
    // MESO: busy music travels faster down the tunnel than a held chord; tension (build-ups) pushes on.
    const advance = (stepBeats / p.ringDensity) * activity * (0.7 + 0.6 * motion) * (1 + 0.3 * tension);
    this.travel += advance;
    this.sparkTravel += advance * 1.6 + dt * detail * music.highPercussion * 20;
    // The wall's shape and the ring lines drift with the mids, never on their own.
    this.shapePhase += dt * flow * music.pace * 0.15;
    this.leadPhase -= dt * flow * music.pace * 0.25;
    this.roll += dt * flow * music.pace * 0.2;

    const { spectrum } = frame;
    this.traces.record(LOW, traceValue(frame, response, 1, sampleSpectrumRange(spectrum, 0, LOW_END)));
    this.traces.record(MID, traceValue(frame, response, 0.5, sampleSpectrumRange(spectrum, LOW_END, MID_END)));
    this.traces.record(HIGH, traceValue(frame, response, 0, sampleSpectrumRange(spectrum, MID_END, 1)));
    this.traces.update(music.tempo, dt);
    this.voices.update(frame, music, dt, p.digital);

    const u = this.tunnelMaterial.uniforms;
    u.uTravel.value = this.travel;
    // MACRO: a full, wide sound widens the tunnel; a lone voice narrows it.
    u.uRadius.value = p.radius * (0.92 + 0.16 * openness);
    u.uTraceShift.value = this.traces.shift;
    u.uDigital.value = this.voices.digital;
    // Bass: the section's depth (weight) and lobes (pitch: higher notes, more lobes; per song a base count).
    // Each part fades with its band: the section with the bass, the ring lines with the lead, the fine grid with the highs.
    u.uShape.value = p.deform * weight * response.lowAudible;
    u.uLobes.value = (3 + 4 * vary[0]) * (1 + 0.5 * Math.max(Math.log2(music.bassPitch / 40), 0));
    u.uShapePhase.value = this.shapePhase;
    u.uRing.value = p.ringTrace * (1 + 0.8 * music.drop);
    // Mids: lead-shaped ring lines, twist and bend.
    u.uLeadWobble.value = p.leadWobble * flow * (0.4 + 0.6 * music.leadVoice) * response.midAudible;
    u.uLeadCycles.value = (2 + 3 * vary[3]) * (1 + 0.3 * Math.max(Math.log2(music.leadPitch / 180), 0));
    u.uLeadPhase.value = this.leadPhase;
    u.uTwist.value = (vary[7] - 0.5) * 0.02 * flow * (1 + tension);
    u.uBend.value = p.bend * (0.3 + 0.7 * flow);
    // Highs: fine grid; brightness from energy, hits and drops.
    u.uDetail.value = detail * response.highAudible;
    u.uDensity.value = density;
    // The last hits leave a faint afterglow on the walls.
    u.uFlash.value = 0.5 * music.drop + 0.1 * trace;
    const s = this.sparkMaterial.uniforms;
    s.uSparkTravel.value = this.sparkTravel;
    s.uSparks.value = detail * (0.3 + 0.7 * music.highPercussion) * response.highAudible;

    // A slow roll with the mids; no zoom or shake on beats.
    this.camera.rotation.z = Math.sin(this.roll) * 0.25 * this.preset.camera.drift;
  }

  override resize(width: number, height: number): void {
    super.resize(width, height);
    this.sparkMaterial.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
  }

  override dispose(): void {
    this.voices.dispose();
    this.traces.dispose();
    super.dispose();
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
