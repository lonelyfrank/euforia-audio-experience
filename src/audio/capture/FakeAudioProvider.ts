import type { ClockSync } from '../../timing/ClockSync';
import { BrowserAnalysis } from '../features/BrowserAnalysis';
import type { AnalysisDecoder } from '../features/decode';
import { BaseCaptureProvider } from './BaseCaptureProvider';
import { SampleRingBuffer } from './SampleRingBuffer';
import { DEFAULT_TEST_SIGNAL, TEST_SIGNALS, type TestSignal } from './testSignals';

const SAMPLE_RATE = 48000;

/**
 * Synthetic source: a deterministic test signal (by default a 124 BPM beat
 * with kick, bass, pad and hi-hats; see testSignals.ts for the others). It is
 * generated where it is analysed (the analysis worker, on its own clock, as a
 * device would deliver it) and its mono mix comes back for the scenes, so the
 * whole pipeline is exercised without any audio device.
 */
export class FakeAudioProvider extends BaseCaptureProvider {
  private readonly ring = new SampleRingBuffer(SAMPLE_RATE);
  analysis: BrowserAnalysis | null = null;

  constructor(private readonly signal: TestSignal = DEFAULT_TEST_SIGNAL) {
    super('fake');
    this.sampleRate = SAMPLE_RATE;
    this.deviceName = TEST_SIGNALS.find((s) => s.id === signal)?.label ?? 'Test signal';
  }

  get epoch(): number {
    return this.analysis?.epoch ?? 0;
  }

  async start(): Promise<void> {
    await this.stop();
    this.ring.clear();
    this.analysis = await BrowserAnalysis.start(SAMPLE_RATE, { kind: 'generator', signal: this.signal }, (mono, frames) => this.ring.write(mono, 0, frames));
  }

  async stop(): Promise<void> {
    this.analysis?.dispose();
    this.analysis = null;
  }

  readSamples(out: Float32Array, delay: number): void {
    // Without a worker the generator runs here, before the scenes read its output.
    this.analysis?.poll();
    this.ring.readLatest(out, delay);
  }

  readFeatures(decoder: AnalysisDecoder, clock: ClockSync): void {
    this.analysis?.read(decoder, clock);
  }
}
