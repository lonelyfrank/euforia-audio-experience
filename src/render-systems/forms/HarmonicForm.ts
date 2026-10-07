import type { AnalysisFrame } from '../../audio/features/decode';

/** Nodes of the network: the partials followed at once (the DSP reports up to twelve; the strongest are kept). */
export const NODES = 8;
/** Texels of `data`: row 0 holds the nodes, row 1 + a the relations of node a. */
export const HARMONIC_WIDTH = NODES;
export const HARMONIC_HEIGHT = NODES + 1;

/** Lowest pitch placed (Hz): octaves are counted from here. */
const BASE_HZ = 55;
/** A partial within this distance (octaves, ≈ 60 cents) of a node is that node. */
const SAME = 0.05;
/** Below this a node is gone: its slot is free and it can be placed anew. */
const GONE = 0.05;
/** Followers (s): a node appears quickly, fades slowly, and glides to where its partial moves. */
const ATTACK = 0.05;
const RELEASE = 0.45;
const GLIDE = 0.1;
const PLACE = 0.25;
/**
 * Octave-reduced just intervals (as a fraction of an octave) and how strongly
 * two partials that far apart belong together: unison/octave, fifth, fourth,
 * major third, major sixth, minor third, minor sixth, harmonic seventh.
 */
const INTERVALS = [0, 0.585, 0.415, 0.3219, 0.737, 0.263, 0.678, 0.8074];
const WEIGHTS = [1, 0.8, 0.7, 0.6, 0.55, 0.5, 0.45, 0.4];
/** Tolerance of an interval (octaves, ≈ 24 cents). */
const TOLERANCE = 0.02;

/** How strongly two pitches `octaves` apart are related, 0..1: 1 for octaves, 0 for a semitone or a tritone. */
export function consonance(octaves: number): number {
  const d = Math.abs(octaves), c = d - Math.floor(d);
  let best = 0;
  for (let k = 0; k < INTERVALS.length; k++) {
    let off = Math.abs(c - INTERVALS[k]);
    if (k === 0) off = Math.min(off, 1 - c);
    const fit = WEIGHTS[k] * Math.exp(-((off / TOLERANCE) ** 2));
    if (fit > best) best = fit;
  }
  return best;
}

/**
 * The partials of the sound as a structure in space: a "sound molecule". Each
 * partial the DSP reports becomes a node that persists while the partial does:
 * the list arrives ordered by level, so partials are matched to the nodes they
 * already are by pitch. A node glides when its partial moves, fades when it
 * stops and is taken over by a new partial only once it is gone, so a change
 * of harmony reconfigures the structure instead of replacing it.
 *
 * Where a node sits is its partial: pitch winds it up a conical spiral (one
 * turn per octave, so octaves line up along a generator and a fifth sits
 * 0.585 of a turn away), the stereo position shifts it sideways, the phase
 * between the channels turns it a little, the level is how much it holds.
 * Two nodes are related by how consonant their interval is and how present
 * both are: matter condenses on the related pairs and triples (formLaw.ts).
 *
 * The matter's strands are seeded with node numbers 0..NODES−1. A number whose
 * node is absent stands for the next node that is there, so a few partials
 * hold several times the matter their own numbers would (on fewer, denser
 * edges), and a node that appears takes over only the strands waiting for it.
 *
 * Rendering history only: no musical state is decided here. Frame-rate
 * independent (exact followers), deterministic, allocation-free.
 */
export class HarmonicForm {
  /**
   * What the form law reads, per node number as the strands are seeded with
   * them. RGBA floats, HARMONIC_WIDTH × HARMONIC_HEIGHT. Row 0: xyz (unit
   * scale: the law multiplies by the matter's radius) and level 0..1 of the
   * node the number stands for. Row 1 + a, column b: relation of the nodes
   * numbers a and b stand for, in the first channel (0 when they are the same node).
   */
  readonly data = new Float32Array(HARMONIC_WIDTH * HARMONIC_HEIGHT * 4);
  /** The node each number stands for: itself when present, else the next present one. */
  readonly standsFor = new Uint8Array(NODES);
  private readonly place = new Float32Array(NODES * 3);
  private readonly related = new Float32Array(NODES * NODES);
  /** Per node: pitch (octaves above BASE_HZ) now and where it is going, level and its target, pan, phase. */
  readonly pitch = new Float32Array(NODES);
  readonly level = new Float32Array(NODES);
  private readonly pitchTarget = new Float32Array(NODES);
  private readonly levelTarget = new Float32Array(NODES);
  private readonly pan = new Float32Array(NODES);
  private readonly panTarget = new Float32Array(NODES);
  private readonly phase = new Float32Array(NODES);
  private readonly phaseTarget = new Float32Array(NODES);
  private readonly claimed = new Uint8Array(NODES);
  /** Nodes present, and related pairs among them (diagnostics). */
  active = 0;
  links = 0;
  /** Increments whenever `data` changes (a texture made from it must be uploaded again). */
  version = 0;

