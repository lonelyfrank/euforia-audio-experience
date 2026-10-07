import { BOND_REST, FIELD_VALUES, fieldLaw, LATERAL_AT, NO_ANCHOR, packFields, packWaves, PHASE_PERIOD, RADIUS_AT, TURN_AT } from '../fields/fieldLaw';
import type { SpatialFields } from '../fields/SpatialFields';
import { anchorOut, formAnchor } from '../forms/formLaw';
import type { MatterForms } from '../forms/MatterForms';
import { MAX_WAVES, type WaveField } from '../waves/WaveField';
import { matterStep, substeps } from './matterLaw';
import { matterLayout, seedMatter, STRAND, type MatterSeeds } from './MatterSeeds';

/** What a body of matter looks like as a whole (means over its elements). */
export interface MatterMeasure {
  /** Mean distance from the centre of the fields and its standard deviation (thin shell → small). */
  radius: number;
  spread: number;
  /** Mean speed (units/s) and mean of the energy channel. */
  speed: number;
  energy: number;
  /** Mean |z| / mean radius: 0 = a disc in the plane of rotation, ~0.5 = a ball. */
  flatness: number;
  /** Share of strand bonds shorter than three rest lengths: 1 = connected filaments, 0 = dust. */
  connectivity: number;
  /** Share of the matter a form holds (mean hold), and how far that matter is from where its form wants it (units, mean). */
  held: number;
  offForm: number;
  /** Mean area of the facets along the strands (units²): 0 for strands lying as lines, larger as they open into ribbons and polygons. */
  facet: number;
}

/**
 * The matter simulated on the CPU with the reference laws: the same seeds,
 * fields, fronts and stepping as the GPU backend, for a small number of
 * elements. It is what the tests exercise and what a host without GPU
 * simulation could draw; `measure` turns it into morphology numbers.
 * Deterministic and allocation-free after construction.
 */
export class MatterProbe {
  readonly seeds: MatterSeeds;
  position: Float32Array;
  velocity: Float32Array;
  private nextPosition: Float32Array;
  private nextVelocity: Float32Array;
  private readonly field = new Float32Array(FIELD_VALUES);
  private readonly waveA = new Float32Array(MAX_WAVES * 4);
  private readonly waveB = new Float32Array(MAX_WAVES * 4);
  private readonly measured: MatterMeasure = { radius: 0, spread: 0, speed: 0, energy: 0, flatness: 0, connectivity: 0, held: 0, offForm: 0, facet: 0 };
  private packedForms: Float32Array | null = null;
  private phase = 0;
  private pendingReset = true;

  /** `forms`: the forms this matter can take, as for the GPU simulation; none = free matter only. */
  constructor(count: number, seed: number, private readonly detail = true, private readonly forms?: MatterForms) {
    this.seeds = seedMatter(matterLayout(count), seed);
    const n = this.seeds.layout.count * 4;
    this.position = new Float32Array(n); this.velocity = new Float32Array(n);
    this.nextPosition = new Float32Array(n); this.nextVelocity = new Float32Array(n);
  }

  get count(): number {
    return this.seeds.layout.count;
  }

  /** Advances by `dt` seconds under `fields` and the fronts as they are at `now`. */
  step(fields: Readonly<SpatialFields>, waves: WaveField | undefined, now: number, dt: number): void {
    const steps = substeps(dt) || (this.pendingReset ? 1 : 0);
    if (steps === 0) return;
    const h = Math.min(dt, 0.1) / steps;
    // Without fronts (no clock) none may linger from an earlier frame.
    if (waves) packWaves(this.waveA, this.waveB, waves, now);
    else this.waveB.fill(0);
    const { home, trait, form } = this.seeds;
    const forms = this.forms, m = forms ? (this.packedForms = forms.pack()) : null;
    for (let s = 0; s < steps; s++) {
      this.phase = (this.phase + fields.phaseRate * h) % PHASE_PERIOD;
      const f = packFields(this.field, fields, this.phase);
      for (let i = 0; i < this.count; i++) {
        const at = i * 4, member = i % STRAND;
        const anchor = m ? formAnchor(form, i, m, f[LATERAL_AT], f[TURN_AT], f[RADIUS_AT], forms!.signal.data, forms!.harmonic.data) : NO_ANCHOR;
        const law = fieldLaw(this.position[at], this.position[at + 1], this.position[at + 2], home[at], home[at + 1], home[at + 2], home[at + 3], trait[at],
          this.position, member > 0 ? i - 1 : -1, member < STRAND - 1 ? i + 1 : -1, f, this.waveA, this.waveB, this.detail, anchor);
        matterStep(i, this.position, this.velocity, this.nextPosition, this.nextVelocity, home, trait, law, f, h, this.pendingReset);
      }
      this.pendingReset = false;
      let swap = this.position; this.position = this.nextPosition; this.nextPosition = swap;
      swap = this.velocity; this.velocity = this.nextVelocity; this.nextVelocity = swap;
    }
  }

  /** The matter re-forms at its seeds on the next step (a new audio session). */
  reset(): void {
    this.pendingReset = true;
    this.phase = 0;
  }

  /** Morphology of the body about the centre `lateral` (the fields' centre along x). Reused object. */
  measure(lateral = 0): MatterMeasure {
    const p = this.position, v = this.velocity, n = this.count, m = this.measured;
    let radius = 0, squares = 0, speed = 0, energy = 0, height = 0, bonds = 0, close = 0, held = 0, off = 0, facets = 0, area = 0;
    const forms = this.forms, packed = this.packedForms, f = this.field;
    for (let i = 0; i < n; i++) {
      const at = i * 4, x = p[at] - lateral, y = p[at + 1], z = p[at + 2];
      if (forms && packed) {
        // Against the forms as the last step saw them.
        formAnchor(this.seeds.form, i, packed, f[LATERAL_AT], f[TURN_AT], f[RADIUS_AT], forms.signal.data, forms.harmonic.data);
        held += anchorOut[3];
        off += anchorOut[3] * Math.hypot(anchorOut[0] - p[at], anchorOut[1] - p[at + 1], anchorOut[2] - p[at + 2]);
      }
      if (i % STRAND < STRAND - 2) {
        // The facet this element starts: itself and the next two of its strand.
        const ax = p[at + 4] - p[at], ay = p[at + 5] - p[at + 1], az = p[at + 6] - p[at + 2];
        const bx = p[at + 8] - p[at], by = p[at + 9] - p[at + 1], bz = p[at + 10] - p[at + 2];
        area += 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
        facets++;
      }
      const r = Math.hypot(x, y, z);
      radius += r; squares += r * r; height += Math.abs(z);
      speed += Math.hypot(v[at], v[at + 1], v[at + 2]);
      energy += p[at + 3];
      if (i % STRAND < STRAND - 1) {
        bonds++;
        if (Math.hypot(p[at + 4] - p[at], p[at + 5] - p[at + 1], p[at + 6] - p[at + 2]) < BOND_REST * 3) close++;
      }
    }
    m.radius = radius / n;
    m.spread = Math.sqrt(Math.max(0, squares / n - m.radius * m.radius));
    m.speed = speed / n; m.energy = energy / n;
    m.flatness = m.radius > 0 ? height / radius : 0;
    m.connectivity = bonds > 0 ? close / bonds : 0;
    m.held = held / n; m.offForm = held > 0 ? off / held : 0;
    m.facet = facets > 0 ? area / facets : 0;
    return m;
  }
}
