import type { Object3D } from 'three';
import { MatterForms } from '../../render-systems/forms/MatterForms';
import { matterLayout, seedMatter } from '../../render-systems/particles/MatterSeeds';
import { MatterSimulation } from '../../render-systems/particles/MatterSimulation';
import { createEmission, ParticleMatter } from '../../render-systems/particles/ParticleMatter';
import type { PaletteColors, QualityProfile } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';

/** What a body of matter is made of at High quality. */
export interface MatterParams {
  /** Elements of matter at High quality. */
  count: number;
  /** Point size (device-independent pixels at the rest distance). */
  pointSize: number;
  /** Light of one element at High quality (the picture is additive). */
  exposure: number;
  /** Share of the strands whose bonds are drawn at High quality (0 = none). */
  links: number;
  /** Share of the strands whose facets are drawn at High quality (0 = none). */
  facets: number;
}

/** What a quality profile gives a body of matter. */
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
export function matterQuality(params: MatterParams, quality: QualityProfile): MatterQuality {
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

export interface MatterOptions {
  pointSize: number;
  /** Whether the matter can take the forms of the sound (the waveform's curve, the partials' network); without, it stays free. */
  forms: boolean;
  /** How far the weight of the sound swells an element (0 = a fixed size). */
  mass?: number;
}

/**
 * The persistent body of a world: particles simulated on the GPU under the
 * shared fields and fronts, drawn as points, bonds and facets, and able to
 * condense on the forms the sound generates (render-systems/particles and
 * /forms; docs/matter-engine.md). The simulation is the generic part every
 * particle world shares; which fields act on it and how it is lit come from
 * the frame.
 */
export class MatterPrimitive implements Primitive {
  readonly object: Object3D;
  readonly forms: MatterForms | null;
  readonly simulation: MatterSimulation;
  readonly matter: ParticleMatter;
  readonly emission = createEmission();
  readonly elements: number;
  readonly vertices: number;
  /** Elements, the matter's state (shares on the wave form, the harmonic network and free), the forms' sources, sub-steps, submit time. */
  readonly debug = { particles: 0, wave: 0, harmonic: 0, free: 1, nodes: 0, links: 0, closure: 0, ribbon: 0, fracture: 0, steps: 0, 'sim ms': 0 };

  constructor(context: PrimitiveContext, quality: MatterQuality, private readonly options: MatterOptions) {
    this.forms = options.forms ? new MatterForms() : null;
    this.simulation = new MatterSimulation(context.renderer, seedMatter(matterLayout(quality.count), context.seed), quality.detail, this.forms ?? undefined);
    const s = this.simulation;
    this.matter = new ParticleMatter(s.seeds.layout, s.homes, s.traits, s.formSeeds, options.pointSize, quality.exposure, quality.links, quality.facets);
    this.object = this.matter.object;
    this.elements = this.debug.particles = s.seeds.layout.count;
    this.vertices = this.matter.vertices;
  }

  setPalette([primary, secondary, highlight]: PaletteColors): void {
    this.matter.setPalette(primary, secondary, highlight);
  }

  update(frame: Readonly<WorldFrame>, presence: number): void {
    const { geometry, fields, look } = frame, forms = this.forms;
    forms?.update(frame.dt, frame.view, geometry, fields.radius, frame.audio, frame.response, frame.snapshot);

    const started = import.meta.env.DEV ? performance.now() : 0;
    // Without a clock no front may linger from an earlier frame.
    const steps = this.simulation.step(fields, frame.timed ? frame.waves : undefined, frame.time, frame.dt);
    this.matter.setState(this.simulation.positions, this.simulation.velocities);

    const e = this.emission;
    e.base = look.emissive * presence; e.glow = look.glow * presence; e.spark = look.spark * presence; e.surface = look.surface * presence;
    e.wave = look.wave * presence;
    e.density = look.opacity; e.links = look.edge; e.facets = look.fill; e.relief = look.relief;
    e.waveShare = forms ? forms.state.wave : 0; e.harmonicShare = forms ? forms.state.harmonic : 0;
    this.matter.setEmission(e, frame.time * 14);
    const mass = this.options.mass;
    if (mass) this.matter.setSize(this.options.pointSize * (1 + mass * (geometry.particleMass - 0.3)));

    if (import.meta.env.DEV) {
      const d = this.debug;
      if (forms) {
        d.wave = forms.state.wave; d.harmonic = forms.state.harmonic; d.free = 1 - forms.state.wave - forms.state.harmonic;
        d.nodes = forms.harmonic.active; d.links = forms.harmonic.links;
        d.closure = forms.state.closure; d.ribbon = forms.state.ribbon; d.fracture = forms.state.fracture;
      }
      d.steps = steps;
      // Time to submit the simulation passes (CPU side); the GPU's own time is not measured here.
      d['sim ms'] += (performance.now() - started - d['sim ms']) * 0.05;
    }
  }

  setPixelRatio(ratio: number): void {
    this.matter.setPixelRatio(ratio);
  }

  /** The matter itself relaxes by its own inertia; the sources of its forms belong to the session that wrote them. */
  reset(): void {
    this.forms?.reset();
  }

  dispose(): void {
    this.simulation.dispose();
    this.matter.dispose();
  }
}
