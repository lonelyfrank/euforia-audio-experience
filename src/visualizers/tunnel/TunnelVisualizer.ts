import type { ModulationState } from '../../director/types';
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
  Vector2,
  Vector3,
  Vector4,
  type WebGLRenderer,
} from 'three';
import { hzToPosition, sampleSpectrumRange } from '../../audio/visual-response/spectrum';
import { MODE_SHAPES, MODES } from '../../physics/ResonantPhysics';
import { Rng, seedOf } from '../../show/rng';
import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import type { PaletteColors, VisualizerContext } from '../../types/visualizer';
import { Reorganization } from '../../world/Reorganization';
import { REST_VIEW } from '../../world/WorldView';
import { BaseVisualizer } from '../shared/BaseVisualizer';
import { RollingTraces, traceGlsl, traceValue } from '../shared/RollingTraces';
import { VoiceTextures, voiceGlsl } from '../shared/VoiceTextures';
import { CONFIGURATIONS, createTopology, tunnelTopology } from './topology';

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
  /** How far the mids squeeze the section into an oval (× radius). */
  oval: number;
  /** Depth of the fine corrugation the highs put on the wall (× radius). */
  ripple: number;
  /** How far the shared modal field moves the wall (× radius per unit of modal displacement). */
  waveguide: number;
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
  uniform float uLateral;
  vec2 curve(float s) {
    return vec2(sin(s * 0.013) + 0.5 * sin(s * 0.029), cos(s * 0.011) + 0.5 * sin(s * 0.023)) * uBend;
  }
  // The world's lateral force (where the sound is in the stereo image) leans the far end towards it.
  vec2 bendAt(float d) {
    return curve(d + uTravel) - curve(uTravel) + vec2(uLateral * d * d * 0.004, 0.0);
  }
`;

/** Half-waves of the first axial mode fit in this length of tunnel (units), and the release front is this deep (units). */
const WAVEGUIDE_SPAN = 24;
const FRONT_WIDTH = 5;
/** How far the wall bulges where a full release front passes (× radius). */
const FRONT_BULGE = 0.3;
/** The modal sum on a cylinder: one cosine per order round the wall, one sine per order along it, a product per mode. */
const ORDERS = Math.max(...MODE_SHAPES.flat());
const modalSum = MODE_SHAPES.map(([m, n], i) => `uModes[${i}] * across[${m - 1}] * along[${n - 1}]`).join(' + ');

/**
 * The wall as architecture: rings along the tunnel, panels round it. Where the world's forces open gaps the wall is
 * cut there (the fragment shader) and each panel moves as a rigid piece (the vertex shader): both read this.
 */
const panelChunk = /* glsl */ `
  // x: gap between panels round the wall, y: gap between rings along it (shares of a cell)
  uniform vec2 uGap;
  // Sides of the section and panels round the wall: xy after the last release, zw before it
  uniform vec4 uConfig;
  // Length of a ring (units): x after the last release, y before it
  uniform vec2 uRings;
  // The last release: how deep its front is (units) and how strong it still is
  uniform float uFront;
  uniform float uRelease;

  // The pressure front of a release, where it is now.
  float frontBand(float d) {
    float x = (d - uFront) / ${FRONT_WIDTH}.0;
    return exp(-x * x) * uRelease;
  }
  // The wall opens further where the front is passing.
  vec2 gapsAt(float d) {
    return min(uGap + vec2(0.22, 0.3) * frontBand(d), vec2(0.6));
  }
  // The front has passed here: the tunnel has its new configuration behind it and still the old one ahead.
  // x: sides, y: panels, z: ring length
  vec3 configAt(float d) {
    return d < uFront ? vec3(uConfig.x, uConfig.y, uRings.x) : vec3(uConfig.z, uConfig.w, uRings.y);
  }
  // Cell coordinates of a point of the wall, shifted by half a gap: a gap opens evenly about the line between two
  // cells and is the start of the shifted cell.
  vec2 panelCoord(float turn, float coord, vec3 config, vec2 gap) {
    return vec2(turn * config.y, coord / config.z) + 0.5 * gap;
  }
  float panelHash(vec2 c) {
    return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453);
  }
