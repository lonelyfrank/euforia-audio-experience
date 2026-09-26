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
import type { AudioFrame } from '../../types/audio';
import type { PaletteColors, VisualizerContext } from '../../types/visualizer';
import { BaseVisualizer } from '../shared/BaseVisualizer';

export interface TunnelParams {
  radius: number;
  length: number;
  radialSegments: number;
  lengthSegments: number;
  baseSpeed: number;
  midSpeed: number;
  /** Extra speed on each beat (units/s at the pulse peak). */
  beatPush: number;
  ringDensity: number;
  segments: number;
  bend: number;
  lobes: number;
  deform: number;
  fog: number;
  hueSpeed: number;
  sparkCount: number;
}

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
  uniform float uRadius;
  uniform float uTime;
  uniform float uBass;
  uniform float uPulse;
  uniform float uLobes;
  uniform float uDeform;

  varying float vDepth;
  varying float vCoord;
  varying float vAngle;

  void main() {
    float d = -position.z;
    float angle = uv.x * 6.2831853;
    // Bass bulges the walls in rotating lobes; beats add a brief global swell.
    float wave = sin(angle * uLobes + d * 0.18 - uTime * 1.5);
    float r = uRadius * (1.0 + uDeform * uBass * wave * smoothstep(2.0, 12.0, d) + uPulse * 0.06);
    vec2 offset = bendAt(d);
    // Same (sin, cos) orientation as CylinderGeometry so BackSide keeps the inner faces.
    vec3 p = vec3(sin(angle) * r + offset.x, cos(angle) * r + offset.y, -d);
    vDepth = d;
    vCoord = d + uTravel;
    vAngle = uv.x;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const tunnelFragment = /* glsl */ `
  uniform float uTime;
  uniform float uRingDensity;
  uniform float uSegments;
  uniform float uFog;
  uniform float uHueSpeed;
  uniform float uTreble;
  uniform float uEnergy;
  uniform float uPulse;

  varying float vDepth;
  varying float vCoord;
  varying float vAngle;

  float gridLine(float coord, float width) {
    float w = fwidth(coord) * width;
    return 1.0 - smoothstep(0.0, w, abs(fract(coord - 0.5) - 0.5));
  }

  uniform vec3 uColor0;
  uniform vec3 uColor1;
  uniform vec3 uColor2;

  // Smooth loop through the preset's three hues.
  vec3 palette(float t) {
    float x = fract(t) * 3.0;
    vec3 a = x < 1.0 ? uColor0 : x < 2.0 ? uColor1 : uColor2;
    vec3 b = x < 1.0 ? uColor1 : x < 2.0 ? uColor2 : uColor0;
    return mix(a, b, smoothstep(0.0, 1.0, fract(x)));
  }

  void main() {
    float rings = gridLine(vCoord * uRingDensity, 1.5);
    float lines = gridLine(vAngle * uSegments, 1.2);
    // Treble reveals a finer secondary grid.
    float detail = max(gridLine(vCoord * uRingDensity * 4.0, 1.0), gridLine(vAngle * uSegments * 4.0, 1.0)) * uTreble;
    float intensity = max(rings, lines * 0.5) + detail * 0.18;

    vec3 color = palette(vCoord * 0.004 + uTime * uHueSpeed);
    float fog = exp(-vDepth * uFog);
    vec3 base = color * 0.015;
    vec3 outColor = (base + color * intensity * (0.25 + uEnergy * 0.5 + uPulse * 0.4)) * fog;
    gl_FragColor = vec4(outColor, 1.0);
  }
`;

const sparkVertex = /* glsl */ `
  ${bendChunk}
  uniform float uSparkTravel;
  uniform float uLength;
  uniform float uRadius;
  uniform float uTreble;
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
    gl_PointSize = min((1.0 + uTreble * 2.0) * (14.0 / -mv.z), 6.0) * uPixelRatio;
    vFade = uTreble * smoothstep(uLength, uLength * 0.5, d) * smoothstep(0.0, 3.0, d);
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
 * bass → wall deformation, mids → speed, treble → fine grid & sparks,
 * beat → short swell of radius, brightness and FOV.
 */
export class TunnelVisualizer extends BaseVisualizer<TunnelParams> {
  private tunnelMaterial!: ShaderMaterial;
  private sparkMaterial!: ShaderMaterial;
  private renderer!: WebGLRenderer;
  private travel = 0;
  private sparkTravel = 0;

  init({ quality, renderer }: VisualizerContext): void {
    const p = this.preset.visual;
    this.renderer = renderer;
    const shared = { uTravel: { value: 0 }, uBend: { value: p.bend }, uRadius: { value: p.radius } };

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
        uTime: { value: 0 },
        uBass: { value: 0 },
        uPulse: { value: 0 },
        uTreble: { value: 0 },
        uEnergy: { value: 0 },
        uLobes: { value: p.lobes },
        uDeform: { value: p.deform },
        uRingDensity: { value: p.ringDensity },
        uSegments: { value: p.segments },
        uFog: { value: p.fog },
        uHueSpeed: { value: p.hueSpeed },
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
        uSparkTravel: { value: 0 },
        uLength: { value: p.length },
        uTreble: { value: 0 },
        uPixelRatio: { value: renderer.getPixelRatio() },
      },
    });
    const sparks = new Points(sparkGeometry, this.sparkMaterial);
    sparks.frustumCulled = false;
    this.scene.add(sparks);
  }

  setPalette(colors: PaletteColors): void {
    const u = this.tunnelMaterial.uniforms;
    colors.forEach((color, i) => (u[`uColor${i}`].value as Color).copy(color));
  }

  update(frame: AudioFrame, dt: number, time: number): void {
    const p = this.preset.visual;
    const speed = p.baseSpeed + frame.mid * p.midSpeed + frame.beatPulse * p.beatPush;
    this.travel += dt * speed;
    this.sparkTravel += dt * (speed * 1.6 + frame.treble * 20);

    const u = this.tunnelMaterial.uniforms;
    u.uTravel.value = this.travel;
    u.uTime.value = time;
    u.uBass.value = frame.bass;
    u.uPulse.value = frame.beatPulse;
    u.uTreble.value = frame.treble;
    u.uEnergy.value = frame.energy;
    const s = this.sparkMaterial.uniforms;
    s.uSparkTravel.value = this.sparkTravel;
    s.uTreble.value = frame.treble;

    // Gentle roll and a subtle FOV kick on beats; no aggressive camera moves.
    const { fov, drift } = this.preset.camera;
    this.camera.rotation.z = Math.sin(time * 0.1) * 0.25 * drift;
    this.camera.fov = fov + frame.beatPulse * 3.5;
    this.camera.updateProjectionMatrix();
  }

  override resize(width: number, height: number): void {
    super.resize(width, height);
    this.sparkMaterial.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
  }
}
