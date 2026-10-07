import type { ExperienceSnapshot } from '../../experience/types';
import { releaseFracture } from '../../render-systems/forms/MatterForms';
import { deriveMaterial } from '../../render-systems/materials/VisualMaterial';
import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import type { WorldView } from '../../world/WorldView';
import { createGeometry, GEOMETRY_KEYS, SIGNED_TRAITS, type GeometryState } from './GeometryState';
import { createCycleShape, describeCycle, type CycleShape } from './voiceShape';

/** The shape of a voice is read in about a tenth of a second (s): a voice that changes glides, it does not flicker. */
const SHAPE_TAU = 0.12;
/** How long the world's last impact still rings in the geometry (s). */
const IMPULSE_TAU = 0.25;

const REST = createGeometry();
const unit = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);

/**
 * Sound and world → geometry traits (GeometryState). The one place where what
 * is heard becomes what shapes can be: it combines what the layers before it
 * already decided and measures nothing of the signal itself.
 *
 *   SoundMorphology (Rust measures, per hop)  what kind of sound it is
 *   WorldView (the persistent world)          what is happening to the matter
 *   ExperienceState / plan                    how much structure the moment can carry
 *   the voices' cycles (graphic analysis)     the real shape of the bass line and the lead
 *
 * Every trait is a continuous function of those, bounded and finite for any
 * input; the reasons are perceptual and written next to each line (and in
 * docs/visual-grammar.md). The only state kept is rendering history: the
 * followers of the voices' shape. Per layer, per frame, allocation-free; the
 * same input gives the same output at any frame rate.
 */
export class SonicGeometryMapper {
  readonly state = createGeometry();
  /** The cycles as measured this frame: the bass line and the lead (diagnostics). */
  readonly bass = createCycleShape();
  readonly lead = createCycleShape();
  private readonly shape: CycleShape = createCycleShape();