`;

const tunnelVertex = /* glsl */ `
  ${bendChunk}
  ${voiceGlsl}
  ${traceGlsl}
  ${panelChunk}
  uniform float uRadius;
  uniform float uLength;
  uniform float uShape;
  uniform float uLobes;
  uniform float uShapePhase;
  uniform float uRing;
  uniform float uDigital;
  // Torsion: turns per unit of depth (deeper sections are turned further)
  uniform float uTwist;
  // The shared modal field (ResonantPhysics) and how far it moves the wall
  uniform float uModes[${MODES}];
  uniform float uWaveguide;
  // x: oval of the mids, y: corrugation of the highs, z: lobes of the corrugation
  uniform vec3 uBreath;
  // x: how polygonal the section is, y: constriction ahead, z: how far panels float, w: how far rings turn against each other
  uniform vec4 uForm;

  varying float vDepth;
  varying float vCoord;
  varying float vAngle;
  varying float vAge;

  // The wall as a waveguide: the modes the audio engine keeps ringing, standing round the wall and along the tunnel.
  float waveguide(float turn, float coord) {
    float across[${ORDERS}];
    float along[${ORDERS}];
    for (int k = 0; k < ${ORDERS}; k++) {
      across[k] = cos(float(k + 1) * turn * 6.2831853);
      along[k] = sin(float(k + 1) * coord * ${(Math.PI / WAVEGUIDE_SPAN).toFixed(6)});
    }
    float w = (${modalSum}) * uWaveguide;
    // Soft limit: however hard the modes ring, the wall stays a wall.
    return w / (1.0 + abs(w) * 2.5);
  }

  // A value each panel has for itself: constant across it, blended to its neighbours' inside the gaps (which are not drawn).
  float panelValue(vec2 q, vec2 gap, float panels) {
    vec2 c = floor(q);
    vec2 e = smoothstep(vec2(0.0), max(gap, vec2(1e-3)), fract(q));
    float x0 = mod(c.x - 1.0, panels), x1 = mod(c.x, panels);
    return mix(
      mix(panelHash(vec2(x0, c.y - 1.0)), panelHash(vec2(x1, c.y - 1.0)), e.x),
      mix(panelHash(vec2(x0, c.y)), panelHash(vec2(x1, c.y)), e.x),
      e.y
    );
  }
  float ringValue(float q, float gap) {
    float c = floor(q);
    return mix(panelHash(vec2(7.0, c - 1.0)), panelHash(vec2(7.0, c)), smoothstep(0.0, max(gap, 1e-3), fract(q)));
  }

  void main() {
    float d = -position.z;
    float coord = d + uTravel;
    // The section is the bass line's cycle wrapped around the wall (a saw bass makes a cog,
    // a sub a soft lobe); hits roll away from the camera as swelling rings.
    float age = d / (uLength * ${TRACE_REACH});
    float heard = step(age, 1.0);
    // Whole numbers of lobes (no seam where the wall closes), blended so the count can glide.
    float lobes = floor(uLobes);
    float section = mix(
      voiceAt(0.0, uv.x * lobes + uShapePhase, uDigital),
      voiceAt(0.0, uv.x * (lobes + 1.0) + uShapePhase, uDigital),
      fract(uLobes)
    );
    // Breathing is not uniform: the lows swell whole rings, the mids squeeze the section into an oval whose axis
    // turns along the tunnel, the highs corrugate the wall finely. Each rolls away with the part that made it.
    float ring = traceAt(${LOW}.0, 3.0, age) * heard;
    float squeeze = traceAt(${MID}.0, 3.0, age) * heard * cos(2.0 * (uv.x * 6.2831853 + coord * 0.05));
    float corrugation = traceAt(${HIGH}.0, 3.0, age) * heard * cos(uBreath.z * uv.x * 6.2831853);
    float r = uRadius * (1.0 + uShape * section * smoothstep(2.0, 12.0, d) + uRing * ring + uBreath.x * squeeze + uBreath.y * corrugation);
    r *= 1.0 + waveguide(uv.x, coord);

    // Architecture: under held potential the section takes edges and the far tunnel is drawn in.
    vec3 config = configAt(d);
    float side = 6.2831853 / config.x;
    r *= mix(1.0, cos(0.5 * side) / cos(mod(uv.x * 6.2831853, side) - 0.5 * side), uForm.x);
    r *= 1.0 - uForm.y * smoothstep(6.0, 70.0, d);
    // A release is a pressure front that travels down the tunnel: the wall bulges where it is.
    r *= 1.0 + ${FRONT_BULGE} * frontBand(d);

    // Where the wall has opened, each panel is a piece of its own: it floats off the wall and its ring turns.
    vec2 gap = gapsAt(d);
    vec2 q = panelCoord(uv.x, coord, config, gap);
    float open = smoothstep(0.0, 0.08, gap.x + gap.y);
    r *= 1.0 + (panelValue(q, gap, config.y) - 0.5) * 2.0 * uForm.z * open;
    // Torsion is geometry: every section is turned by its depth, so the wall, its lines and its panels wind together.
    float angle = (uv.x - d * uTwist + (ringValue(q.y, gap.y) - 0.5) * 2.0 * uForm.w * open) * 6.2831853;

    vec2 offset = bendAt(d);
    // Same (sin, cos) orientation as CylinderGeometry so BackSide keeps the inner faces.
    vec3 p = vec3(sin(angle) * r + offset.x, cos(angle) * r + offset.y, -d);
    vDepth = d;
    vCoord = coord;
    vAngle = uv.x;
    vAge = age;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const tunnelFragment = /* glsl */ `
  ${voiceGlsl}
  ${traceGlsl}
  ${panelChunk}
  uniform float uRingDensity;
  uniform float uSegments;
  uniform float uFog;
  uniform float uDetail;
  uniform float uDensity;
  uniform float uLeadWobble;
  uniform float uLeadCycles;
  uniform float uLeadPhase;
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
    // Where the wall has opened there is no wall: the gaps between rings and panels are not drawn.
    vec2 gap = gapsAt(vDepth);
    vec2 panel = panelCoord(vAngle, vCoord, configAt(vDepth), gap);
    vec2 pixel = max(fwidth(panel), vec2(1e-5));
    vec2 cell = fract(panel);
    if (cell.x < gap.x || cell.y < gap.y) discard;
    // The cut edges of a piece are lit: it reads as architecture, not as a tear.
    vec2 cut = (1.0 - smoothstep(vec2(0.0), vec2(1.6), min(cell - gap, 1.0 - cell) / pixel)) * smoothstep(vec2(0.0), vec2(0.05), gap);

    // Ring lines follow the lead's shape around the wall; the long lines wind with the wall's own torsion.
    float cycles = floor(uLeadCycles);
    float lead = mix(
      voiceAt(1.0, vAngle * cycles + uLeadPhase, uDigital),
      voiceAt(1.0, vAngle * (cycles + 1.0) + uLeadPhase, uDigital),
      fract(uLeadCycles)
    ) * uLeadWobble;
    float rings = gridLine((vCoord + lead) * uRingDensity, 1.5);
    float lines = gridLine(vAngle * uSegments, 1.2);
    // Highs reveal a finer secondary grid.
    float detail = max(gridLine(vCoord * uRingDensity * 4.0, 1.0), gridLine(vAngle * uSegments * 4.0, 1.0)) * uDetail;
    float intensity = max(max(rings, lines * 0.5), max(cut.x, cut.y) * 0.7) + detail * 0.18;

    // Snares and hats light the stretch of tunnel they are rolling through.
    float inReach = step(vAge, 1.0);
    float hits = (traceAt(${MID}.0, 3.0, vAge) * 0.5 + traceAt(${HIGH}.0, 3.0, vAge) * 0.35 * uDetail) * inReach;

    vec3 color = palette(vCoord * 0.004);
    float fog = exp(-vDepth * uFog);
    vec3 base = color * 0.015;
    float shock = frontBand(vDepth);
    vec3 outColor = (base + color * intensity * (0.22 + uDensity * 0.35 + hits + shock * 0.8)) * fog;
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
 * Forward travel follows motion while the history rings retain the tempo.
 * The tunnel stops advancing in silence.
 * bass line → shape of the wall section, kicks → rings rolling down the
 * tunnel, lead → shape of the ring lines, mids → bend and an oval squeeze,
 * highs → fine grid, corrugation and sparks.
 *
 * The wall is architecture under the world's forces (topology.ts), not a fixed
 * tube: its angular momentum twists it section by section, the shared modal
 * field stands in it as in a waveguide, held potential gives it edges, draws
 * the far end in and, with disorder, opens it into rings and floating panels
 * that still line the same path; a release is a pressure front that travels
 * down it and leaves another structure behind. At rest it is the plain corridor.
 */
export class TunnelVisualizer extends BaseVisualizer<TunnelParams> {
  private tunnelMaterial!: ShaderMaterial;
  private sparkMaterial!: ShaderMaterial;
  private renderer!: WebGLRenderer;
  private readonly voices = new VoiceTextures();
  private readonly traces = new RollingTraces(3);
  /** What the world's forces do to the wall right now, and which structure its releases have left. */
  readonly topology = createTopology();
  private readonly structure = new Reorganization(CONFIGURATIONS.length, 0x74756e);
  private readonly modes = new Float32Array(MODES);
  private travel = 0;
  private sparkTravel = 0;
  private roll = 0;
  private shapePhase = 0;
  private leadPhase = 0;

  init({ quality, renderer }: VisualizerContext): void {
    const p = this.preset.visual;
    this.renderer = renderer;
    const shared = {
      uTravel: { value: 0 },
      uBend: { value: p.bend },
      uLateral: { value: 0 },
      uRadius: { value: p.radius },
      uLength: { value: p.length },
      tVoices: { value: this.voices.texture },
      tTrace: { value: this.traces.texture },
      uTraceShift: { value: 0 },
      uDigital: { value: 0 },
    };

    // Enough of them round the wall at any quality for a polygon's sides and a panel's edges to be drawn.
    const radial = Math.max(48, Math.round(p.radialSegments * quality.density));
    const geometry = new CylinderGeometry(
      p.radius,
      p.radius,
      p.length,
      radial,
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
        uRelease: { value: 0 },
        uLeadWobble: { value: 0 },
        uLeadCycles: { value: 3 },
        uLeadPhase: { value: 0 },
        uTwist: { value: 0 },
        uModes: { value: this.modes },
        uWaveguide: { value: 0 },
        // The corrugation has as many lobes as the mesh can draw (four vertices to a lobe).
        uBreath: { value: new Vector3(0, 0, Math.floor(radial / 8) * 2) },
        uForm: { value: new Vector4() },
        uGap: { value: new Vector2() },
        uConfig: { value: new Vector4(CONFIGURATIONS[0][0], CONFIGURATIONS[0][1], CONFIGURATIONS[0][0], CONFIGURATIONS[0][1]) },
        uRings: { value: new Vector2(CONFIGURATIONS[0][2], CONFIGURATIONS[0][2]) },
        uFront: { value: this.topology.front },
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
    const rng = new Rng(seedOf(count, 0x74756e));
    for (let i = 0; i < seeds.length; i++) seeds[i] = rng.next();
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
        uLateral: shared.uLateral,
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

  update(frame: AudioFrame, dt: number, _time: number, response: VisualResponseFrame, modulation?: ModulationState): void {
    const p = this.preset.visual;
    const { weight, flow, detail, music, trace } = response;
    const vary = music.variation;
    // The tunnel is a view of the shared world: its travel is the world's, the wall is the world's
    // radial body (pressure, hits, stored tension), roll and torsion its angular momentum.
    const world = modulation?.world ?? REST_VIEW;
    const advance = world.dTravel * (2 / p.ringDensity);
    this.travel += advance;
    this.roll += world.dTurn * 0.25;
    this.sparkTravel += advance * 1.6 + dt * world.shimmer * 8;
    // The wall's shape and the ring lines turn and drift with the world, never on their own.
    this.shapePhase += world.dTurn * 0.5;
    this.leadPhase -= world.dTravel * 0.08;

    const { spectrum } = frame;
    this.traces.record(LOW, traceValue(frame, response, 1, sampleSpectrumRange(spectrum, 0, LOW_END)));
    this.traces.record(MID, traceValue(frame, response, 0.5, sampleSpectrumRange(spectrum, LOW_END, MID_END)));
    this.traces.record(HIGH, traceValue(frame, response, 0, sampleSpectrumRange(spectrum, MID_END, 1)));
    this.traces.update(music.tempo / (modulation ? 0.4 + 2 * modulation.persistence : 1), dt);
    this.voices.update(frame, music, dt, p.digital);

    const u = this.tunnelMaterial.uniforms;
    u.uTravel.value = this.travel;
    u.uRadius.value = p.radius * (modulation ? 0.85 + 0.3 * modulation.scale : 1) * Math.max(0.4, 1 + 0.42 * world.pressure);
    u.uTraceShift.value = this.traces.shift;
    u.uDigital.value = this.voices.digital;
    // Bass: the section's depth (weight) and lobes (pitch: higher notes, more lobes; per song a base count).
    // Each part fades with its band: the section with the bass, the ring lines with the lead, the fine grid with the highs.
    u.uShape.value = p.deform * (modulation?.distortion ?? weight) * response.lowAudible;
    u.uLobes.value = (3 + 4 * vary[0]) * (1 + 0.5 * Math.max(Math.log2(music.bassPitch / 40), 0));
    u.uShapePhase.value = this.shapePhase;
    u.uRing.value = p.ringTrace * (0.5 + 0.4 * trace + 0.6 * world.excitation);
    // Mids: lead-shaped ring lines, twist and bend.
    u.uLeadWobble.value = p.leadWobble * flow * (0.4 + 0.6 * music.leadVoice) * response.midAudible;
    u.uLeadCycles.value = (2 + 3 * vary[3]) * (1 + 0.3 * Math.max(Math.log2(music.leadPitch / 180), 0));
    u.uLeadPhase.value = this.leadPhase;
    // Torsion: the tunnel winds with the world's angular velocity, every section further than the one before it.
    u.uTwist.value = (vary[7] - 0.5) * 0.02 * flow + world.spin * 0.03;
    u.uBend.value = p.bend * (0.1 + 1.4 * world.disorder);
    u.uLateral.value = world.lateral;
    // Highs: fine grid; brightness from energy, hits and drops.
    u.uDetail.value = detail * response.highAudible;
    u.uDensity.value = world.light;
    // Breathing by register: the mids squeeze the section, the highs corrugate the wall (each fades with its band).
    const breath = u.uBreath.value as Vector3;
    breath.x = p.oval * (0.4 + 0.6 * flow) * response.midAudible;
    breath.y = p.ripple * detail * response.highAudible;
    // Waveguide: the wall carries the modes the audio engine keeps ringing; a coherent world carries them cleanly.
    const physics = modulation?.experienceState?.physics;
    if (physics) this.modes.set(physics.modes); else this.modes.fill(0);
    u.uWaveguide.value = p.waveguide * (0.4 + 0.6 * world.coherence);
    // Architecture under force: held potential and disorder open the wall into rings and panels, draw the far tunnel
    // in and give the section edges. A release is a front that travels down the tunnel and leaves another structure
    // behind it: the one before the release is still ahead of the front.
    const t = tunnelTopology(this.topology, world), structure = this.structure;
    structure.update(world);
    const after = CONFIGURATIONS[structure.current], before = CONFIGURATIONS[structure.previous];
    (u.uGap.value as Vector2).set(t.gapAngular, t.gapAxial);
    (u.uForm.value as Vector4).set(t.facet, t.throat, t.lift, t.shear);
    (u.uConfig.value as Vector4).set(after[0], after[1], before[0], before[1]);
    (u.uRings.value as Vector2).set(after[2], before[2]);
    u.uFront.value = t.front;
    u.uRelease.value = t.release;
    const s = this.sparkMaterial.uniforms;
    s.uSparkTravel.value = this.sparkTravel;
    s.uSparks.value = (modulation?.particleEmission ?? (detail * (0.3 + 0.7 * music.highPercussion))) * response.highAudible;

    // A slow roll with the mids; no zoom or shake on beats.
    if (modulation) {
      const fov = this.preset.camera.fov * (0.85 + 0.3 * modulation.depth);
      if (Math.abs(fov - this.camera.fov) > 0.02) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    }
    this.camera.rotation.z = Math.sin(this.roll) * 0.25 * this.preset.camera.drift * (modulation ? 2 * modulation.cameraMotion : 1);
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
