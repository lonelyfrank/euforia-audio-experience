import type { ClockSync } from '../../timing/ClockSync';
import type { AnalysisDecoder } from './decode';
import { RECORD, TAG } from './layout';

const CLOCKS = 64;

/**
 * Analysis records received from a producer off the frame loop (the native
 * capture thread, the browser analysis worker) between two rendered frames.
 * Each batch ends with a clock record: its arrival time says how the capture
 * clock maps to ours. Decoded once per frame, in arrival order. A stalled
 * frame loop drops the oldest records rather than growing.
 */
export class RecordStage {
  private readonly records: Float64Array;
  private count = 0;
  /** Clock observations: arrival (s, host), sample index, age (s). */
  private readonly clocks = new Float64Array(3 * CLOCKS);
  private clockCount = 0;
  /** Records dropped because the frame loop did not read them in time (f64 values). */
  dropped = 0;

  constructor(capacity: number) {
    this.records = new Float64Array(capacity);
  }

  /** f64 values waiting to be decoded. */
  get pending(): number {
    return this.count;
  }

  /** Appends whole records (`length` values of `batch`). */
  stage(batch: Float64Array, length: number, arrival: number): void {
    const at = length - RECORD.clock;
    if (at >= 0 && batch[at] === TAG.clock && this.clockCount < CLOCKS) {
      const c = 3 * this.clockCount++;
      this.clocks[c] = arrival;
      this.clocks[c + 1] = batch[at + 1];
      this.clocks[c + 2] = batch[at + 2];
    }
    if (length > this.records.length) {
      this.dropped += length;
      return;
    }
    if (this.count + length > this.records.length) {
      this.dropped += this.count;
      this.count = 0;
    }
    this.records.set(batch.subarray(0, length), this.count);
    this.count += length;
  }

  /** Gives `clock` the batches' observations and decodes their records into `decoder`. */
  drain(decoder: AnalysisDecoder, clock: ClockSync, sampleRate: number): void {
    for (let i = 0; i < this.clockCount; i++) clock.observe(this.clocks[3 * i], this.clocks[3 * i + 1] / sampleRate, this.clocks[3 * i + 2]);
    this.clockCount = 0;
    if (this.count === 0) return;
    decoder.decode(this.records, this.count);
    this.count = 0;
  }

  clear(): void {
    this.count = 0;
    this.clockCount = 0;
  }
}
