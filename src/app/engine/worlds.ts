import type { Cue } from '../../experience/MusicalCues';
import type { EmergencePrimitive } from '../../visual-engine/primitives/EmergencePrimitive';
import type { ForestPrimitive } from '../../visual-engine/primitives/ForestPrimitive';
import type { OceanPrimitive } from '../../visual-engine/primitives/OceanPrimitive';
import type { SolidPrimitive } from '../../visual-engine/primitives/SolidPrimitive';
import type { VisualWorld } from '../../visual-engine/VisualWorld';
import type { SyntheticCue } from './emergence';

/*
 * The new worlds in the Emergence laboratory (DEV, docs/generative-worlds.md): which world is in view, what its observer
 * is doing and what its own subject is (monoliths, bodies, sea, trees), a reset of that subject, and synthetic cues
 * through the same path as the session's musical cues. Logic without DOM; it changes nothing it does not give back:
 * a reset starts the subject over (as the Terrain subject's does), the cues are the ones the subject would take anyway.
 */

/** The worlds the laboratory studies, in the Worlds ring's order. */
export const LAB_WORLDS = ['monolith-desert', 'fractured-expanse', 'pulse-ocean', 'resonant-forest'] as const;
export type LabWorld = typeof LAB_WORLDS[number];

/** One line of what the laboratory reads of a world: a label and its value, already formatted. */
export type Reading = [label: string, value: string];

export class WorldsExperiment {
  offered = 0;
  private seq = 3e6;

  /** What the laboratory can do with the world in view: its subject, or null when the world is not one of the new ones. */
  subject(world: VisualWorld | null): { id: LabWorld; world: VisualWorld } | null {
    const id = world?.recipe.id;
    return world && (LAB_WORLDS as readonly string[]).includes(id ?? '') ? { id: id as LabWorld, world } : null;
  }

  /** The world's subject starts over: monoliths and trees back to the pool, bodies seeded again. False when there is nothing to reset. */
  reset(world: VisualWorld | null): boolean {
    const s = this.subject(world);
    if (!s) return false;
    if (s.id === 'monolith-desert') { const m = s.world.primitive<EmergencePrimitive>('monoliths'); m?.field.clear(); return !!m; }
    if (s.id === 'fractured-expanse') { const b = s.world.primitive<SolidPrimitive>('bodies'); b?.reseed(); return !!b; }
    if (s.id === 'resonant-forest') { const t = s.world.primitive<ForestPrimitive>('trees'); t?.field.clear(); return !!t; }
    // The sea has nothing of its own to start over: it is the world's reading.
    return false;
  }

  /** A synthetic cue at audio time `time`, through the subject's own path. False when the world takes no cues (the sea reads the world's release). */
  offer(world: VisualWorld | null, kind: SyntheticCue | 'withdraw', time: number): boolean {
    const s = this.subject(world);
    if (!s) return false;
    const status = kind === 'release' ? 'confirmed' : kind === 'accent' ? 'observed' : kind === 'withdraw' ? 'refuted' : 'predicted';
    const cue: Cue = { seq: ++this.seq, kind: kind === 'prediction' ? 'prepare' : kind, status, time, expected: kind === 'prediction' ? time + 2 : 0, strength: 0.9, confidence: 1, ref: 1 };
    let taken = false;
    if (s.id === 'monolith-desert') { const m = s.world.primitive<EmergencePrimitive>('monoliths'); if (m) { m.field.cue(cue); taken = true; } }
    else if (s.id === 'fractured-expanse') { const b = s.world.primitive<SolidPrimitive>('bodies'); if (b) { b.cue(cue); taken = true; } }
    else if (s.id === 'resonant-forest') { const t = s.world.primitive<ForestPrimitive>('trees'); if (t) { t.field.cue(cue); taken = true; } }
    if (taken) this.offered++;
    return taken;
  }

  /** What the world in view is doing: its observer, then its subject. */
  read(world: VisualWorld | null): Reading[] {
    const s = this.subject(world);
    if (!s) return [];
    const camera = s.world.recipe.camera, d = camera?.debug ?? {}, f = (x: number | undefined, n = 2): string => (x === undefined ? '—' : x.toFixed(n));
    const out: Reading[] = [
      ['locomotion', camera ? camera.locomotion.join(' + ') : '—'],
      ['observer', `${f(d.x)} · ${f(d.y)} · ${f(d.z)}`], ['target', `${f(d.tx)} · ${f(d.ty)} · ${f(d.tz)}`],
      ['speed · forward', `${f(d.motion)} u/s · ${f(d.advance)} u/s`], ['lens · roll', `${f(d.fov, 1)}° · ${f(d.roll, 3)} rad`], ['subject', f(d.focus)],
    ];
    if (s.id === 'monolith-desert') {
      const m = s.world.primitive<EmergencePrimitive>('monoliths');
      if (m) { const st = m.field.stats; out.push(['monoliths', `${m.field.count} / ${m.field.params.capacity}`], ['life', `born ${st.spawned} · recycled ${st.recycled} · retreated ${st.retreated} · refused ${st.refused}`], ['cost', `${f(m.debug['emergence ms'], 3)} ms`]); }
    } else if (s.id === 'fractured-expanse') {
      const b = s.world.primitive<SolidPrimitive>('bodies');
      if (b) { const st = b.system.solids!.stats; out.push(['bodies', `${b.system.solids!.state.bodies} · cells ${st.cells} · fragments ${st.fragments}`], ['fractures · reforms', `${st.events} · ${st.reforms}`], ['cost', `${f(st.solveMs, 3)} ms solid pass`]); }
    } else if (s.id === 'pulse-ocean') {
      const o = s.world.primitive<OceanPrimitive>('sea');
      if (o) { const m = o.motion; out.push(['swell · groove · ripple', `${f(m.drive)} · ${f(m.ring)} · ${f(m.stir)}`], ['alive', f(m.life)], ['travelled', `${f(m.position, 1)} rows`]); }
    } else {
      const t = s.world.primitive<ForestPrimitive>('trees');
      if (t) { const st = t.field.stats; out.push(['trees', `${t.field.live()} / ${t.field.params.capacity}`], ['life', `born ${st.spawned} · decayed ${st.decayed} · aged ${st.aged} · passed ${st.passed}`], ['memory', `${st.remembering} remembering · match ${f(st.match)} · filaments ${t.field.links}`], ['cost', `${f(t.debug['forest ms'], 3)} ms`]); }
    }
    return out;
  }
}
