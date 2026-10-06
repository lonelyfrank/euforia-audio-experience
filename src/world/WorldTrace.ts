import { INTENTS, NARRATIVES, TRAJECTORIES, type ExperienceSnapshot } from '../experience/types';

/*
 * Development trace of a session: acoustic context, experience, prediction,
 * intents and world, one row per sample, in a bounded ring. Used by the DEV
 * overlay (Shift+T exports the last minutes as CSV) and by the replay harness
 * (src/validation). Never part of the production frame loop.
 */

type Read = (s: ExperienceSnapshot) => number;

const NARRATIVE = Object.fromEntries(NARRATIVES.map((n, i) => [n, i]));
const TRAJECTORY = Object.fromEntries(TRAJECTORIES.map((t, i) => [t, i]));

export const TRACE_FIELDS: readonly (readonly [string, Read])[] = [
  ['time', (s) => s.state.time],
  ['presence', (s) => s.acoustic.presence],
  ['loudness', (s) => s.acoustic.loudnessMomentary],
  ['energy', (s) => s.state.energy],
  ['complexity', (s) => s.state.complexity],
  ['tension', (s) => s.state.tension],
  ['onsetDensity', (s) => s.acoustic.onsetDensity],
  ['bpm', (s) => s.acoustic.beatBpm],
  ['beatConfidence', (s) => s.acoustic.beatConfidence],
  ['meter', (s) => s.acoustic.meter],
  ['meterConfidence', (s) => s.acoustic.meterConfidence],
  ['downbeatConfidence', (s) => s.acoustic.downbeatConfidence],
  ['structureConfidence', (s) => s.acoustic.structureConfidence],
  ['sectionNovelty', (s) => s.acoustic.novelty],
  ['novelty', (s) => s.state.novelty],
  ['recurrence', (s) => s.state.recurrence],
  ['narrative', (s) => NARRATIVE[s.state.narrative]],
  ['narrativeConfidence', (s) => s.state.narrativeConfidence],
  ['trajectory', (s) => TRAJECTORY[s.state.trajectory]],
  ['anticipation', (s) => s.state.anticipation],
  ['anticipationConfidence', (s) => s.state.anticipationConfidence],
  ['releasePotential', (s) => s.state.releasePotential],
  ['release', (s) => s.state.release],
  ['likelyBuild', (s) => s.state.likelyBuild],
  ['likelyBoundary', (s) => s.state.likelyBoundary],
  ['predictionConfidence', (s) => s.state.predictionConfidence],
  ['balance', (s) => s.acoustic.balance],
  ['width', (s) => s.acoustic.width],
  ['correlation', (s) => s.acoustic.correlation],
  ['radius', (s) => s.world.radius],
  ['radialVelocity', (s) => s.world.radialVelocity],
  ['spin', (s) => s.world.spin],
  ['speed', (s) => s.world.speed],
  ['bias', (s) => s.world.bias],
  ['excitation', (s) => s.world.excitation],
  ['shimmer', (s) => s.world.shimmer],
  ['turbulence', (s) => s.world.turbulence],
  ['coherence', (s) => s.world.coherence],
  ['potential', (s) => s.world.potential],
  ['illumination', (s) => s.world.illumination],
  ['openness', (s) => s.world.openness],
  ['kinetic', (s) => s.world.kinetic],
  ['elastic', (s) => s.world.elastic],
  ['wave', (s) => s.world.wave],
  ['worldEnergy', (s) => s.world.energy],
  ['releaseStrength', (s) => s.world.releaseStrength],
  ['modalEnergy', (s) => s.physics.energy],
  ...INTENTS.map((kind, i): readonly [string, Read] => [`intent.${kind}`, (s) => s.intents[i].strength * s.intents[i].confidence]),
];

export class WorldTrace {
  private readonly rows: Float64Array;
  private written = 0;

  constructor(readonly capacity = 20 * 60 * 10) {
    this.rows = new Float64Array(capacity * TRACE_FIELDS.length);
  }

  get length(): number {
    return Math.min(this.written, this.capacity);
  }

  sample(s: ExperienceSnapshot): void {
    const at = (this.written++ % this.capacity) * TRACE_FIELDS.length;
    for (let f = 0; f < TRACE_FIELDS.length; f++) this.rows[at + f] = TRACE_FIELDS[f][1](s);
  }

  /** Value of field `f` in the `i`-th oldest row kept. */
  value(i: number, f: number): number {
    const first = Math.max(0, this.written - this.capacity);
    return this.rows[((first + i) % this.capacity) * TRACE_FIELDS.length + f];
  }

  column(name: string): Float64Array {
    const f = TRACE_FIELDS.findIndex(([n]) => n === name);
    if (f < 0) throw new Error(`unknown trace field ${name}`);
    const out = new Float64Array(this.length);
    for (let i = 0; i < out.length; i++) out[i] = this.value(i, f);
    return out;
  }

  toCsv(): string {
    const lines = [TRACE_FIELDS.map(([name]) => name).join(',')];
    for (let i = 0; i < this.length; i++) {
      const row: string[] = [];
      for (let f = 0; f < TRACE_FIELDS.length; f++) row.push(Number(this.value(i, f).toFixed(5)).toString());
      lines.push(row.join(','));
    }
    return lines.join('\n') + '\n';
  }

  clear(): void {
    this.written = 0;
  }
}
