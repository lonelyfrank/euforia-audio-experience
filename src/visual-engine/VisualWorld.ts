import { Group, type PerspectiveCamera } from 'three';
import type { ModulationState } from '../director/types';
import { unit } from '../experience/types';
import { Envelope } from '../physics/primitives';
import { Observer } from '../render-systems/camera/Observer';
import { FeedbackPass } from '../render-systems/feedback/FeedbackPass';
import { createMemory, deriveMemory } from '../render-systems/feedback/visualMemory';
import { FIELD_VALUES, packFields, packWaves, PHASE_PERIOD } from '../render-systems/fields/fieldLaw';
import { createFields, deriveFields } from '../render-systems/fields/SpatialFields';
import { MAX_WAVES, WaveField } from '../render-systems/waves/WaveField';
import type { AudioFrame, VisualResponseFrame } from '../types/audio';
import type { PaletteColors, SceneClock, VisualizerContext } from '../types/visualizer';
import { REST_VIEW } from '../world/WorldView';
import { SonicGeometryMapper } from './geometry/SonicGeometryMapper';
import { VoiceCycles } from './geometry/VoiceCycles';
import { MaterialSystem } from './material/MaterialState';
import type { Primitive, PrimitiveContext, WorldFrame } from './Primitive';
import { ResonanceField } from './structural/ResonanceField';
import { DISSOLVE_TIME, FORM_TIME, type PrimitiveSlot, type WorldRecipe } from './WorldRecipe';

/** The structural budget grows over about a bar and gives way more slowly (s): the picture breathes, it does not flicker. */
const BUDGET_ATTACK = 1.6;
const BUDGET_RELEASE = 4;
/**
 * How much of the planner's entropy fills the budget: a full mix (entropy about a third) carries most of a world's
 * structures, and only the densest moments all of them.
 */
export const BUDGET_GAIN = 2.6;
/** Below this a primitive shows nothing and is not drawn. */
const ABSENT = 0.004;

/**
 * Development switch: with `only` set, exactly those primitives are present
 * (whatever the sound), so each can be looked at on its own. Read in
 * development builds only; nothing in the product sets it.
 */
export const worldLab: { only: ReadonlySet<string> | null } = { only: null };

/** A primitive mounted in a world and how present it is. */
export interface MountedPrimitive {
  slot: PrimitiveSlot;
  primitive: Primitive;
  /** What the world asks of it now, and what it shows (eased). */
  target: number;
  presence: Envelope;
}

/**
 * A persistent visual world: primitive systems, the fields they share, their
 * material and the observer looking at them. The sound does not pick a scene
 * and set its parameters; it changes the geometry and the fields of this
 * world, and every structure in it follows together.
 *
 *   WorldView + snapshot + voices → SonicGeometryMapper → GeometryState
 *   WorldView + geometry + intents → SpatialFields (packed once: uField)
 *   event stream → WaveField (dated fronts, packed once: uWaveA / uWaveB)
 *   world light + Director + admitted light → MaterialState
 *   planner's entropy × the show's ceiling → structural budget → presence of each primitive
 *   every primitive: update(frame, presence)        the same frame for all
 *   world → Observer (camera) · frame → visual memory
 *
 * Nothing in it is rebuilt when the music changes: primitives stay mounted
 * and fade with their presence, the matter keeps its state, fronts keep
 * travelling. Its own state is rendering history only; the musical state is
 * the shared WorldState's. Without sound the world's fields rest, the budget
 * empties, structures dissolve and the light cools down.
 */
export class VisualWorld {
  /** Everything the world draws; the host adds it to its scene. */
  readonly object = new Group();
  readonly mapper = new SonicGeometryMapper();
  readonly fields = createFields();
  readonly waves = new WaveField();
  readonly materials = new MaterialSystem();
  readonly voices = new VoiceCycles();
  readonly observer = new Observer();
  readonly memory = createMemory();
  /** The multiscale resonance as matter looks it up by its natural frequency; only when the recipe asks for it. */
  readonly resonance: ResonanceField | null;
  /** Packed uniforms shared by every primitive that reads the fields (bound once; rewritten in place). */
  readonly uField = new Float32Array(FIELD_VALUES);
  readonly uWaveA = new Float32Array(MAX_WAVES * 4);
  readonly uWaveB = new Float32Array(MAX_WAVES * 4);
  readonly mounted: MountedPrimitive[] = [];
  /** How much structure the world carries now, 0..1 (eased), and the ceiling the show gives it. */
  readonly budget = new Envelope(BUDGET_ATTACK, BUDGET_RELEASE);
  ceiling = 1;
  /** Development overlay: budget, primitives present, what is submitted, fields, fronts, memory. */
  readonly debug = {
    budget: 0, ceiling: 1, present: 0, primitives: 0, elements: 0, vertices: 0,
    radius: 0, vortex: 0, turb: 0, cohesion: 0, frag: 0, waves: 0, decay: 1,
  };
  readonly frame: WorldFrame;
  private feedback: FeedbackPass | null = null;
  private context: PrimitiveContext | null = null;
  private palette: PaletteColors | null = null;
  private pixelRatio = 1;
  private phase = 0;
  private lastClock = -Infinity;

