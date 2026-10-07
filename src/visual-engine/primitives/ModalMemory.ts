import { MODES } from '../../physics/ResonantPhysics';

/** Times a second (of audio time) the membrane's state is remembered. */
export const MEMORY_RATE = 30;
/** A clock that went back by more than this is another session (s). */
const SESSION_GAP = 1;

/**
 * What a membrane's modes were a moment ago: a bounded ring of their values
 * at fixed ticks of the audio clock, so the past a shell shows is the same
 * whatever the frame rate. A frame falls between two ticks: the value at a
 * tick is interpolated between the two frames round it, and a read between
 * the newest tick and now between that tick and the live modes. Before
 * anything was heard the membrane was flat. Rendering history only;
 * allocation-free after construction.
 */
export class ModalMemory {
  private readonly rows: Float32Array;
  private readonly size: number;
  private readonly live = new Float32Array(MODES);
  /** Audio time of the live modes, and the newest tick recorded. */
  private time = NaN;
  private tick = 0;

  /** `span`: the oldest age that can be read (s). */
  constructor(readonly span: number) {
    this.size = Math.ceil(span * MEMORY_RATE) + 2;
    this.rows = new Float32Array(this.size * MODES);
  }

  /** The modes as they are at `time` (the heard audio time). */
  record(time: number, modes: ArrayLike<number>): void {
    if (!Number.isFinite(time)) return;
    if (!(time >= this.time)) {
      // A clock that hesitates keeps what is known; one that starts or starts again knows nothing yet.
      if (this.time - time < SESSION_GAP) return;
      this.clear();
    }
    const newest = Math.floor(time * MEMORY_RATE);
    if (Number.isNaN(this.time)) this.tick = newest;
    else {
      const elapsed = time - this.time;
      // After a stall only the ticks that still fit are written.
      for (let n = Math.max(this.tick + 1, newest - this.size + 1); n <= newest; n++) {
        const w = elapsed > 0 ? Math.min(1, Math.max(0, (n / MEMORY_RATE - this.time) / elapsed)) : 1, at = (n % this.size) * MODES;
        for (let i = 0; i < MODES; i++) this.rows[at + i] = this.live[i] + (finite(modes[i]) - this.live[i]) * w;
      }
      this.tick = newest;
    }
    for (let i = 0; i < MODES; i++) this.live[i] = finite(modes[i]);
    this.time = time;
  }

  /** Writes the modes as they were `delay` seconds before the last record into `out` at `offset`. */
  read(delay: number, out: Float32Array, offset = 0): void {
    const live = this.live, rows = this.rows;
    if (Number.isNaN(this.time) || !(delay > 0)) {
      for (let i = 0; i < MODES; i++) out[offset + i] = live[i];
      return;
    }
    const x = (this.time - Math.min(delay, this.span)) * MEMORY_RATE;
    const n = Math.max(Math.floor(x), this.tick - this.size + 1);
    if (n >= this.tick) {
      // Between the newest tick and now.
      const from = this.tick / MEMORY_RATE, gap = this.time - from, w = gap > 1e-9 ? Math.min(1, Math.max(0, (x / MEMORY_RATE - from) / gap)) : 1;
      const at = (this.tick % this.size) * MODES;
      for (let i = 0; i < MODES; i++) out[offset + i] = rows[at + i] + (live[i] - rows[at + i]) * w;
      return;
    }
    const w = Math.min(1, Math.max(0, x - n)), a = mod(n, this.size) * MODES, b = mod(n + 1, this.size) * MODES;
    for (let i = 0; i < MODES; i++) out[offset + i] = rows[a + i] + (rows[b + i] - rows[a + i]) * w;
  }

  clear(): void {
    this.rows.fill(0); this.live.fill(0);
    this.time = NaN; this.tick = 0;
  }
}

const finite = (x: number): number => (Number.isFinite(x) ? x : 0);
const mod = (n: number, size: number): number => ((n % size) + size) % size;
