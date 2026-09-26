import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial, type WebGLRenderer } from 'three';
import type { AudioFrame } from '../../types/audio';
import type { PaletteColors, VisualizerContext } from '../../types/visualizer';
import { BaseVisualizer } from '../shared/BaseVisualizer';

export interface GalaxyParams {
  count: number;
  radius: number;
  arms: number;
  /** Radians of spiral twist from the centre to the rim. */
  twist: number;
  thickness: number;
  size: number;
  /** Base angular speed (inner stars turn faster). */
  spin: number;
  /** Camera elevation, radians. */
  tilt: number;
}

const vertexShader = /* glsl */ `
  uniform float uSpin;
  uniform float uRadius;
  uniform float uSize;
  uniform float uKick;
  uniform float uPixelRatio;
  uniform vec3 uColors[3];

  // x: radius 0..1, y: base angle, z: arm index, w: size factor
  attribute vec4 aStar;
  attribute float aHeight;

  varying vec3 vColor;

  void main() {
    float r = aStar.x;
    // Differential rotation: the core turns faster than the rim.
    float angle = aStar.y + uSpin * (0.4 + 1.0 * (1.0 - r));
    vec3 p = vec3(cos(angle) * r, aHeight * (1.0 - r), sin(angle) * r) * uRadius;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    // Kicks swell the inner stars.
    float size = uSize * aStar.w * (1.0 + uKick * 0.6 * (1.0 - r));
    gl_PointSize = size * uPixelRatio * (300.0 / -mv.z);
    int arm = int(aStar.z);
    vec3 color = arm == 0 ? uColors[0] : arm == 1 ? uColors[1] : uColors[2];
    vColor = color * (0.35 + 0.65 * (1.0 - r));
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uLevel;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    gl_FragColor = vec4(vColor * smoothstep(0.5, 0.0, d) * (0.5 + uLevel * 0.7), 1.0);
  }
`;

/**
 * A three-armed spiral galaxy seen at a low angle. Positions are computed on
 * the GPU from per-star seeds; the CPU only integrates the spin.
 * kick → size of the inner stars, mids → spin speed, volume → brightness.
 */
export class GalaxyVisualizer extends BaseVisualizer<GalaxyParams> {
  private material!: ShaderMaterial;
  private renderer!: WebGLRenderer;
  private spin = 0;

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
        uSpin: { value: 0 },
        uRadius: { value: p.radius },
        uSize: { value: p.size },
        uKick: { value: 0 },
        uLevel: { value: 0 },
        uPixelRatio: { value: renderer.getPixelRatio() },
        uColors: { value: [new Color(), new Color(), new Color()] },
      },
    });
    const points = new Points(geometry, this.material);
    points.frustumCulled = false;
    this.scene.add(points);
  }

  setPalette(colors: PaletteColors): void {
    const target = this.material.uniforms.uColors.value as Color[];
    colors.forEach((color, i) => target[i].copy(color));
  }

  update(frame: AudioFrame, dt: number, time: number): void {
    const p = this.preset.visual;
    this.spin += dt * p.spin * (1 + frame.mid * 1.5);
    const u = this.material.uniforms;
    u.uSpin.value = this.spin;
    u.uKick.value = Math.max(frame.beatPulse, frame.bass * 0.5);
    u.uLevel.value = frame.volume;

    const { distance, drift } = this.preset.camera;
    const tilt = p.tilt + Math.sin(time * 0.06) * 0.06 * drift;
    const yaw = Math.sin(time * 0.04) * 0.3 * drift;
    this.camera.position.set(Math.sin(yaw) * Math.cos(tilt) * distance, Math.sin(tilt) * distance, Math.cos(yaw) * Math.cos(tilt) * distance);
    this.camera.lookAt(0, 0, 0);
  }

  override resize(width: number, height: number): void {
    super.resize(width, height);
    this.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
  }
}
