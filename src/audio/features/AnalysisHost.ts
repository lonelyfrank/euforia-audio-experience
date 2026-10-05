import { SignalGenerator, type TestSignal } from '../capture/testSignals';
import { RECORD, TAG } from './layout';
import { FILLED, PcmRing } from './PcmRing';
import { CAPACITY, WasmAnalysis, type RecordSink } from './WasmAnalysis';

/**
 * Where the PCM comes from: a ring shared with the AudioWorklet, a local ring
 * fed by `write` (blocks posted by the worklet without cross-origin
 * isolation), or the deterministic test generator running on the host's own
 * timer (so the synthetic source is clocked like a device, not by frames).
 */
export type HostSource =
  | { kind: 'shared'; ring: SharedArrayBuffer }
  | { kind: 'port' }
  | { kind: 'generator'; signal: TestSignal };

export interface HostOptions {
  sampleRate: number;
  source: HostSource;
  /** Lower slow DSP rates when the measured cost is high (never hop, beats or onsets). */
  adaptive: boolean;
}

/** Diagnostics sent with each batch. */
export interface BatchInfo {
  /** Increments when the analysis restarted after a long loss of audio (the capture clock restarts too). */
  epoch: number;
  /** DSP work / audio duration, smoothed (0.1 = 10% of one core). */
  load: number;
  quality: number;
  /** Frames captured but not analysed yet when the batch was sent. */
  backlog: number;
  /** Frames the consumer lost to a stall, and frames the worklet filled with silence (cumulative). */
  lost: number;
  filled: number;
}

/** What crosses the thread boundary. Buffers are lent; give them back with `recycle`. */
export interface HostOutput {
  records(batch: Float64Array, length: number, info: BatchInfo): void;
  /** Generator only: the mono mix of what was analysed, for the scenes' graphics. */
  pcm?(mono: Float32Array, frames: number): void;
}

const CHANNELS = 2;
const FRAMES = CAPACITY / CHANNELS;
/** Seconds of capture the ring holds. */
export const RING_SECONDS = 2;
/** Lost audio up to this long is analysed as silence (the capture clock stays exact); beyond, the analysis restarts. */
const MAX_FILL = 1;
/** The generator never synthesises more than this per pump (after the host was suspended). */
const MAX_CATCH_UP = 0.25;
const POOL = 16;

/**
 * Runs the Rust/WASM analysis outside the frame loop: drains the PCM ring,
 * analyses every frame in chunks, and sends the records of each chunk with a
 * clock record (capture sample, age of its newest sample), exactly like the
 * native capture thread does. Environment-agnostic: the analysis worker runs
 * it; without workers it runs on the main thread. Allocation-free after warm-up
 * (record and PCM buffers circulate through pools).
 */
export class AnalysisHost implements RecordSink {
  epoch = 0;
  /** Frames analysed in this epoch: the capture clock. */
  analysed = 0;
  readonly ring: PcmRing;
  private wasm!: WasmAnalysis<AnalysisHost>;
  private readonly input = new Float32Array(CAPACITY);
  private readonly generator: SignalGenerator | null;
  private lastGenerated = 0;
  private owed = 0;
  private batch: Float64Array | null = null;
  private length = 0;
  private readonly records: Float64Array[] = [];
  private readonly pcmPool: Float32Array[] = [];
  private lost = 0;
  private readonly info: BatchInfo = { epoch: 0, load: 0, quality: 0, backlog: 0, lost: 0, filled: 0 };

  private constructor(readonly options: HostOptions, private readonly output: HostOutput, private readonly now: () => number) {
    const { source, sampleRate } = options;
    const frames = sampleRate * RING_SECONDS;
    this.ring = new PcmRing(source.kind === 'shared' ? source.ring : new ArrayBuffer(PcmRing.bytes(frames, CHANNELS)), CHANNELS);
    this.generator = source.kind === 'generator' ? new SignalGenerator(source.signal, sampleRate) : null;
  }