  /**
   * `acoustic`: the heard analysis frame (its partials), or none (no clock:
   * the structure fades). `trust` 0..1: how far the partials are partials
   * (steady, tonal sound) and not the peaks of noise.
   */
  update(dt: number, acoustic: AnalysisFrame | undefined, trust: number): void {
    const h = dt > 0 ? Math.min(dt, 0.25) : 0;
    const { pitch, level, pitchTarget, levelTarget, pan, panTarget, phase, phaseTarget, claimed } = this;
    claimed.fill(0);
    const weight = trust > 0 ? Math.min(trust, 1) : 0;
    if (acoustic && weight > 0) {
      const hz = acoustic.partialHz, levels = acoustic.partialLevel;
      for (let i = 0; i < hz.length; i++) {
        const strength = levels[i] * weight;
        if (!(strength > GONE) || !(hz[i] >= BASE_HZ) || hz[i] === Infinity) continue;
        const p = Math.log2(hz[i] / BASE_HZ);
        // The node this partial already is: the nearest unclaimed one that is still there.
        let slot = -1, nearest = SAME;
        for (let n = 0; n < NODES; n++) {
          const off = Math.abs(p - pitchTarget[n]);
          if (!claimed[n] && (level[n] > GONE || levelTarget[n] > 0) && off < nearest) { nearest = off; slot = n; }
        }
        if (slot < 0) {
          // A new partial takes a free slot, or the place of a clearly weaker node (which then glides to it).
          let weakest = Infinity;
          for (let n = 0; n < NODES; n++) if (!claimed[n] && level[n] < weakest) { weakest = level[n]; slot = n; }
          if (slot < 0 || (weakest > GONE && strength < weakest + 0.25)) continue;
          if (weakest <= GONE) { pitch[slot] = p; pan[slot] = within(acoustic.partialPan[i], 1); phase[slot] = within(acoustic.partialPhase[i], Math.PI); }
        }
        claimed[slot] = 1;
        pitchTarget[slot] = p; levelTarget[slot] = Math.min(strength, 1);
        panTarget[slot] = within(acoustic.partialPan[i], 1); phaseTarget[slot] = within(acoustic.partialPhase[i], Math.PI);
      }
    }
    const glide = 1 - Math.exp(-h / GLIDE), settle = 1 - Math.exp(-h / PLACE);
    const { data, place, related, standsFor } = this;
    this.active = 0;
    for (let n = 0; n < NODES; n++) {
      if (!claimed[n]) levelTarget[n] = 0;
      level[n] += (levelTarget[n] - level[n]) * (1 - Math.exp(-h / (levelTarget[n] > level[n] ? ATTACK : RELEASE)));
      if (!(level[n] > 1e-4)) level[n] = 0;
      pitch[n] += (pitchTarget[n] - pitch[n]) * glide;
      pan[n] += (panTarget[n] - pan[n]) * settle;
      phase[n] += (phaseTarget[n] - phase[n]) * settle;
      if (level[n] > GONE) this.active++;
      const octave = pitch[n], angle = 2 * Math.PI * (octave - Math.floor(octave)) + 0.25 * phase[n];
      const radius = 0.4 + 0.22 * octave;
      place[n * 3] = radius * Math.cos(angle) + 0.35 * pan[n];
      place[n * 3 + 1] = radius * Math.sin(angle);
      place[n * 3 + 2] = 0.3 * (octave - 3);
    }
    this.links = 0;
    for (let a = 0; a < NODES; a++) {
      for (let b = 0; b < NODES; b++) {
        const value = a === b ? 0 : Math.min(1, 1.6 * consonance(pitch[a] - pitch[b]) * Math.sqrt(level[a] * level[b]));
        related[a * NODES + b] = value;
        if (a < b && value > 0.2) this.links++;
      }
    }
    for (let n = 0; n < NODES; n++) {
      let node = n;
      for (let k = 0; k < NODES && !(level[node] > GONE); k++) node = (n + k + 1) % NODES;
      standsFor[n] = level[node] > GONE ? node : n;
    }
    for (let a = 0; a < NODES; a++) {
      const node = standsFor[a];
      data[a * 4] = place[node * 3]; data[a * 4 + 1] = place[node * 3 + 1]; data[a * 4 + 2] = place[node * 3 + 2];
      data[a * 4 + 3] = level[node];
      for (let b = 0; b < NODES; b++) data[((1 + a) * HARMONIC_WIDTH + b) * 4] = related[node * NODES + standsFor[b]];
    }
    this.version++;
  }

  /** Relation of nodes `a` and `b` (the nodes themselves, not the numbers that stand for them). */
  relation(a: number, b: number): number {
    return this.related[a * NODES + b];
  }

  /** Where node `n` sits (unit scale), written to `out`. */
  position(n: number, out: number[] = [0, 0, 0]): number[] {
    out[0] = this.place[n * 3]; out[1] = this.place[n * 3 + 1]; out[2] = this.place[n * 3 + 2];
    return out;
  }

  reset(): void {
    this.data.fill(0); this.place.fill(0); this.related.fill(0);
    for (let n = 0; n < NODES; n++) this.standsFor[n] = n;
    this.pitch.fill(0); this.level.fill(0); this.pitchTarget.fill(0); this.levelTarget.fill(0);
    this.pan.fill(0); this.panTarget.fill(0); this.phase.fill(0); this.phaseTarget.fill(0);
    this.active = this.links = 0;
    this.version++;
  }
}

/** `x` within ±`limit`; 0 when it is not a number. */
function within(x: number, limit: number): number {
  return x > -limit ? (x < limit ? x : limit) : x <= -limit ? -limit : 0;
}
