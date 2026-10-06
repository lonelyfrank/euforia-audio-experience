import { VisualDirector, type DirectorClock } from '../director/VisualDirector';
import type { DirectionSettings, SceneDirection } from '../director/types';
import { HalfFloatType, OrthographicCamera, PerspectiveCamera, Vector2, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { PaletteColors, QualityProfile, SceneClock, SceneInput, SceneLayout, Visualizer, VisualizerPreset } from '../types/visualizer';

export interface SceneSource {
  direction?: SceneDirection;
  create: () => Visualizer;
  preset: VisualizerPreset;
}

export interface LayerSize {
  width: number;
  height: number;
  pixelRatio: number;
}

/**
 * One mounted visualizer with its own post-processing chain, rendered into an
 * offscreen target so two of them can be crossfaded.
 */
export class Layer {
  /** Reused timed input of the Director. */
  private readonly clock: DirectorClock = { time: 0, impact: 0, snapAt: -1 };
  /** Reused timed input of the scene (set while the rig is timed). */
  private sceneClock: SceneClock | null = null;
  readonly director: VisualDirector;
  private bloom: UnrealBloomPass | null = null;
  readonly visualizer: Visualizer;
  private readonly composer: EffectComposer;
  private readonly passes: Pass[] = [];
  private size: LayerSize = { width: 1, height: 1, pixelRatio: 1 };

  constructor(
    renderer: WebGLRenderer,
    readonly source: SceneSource,
    readonly quality: QualityProfile,
    size: LayerSize,
    palette: PaletteColors,
    private layout: SceneLayout,
  ) {
    this.director = new VisualDirector(source.direction);
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
    this.visualizer.setLayout?.(layout);

    this.passes.push(new RenderPass(this.visualizer.scene, this.visualizer.camera), ...preBloom);
    const { strength, radius, threshold } = source.preset.bloom;
    if (quality.bloom && strength > 0) {
      this.bloom = new UnrealBloomPass(new Vector2(1, 1), strength, radius, threshold);
      this.passes.push(this.bloom);
    }
    this.passes.push(...postBloom);
    for (const pass of this.passes) this.composer.addPass(pass);
    this.resize(size);
  }

  /** The rendered frame (valid after `render`). */
  get texture() {
    return this.composer.readBuffer.texture;
  }

  resize(size: LayerSize): void {
    this.size = size;
    this.composer.setPixelRatio(size.pixelRatio);
    this.composer.setSize(size.width, size.height);
    this.visualizer.resize(size.width, size.height);
    this.placeCamera();
  }

  /** New layout (shared object, updated in place by the engine). */
  setLayout(layout: SceneLayout): void {
    this.layout = layout;
    this.placeCamera();
    this.visualizer.setLayout?.(layout);
  }

  /** Shift the principal point so the scene centre lands at the layout's centre. */
  private placeCamera(): void {
    const { width, height } = this.size;
    const { centerX, centerY } = this.layout;
    const camera = this.visualizer.camera;
    if (camera instanceof PerspectiveCamera || camera instanceof OrthographicCamera) {
      camera.setViewOffset(width, height, (0.5 - centerX) * width, (centerY - 0.5) * -height, width, height);
    }
  }

  update(input: SceneInput, settings: DirectionSettings, dt: number, time: number): void {
    const rig = input.rig;
    if (rig?.timed) {
      this.clock.time = rig.time;
      this.clock.impact = rig.glowPulse;
      this.clock.snapAt = rig.snapAt;
      this.clock.releaseLight = rig.experienceLight;
    }
    const modulation = this.director.update(input.response, settings, dt, rig?.timed ? this.clock : undefined, rig?.experience);
    let clock: SceneClock | undefined;
    if (rig?.timed) {
      clock = this.sceneClock ??= { time: 0, hits: rig.hits, hitScale: 1 };
      clock.time = rig.time;
      clock.hits = rig.hits;
      clock.hitScale = this.director.impactScale;
      clock.experience = rig.experience;
    }
    this.visualizer.update(input.audio, dt, time, this.director.response!, modulation, clock);
    if (this.bloom) this.bloom.strength = this.source.preset.bloom.strength * (0.25 + 1.5 * modulation.bloom);
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

