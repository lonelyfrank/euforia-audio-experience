import type { Cue } from '../../experience/MusicalCues';
import { MIXED_POPULATION, solidSlot, SOLIDS_SLOT } from '../../visual-engine/primitives/solidSlot';
import { SolidPrimitive, type SolidPopulation } from '../../visual-engine/primitives/SolidPrimitive';
import type { SolidProfile } from '../../visual-engine/structural/SolidTypes';
import type { VisualWorld } from '../../visual-engine/VisualWorld';

/*
 * The Emergence laboratory without its DOM (docs/scene-families.md): what it asks of the world in the viewport and how it
 * gives it back. Its settings are its own (taken when it opens, gone when it ends: nothing is saved); the scene in the
 * viewport is pinned by the laboratory and unpinned when it ends, as the other laboratories do.
 *
 * Solids among the particles: a population of bodies of the structural engine is mounted in the running world of a
 * Particles scene that is a recipe (VisualWorld.add) and taken away again (remove), so the scene without the experiment
 * is the scene as it is. Synthetic events go through the same path as the session's cues.
 */

export interface ParticleSolidsSettings {
  enabled: boolean;
  /** How many of the population's bodies (1..3). */
  bodies: number;
  start: SolidPopulation['start'];
  fracture: SolidPopulation['fracture'];
  profile: SolidProfile;
}

export const createParticleSolids = (): ParticleSolidsSettings => ({ enabled: true, bodies: 3, start: 'free', fracture: 'release', profile: 'rigid' });

export const populationOf = (s: Readonly<ParticleSolidsSettings>): SolidPopulation => ({
  ...MIXED_POPULATION, start: s.start, fracture: s.fracture, profile: s.profile,
  bodies: MIXED_POPULATION.bodies.slice(0, Math.max(1, Math.min(MIXED_POPULATION.bodies.length, Math.round(s.bodies)))),
});

/** A synthetic musical event a tool offers: the kinds of cue the scenes read (a prediction breaks nothing: that is the point of offering it). */
export type SyntheticCue = 'release' | 'accent' | 'prediction';

export class ParticleSolidsExperiment {
  readonly settings = createParticleSolids();
  /** Synthetic cues offered so far. */
  offered = 0;
  private world: VisualWorld | null = null;
  private applied = '';
  private seq = 1e6;

  /** The population in the world, if the experiment holds one now. */
  get primitive(): SolidPrimitive | null {
    const p = this.world?.primitive(SOLIDS_SLOT);
    return p instanceof SolidPrimitive ? p : null;
  }

  /**
   * Keeps the world in the viewport as the settings ask: the slot mounted (again, when the settings changed or the
   * layer was rebuilt), or taken away. `world`: the running world of the pinned scene, or null while there is none.
   * Must be called by the laboratory's refresh, never per frame.
   */
  apply(world: VisualWorld | null): SolidPrimitive | null {
    if (world !== this.world) this.detach();
    this.world = world;
    if (!world) return null;
    const wanted = this.settings.enabled ? JSON.stringify(this.settings) : '';
    if (wanted === this.applied && (!wanted || world.primitive(SOLIDS_SLOT))) return this.primitive;
    world.remove(SOLIDS_SLOT);
    if (wanted) world.add(solidSlot(populationOf(this.settings)));
    this.applied = wanted;
    return this.primitive;
  }

  /** The population seeded again from the same matter: the cycle starts over. */
  reset(): void {
    this.primitive?.reseed();
  }

  /** A synthetic event at the audio time `time`, through the same path as the session's cues. False when nothing holds it. */
  offer(kind: SyntheticCue, time: number): boolean {
    const primitive = this.primitive;
    if (!primitive) return false;
    const cue: Cue = {
      seq: ++this.seq, kind: kind === 'prediction' ? 'prepare' : kind, status: kind === 'release' ? 'confirmed' : kind === 'accent' ? 'observed' : 'predicted',
      time, expected: kind === 'prediction' ? time + 2 : 0, strength: 0.9, confidence: 1, ref: 0,
    };
    primitive.cue(cue);
    this.offered++;
    return true;
  }

  /** Gives the world back as it was: the slot taken away. Safe to repeat. */
  detach(): void {
    this.world?.remove(SOLIDS_SLOT);
    this.world = null; this.applied = '';
  }
}
