import { Color, Mesh, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial } from 'three';
import type { AudioFrame } from '../../types/audio';
import type { PaletteColors, Visualizer, VisualizerContext, VisualizerPreset } from '../../types/visualizer';
import { HORIZON, SCENE_CENTER } from '../../renderer/compositeShader';
import { disposeObject } from '../shared/dispose';

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
}

const MAX_RIBBONS = 8;

const vertexShader = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = (modelMatrix * vec4(position, 1.0)).xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  #define MAX_RIBBONS ${MAX_RIBBONS}
  uniform float uTime;
  uniform float uHalfWidth;
  uniform float uHorizonY;
  uniform int uRibbons;
  uniform float uAmplitude;
  uniform float uRipple;
  uniform float uFill;
  uniform float uLineWidth;
  uniform float uLevel;
  uniform float uTreble;
  uniform vec3 uColors[3];
  varying vec2 vPos;

  void main() {
    float v = vPos.x / (2.0 * uHalfWidth) + 0.5;
    vec3 color = vec3(0.0);
    for (int k = 0; k < MAX_RIBBONS; k++) {
      if (k >= uRibbons) break;
      float fk = float(k);
      // Ribbons are stacked from high in the sky down towards the horizon.
      float base = uHorizonY + (1.0 - fk / float(uRibbons)) * 0.5;
      float wave = base
        + sin(v * (3.0 + fk) + uTime * (0.4 + fk * 0.13) + fk) * uAmplitude * (1.0 + uLevel)
        + sin(v * 11.0 - uTime * 0.9 + fk * 1.7) * uRipple
        + sin(v * 29.0 + uTime * 2.3 + fk) * uRipple * 0.35 * uTreble;
      vec3 hue = k == 0 || k == 3 ? uColors[0] : k == 1 || k == 4 ? uColors[1] : uColors[2];
      float d = vPos.y - wave;
      // Body between the ribbon and the horizon.
      if (d < 0.0 && vPos.y > uHorizonY) color += hue * 0.5 * (uFill + uLevel * 0.015);
      // Bright edge, anti-aliased.
      float px = fwidth(vPos.y);
      float edge = 1.0 - smoothstep(0.0, uLineWidth * px, abs(d));
      color += hue * edge * (0.4 + uLevel * 0.25);
    }
    gl_FragColor = vec4(color, 1.0);
  }
`;

/**
 * Layered undulating ribbons over the horizon, drawn analytically in one
 * full-screen fragment shader.
 * volume → wave amplitude, treble → fine ripples.
 */
export class LiquidVisualizer implements Visualizer {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, -1, 1);
  private material!: ShaderMaterial;
  private mesh!: Mesh;
  private time = 0;

  constructor(private readonly preset: VisualizerPreset<LiquidParams>) {}

  init({ renderer }: VisualizerContext): void {
    const p = this.preset.visual;
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uHalfWidth: { value: 1 },
        // Horizon in camera units: the scene centre is at y = 0, half-height = 1.
        uHorizonY: { value: (SCENE_CENTER.y - HORIZON) * 2 },
        uRibbons: { value: Math.min(p.ribbons, MAX_RIBBONS) },
        uAmplitude: { value: p.amplitude },
        uRipple: { value: p.ripple },
        uFill: { value: p.fill },
        uLineWidth: { value: p.lineWidth * renderer.getPixelRatio() },
        uLevel: { value: 0 },
        uTreble: { value: 0 },
        uColors: { value: [new Color(), new Color(), new Color()] },
      },
    });
    // Scaled to twice the view in resize(), so it still covers it after the scene-centre offset.
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.scene.add(this.mesh);
  }

  setPalette(colors: PaletteColors): void {
    const target = this.material.uniforms.uColors.value as Color[];
    colors.forEach((color, i) => target[i].copy(color));
  }

  update(frame: AudioFrame, dt: number): void {
    this.time += dt * this.preset.visual.speed * (0.8 + frame.mid * 0.6);
    const u = this.material.uniforms;
    u.uTime.value = this.time;
    u.uLevel.value = frame.volume;
    u.uTreble.value = frame.treble;
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
    disposeObject(this.scene);
    this.scene.clear();
  }
}
