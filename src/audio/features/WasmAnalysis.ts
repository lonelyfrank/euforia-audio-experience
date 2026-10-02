import { AnalysisDecoder } from './decode';
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
}

/** Interleaved samples accepted per push (larger inputs are split). */
const CAPACITY = 16384;

/**
 * The Rust analysis compiled to WebAssembly, for sources that live in the
 * browser (synthetic signal, getUserMedia microphone). The desktop app runs
 * the same code natively on the capture thread instead.
 */
export class WasmAnalysis {
  private readonly host: number;
  private buffer: ArrayBuffer | null = null;
  private input = new Float32Array(0);
  private output = new Float64Array(0);

  private constructor(
    private readonly exports: Exports,
    readonly sampleRate: number,
    readonly channels: number,
    /** Receives the frames and events; call its `begin()` once per rendered frame. */
    readonly decoder: AnalysisDecoder,
  ) {
    this.host = exports.sa_new(sampleRate, channels, CAPACITY);
  }

  /** A new analysis in its own module instance (the module is fetched and compiled by Vite's `?init`). */
  static async create(sampleRate: number, channels: number, decoder = new AnalysisDecoder()): Promise<WasmAnalysis> {
    const instance = await instantiate();
    return new WasmAnalysis(instance.exports as unknown as Exports, sampleRate, channels, decoder);
  }

  /** Analyses interleaved samples; their frames and events are added to the decoder. */
  push(samples: Float32Array, count = samples.length): void {
    const { exports, host, decoder } = this;
    for (let from = 0; from < count; from += CAPACITY) {
      const n = Math.min(CAPACITY, count - from);
      this.views();
      for (let i = 0; i < n; i++) this.input[i] = samples[from + i];
      const written = exports.sa_push(host, n);
      // Pushing never allocates on the Rust side, but check anyway: growth detaches old views.
      this.views();
      decoder.decode(this.output, written);
    }
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
    this.decoder.reset();
  }

  dispose(): void {
    this.exports.sa_free(this.host);
  }
}
