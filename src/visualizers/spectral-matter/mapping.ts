import type { ModulationState } from '../../director/types';
import { INTENT, unit } from '../../experience/types';
import { Envelope } from '../../physics/primitives';
import { createMemory, deriveMemory } from '../../render-systems/feedback/visualMemory';
import { createFields, deriveFields } from '../../render-systems/fields/SpatialFields';
import { MatterForms } from '../../render-systems/forms/MatterForms';
import { createMaterial, deriveMaterial } from '../../render-systems/materials/VisualMaterial';
import { createEmission } from '../../render-systems/particles/ParticleMatter';
import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import type { QualityProfile, SceneClock } from '../../types/visualizer';
import type { WorldView } from '../../world/WorldView';

export interface SpectralMatterParams {
  /** Elements of matter at High quality. */
  count: number;
  /** Seed of the matter: the same seed is the same body. */
  seed: number;
  /** Point size (device-independent pixels at the rest distance). */
  pointSize: number;
  /** Light of one element at High quality (the picture is additive). */
  exposure: number;
  /** Share of the strands whose bonds are drawn at High quality (0 = none). */
  links: number;
  /** Share of the strands whose facets are drawn at High quality (0 = none). */
  facets: number;
  /** Tilt of the matter's axis away from the viewer (rad). */
  tilt: number;
}

/** What a quality profile gives the scene. */
export interface MatterQuality {
  count: number;
  /** Light of one element: fewer elements each carry more, so the body keeps its brightness. */
  exposure: number;
  /** Share of the strands whose bonds are drawn. */
  links: number;
  /** Share of the strands whose facets are drawn. */
  facets: number;
  /** Visual memory: full resolution, half resolution, or none. */
  feedback: 'full' | 'half' | 'off';
  /** Second turbulence octave. */
  detail: boolean;
}

/**
 * High: everything. Medium: fewer elements, bonds and facets, half-resolution
 * memory. Low: the matter, its fields and its forms as points only (one
 * turbulence octave, no bonds, no facets, no memory pass). Auto walks these
 * through the profile's density.
 */
export function matterQuality(params: SpectralMatterParams, quality: QualityProfile): MatterQuality {
  const density = Math.min(1, Math.max(0.1, quality.density));
  const high = density >= 0.9, medium = density >= 0.6;
  return {
    count: Math.round(params.count * density),
    exposure: params.exposure / Math.sqrt(density),
    links: high ? params.links : medium ? params.links * 0.4 : 0,
    facets: high ? params.facets : medium ? params.facets * 0.5 : 0,
    feedback: high ? 'full' : medium ? 'half' : 'off',
    detail: medium,
  };
}

/**
 * Sound and world → render parameters of Spectral Matter: the visual material,
 * the spatial fields, the forms the matter takes, how it emits light and what
 * the picture remembers. Everything musical comes from the shared world, the
 * experience snapshot and the Director; the state kept here is rendering
 * history (the forms' sources, the follower of the admitted light).
 * Allocation-free.
 */
export class SpectralMatterMapping {
  readonly material = createMaterial();
  readonly fields = createFields();
  readonly forms = new MatterForms();
  readonly emission = createEmission();
  readonly memory = createMemory();
  /** The admitted light of the impacts, held while their fronts still travel. */
  private readonly waveLight = new Envelope(0.02, 0.9);

  update(dt: number, view: Readonly<WorldView>, frame: AudioFrame, response: VisualResponseFrame, modulation?: ModulationState, clock?: SceneClock): void {
    const snapshot = modulation?.experienceState ?? clock?.experience;
    const intents = snapshot?.intents;
    deriveMaterial(this.material, view, snapshot);
    deriveFields(this.fields, view, this.material, intents);
    this.forms.update(dt, view, this.material, this.fields.radius, frame, response, snapshot);

    const e = this.emission;
    // The Director's brightness and visibility gate the light; the world provides it.
    const gate = modulation ? (0.35 + 0.65 * modulation.brightness) * (0.3 + 0.7 * modulation.visibility) : 1;
    // Without the experience (clock not synchronized yet) the matter is lit by what is audible, and stays still.
    const light = snapshot ? view.light : response.audible * 0.5;
    this.waveLight.step(dt, unit(clock?.light ?? 0));
    e.base = unit(light * gate);
    e.glow = unit((snapshot?.state.resonance ?? 0) * Math.sqrt(unit(light)) * gate);
    e.spark = unit(view.shimmer * (modulation ? 0.3 + 0.7 * modulation.particleEmission : 1) * gate);
    e.surface = unit(view.excitation * 0.8 * gate);
    // A front always shows a little; how bright it gets is what the FlashGuard admitted.
    e.wave = (0.25 + 0.75 * this.waveLight.value) * gate;
    const dissolve = intents ? intents[INTENT.dissolve].strength * intents[INTENT.dissolve].confidence : 0;
    e.density = Math.max(0.25, (modulation ? 0.45 + 0.55 * modulation.particleEmission : 1) * (1 - 0.6 * dissolve) * (1 - 0.25 * this.material.fragmentation));
    e.links = unit(this.fields.bond / 30) * (0.4 + 0.6 * unit(view.coherence));
    // Facets show wherever strands have opened; angular matter shows each one's own tilt.
    e.facets = 0.55 + 0.45 * this.material.angularity;
    e.relief = this.material.angularity;
    e.waveShare = this.forms.state.wave; e.harmonicShare = this.forms.state.harmonic;

    deriveMemory(this.memory, view, modulation?.persistence ?? 0.5, this.waveLight.value);
  }
}
