import type { AudioSourceId } from '../../types/audio';

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
   * Browser sources only: copies the mono samples captured since the previous
   * call into `out` (oldest first) and returns how many; call again while it
   * fills `out`. They feed the WebAssembly analysis. Native sources omit it:
   * their analysis runs in Rust on the capture thread.
   */
  drain?(out: Float32Array): number;

  /** Registers a callback for asynchronous failures (device lost, ...). */
  onError(listener: (message: string) => void): void;
}
