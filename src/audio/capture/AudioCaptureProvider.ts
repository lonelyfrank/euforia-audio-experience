import type { AudioFrame, AudioSourceId } from '../../types/audio';
import type { AnalysisDecoder } from '../features/decode';
import type { RealtimeStats } from '../features/BrowserAnalysis';
import type { ClockSync } from '../../timing/ClockSync';

/**
 * A live source (system loopback, microphone, or the synthetic test signal
 * used in development) and its analysis. There are no file or pre-recorded
 * sources: everything is analysed as it is heard. The audio never reaches
 * the frame loop: it is analysed where it is captured (in Rust on the native
 * capture thread, or as WebAssembly in the browser analysis worker), and the
 * provider only keeps the records that come back until a frame reads them.
 *
 * The engine pulls once per frame (`readFeatures`, `readScene`), so providers
 * never push into the rest of the engine.
 */
export interface AudioCaptureProvider {
  readonly id: AudioSourceId;
  /** Sample rate of the capture clock (valid after start). */
  readonly sampleRate: number;
  /** Human readable name of the device/source actually in use. */
  readonly deviceName: string;

  start(): Promise<void>;
  stop(): Promise<void>;

  /**
   * Decodes into `decoder` the analysis records received and not decoded yet,
   * at most `maxFrames` hop frames of them (a backlog is worked off over the
   * following frames), and gives `clock` one observation per batch (its
   * arrival time and capture clock).
   */
  readFeatures?(decoder: AnalysisDecoder, clock: ClockSync, maxFrames?: number): void;

  /**
   * Writes into `frame` the scenes' graphic analysis nearest to `delay`
   * samples before the newest one (see SceneFeed). False while none has arrived.
   * Must not allocate.
   */
  readScene(frame: AudioFrame, delay: number, beatResponse: boolean): boolean;

  /**
   * The scenes' analysis runs with the user's reactivity and smoothing: tells
   * the producer (now if it is running, and at every start).
   */
  setScene(sensitivity: number, smoothing: number): void;

  /** Changes when the analysis restarted after losing audio (its capture clock starts over). */
  readonly epoch?: number;

  /** Where the DSP runs, what it costs and how its records travel (diagnostics). */
  readonly stats?: RealtimeStats | null;

  /** Registers a callback for asynchronous failures (device lost, ...). */
  onError(listener: (message: string) => void): void;
}