  static async create(options: HostOptions, output: HostOutput, now = () => performance.now() / 1000): Promise<AnalysisHost> {
    const host = new AnalysisHost(options, output, now);
    host.wasm = await WasmAnalysis.create(options.sampleRate, CHANNELS, host);
    host.wasm.adaptive = options.adaptive;
    // The generator's clock starts with the source, not at the first pump.
    host.lastGenerated = now();
    return host;
  }

  /** Port source: a block of interleaved stereo frames from the worklet. */
  write(block: Float32Array): void {
    this.ring.write(block, block.length / CHANNELS);
  }

  /** Generates (generator source), then analyses everything captured so far. */
  pump(): void {
    const arrival = this.now();
    if (this.generator) this.generate(arrival);
    const ring = this.ring;
    for (;;) {
      const frames = ring.readInto(this.input);
      if (ring.lost > 0) {
        this.lose(ring.lost, arrival);
        ring.lost = 0;
      }
      if (frames === 0) break;
      this.analyse(this.input, frames, arrival);
      if (frames < FRAMES) break;
    }
  }

  /** RecordSink: the records of one push. */
  decode(data: Float64Array, length: number): void {
    const batch = this.take(length + RECORD.clock);
    batch.set(data.subarray(0, length), this.length);
    this.length += length;
  }

  /** A buffer the receiver is done with. */
  recycle(buffer: ArrayBuffer): void {
    if (buffer.byteLength === (this.wasm.outputCapacity + RECORD.clock) * 8) {
      if (this.records.length < POOL) this.records.push(new Float64Array(buffer));
    } else if (buffer.byteLength === FRAMES * 4 && this.pcmPool.length < POOL) this.pcmPool.push(new Float32Array(buffer));
  }

  dispose(): void {
    this.wasm.dispose();
  }

  private analyse(samples: Float32Array, frames: number, arrival: number): void {
    this.wasm.push(samples, frames * CHANNELS);
    this.analysed += frames;
    // A chunk shorter than a hop may produce no record; the clock record still goes out.
    const batch = this.take(RECORD.clock);
    batch[this.length] = TAG.clock;
    batch[this.length + 1] = this.analysed;
    batch[this.length + 2] = Math.max(0, this.now() - arrival);
    this.length += RECORD.clock;
    const info = this.info;
    info.epoch = this.epoch;
    info.load = this.wasm.budget.load;
    info.quality = this.wasm.budget.quality;
    info.backlog = this.ring.available();
    info.lost = this.lost;
    info.filled = Atomics.load(this.ring.state, FILLED);
    this.batch = null;
    const length = this.length;
    this.length = 0;
    this.output.records(batch, length, info);
  }

  /** Audio the analysis did not see: silence keeps the clock if short, otherwise a new epoch. */
  private lose(frames: number, arrival: number): void {
    this.lost += frames;
    if (frames > MAX_FILL * this.options.sampleRate) {
      this.wasm.reset();
      this.analysed = 0;
      this.epoch++;
      return;
    }
    this.input.fill(0);
    for (let left = frames; left > 0; left -= FRAMES) this.analyse(this.input, Math.min(left, FRAMES), arrival);
  }

  private generate(now: number): void {
    const generator = this.generator!;
    this.owed += Math.min(now - this.lastGenerated, MAX_CATCH_UP) * this.options.sampleRate;
    this.lastGenerated = now;
    let frames = Math.floor(this.owed);
    this.owed -= frames;
    while (frames > 0) {
      const n = Math.min(frames, FRAMES);
      generator.fillStereo(this.input, n);
      this.ring.write(this.input, n);
      if (this.output.pcm) {
        const mono = this.pcmPool.pop() ?? new Float32Array(FRAMES);
        for (let i = 0; i < n; i++) mono[i] = (this.input[2 * i] + this.input[2 * i + 1]) * 0.5;
        this.output.pcm(mono, n);
      }
      frames -= n;
    }
  }

  /** The current batch, with room for `extra` more values. */
  private take(extra: number): Float64Array {
    if (!this.batch) {
      this.batch = this.records.pop() ?? new Float64Array(this.wasm.outputCapacity + RECORD.clock);
      this.length = 0;
    }
    if (this.length + extra > this.batch.length) throw new Error('analysis batch overflow');
    return this.batch;
  }
}
