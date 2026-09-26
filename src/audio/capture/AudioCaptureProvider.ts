import type { AudioSourceId } from '../../types/audio';

/**
 * A source of mono PCM samples. Providers know nothing about analysis or
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
   * Providers that play the audio themselves (files) ignore the delay.
   */
  readSamples(out: Float32Array, delay: number): void;

  /** Registers a callback for asynchronous failures (device lost, ...). */
  onError(listener: (message: string) => void): void;

  /** Position/duration in seconds for sources with a timeline (files); live sources omit it. */
  playback?(): Playback;
}

export interface Playback {
  position: number;
  duration: number;
}