  /**
   * `snapshot`: the heard experience; without it (no synchronized clock) only
   * what the graphic analysis shows is known and the world is at rest.
   */
  update(dt: number, view: Readonly<WorldView>, frame: AudioFrame, response: VisualResponseFrame, snapshot?: ExperienceSnapshot): GeometryState {
    const g = this.state, m = snapshot?.morphology, s = snapshot?.state, a = snapshot?.acoustic, music = response.music;
    // What kind of matter (fragmentation, symmetry, continuity, angularity, connectivity …): unchanged, shared with the matter engine.
    deriveMaterial(g, view, snapshot);
    const live = a ? (a.silent ? 0 : unit(a.presence)) : unit(response.audible);

    // The voices: the clearer one decides, and a voice that is not there has no shape.
    const wb = unit(music.bassVoice), wl = unit(music.leadVoice);
    const b = describeCycle(music.bassLine, this.bass), l = describeCycle(music.leadLine, this.lead);
    const squares = wb * wb + wl * wl, top = Math.max(wb, wl), k = squares > 1e-6 ? top / squares : 0;
    const glide = dt > 0 ? 1 - Math.exp(-Math.min(dt, 0.25) / SHAPE_TAU) : 0;
    const v = this.shape;
    v.edge += ((wb * wb * b.edge + wl * wl * l.edge) * k - v.edge) * glide;
    v.step += ((wb * wb * b.step + wl * wl * l.step) * k - v.step) * glide;
    v.skew += ((wb * wb * b.skew + wl * wl * l.skew) * k - v.skew) * glide;
    v.ripple += ((wb * wb * b.ripple + wl * wl * l.ripple) * k - v.ripple) * glide;

    // A clean cycle, or a sound that is one steady period: something with a shape of its own.
    g.tonalShape = unit(0.65 * Math.max(0, top - v.ripple) + (m ? 0.35 * m.periodicity * m.stability : 0));
    // No period: noise as the DSP hears it, and a cycle too busy to be one line.
    g.noiseShape = unit(0.7 * (m ? m.noisiness : 0.5 * frame.flatness * live) + 0.5 * v.ripple);
    // Corners come from the cycle itself first (a saw's fall, a square's sides), then from a bright stacked spectrum and sharp attacks.
    g.edgeHardness = unit(0.75 * v.edge + 0.35 * g.angularity + (m ? 0.3 * m.transientness * m.sharpness : 0));
    g.stepping = unit(v.step);
    g.skew = v.skew;
    // Round, unbroken lines need a tonal shape and no corners; noise frays them.
    g.curvature = unit((0.25 * live + 0.75 * g.tonalShape) * (1 - 0.85 * g.edgeHardness) * (1 - 0.5 * g.noiseShape));

    g.coherence = unit(view.coherence);
    g.disorder = unit(view.disorder);

    g.density = unit(0.5 * (m ? m.density : 0) + 0.5 * (s ? s.density : response.density * live));
    // Partials that belong together without being one cycle (a chord, a rich pad) fork; so does a complex mix.
    g.branching = unit(0.6 * g.connectivity + (m ? 0.5 * m.richness * m.harmonicity * (1 - 0.5 * m.periodicity) : 0) + (s ? 0.25 * s.complexity * live : 0));
    // The planner already limits sustained entropy (fatigue): the picture's structure follows it and breathes with it.
    g.topologyComplexity = snapshot && s ? unit(0.6 * snapshot.plan.desiredEntropy + 0.4 * s.visualEntropy * (1 - 0.5 * s.fatigue)) * live : 0;

    // Resonant, flowing sound keeps ringing; stored potential and stiff matter hold motion back.
    g.elasticity = unit(0.7 * (s ? s.resonance : 0) + 0.3 * g.fluidity);
    g.viscosity = unit(0.45 * (1 - g.fluidity) * live + 0.55 * unit(view.tension));
    g.tension = unit(view.tension);

    // Low sound is long waves and heavy matter; bright sound is fine detail.
    const low = unit(1.6 * response.lowShare);
    g.waveScale = live * unit(0.5 * (1 - (m ? unit(m.sharpness) : unit(music.brightness))) + 0.5 * low);
    g.waveVelocity = unit(0.6 * unit(view.speed) + 0.4 * (s ? s.motion : response.motion));
    g.particleMass = live * unit(0.6 * low + 0.4 * response.weight);
    g.stereoSpread = m ? unit(m.spatialWidth) : 0;
    g.particleSpread = unit(0.55 * unit(view.openness) + 0.45 * g.stereoSpread);

    // Ordered, related sound joins over a distance; what fragments the world cuts the joints.
    g.connectionRadius = unit((0.5 * g.symmetry + 0.6 * g.connectivity + 0.2 * g.rigidity * live) * (1 - 0.8 * g.fragmentation));
    // A steady, coherent sound leaves long traces; shimmer and turbulence shorten them.
    g.trailPersistence = unit(live * (0.35 + 0.45 * g.coherence * (m ? m.stability : 0.5) + 0.2 * g.continuity - 0.3 * unit(view.shimmer) - 0.3 * g.disorder));

    // Sustain is pressure on a surface (a continuous deformation); roughness and noise are its texture.
    g.surfaceDisplacement = unit(live * (0.45 * (s ? s.pressure : response.weight) + 0.35 * (s ? s.flow : response.flow) + 0.3 * unit(view.excitation)));
    g.surfaceRoughness = unit(0.6 * (m ? m.roughness : 0) * live + 0.4 * g.noiseShape + 0.2 * g.granularity);

    g.spatialDepth = unit(0.5 * unit(view.openness) + 0.3 * unit(view.speed) + 0.2 * g.stereoSpread);
    g.lateralBias = view.lateral;

    // Events are the world's own facts (strength and age): nothing is detected here.
    g.impulse = unit(view.impulseStrength * Math.exp(-Math.max(0, view.impulseAge) / IMPULSE_TAU));
    g.fracture = releaseFracture(view);
    g.energy = unit(0.6 * unit(view.light) + 0.4 * unit(view.excitation));

    for (const key of GEOMETRY_KEYS) {
      const value = g[key];
      if (!Number.isFinite(value)) g[key] = REST[key];
      else if (SIGNED_TRAITS.includes(key)) g[key] = value > 1 ? 1 : value < -1 ? -1 : value;
      else g[key] = unit(value);
    }
    return g;
  }

  /** A new audio session: the voices' shapes of the previous one are not this one's. */
  reset(): void {
    Object.assign(this.state, REST);
    Object.assign(this.shape, createCycleShape());
  }
}