  constructor(readonly recipe: WorldRecipe) {
    this.resonance = recipe.resonance ? new ResonanceField() : null;
    this.frame = {
      dt: 0, time: 0, timed: false, view: REST_VIEW, geometry: this.mapper.state, fields: this.fields, look: this.materials.state,
      waves: this.waves, audio: undefined as never, response: undefined as never,
    };
    if (this.resonance) this.frame.resonance = this.resonance;
  }

  /** Mounts the recipe's primitives (GPU resources are created here, once). */
  init({ renderer, quality, addPass }: VisualizerContext): void {
    this.context = { renderer, quality, seed: this.recipe.seed, uField: this.uField, uWaveA: this.uWaveA, uWaveB: this.uWaveB, voices: this.voices };
    packFields(this.uField, this.fields, 0);
    for (const slot of this.recipe.slots) this.add(slot);
    if (this.recipe.memory !== 'off') {
      this.feedback = new FeedbackPass(this.recipe.memory === 'full' ? 1 : 0.5);
      // Handed to the layer, which disposes it with its other passes.
      addPass(this.feedback, 'pre-bloom');
    }
  }

  /** Mounts one more primitive system (also while the world runs: it forms from nothing). */
  add(slot: PrimitiveSlot): Primitive {
    if (!this.context) throw new Error('VisualWorld.add before init');
    const primitive = slot.create(this.context);
    this.mounted.push({ slot, primitive, target: 0, presence: new Envelope(slot.attack ?? FORM_TIME, slot.release ?? DISSOLVE_TIME) });
    this.object.add(primitive.object);
    if (this.palette) primitive.setPalette(this.palette);
    primitive.setPixelRatio?.(this.pixelRatio);
    primitive.object.visible = !!slot.base;
    this.count();
    return primitive;
  }

  /** Unmounts a primitive system and releases what it owns. */
  remove(id: string): boolean {
    const at = this.mounted.findIndex((m) => m.slot.id === id);
    if (at < 0) return false;
    const [{ primitive }] = this.mounted.splice(at, 1);
    this.object.remove(primitive.object);
    primitive.dispose();
    this.count();
    return true;
  }

  primitive<T extends Primitive = Primitive>(id: string): T | undefined {
    for (const m of this.mounted) if (m.slot.id === id) return m.primitive as T;
    return undefined;
  }

  /** How present a primitive is right now, 0..1. */
  presence(id: string): number {
    for (const m of this.mounted) if (m.slot.id === id) return m.presence.value;
    return 0;
  }

  setPalette(colors: PaletteColors): void {
    this.palette = colors;
    for (const m of this.mounted) m.primitive.setPalette(colors);
  }

  setPixelRatio(ratio: number): void {
    this.pixelRatio = ratio;
    for (const m of this.mounted) m.primitive.setPixelRatio?.(ratio);
  }

