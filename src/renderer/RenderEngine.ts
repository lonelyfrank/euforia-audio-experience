import { approach, VisualDirector, type DirectorClock } from '../director/VisualDirector';
import { AutoDirection } from '../director/AutoDirection';
import { DEFAULT_DIRECTION } from '../director/profiles';
import type { DirectionSettings, SceneDirection } from '../director/types';
import { Color, HalfFloatType, OrthographicCamera, PerspectiveCamera, Vector2, WebGLRenderer, WebGLRenderTarget } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { PaletteColors, QualityProfile, QualitySetting, SceneInput, SceneLayout, Visualizer, VisualizerPreset } from '../types/visualizer';
import { CompositeShader, HORIZON, OPEN_CENTER, OPEN_HORIZON, SCENE_CENTER } from './compositeShader';
import { QualityController } from './quality';

/** Longest step fed to visualizers, so a hiccup does not make them jump. */
const MAX_DELTA = 1 / 20;
/** Scene switch crossfade, seconds (linear). */
const CROSSFADE = 0.9;
/** Water reflection on/off transition, seconds. */
const REFLECTION_FADE = 1;
/** How far the scene floats without the reflection (fractions of the window). */
const FLOAT_X = 0.04;
const FLOAT_Y = 0.03;

export interface SceneSource {
  direction?: SceneDirection;
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
  /** Reused timed input of the Director. */
  private readonly clock: DirectorClock = { time: 0, impact: 0, snapAt: -1 };
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
      this.clock.impact = rig.haloPulse;
      this.clock.snapAt = rig.snapAt;
    }
    const modulation = this.director.update(input.response, settings, dt, rig?.timed ? this.clock : undefined);
    this.visualizer.update(input.audio, dt, time, this.director.response!, modulation);
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

/**
 * Owns the WebGL renderer, the frame loop and the final Halo composition
 * (crossfade, sky, reflective floor, horizon). Audio comes in through the
 * `frameSource` callback, so it does not depend on the audio engine.
 */
export class RenderEngine {
  readonly renderer: WebGLRenderer;
  paused = false;
  readonly autoDirection = new AutoDirection();
  private readonly direction: DirectionSettings = { ...DEFAULT_DIRECTION };
  get modulation() { return this.current?.director.frame; }
  get effectiveDirection() { return this.autoDirection.settings; }
  setDirection(settings: DirectionSettings): void {
    this.direction.mood = settings.mood;
    this.direction.moodIntensity = settings.moodIntensity;
    this.direction.experience = settings.experience;
    this.direction.autoDirection = settings.autoDirection;
  }

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
  private readonly layout: SceneLayout = { centerX: SCENE_CENTER.x, centerY: SCENE_CENTER.y, horizon: HORIZON, reflection: 1 };
  /** Water reflection: target (0/1) and the current, animated amount. */
  private reflectionTarget = 1;
  private reflection = 1;
  private reflectionSet = false;
  /** Phase of the gentle float without the reflection; advances only with the music. */
  private floatPhase = 0;

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

  /** Shows or hides the water reflection (animated, except the first time). */
  setReflection(on: boolean): void {
    this.reflectionTarget = on ? 1 : 0;
    if (!this.reflectionSet) {
      this.reflection = this.reflectionTarget;
      this.reflectionSet = true;
      this.updateLayout(0, 0);
    }
  }

  /** Mounts a scene. With one already showing, the two crossfade. */
  show(source: SceneSource): void {
    // A switch during a crossfade drops the oldest scene.
    this.previous?.dispose();
    this.previous = this.current;
    this.current = new Layer(this.renderer, source, this.quality.profile, this.layerSize, this.palette, this.layout);
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

    const input = this.frameSource(dt);
    const { audio: frame, response } = input;
    const direction = this.autoDirection.update(response, this.direction, this.paused ? 0 : dt, frame.time);
    const current = this.current;
    if (!current) return;
    if (!this.paused) {
      this.floatPhase += dt * (0.6 * response.flow + 0.2 * response.density) * response.music.pace;
      this.updateLayout(dt, this.floatPhase);
    }

    if (this.previous) {
      this.mix = Math.min(this.mix + dt / CROSSFADE, 1);
      if (this.mix >= 1) {
        this.previous.dispose();
        this.previous = null;
      }
    }
    if (!this.paused) {
      this.time += dt;
      current.update(input, direction, dt, this.time);
      this.previous?.update(input, direction, dt, this.time);
    }
    current.render(dt);
    this.previous?.render(dt);

    const u = this.composite.uniforms;
    u.tA.value = (this.previous ?? current).texture;
    u.tB.value = current.texture;
    u.uMix.value = this.mix;
    u.uTime.value = this.time;
    u.uWeight.value = response.weight;
    u.uDetail.value = response.detail;
    u.uDensity.value = response.density;
    // Migrated to the Dynamics layer: predicted beats and kicks, instant attack (falls back to the old envelope).
    u.uImpact.value = input.rig?.haloPulse ?? response.impact;
    // Allow a short event afterimage to survive the live audibility gate.
    const directed = current.director.response ?? response;
    u.uAudible.value = Math.max(directed.audible, directed.trace * 0.5, directed.music.drop * 0.4);
    u.uMinimal.value = approach(u.uMinimal.value as number, direction.experience === 'minimal' ? current.director.frame.visibility : 1, dt, 1, 1);
    u.uContrast.value = current.director.frame.contrast;
    this.composer.render(dt);

    if (!this.paused && this.quality.sample(rawDt)) this.applyQuality();
  };

  /**
   * Layout between the Halo one (above the water) and the open one (whole
   * window, floating gently with the music); pushed to the scenes and the
   * composition only when it moves.
   */
  private updateLayout(dt: number, phase: number): void {
    const target = this.reflectionTarget;
    const previous = this.reflection;
    const step = dt / REFLECTION_FADE;
    this.reflection = target > previous ? Math.min(previous + step, target) : Math.max(previous - step, target);
    const r = this.reflection * this.reflection * (3 - 2 * this.reflection);
    const open = 1 - r;
    const dx = (Math.sin(phase * 0.37) * 0.6 + Math.sin(phase * 0.13 + 1.7) * 0.4) * FLOAT_X * open;
    const dy = (Math.cos(phase * 0.29) * 0.6 + Math.sin(phase * 0.11 + 0.6) * 0.4) * FLOAT_Y * open;
    const layout = this.layout;
    const centerX = OPEN_CENTER.x + (SCENE_CENTER.x - OPEN_CENTER.x) * r + dx;
    const centerY = OPEN_CENTER.y + (SCENE_CENTER.y - OPEN_CENTER.y) * r + dy;
    const horizon = OPEN_HORIZON + (HORIZON - OPEN_HORIZON) * r + dy;
    const moved =
      Math.abs(centerX - layout.centerX) + Math.abs(centerY - layout.centerY) + Math.abs(horizon - layout.horizon) + Math.abs(r - layout.reflection) > 1e-6;
    this.composite.uniforms.uReflection.value = r;
    if (!moved && dt > 0) return;
    layout.centerX = centerX;
    layout.centerY = centerY;
    layout.horizon = horizon;
    layout.reflection = r;
    (this.composite.uniforms.uCenter.value as Vector2).set(centerX, 1 - centerY);
    this.current?.setLayout(layout);
    this.previous?.setLayout(layout);
  }

  /** Quality can change geometry density, so the scene is rebuilt (crossfaded). */
  private applyQuality(): void {
    this.resize();
    const current = this.current;
    const profile = this.quality.profile;
    if (current && (current.quality.density !== profile.density || current.quality.bloom !== profile.bloom)) this.show(current.source);
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
