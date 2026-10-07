import type { WebGLRenderer } from 'three';
import type { ModulationState, SceneDirection } from '../director/types';
import type { AudioFrame, VisualResponseFrame } from '../types/audio';
import type { PaletteColors, QualityProfile, SceneClock, SceneIcon, VisualizerContext, VisualizerDefinition, VisualizerPreset } from '../types/visualizer';
import { BaseVisualizer } from '../visualizers/shared/BaseVisualizer';
import { VisualWorld } from './VisualWorld';
import type { WorldRecipe } from './WorldRecipe';

/** Builds a recipe from a preset's parameters at a quality: counts and passes are chosen here, once per mount. */
export type RecipeBuilder<TVisual> = (params: TVisual, quality: QualityProfile) => WorldRecipe;

/**
 * A visual world behind the contract every scene implements, so the render
 * engine, the layers, the show and the menus treat a recipe like any other
 * scene and old visualizers and new worlds play side by side (also crossfaded
 * or as supporting fixtures). It holds nothing of its own: scene, camera and
 * lifecycle on one side, a VisualWorld on the other.
 */
export class RecipeVisualizer<TVisual> extends BaseVisualizer<TVisual> {
  world!: VisualWorld;
  private renderer!: WebGLRenderer;
  /** Development overlay: the world's numbers and those of each primitive, in one stable object. */
  readonly debug: Record<string, number> = {};

  constructor(preset: VisualizerPreset<TVisual>, private readonly build: RecipeBuilder<TVisual>) {
    super(preset);
  }

  init(context: VisualizerContext): void {
    this.renderer = context.renderer;
    const recipe = this.build(this.preset.visual, context.quality);
    this.world = new VisualWorld(recipe);
    this.world.init(context);
    this.world.object.rotation.x = -recipe.tilt;
    this.world.object.rotation.z = recipe.roll ?? 0;
    this.scene.add(this.world.object);
    this.world.place(this.camera, this.preset.camera.distance, this.preset.camera.fov);
    this.report();
  }

  setPalette(colors: PaletteColors): void {
    this.world.setPalette(colors);
  }

  update(frame: AudioFrame, dt: number, time: number, response: VisualResponseFrame, modulation?: ModulationState, clock?: SceneClock): void {
    this.world.update(frame, dt, time, response, modulation, clock);
    this.world.place(this.camera, this.preset.camera.distance, this.preset.camera.fov);
    if (import.meta.env.DEV) this.report();
  }

  override resize(width: number, height: number): void {
    super.resize(width, height);
    this.world.setPixelRatio(this.renderer.getPixelRatio());
  }

  override dispose(): void {
    this.world.dispose();
    super.dispose();
  }

  private report(): void {
    const debug = this.debug;
    Object.assign(debug, this.world.debug);
    for (const m of this.world.mounted) {
      Object.assign(debug, m.primitive.debug);
      if (!m.slot.base) debug[`${m.slot.id}%`] = m.presence.value;
    }
  }
}

/** A scene that is a recipe: registry entry and factory, like `defineVisualizer`. */
export function defineRecipe<TVisual>(definition: {
  id: string; name: string; description: string; icon: SceneIcon; order: number; direction?: SceneDirection;
  preset: VisualizerPreset<TVisual>; recipe: RecipeBuilder<TVisual>;
}): VisualizerDefinition {
  const { recipe, ...rest } = definition;
  const typed: VisualizerDefinition<TVisual> = { ...rest, create: (preset) => new RecipeVisualizer(preset, recipe) };
  return typed as unknown as VisualizerDefinition;
}
