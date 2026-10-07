import type { ModulationState } from '../../director/types';
import { INTENT, unit, type ExperienceSnapshot } from '../../experience/types';
import { Envelope } from '../../physics/primitives';
import type { SpatialFields } from '../../render-systems/fields/SpatialFields';
import type { VisualResponseFrame } from '../../types/audio';
import type { WorldView } from '../../world/WorldView';
import type { GeometryState } from '../geometry/GeometryState';

/**
 * How the world's matter shows: its light, not its shape. The geometry says
 * what there is (GeometryState); this says how it emits, the same for every
 * primitive, so a filament, a facet and a point of one world share one light.
 * The palette stays the user's: nothing here is a colour, only how the three
 * hues are weighted. Abstract and synthetic by construction: emission, edges
 * and rim light, no textures. All 0..1.
 */
export interface MaterialState {
  /** Base level of everything: the world's illumination through the Director's brightness and visibility. */
  emissive: number;
  /** Inner glow: resonance held by the world's light. */
  glow: number;
  /** Fine sparks on the bright end of the matter (shimmer). */
  spark: number;
  /** Energy of the outer layers (excitation). */
  surface: number;
  /** How bright passing wave fronts show: what the shared FlashGuard admitted, never less than a trace. */
  wave: number;
  /** Share of the elements shown (density; dissolution takes matter away). */
  opacity: number;
  /** How visible edges and bonds are: matter that holds together shows its joints. */
  edge: number;
  /** How visible filled facets are, and how much each is lit by its own tilt (hard, angular matter). */
  fill: number;
  relief: number;
  /** Rim light: a smooth, round surface shows at grazing angles. */
  fresnel: number;
  /** How much what is far fades: a deep world keeps its distance readable. */
  depthFade: number;
  /** Uneven light across a structure: rough, noisy sound. */
  grain: number;
  /** 0 = the palette's first hue leads (low, dark sound) … 1 = its second (bright sound). */
  blend: number;
  /** What a structure still shows after the light is gone: it cools down over seconds instead of vanishing. */
  ember: number;
  /** The Director's gate on light (brightness × visibility): what a primitive scales a light source of its own by. */
  gate: number;
}

export const createMaterialState = (): MaterialState => ({
  emissive: 0, glow: 0, spark: 0, surface: 0, wave: 0, opacity: 1, edge: 0, fill: 0, relief: 0, fresnel: 0, depthFade: 0, grain: 0, blend: 0.5, ember: 0, gate: 1,
});

export const MATERIAL_STATE_KEYS = Object.keys(createMaterialState()) as (keyof MaterialState)[];

/** Light a structure keeps of the brightest it has recently been, and how slowly that fades (s). */
const EMBER = 0.07;
const EMBER_TAU = 6;

/**
 * Owns one world's material state. The musical terms come from the world,
 * the snapshot and the Director; the state kept is rendering history (the
 * admitted light of the fronts, held while they travel, and the ember).
 * Allocation-free.
 */
export class MaterialSystem {
  readonly state = createMaterialState();
  /** The admitted light of the impacts, held while their fronts still travel. */
  private readonly waveLight = new Envelope(0.02, 0.9);
  private readonly warmth = new Envelope(0.3, EMBER_TAU);

  /** The admitted impact light as held here (the visual memory imprints with it). */
  get admitted(): number {
    return this.waveLight.value;
  }

  update(
    dt: number, view: Readonly<WorldView>, geometry: Readonly<GeometryState>, fields: Readonly<SpatialFields>,
    response: VisualResponseFrame, snapshot?: ExperienceSnapshot, modulation?: ModulationState, admittedLight = 0,
  ): MaterialState {
    const m = this.state, intents = snapshot?.intents;
    // The Director's brightness and visibility gate the light; the world provides it.
    const gate = modulation ? (0.35 + 0.65 * modulation.brightness) * (0.3 + 0.7 * modulation.visibility) : 1;
    // Without the experience (clock not synchronized yet) the world is lit by what is audible, and stays still.
    const light = snapshot ? view.light : response.audible * 0.5;
    this.waveLight.step(dt, unit(admittedLight));
    m.gate = gate;
    m.emissive = unit(light * gate);
    m.glow = unit((snapshot?.state.resonance ?? 0) * Math.sqrt(unit(light)) * gate);
    m.spark = unit(view.shimmer * (modulation ? 0.3 + 0.7 * modulation.particleEmission : 1) * gate);
    m.surface = unit(view.excitation * 0.8 * gate);
    // A front always shows a little; how bright it gets is what the FlashGuard admitted.
    m.wave = (0.25 + 0.75 * this.waveLight.value) * gate;
    const dissolve = intents ? intents[INTENT.dissolve].strength * intents[INTENT.dissolve].confidence : 0;
    m.opacity = Math.max(0.25, (modulation ? 0.45 + 0.55 * modulation.particleEmission : 1) * (1 - 0.6 * dissolve) * (1 - 0.25 * geometry.fragmentation));
    m.edge = unit(fields.bond / 30) * (0.4 + 0.6 * unit(view.coherence));
    // Facets show wherever strands have opened; angular matter shows each one's own tilt.
    m.fill = 0.55 + 0.45 * geometry.angularity;
    m.relief = geometry.angularity;
    m.fresnel = unit(geometry.curvature * (1 - 0.5 * geometry.edgeHardness));
    m.depthFade = geometry.spatialDepth;
    m.grain = unit(0.6 * geometry.surfaceRoughness + 0.4 * geometry.granularity);
    m.blend = unit(1 - geometry.waveScale);
    this.warmth.step(dt, m.emissive);
    m.ember = EMBER * this.warmth.value;
    for (const key of MATERIAL_STATE_KEYS) if (!Number.isFinite(m[key])) m[key] = 0;
    return m;
  }

  reset(): void {
    this.waveLight.reset(); this.warmth.reset();
    Object.assign(this.state, createMaterialState());
  }
}