  /** One frame: interpretation once, then every primitive with the same frame. Must not allocate. */
  update(audio: AudioFrame, dt: number, time: number, response: VisualResponseFrame, modulation?: ModulationState, clock?: SceneClock): void {
    const view = modulation?.world ?? REST_VIEW;
    const snapshot = modulation?.experienceState ?? clock?.experience;
    // A clock that went back is another session: its rendering history is not this one's.
    if (clock) {
      if (clock.time < this.lastClock - 1) this.reset();
      this.lastClock = clock.time;
    }

    const geometry = this.mapper.update(dt, view, audio, response, snapshot);
    const fields = deriveFields(this.fields, view, geometry, snapshot?.intents);
    this.recipe.tune?.(fields, geometry);

    // Fronts start at the audio time of the events already heard; without a clock there are none.
    const now = clock ? clock.time : time;
    if (clock) this.waves.update(now, clock.events, view.lateral, clock.hitScale);
    const h = dt > 0 ? Math.min(dt, 0.1) : 0;
    this.phase = (this.phase + fields.phaseRate * h) % PHASE_PERIOD;
    packFields(this.uField, fields, this.phase);
    if (clock) packWaves(this.uWaveA, this.uWaveB, this.waves, now);
    else this.uWaveB.fill(0);
    this.voices.update(response);
    // Dated like the fronts: what rings is what has been heard, and without a clock nothing does.
    this.resonance?.update(clock ? snapshot?.resonance : undefined);
    this.materials.update(dt, view, geometry, fields, response, snapshot, modulation, clock?.light ?? 0);

    const frame = this.frame;
    frame.dt = dt; frame.time = now; frame.timed = !!clock; frame.view = view;
    frame.snapshot = snapshot; frame.audio = audio; frame.response = response; frame.modulation = modulation; frame.clock = clock;

    // How much structure the moment can carry: the planner's entropy, under the ceiling the show gives this fixture.
    this.ceiling = clock?.structure === undefined ? 1 : unit(clock.structure);
    this.budget.step(dt, unit(BUDGET_GAIN * geometry.topologyComplexity) * this.ceiling);
    let total = 0;
    for (const m of this.mounted) if (!m.slot.base) total += m.slot.cost ?? 1;
    const filled = this.budget.value * total;
    let before = 0, present = 0;
    for (const m of this.mounted) {
      const slot = m.slot;
      if (slot.base) m.target = 1;
      else {
        const cost = slot.cost ?? 1;
        m.target = unit((filled - before) / cost) * unit(slot.affinity ? slot.affinity(geometry) : 1);
        before += cost;
      }
      const pinned = import.meta.env.DEV && worldLab.only !== null;
      if (pinned) m.target = worldLab.only!.has(slot.id) ? 1 : 0;
      if (slot.base || pinned) m.presence.value = m.target;
      else m.presence.step(dt, Number.isFinite(m.target) ? m.target : 0);
      const shown = m.presence.value > ABSENT;
      // A primitive that left is told once (presence 0), then left alone until it is wanted again.
      if (shown || m.primitive.object.visible) m.primitive.update(frame, shown ? m.presence.value : 0);
      m.primitive.object.visible = shown;
      if (shown) present++;
    }

    const persistence = modulation?.persistence ?? 0.5, trail = this.recipe.trail ?? 0;
    deriveMemory(this.memory, view, persistence + (geometry.trailPersistence - persistence) * trail, this.materials.admitted);
    const feedback = this.feedback;
    if (feedback) {
      const memory = feedback.memory;
      memory.persistence = this.memory.persistence; memory.irregularity = this.memory.irregularity;
      memory.imprint = this.memory.imprint; memory.accumulate = this.memory.accumulate;
    }

    if (this.recipe.observer !== false) {
      const depth = modulation?.depth ?? 0.5, spatial = this.recipe.spatial ?? 0;
      this.observer.step(dt, view, modulation ? 0.35 + 0.65 * modulation.cameraMotion : 0.35, depth + (geometry.spatialDepth - depth) * spatial);
    }

    if (import.meta.env.DEV) {
      const d = this.debug;
      d.budget = this.budget.value; d.ceiling = this.ceiling; d.present = present;
      d.radius = fields.radius; d.vortex = fields.vortex; d.turb = fields.turbulence; d.cohesion = fields.cohesion;
      d.frag = geometry.fragmentation; d.waves = clock ? this.waves.active(now) : 0; d.decay = feedback ? feedback.decay : 0;
    }
  }

  /** Places `camera` where the observer is (see Observer.apply). Must not allocate. */
  place(camera: PerspectiveCamera, distance: number, fov: number): void {
    this.observer.apply(camera, distance, fov);
  }

  /**
   * A new audio session. What the world has learned of the previous one is
   * forgotten (the voices' shapes, the fronts, the held light); what is on
   * screen is not torn down: structures dissolve with their presence and the
   * matter relaxes by itself.
   */
  reset(): void {
    this.mapper.reset(); this.materials.reset(); this.waves.reset(); this.voices.reset(); this.resonance?.reset();
    this.lastClock = -Infinity;
    for (const m of this.mounted) m.primitive.reset();
  }

  dispose(): void {
    for (const m of this.mounted) {
      this.object.remove(m.primitive.object);
      m.primitive.dispose();
    }
    this.mounted.length = 0;
    this.voices.dispose();
    this.object.clear();
    this.feedback = null;
    this.context = null;
  }

  private count(): void {
    const d = this.debug;
    d.primitives = this.mounted.length; d.elements = d.vertices = 0;
    for (const m of this.mounted) { d.elements += m.primitive.elements; d.vertices += m.primitive.vertices; }
  }
}
