import { Color, HalfFloatType, OrthographicCamera, PerspectiveCamera, Vector2, WebGLRenderer, WebGLRenderTarget } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { PaletteColors, QualityProfile, QualitySetting, SceneInput, Visualizer, VisualizerPreset } from '../types/visualizer';
import { CompositeShader, SCENE_CENTER } from './compositeShader';
import { QualityController } from './quality';

/** Longest step fed to visualizers, so a hiccup does not make them jump. */
const MAX_DELTA = 1 / 20;
/** Scene switch crossfade, seconds (linear). */
const CROSSFADE = 0.9;

export interface SceneSource {
  create: () => Visualizer;
  preset: VisualizerPreset;
}

interface LayerSize {
  width: number;
  height: number;
  pixelRatio: number;
}

/**
 * One mounted visualizer with its own post-processing chain, rendered into an
 * offscreen target so two of them can be crossfaded.
 */
class Layer {
  readonly visualizer: Visualizer;
  private readonly composer: EffectComposer;
  private readonly passes: Pass[] = [];

  constructor(
    renderer: WebGLRenderer,
    readonly source: SceneSource,
    quality: QualityProfile,
    size: LayerSize,
    palette: PaletteColors,
  ) {
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: quality.bloom ? 4 : 0 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.renderToScreen = false;
    this.visualizer = source.create();

    const preBloom: Pass[] = [];
    const postBloom: Pass[] = [];
    this.visualizer.init({
      renderer,
      width: size.width,
      height: size.height,
      quality,
      addPass: (pass, stage = 'post-bloom') => (stage === 'pre-bloom' ? preBloom : postBloom).push(pass),
    });
    this.visualizer.setPalette(palette);

    this.passes.push(new RenderPass(this.visualizer.scene, this.visualizer.camera), ...preBloom);
    const { strength, radius, threshold } = source.preset.bloom;
    if (quality.bloom && strength > 0) this.passes.push(new UnrealBloomPass(new Vector2(1, 1), strength, radius, threshold));
    this.passes.push(...postBloom);
    for (const pass of this.passes) this.composer.addPass(pass);
    this.resize(size);
  }

  /** The rendered frame (valid after `render`). */
  get texture() {
    return this.composer.readBuffer.texture;
  }

  resize({ width, height, pixelRatio }: LayerSize): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.visualizer.resize(width, height);
    // Shift the principal point so the scene centre lands at SCENE_CENTER.
    const camera = this.visualizer.camera;
    if (camera instanceof PerspectiveCamera || camera instanceof OrthographicCamera) {
      camera.setViewOffset(width, height, (0.5 - SCENE_CENTER.x) * width, (SCENE_CENTER.y - 0.5) * -height, width, height);
    }
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  dispose(): void {
    this.visualizer.dispose();
    for (const pass of this.passes) pass.dispose();
    this.composer.dispose();
  }
}

/**
 * Owns the WebGL renderer, the frame loop and the final Halo composition
 * (crossfade, sky, reflective floor, horizon). Audio comes in through the
 * `frameSource` callback, so it does not depend on the audio engine.
 */
export class RenderEngine {
  readonly renderer: WebGLRenderer;
  paused = false;

  private readonly composer: EffectComposer;
  private readonly composite = new ShaderPass(CompositeShader, 'tUnused');
  private readonly output = new OutputPass();
  private readonly quality = new QualityController();
  private readonly resizeObserver: ResizeObserver;
  private readonly palette: [Color, Color, Color] = [new Color(), new Color(), new Color()];
  private current: Layer | null = null;
  private previous: Layer | null = null;
  private mix = 1;
  private rafId = 0;
  private lastTime = 0;
  private time = 0;
  private layerSize: LayerSize = { width: 1, height: 1, pixelRatio: 1 };

  constructor(
    private readonly container: HTMLElement,
    private readonly frameSource: (dt: number) => SceneInput,
  ) {
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 1);
    container.appendChild(this.renderer.domElement);

    this.composer = new EffectComposer(this.renderer, new WebGLRenderTarget(1, 1, { type: HalfFloatType }));
    this.composer.addPass(this.composite);
    this.composer.addPass(this.output);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  setQuality(setting: QualitySetting): void {
    this.quality.set(setting);
    this.applyQuality();
  }

  /** Palette colours are copied; the scenes and the composition pick them up at once. */
  setPalette(colors: PaletteColors): void {
    colors.forEach((c, i) => this.palette[i].copy(c));
    this.current?.visualizer.setPalette(this.palette);
    this.previous?.visualizer.setPalette(this.palette);
    const u = this.composite.uniforms;
    (u.uHaze.value as Color).copy(this.palette[1]).multiplyScalar(0.25);
    (u.uSheen.value as Color).copy(this.palette[1]);
  }

  /** Mounts a scene. With one already showing, the two crossfade. */
  show(source: SceneSource): void {
    // A switch during a crossfade drops the oldest scene.
    this.previous?.dispose();
    this.previous = this.current;
    this.current = new Layer(this.renderer, source, this.quality.profile, this.layerSize, this.palette);
    this.mix = this.previous ? 0 : 1;
    this.quality.resetWindow();
  }

  start(): void {
    if (this.rafId) return;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.previous?.dispose();
    this.current?.dispose();
    this.resizeObserver.disconnect();
    this.composite.dispose();
    this.output.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private readonly tick = (now: number): void => {
    this.rafId = requestAnimationFrame(this.tick);
    const rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    const dt = Math.min(rawDt, MAX_DELTA);

    const { audio: frame, response } = this.frameSource(dt);
    const current = this.current;
    if (!current) return;

    if (this.previous) {
      this.mix = Math.min(this.mix + dt / CROSSFADE, 1);
      if (this.mix >= 1) {
        this.previous.dispose();
        this.previous = null;
      }
    }
    if (!this.paused) {
      this.time += dt;
      current.visualizer.update(frame, dt, this.time, response);
      this.previous?.visualizer.update(frame, dt, this.time, response);
    }
    current.render(dt);
    this.previous?.render(dt);

    const u = this.composite.uniforms;
    u.tA.value = (this.previous ?? current).texture;
    u.tB.value = current.texture;
    u.uMix.value = this.mix;
    u.uTime.value = this.time;
    u.uLevel.value = frame.volume;
    this.composer.render(dt);

    if (!this.paused && this.quality.sample(rawDt)) this.applyQuality();
  };

  /** Quality can change geometry density, so the scene is rebuilt (crossfaded). */
  private applyQuality(): void {
    this.resize();
    if (this.current) this.show(this.current.source);
  }

  private resize(): void {
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    const profile = this.quality.profile;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, profile.maxPixelRatio) * profile.pixelScale;
    this.layerSize = { width, height, pixelRatio };
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    (this.composite.uniforms.uResolution.value as Vector2).set(width * pixelRatio, height * pixelRatio);
    this.current?.resize(this.layerSize);
    this.previous?.resize(this.layerSize);
  }
}
