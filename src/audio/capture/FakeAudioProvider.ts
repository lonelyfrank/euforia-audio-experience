import type { ClockSync } from '../../timing/ClockSync';
import type { AudioFrame } from '../../types/audio';
import { BrowserAnalysis, type RealtimeStats } from '../features/BrowserAnalysis';
import type { AnalysisDecoder } from '../features/decode';
import { BaseCaptureProvider } from './BaseCaptureProvider';
import { DEFAULT_TEST_SIGNAL, TEST_SIGNALS, type TestSignal } from './testSignals';

const SAMPLE_RATE = 48000;

/**
 * Synthetic source: a deterministic test signal (by default a 124 BPM beat
 * with kick, bass, pad and hi-hats; see testSignals.ts for the others). It is
 * generated where it is analysed (the analysis worker, on its own clock, as a
 * device would deliver it), so the whole pipeline is exercised without any
 * audio device.
 */
export class FakeAudioProvider extends BaseCaptureProvider {
  analysis: BrowserAnalysis | null = null;
  private scene = { sensitivity: 1, smoothing: 0.5 };

  constructor(private readonly signal: TestSignal = DEFAULT_TEST_SIGNAL) {
    super('fake');
    this.sampleRate = SAMPLE_RATE;
    this.deviceName = TEST_SIGNALS.find((s) => s.id === signal)?.label ?? 'Test signal';
  }

  get epoch(): number {
    return this.analysis?.epoch ?? 0;
  }

  get stats(): RealtimeStats | null {
    return this.analysis?.stats ?? null;
  }

  async start(): Promise<void> {
    await this.stop();
    this.analysis = await BrowserAnalysis.start(SAMPLE_RATE, { kind: 'generator', signal: this.signal }, this.scene);
  }

  async stop(): Promise<void> {
    this.analysis?.dispose();
    this.analysis = null;
  }

  /** Without a worker the generator runs here (`read` pumps it), before the scenes read its analysis. */
  readFeatures(decoder: AnalysisDecoder, clock: ClockSync, maxFrames?: number): void {
    this.analysis?.read(decoder, clock, maxFrames);
  }

  readScene(frame: AudioFrame, delay: number, beatResponse: boolean): boolean {
    return this.analysis?.readScene(frame, delay, beatResponse) ?? false;
  }

  setScene(sensitivity: number, smoothing: number): void {
    this.scene = { sensitivity, smoothing };
    this.analysis?.setScene(this.scene);
  }
}
