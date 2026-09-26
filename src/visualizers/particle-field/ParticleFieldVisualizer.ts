import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial, type WebGLRenderer } from 'three';
import type { AudioFrame } from '../../types/audio';
import type { PaletteColors, VisualizerContext } from '../../types/visualizer';
import { BaseVisualizer } from '../shared/BaseVisualizer';

export interface ParticleFieldParams {
  count: number;
  depth: number;
  spread: number;
  baseSpeed: number;
  midSpeed: number;
  /** Extra speed on each beat (units/s at the pulse peak). */
  beatPush: number;
  size: number;
  swirl: number;
}

const WHITE = new Color(1, 1, 1);

const vertexShader = /* glsl */ `
  uniform float uTravel;
  uniform float uSparkTravel;
  uniform float uTime;
  uniform float uDepth;
  uniform float uSpread;
  uniform float uSize;
  uniform float uBass;
  uniform float uPulse;
  uniform float uTreble;
  uniform float uDensity;
  uniform float uSwirl;
  uniform float uPixelRatio;

  attribute vec4 aSeed;

  varying float vMix;
  varying float vSpark;
  varying float vFade;

  void main() {
    // seed.w > 0.8: "spark" particles, driven by treble (smaller, faster).
    float spark = step(0.8, aSeed.w);
    float travel = mix(uTravel, uSparkTravel, spark);

    // Endless flight: z wraps around the field depth.
    float z = mod(aSeed.z * uDepth + travel, uDepth) - uDepth;

    // Polar layout around the flight axis, swirling with depth and time.
    float angle = aSeed.x * 6.2831853 + z * 0.02 * uSwirl + uTime * 0.1 * uSwirl;
    float radius = (0.08 + pow(aSeed.y, 0.7)) * uSpread;
    // Bass kicks push particles outwards as a shock wave.
    radius *= 1.0 + uBass * 0.25 + uPulse * 0.35 * (1.0 - aSeed.y);
    vec3 position = vec3(cos(angle) * radius, sin(angle) * radius, z);

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // Emission: only a density-dependent share of the field is visible.
    float visible = step(aSeed.w, uDensity) + spark * step(0.2, uTreble);
    float size = uSize * mix(1.0 + uBass * 1.2, 0.5 + uTreble * 1.5, spark);
    gl_PointSize = visible > 0.0 ? min(size * (300.0 / -mvPosition.z), 9.0) * uPixelRatio : 0.0;

    vMix = aSeed.x;
    vSpark = spark;
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

  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p);
    if (d > 0.5) discard;
    float glow = smoothstep(0.5, 0.0, d);
    vec3 color = mix(mix(uColorA, uColorB, vMix), uSparkColor, vSpark);
    gl_FragColor = vec4(color * glow * vFade * (0.5 + uEnergy), 1.0);
  }
`;

/**
 * GPU particle flight: every particle's position is computed in the vertex
 * shader from a static seed and a few uniforms, so the CPU only integrates
 * travel distance each frame.
 * bass → radial impulses & size, mids → flight speed, treble → sparks,
 * energy → emission density & brightness.
 */
export class ParticleFieldVisualizer extends BaseVisualizer<ParticleFieldParams> {
  private material!: ShaderMaterial;
  private renderer!: WebGLRenderer;
  private travel = 0;
  private sparkTravel = 0;
  private density = 0.4;

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
        uTravel: { value: 0 },
        uSparkTravel: { value: 0 },
        uTime: { value: 0 },
        uDepth: { value: p.depth },
        uSpread: { value: p.spread },
        uSize: { value: p.size },
        uBass: { value: 0 },
        uPulse: { value: 0 },
        uTreble: { value: 0 },
        uEnergy: { value: 0 },
        uDensity: { value: 0.4 },
        uSwirl: { value: p.swirl },
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

  update(frame: AudioFrame, dt: number, time: number): void {
    const p = this.preset.visual;
    const u = this.material.uniforms;
    this.travel += dt * (p.baseSpeed + frame.mid * p.midSpeed + frame.beatPulse * p.beatPush);
    this.sparkTravel += dt * (p.baseSpeed * 2 + (frame.treble + frame.highMid) * p.midSpeed * 0.75);
    // Density eases towards the current energy so emission swells and recedes.
    this.density += (0.25 + frame.energy * 0.55 - this.density) * Math.min(dt * 2, 1);

    u.uTravel.value = this.travel;
    u.uSparkTravel.value = this.sparkTravel;
    u.uTime.value = time;
    u.uBass.value = frame.bass;
    u.uPulse.value = frame.beatPulse;
    u.uTreble.value = frame.treble;
    u.uEnergy.value = frame.energy;
    u.uDensity.value = this.density;

    const drift = this.preset.camera.drift;
    this.camera.rotation.z = Math.sin(time * 0.05) * 0.3 * drift;
    this.camera.position.x = Math.sin(time * 0.13) * 1.5 * drift;
    this.camera.position.y = Math.cos(time * 0.11) * 1.5 * drift;
  }

  override resize(width: number, height: number): void {
    super.resize(width, height);
    // Point sizes are in device pixels; the ratio changes with quality/resolution.
    this.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
  }
}
