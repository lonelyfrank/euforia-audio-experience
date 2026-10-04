import { approach, VisualDirector, type DirectorClock } from '../director/VisualDirector';
import { AutoDirection } from '../director/AutoDirection';
import { DEFAULT_DIRECTION } from '../director/profiles';
import type { DirectionSettings, SceneDirection } from '../director/types';
import { Color, HalfFloatType, OrthographicCamera, PerspectiveCamera, Vector2, WebGLRenderer, WebGLRenderTarget, type Vector4 } from 'three';
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

/** Fixtures that can play at once (the show director's slots). */
export const SLOTS = 3;
/** Layers the composition samples at most (slots plus the ones fading out). */
const MAX_LAYERS = 4;

/** Generic fixture parameters of a slot, applied in the composition (values from the Dynamics layer). */
export interface SlotParams {
  /** 0..1: brightness of the fixture. */
  weight: number;
  /** Scale around the scene centre. */
  size: number;
  /** Horizontal offset (fraction of the width). */
  offset: number;
  /** Draw the mirrored pair too. */
  mirror: boolean;
  /** Strobe flash (extra brightness, 0..1). */
  flash: number;
}

/** A slot of the rig: its fixture (with the previous one while they crossfade) and parameters. */
class Slot {
  current: Layer | null = null;
  previous: Layer | null = null;
  mix = 1;
  hue = 0;
  readonly params: SlotParams = { weight: 0, size: 1, offset: 0, mirror: false, flash: 0 };
  /** The palette in this slot's hue order (the lead hue first). */
  readonly palette: [Color, Color, Color] = [new Color(), new Color(), new Color()];

  dispose(): void {
    this.current?.dispose();
    this.previous?.dispose();
    this.current = this.previous = null;
  }
}

/**
 * Owns the WebGL renderer, the frame loop and the final Halo composition
 * (the rig's layers, sky, reflective floor, horizon). Audio comes in through
 * the `frameSource` callback, so it does not depend on the audio engine.
 * Up to SLOTS fixtures (scenes) play at once; slot 0 is the protagonist.
 */
export class RenderEngine {
  readonly renderer: WebGLRenderer;
  paused = false;
  readonly autoDirection = new AutoDirection();
  private readonly direction: DirectionSettings = { ...DEFAULT_DIRECTION };
  /** The protagonist's layer (slot 0). */
  get current(): Layer | null { return this.slots[0].current; }
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
  private readonly slots: Slot[] = Array.from({ length: SLOTS }, () => new Slot());
  private readonly layerTextures = ['tL0', 'tL1', 'tL2', 'tL3'] as const;
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
    // Until a show director drives the slots, the protagonist plays as designed.
    this.slots[0].params.weight = 1;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  setQuality(setting: QualitySetting): void {
    this.quality.set(setting);
    this.applyQuality();
  }

  /** The quality tier in effect (Auto resolves to the tier of its current step). */
  get qualityTier(): 'low' | 'medium' | 'high' {
    const density = this.quality.profile.density;
    return density >= 0.9 ? 'high' : density >= 0.5 ? 'medium' : 'low';
  }

  /** Frame rate measured by the quality controller (for the GPU budget). */
  get measuredFps(): number {
    return this.quality.fps;
  }

  /** Palette colours are copied; the scenes and the composition pick them up at once. */
  setPalette(colors: PaletteColors): void {
    colors.forEach((c, i) => this.palette[i].copy(c));
    for (let i = 0; i < SLOTS; i++) this.applyHue(i);
    const u = this.composite.uniforms;
    (u.uHaze.value as Color).copy(this.palette[1]).multiplyScalar(0.25);
    (u.uSheen.value as Color).copy(this.palette[1]);
  }

  /** Which palette hue leads a slot's fixture (0..2); the palette stays the user's. */
  setSlotHue(index: number, hue: number): void {
    const slot = this.slots[index];
    if (slot.hue === hue) return;
    slot.hue = hue;
    this.applyHue(index);
  }

  /** Per-frame fixture parameters of a slot (copied). */
  setSlotParams(index: number, params: SlotParams): void {
    Object.assign(this.slots[index].params, params);
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

  /** Mounts a scene as the protagonist (slot 0). With one already showing, the two crossfade. */
  show(source: SceneSource): void {
    this.setSlot(0, source, true);
  }

  /** Puts a fixture in a slot (null empties it); a change crossfades within the slot. */
  setSlot(index: number, source: SceneSource | null, force = false): void {
    const slot = this.slots[index];
    if (!force && (slot.current?.source ?? null) === source) return;
    // A switch during a crossfade drops the oldest scene.
    slot.previous?.dispose();
    slot.previous = slot.current;
    slot.current = source ? new Layer(this.renderer, source, this.quality.profile, this.layerSize, slot.palette, this.layout) : null;
    slot.mix = slot.previous ? 0 : 1;
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
    for (const slot of this.slots) slot.dispose();
    this.resizeObserver.disconnect();
    this.composite.dispose();
    this.output.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** Updates and renders one layer and gives it a place in the composition; returns the places used. */
  private drawLayer(layer: Layer | null, slot: Slot, amount: number, used: number, input: SceneInput, direction: DirectionSettings, dt: number): number {
    if (!layer) return used;
    if (!this.paused) layer.update(input, direction, dt, this.time + dt);
    layer.render(dt);
    if (used >= MAX_LAYERS) return used;
    const u = this.composite.uniforms;
    const p = slot.params;
    u[this.layerTextures[used]].value = layer.texture;
    (u.uLayer.value as Vector4[])[used].set(p.weight * amount, p.size, p.offset, p.mirror ? 1 : 0);
    (u.uFlash.value as number[])[used] = p.flash;
    return used + 1;
  }

  private applyHue(index: number): void {
    const slot = this.slots[index];
    for (let k = 0; k < 3; k++) slot.palette[k].copy(this.palette[(k + slot.hue) % 3]);
    slot.current?.visualizer.setPalette(slot.palette);
    slot.previous?.visualizer.setPalette(slot.palette);
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

    const u = this.composite.uniforms;
    let used = 0;
    for (const slot of this.slots) {
      if (slot.previous) {
        slot.mix = Math.min(slot.mix + dt / CROSSFADE, 1);
        if (slot.mix >= 1) {
          slot.previous.dispose();
          slot.previous = null;
        }
      }
      used = this.drawLayer(slot.current, slot, slot.mix, used, input, direction, dt);
      used = this.drawLayer(slot.previous, slot, 1 - slot.mix, used, input, direction, dt);
    }
    for (let i = used; i < MAX_LAYERS; i++) (u.uLayer.value as Vector4[])[i].x = 0;
    if (!this.paused) this.time += dt;

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
    for (const slot of this.slots) {
      slot.current?.setLayout(layout);
      slot.previous?.setLayout(layout);
    }
  }

  /** Quality can change geometry density, so the scenes are rebuilt (crossfaded). */
  private applyQuality(): void {
    this.resize();
    const profile = this.quality.profile;
    this.slots.forEach((slot, i) => {
      const current = slot.current;
      if (current && (current.quality.density !== profile.density || current.quality.bloom !== profile.bloom)) this.setSlot(i, current.source, true);
    });
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
    for (const slot of this.slots) {
      slot.current?.resize(this.layerSize);
      slot.previous?.resize(this.layerSize);
    }
  }
}
