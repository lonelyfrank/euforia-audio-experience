import { VisualDirector, type DirectorClock } from '../director/VisualDirector';
import type { DirectionSettings, SceneDirection } from '../director/types';
import { HalfFloatType, OrthographicCamera, PerspectiveCamera, Vector2, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { PaletteColors, QualityProfile, SceneClock, SceneInput, SceneLayout, Visualizer, VisualizerPreset } from '../types/visualizer';
import { ScenePass } from './ScenePass';

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

/** Longest wait (ms) for a new scene's programs before it is shown anyway (a driver that never reports them ready). */
const PREPARE_TIMEOUT = 3000;

/**
 * One mounted visualizer with its own post-processing chain, rendered into an
 * offscreen target so two of them can be crossfaded.
 *
 * The scene's geometry is multisampled once (ScenePass); the passes after it
 * (the scene's own, bloom) work on plain targets. Its shader programs are
 * compiled off the frame (`ready`): until then the layer is not drawn, so a
 * scene change does not stall the picture on a compile.
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
  /** The multisampled scene pass, when the profile asks for antialiasing. */
  private readonly scenePass: ScenePass | null = null;
  private size: LayerSize = { width: 1, height: 1, pixelRatio: 1 };
  /** True once the scene's programs are compiled: drawing it will not stall the frame. */
  ready = false;
  private disposed = false;

  constructor(
    renderer: WebGLRenderer,
    readonly source: SceneSource,
    readonly quality: QualityProfile,
    size: LayerSize,
    palette: PaletteColors,
    private layout: SceneLayout,
  ) {
    this.director = new VisualDirector(source.direction);
    const samples = quality.samples ?? (quality.bloom ? 4 : 0);
    // With a multisampled scene pass the composer's targets hold only resolved pictures: no samples, no depth.
    this.composer = new EffectComposer(renderer, new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: samples === 0 }));
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

    if (samples > 0) {
      this.scenePass = new ScenePass(this.visualizer.scene, this.visualizer.camera, samples);
      this.passes.push(this.scenePass);
    } else this.passes.push(new RenderPass(this.visualizer.scene, this.visualizer.camera));
    this.passes.push(...preBloom);
    const { strength, radius, threshold } = source.preset.bloom;
    if (quality.bloom && strength > 0) {
      this.bloom = new UnrealBloomPass(new Vector2(1, 1), strength, radius, threshold);
      this.passes.push(this.bloom);
    }
    this.passes.push(...postBloom);
    if (this.scenePass) this.scenePass.last = this.passes.length === 1;
    for (const pass of this.passes) this.composer.addPass(pass);
    this.resize(size);
    this.prepare(renderer);
  }

  /** The rendered frame (valid after `render`). */
  get texture() {
    return this.scenePass?.last ? this.scenePass.texture : this.composer.readBuffer.texture;
  }

  /**
   * Compiles the scene's programs without blocking (KHR_parallel_shader_compile where the driver has
   * it), for the target a frame draws them into: a program is specific to its output colour space.
   */
  private prepare(renderer: WebGLRenderer): void {
    const done = () => { this.ready = true; };
    if (typeof renderer.compileAsync !== 'function') return done();
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.scenePass?.renderTarget ?? this.composer.readBuffer);
    const compiled = renderer.compileAsync(this.visualizer.scene, this.visualizer.camera);
    renderer.setRenderTarget(previous);
    const timeout = setTimeout(done, PREPARE_TIMEOUT);
    void compiled.catch(() => undefined).then(() => {
      clearTimeout(timeout);
      if (!this.disposed) done();
    });
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

  /** `structure` 0..1: how much structure the show lets this fixture carry (see SceneClock.structure). */
  update(input: SceneInput, settings: DirectionSettings, dt: number, time: number, structure = 1): void {
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
      clock.events = rig.events;
      clock.light = rig.experienceLight ?? 0;
      clock.structure = structure;
    }
    this.visualizer.update(input.audio, dt, time, this.director.response!, modulation, clock);
    if (this.bloom) this.bloom.strength = this.source.preset.bloom.strength * (0.25 + 1.5 * modulation.bloom);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  /** Configured enabled passes; hidden layers may not submit them. */
  get diagnosticPasses(): number {
    let count = 0;
    for (const pass of this.composer.passes) if (pass.enabled) count++;
    return count;
  }

  dispose(): void {
    this.disposed = true;
    this.visualizer.dispose();
    for (const pass of this.passes) pass.dispose();
    this.composer.dispose();
  }
}

