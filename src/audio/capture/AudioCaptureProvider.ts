import type { AudioSourceId } from '../../types/audio';
import type { AnalysisDecoder } from '../features/decode';
import type { RealtimeStats } from '../features/BrowserAnalysis';
import type { ClockSync } from '../../timing/ClockSync';

/**
 * A live source of mono PCM samples (system loopback, microphone, or the
 * synthetic test signal used in development). There are no file or
 * pre-recorded sources: everything is analysed as it is heard. Providers know nothing about analysis or
 * rendering: they only keep the most recent samples available for reading.
 *
 * The analyzer pulls data once per frame via `readSamples`, so providers never
 * push into the rest of the engine.
 */
export interface AudioCaptureProvider {
  readonly id: AudioSourceId;
  /** Sample rate of the data returned by `readSamples` (valid after start). */
  readonly sampleRate: number;
  /** Human readable name of the device/source actually in use. */
  readonly deviceName: string;

  start(): Promise<void>;
  stop(): Promise<void>;

  /**
   * Copies the most recent `out.length` mono samples into `out`
   * (oldest first), ending `delay` samples in the past. Must not allocate.
   */
  readSamples(out: Float32Array, delay: number): void;

  /**
   * Decodes the analysis records received since the previous call into
   * `decoder`, and gives `clock` one observation per batch (its arrival time
   * and capture clock). The analysis runs off the frame loop: in Rust on the
   * native capture thread, or as WebAssembly in the browser analysis worker.
   */
  readFeatures?(decoder: AnalysisDecoder, clock: ClockSync): void;

  /** Changes when the analysis restarted after losing audio (its capture clock starts over). */
  readonly epoch?: number;

  /** Browser sources: where the DSP runs and what it costs (debug). */
  readonly analysis?: { readonly stats: RealtimeStats } | null;

  /** Registers a callback for asynchronous failures (device lost, ...). */
  onError(listener: (message: string) => void): void;
}
