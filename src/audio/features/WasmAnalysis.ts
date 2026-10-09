import { DspBudget } from './DspBudget';
import { AnalysisDecoder } from './decode';
import { WIRE_VERSION } from './layout';
import instantiate from './spectrum_analysis.wasm?init';

/** Exports of spectrum_analysis.wasm (native/analysis-wasm). */
interface Exports {
  memory: WebAssembly.Memory;
  sa_new(sampleRate: number, channels: number, capacity: number): number;
  sa_free(host: number): void;
  sa_input(host: number): number;
  sa_output(host: number): number;
  sa_output_capacity(host: number): number;
  sa_push(host: number, count: number): number;
  sa_reset(host: number): void;
  sa_quality(host: number, quality: number): void;
  sa_scene(host: number, sensitivity: number, smoothing: number, every: number): void;
  sa_version(): number;
}

/** Interleaved samples accepted per push (larger inputs are split). */
export const CAPACITY = 16384;

/** Receives the encoded records of each push: the decoder, or a host forwarding them across a thread. */
export interface RecordSink {
  decode(data: Float64Array, length: number): void;
  reset?(): void;
}

/**
 * The Rust analysis compiled to WebAssembly, for sources that live in the
 * browser (synthetic signal, getUserMedia microphone). The desktop app runs
 * the same code natively on the capture thread instead.
 */
export class WasmAnalysis<S extends RecordSink = AnalysisDecoder> {
  readonly budget = new DspBudget();
  adaptive = false;
  private readonly host: number;
  private buffer: ArrayBuffer | null = null;
  private input = new Float32Array(0);
  private output = new Float64Array(0);

  private constructor(
    private readonly exports: Exports,
    readonly sampleRate: number,
    readonly channels: number,
    /** Receives the records (an AnalysisDecoder: call its `begin()` once per rendered frame). */
    readonly decoder: S,
  ) {
    this.host = exports.sa_new(sampleRate, channels, CAPACITY);
  }

  /** A new analysis in its own module instance (the module is fetched and compiled by Vite's `?init`). */
  static async create(sampleRate: number, channels: number): Promise<WasmAnalysis>;
  static async create<S extends RecordSink>(sampleRate: number, channels: number, decoder: S): Promise<WasmAnalysis<S>>;
  static async create(sampleRate: number, channels: number, decoder: RecordSink = new AnalysisDecoder()): Promise<WasmAnalysis<RecordSink>> {
    const instance = await instantiate();
    const exports = instance.exports as unknown as Exports;
    // The module is versioned with the decoder: a stale binary would be read with the wrong layout.
    const version = exports.sa_version?.() ?? 1;
    if (version !== WIRE_VERSION) throw new Error(`spectrum_analysis.wasm speaks wire ${version}, the decoder ${WIRE_VERSION}: run \`npm run wasm\``);
    return new WasmAnalysis(exports, sampleRate, channels, decoder);
  }

  /**
   * The scenes' analysis: the user's reactivity and smoothing, and its cadence in hops (0 = about
   * 60 scene frames per second). Applies from the next scene frame.
   */
  setScene(sensitivity: number, smoothing: number, every = 0): void {
    this.exports.sa_scene(this.host, sensitivity, smoothing, every);
  }

  /** Analyses interleaved samples; their frames and events are added to the decoder. */
  push(samples: Float32Array, count = samples.length): void {
    const { exports, host, decoder } = this;
    for (let from = 0; from < count; from += CAPACITY) {
      const n = Math.min(CAPACITY, count - from);
      this.views();
      for (let i = 0; i < n; i++) this.input[i] = samples[from + i];
      const start = this.adaptive ? performance.now() : 0;
      const written = exports.sa_push(host, n);
      if (this.adaptive) exports.sa_quality(host, this.budget.update((performance.now() - start) / 1000, n / this.channels / this.sampleRate));
      // Pushing never allocates on the Rust side, but check anyway: growth detaches old views.
      this.views();
      decoder.decode(this.output, written);
    }
  }

  /** Largest number of f64 values one push of CAPACITY samples can produce. */
  get outputCapacity(): number {
    return this.exports.sa_output_capacity(this.host);
  }

  /** (Re)creates the memory views when the module's memory has grown; otherwise reuses them. */
  private views(): void {
    const { exports, host } = this;
    if (this.buffer === exports.memory.buffer) return;
    this.buffer = exports.memory.buffer;
    this.input = new Float32Array(this.buffer, exports.sa_input(host), CAPACITY);
    this.output = new Float64Array(this.buffer, exports.sa_output(host), exports.sa_output_capacity(host));
  }

  reset(): void {
    this.exports.sa_reset(this.host);
    this.decoder.reset?.();
  }

  dispose(): void {
    this.exports.sa_free(this.host);
  }
}
