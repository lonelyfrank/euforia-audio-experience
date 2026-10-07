import type { WebGLRenderer } from 'three';
import type { ModulationState } from '../../director/types';
import { Observer } from '../../render-systems/camera/Observer';
import { FeedbackPass } from '../../render-systems/feedback/FeedbackPass';
import { matterLayout, seedMatter } from '../../render-systems/particles/MatterSeeds';
import { MatterSimulation } from '../../render-systems/particles/MatterSimulation';
import { ParticleMatter } from '../../render-systems/particles/ParticleMatter';
import { WaveField } from '../../render-systems/waves/WaveField';
import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import type { PaletteColors, SceneClock, VisualizerContext } from '../../types/visualizer';
import { REST_VIEW } from '../../world/WorldView';
import { BaseVisualizer } from '../shared/BaseVisualizer';
import { matterQuality, SpectralMatterMapping, type SpectralMatterParams } from './mapping';

/**
 * A persistent body of matter under the fields of the shared world: the
 * laboratory of the matter engine (docs/matter-engine.md). It has no final
 * shape. As free matter it is cloud, shells, disc, vortex, filaments and
 * grains; where the sound is one repeating cycle part of it gathers on the
 * curve the waveform draws (ring, ribbons, a surface receding in time); where
 * the sound is stacked partials part of it condenses on the network they span
 * (filaments, polygons). The same elements pass from one state to another and
 * back to particles: nothing is created for a shape or removed with it. The
 * scene only orchestrates the shared render systems:
 *
 *   WorldView + snapshot → mapping (material, fields, forms, emission, memory)
 *   event stream → WaveField (dated fronts)
 *   fields + forms + fronts → MatterSimulation (GPU) → ParticleMatter (points, bonds, facets)
 *   frame → FeedbackPass (visual memory) · world → Observer (camera)
 *
 * It keeps no musical state: anticipation, potential, spin, travel and
 * pressure are the world's. Its own state is the matter, the fronts, the
 * forms' sources (signal history, followed partials), the memory buffer and
 * the observer's inertia.
 */
export class SpectralMatterVisualizer extends BaseVisualizer<SpectralMatterParams> {
  private readonly mapping = new SpectralMatterMapping();
  private readonly waves = new WaveField();
  private readonly observer = new Observer();
  private renderer!: WebGLRenderer;
  private simulation!: MatterSimulation;
  private matter!: ParticleMatter;
  private feedback: FeedbackPass | null = null;
  /**
   * Development overlay: elements and vertices submitted, the matter's state (shares on the wave form, the harmonic
   * network and free), the forms' sources, fields, live fronts, memory decay, sub-steps, simulation submit time.
   */
  readonly debug = {
    particles: 0, vertices: 0, wave: 0, harmonic: 0, free: 1, nodes: 0, links: 0, closure: 0, ribbon: 0, fracture: 0,
    radius: 0, vortex: 0, turb: 0, cohesion: 0, frag: 0, waves: 0, decay: 1, steps: 0, 'sim ms': 0,
  };

  init({ renderer, quality, addPass }: VisualizerContext): void {
    const p = this.preset.visual;
    const q = matterQuality(p, quality);
    this.renderer = renderer;
    this.simulation = new MatterSimulation(renderer, seedMatter(matterLayout(q.count), p.seed), q.detail, this.mapping.forms);
    this.matter = new ParticleMatter(this.simulation.seeds.layout, this.simulation.homes, this.simulation.traits, this.simulation.formSeeds, p.pointSize, q.exposure, q.links, q.facets);
    this.matter.object.rotation.x = -p.tilt;
    this.scene.add(this.matter.object);
    if (q.feedback !== 'off') {
      this.feedback = new FeedbackPass(q.feedback === 'full' ? 1 : 0.5);
      addPass(this.feedback, 'pre-bloom');
    }
    this.debug.particles = this.simulation.seeds.layout.count;
    this.debug.vertices = this.matter.vertices;
    this.observer.apply(this.camera, this.preset.camera.distance, this.preset.camera.fov);
  }

  setPalette([primary, secondary, highlight]: PaletteColors): void {
    this.matter.setPalette(primary, secondary, highlight);
  }

  update(frame: AudioFrame, dt: number, time: number, response: VisualResponseFrame, modulation?: ModulationState, clock?: SceneClock): void {
    const world = modulation?.world ?? REST_VIEW;
    const mapping = this.mapping;
    mapping.update(dt, world, frame, response, modulation, clock);

    // Fronts start at the audio time of the events already heard; without a clock there are none.
    const now = clock ? clock.time : time;
    if (clock) this.waves.update(now, clock.events, world.lateral, clock.hitScale);

    const started = import.meta.env.DEV ? performance.now() : 0;
    const steps = this.simulation.step(mapping.fields, clock ? this.waves : undefined, now, dt);
    this.matter.setState(this.simulation.positions, this.simulation.velocities);
    this.matter.setEmission(mapping.emission, now * 14);

    const feedback = this.feedback;
    if (feedback) {
      const memory = feedback.memory;
      memory.persistence = mapping.memory.persistence; memory.irregularity = mapping.memory.irregularity;
      memory.imprint = mapping.memory.imprint; memory.accumulate = mapping.memory.accumulate;
    }

    this.observer.step(dt, world, modulation ? 0.35 + 0.65 * modulation.cameraMotion : 0.35, modulation?.depth ?? 0.5);
    this.observer.apply(this.camera, this.preset.camera.distance, this.preset.camera.fov);

    if (import.meta.env.DEV) {
      const d = this.debug, f = mapping.fields, forms = mapping.forms;
      d.wave = forms.state.wave; d.harmonic = forms.state.harmonic; d.free = 1 - forms.state.wave - forms.state.harmonic;
      d.nodes = forms.harmonic.active; d.links = forms.harmonic.links;
      d.closure = forms.state.closure; d.ribbon = forms.state.ribbon; d.fracture = forms.state.fracture;
      d.radius = f.radius; d.vortex = f.vortex; d.turb = f.turbulence; d.cohesion = f.cohesion;
      d.frag = mapping.material.fragmentation; d.waves = clock ? this.waves.active(now) : 0;
      d.decay = feedback ? feedback.decay : 0; d.steps = steps;
      // Time to submit the simulation passes (CPU side); the GPU's own time is not measured here.
      d['sim ms'] += (performance.now() - started - d['sim ms']) * 0.05;
    }
  }

  override resize(width: number, height: number): void {
    super.resize(width, height);
    this.matter.setPixelRatio(this.renderer.getPixelRatio());
  }

  override dispose(): void {
    this.simulation.dispose();
    this.matter.dispose();
    // The memory pass was handed to the layer, which disposes it with its other passes.
    super.dispose();
  }
}
