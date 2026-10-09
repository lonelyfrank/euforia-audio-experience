import type { ClockSync } from '../../timing/ClockSync';
import { recordSize, type AnalysisDecoder } from './decode';
import { CLOCK_FIELDS, HOP, RECORD, TAG } from './layout';
import { SceneFeed } from './SceneFeed';

const CLOCKS = 64;
/** Seconds of analysis kept while the frame loop is not reading (a longer stall drops what is pending). */
const STAGE_SECONDS = 3;

/** What the producer says about itself with each batch (its clock record), and what the stage saw of the transport. */
export interface TransportStats {
  /** Batches received, and holes in the producer's sequence (a batch that never arrived, or out of order). */
  batches: number;
  missed: number;
  /** Frames the capture lost so far, as the producer counts them. */
  lost: number;
  /** DSP work / audio time (0.1 = 10 % of one core) and the DSP quality level (0 high … 2 low). */
  load: number;
  quality: number;
  /** Seconds between the capture of a batch's newest sample and its sending. */
  age: number;
  /** f64 values waiting to be decoded, and dropped because the frame loop did not read them in time. */
  pending: number;
  dropped: number;
}

/**
 * Analysis records received from a producer off the frame loop (the native
 * capture thread, the browser analysis worker), between their arrival and the
 * rendered frames that decode them.
 *
 * Each batch ends with a clock record: its arrival time says how the capture
 * clock maps to ours, its sequence number tells a lost batch, its epoch a
 * restart of the capture clock. Scene records go straight to the `scenes`
 * feed (only the newest matter); everything else waits here, in arrival
 * order, and is decoded a bounded number of hops per frame: after a stall
 * the backlog is worked off over the next frames instead of in one. Nothing
 * is skipped unless the stage overflows, which drops what was pending (the
 * consumers see a gap in the capture clock and start over).
 */
export class RecordStage {
  /** The scenes' graphic analysis: read once per rendered frame. */
  readonly scenes = new SceneFeed();
  readonly stats: TransportStats = { batches: 0, missed: 0, lost: 0, load: 0, quality: 0, age: 0, pending: 0, dropped: 0 };
  /** Changes when the producer's analysis restarted after losing audio: its capture clock started over. */
  epoch = 0;
  private records: Float64Array;
  /** Pending records are `records[start..end)`. */
  private start = 0;
  private end = 0;
  /** Clock observations: arrival (s, host), sample index, age (s). */
  private readonly clocks = new Float64Array(3 * CLOCKS);
  private clockCount = 0;
  private sequence = -1;

  constructor(sampleRate: number) {
    this.records = new Float64Array(RecordStage.capacity(sampleRate));
  }

  private static capacity(sampleRate: number): number {
    const hops = Math.ceil((sampleRate / HOP) * STAGE_SECONDS);
    return hops * (RECORD.frame + RECORD.onset + RECORD.beat) + CLOCKS * RECORD.clock;
  }

  /** The stage was sized for another sample rate: resize it, keeping what is pending. */
  resize(sampleRate: number): void {
    const capacity = RecordStage.capacity(sampleRate);
    if (capacity === this.records.length) return;
    const records = new Float64Array(capacity);
    const kept = Math.min(this.end - this.start, capacity);
    records.set(this.records.subarray(this.end - kept, this.end));
    this.records = records;
    this.start = 0;
    this.end = kept;
  }

  /** f64 values waiting to be decoded. */
  get pending(): number {
    return this.end - this.start;
  }

  /** Takes a batch of whole records (`length` values), as it arrives. */
  stage(batch: Float64Array, length: number, arrival: number): void {
    const stats = this.stats;
    stats.batches++;
    const clock = length - RECORD.clock;
    if (clock >= 0 && batch[clock] === TAG.clock) {
      const epoch = batch[clock + CLOCK_FIELDS.epoch[0]];
      if (epoch !== this.epoch) {
        // The capture clock restarted: nothing staged from the old epoch may reach the consumers.
        this.clear();
        this.epoch = epoch;
      }
      const sequence = batch[clock + CLOCK_FIELDS.sequence[0]];
      if (this.sequence >= 0 && sequence !== this.sequence + 1) stats.missed++;
      this.sequence = sequence;
      stats.lost = batch[clock + CLOCK_FIELDS.lost[0]];
      stats.load = batch[clock + CLOCK_FIELDS.load[0]];
      stats.quality = batch[clock + CLOCK_FIELDS.quality[0]];
      stats.age = batch[clock + CLOCK_FIELDS.age[0]];
      if (this.clockCount < CLOCKS) {
        const c = 3 * this.clockCount++;
        this.clocks[c] = arrival;
        this.clocks[c + 1] = batch[clock + CLOCK_FIELDS.sample[0]];
        this.clocks[c + 2] = stats.age;
      }
    }
    // Scene records leave for their feed; the runs between them are staged.
    let at = 0;
    let run = 0;
    while (at < length) {
      const tag = batch[at];
      const size = recordSize(tag);
      // A truncated or unknown record: the stream is out of sync, the rest of the batch is unusable.
      if (size === 0 || at + size > length) break;
      if (tag === TAG.scene) {
        this.append(batch, run, at);
        this.scenes.push(batch, at);
        run = at + size;
      }
      at += size;
    }
    this.append(batch, run, at);
    stats.pending = this.end - this.start;
  }

  /**
   * Gives `clock` the batches' observations and decodes into `decoder` what
   * is pending, at most `maxFrames` hop frames of it: the rest stays for the
   * next call.
   */
  drain(decoder: AnalysisDecoder, clock: ClockSync, sampleRate: number, maxFrames = Infinity): void {
    for (let i = 0; i < this.clockCount; i++) clock.observe(this.clocks[3 * i], this.clocks[3 * i + 1] / sampleRate, this.clocks[3 * i + 2]);
    this.clockCount = 0;
    if (this.start === this.end) return;
    decoder.decode(this.records, this.end, this.start, maxFrames);
    this.start = decoder.consumed;
    if (this.start >= this.end) this.start = this.end = 0;
    this.stats.pending = this.end - this.start;
  }

  clear(): void {
    this.start = this.end = 0;
    this.clockCount = 0;
    this.sequence = -1;
    this.scenes.clear();
    this.stats.pending = 0;
  }

  /** Appends `batch[from..to)` to the pending records. */
  private append(batch: Float64Array, from: number, to: number): void {
    const length = to - from;
    if (length <= 0) return;
    const records = this.records;
    if (length > records.length) {
      this.stats.dropped += length;
      return;
    }
    if (this.end + length > records.length) {
      // Out of room at the end: move what is pending to the front; if it still does not fit, the frame loop stalled.
      records.copyWithin(0, this.start, this.end);
      this.end -= this.start;
      this.start = 0;
      if (this.end + length > records.length) {
        this.stats.dropped += this.end;
        this.end = 0;
      }
    }
    records.set(from === 0 && to === batch.length ? batch : batch.subarray(from, to), this.end);
    this.end += length;
  }
}
