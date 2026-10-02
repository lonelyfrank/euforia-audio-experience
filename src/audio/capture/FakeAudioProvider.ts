import { BaseCaptureProvider } from './BaseCaptureProvider';
import { SampleRingBuffer } from './SampleRingBuffer';
import { DEFAULT_TEST_SIGNAL, SignalGenerator, TEST_SIGNALS, type TestSignal } from './testSignals';

const SAMPLE_RATE = 48000;
/** Never synthesize more than this per read (e.g. after the tab was hidden). */
const MAX_CATCH_UP = 0.25;

/**
 * Synthetic source: a deterministic test signal (by default a 124 BPM beat
 * with kick, bass, pad and hi-hats; see testSignals.ts for the others). It
 * produces real PCM so the whole analysis pipeline is exercised without any
 * audio device.
 */
export class FakeAudioProvider extends BaseCaptureProvider {
  private readonly ring = new SampleRingBuffer(SAMPLE_RATE);
  private readonly chunk = new Float32Array(Math.ceil(SAMPLE_RATE * MAX_CATCH_UP));
  private generator: SignalGenerator;
  private lastRead = 0;
  private running = false;

  constructor(private readonly signal: TestSignal = DEFAULT_TEST_SIGNAL) {
    super('fake');
    this.sampleRate = SAMPLE_RATE;
    this.deviceName = TEST_SIGNALS.find((s) => s.id === signal)?.label ?? 'Test signal';
    this.generator = new SignalGenerator(signal, SAMPLE_RATE);
  }

  async start(): Promise<void> {
    this.ring.clear();
    this.generator = new SignalGenerator(this.signal, SAMPLE_RATE);
    this.lastRead = performance.now();
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  readSamples(out: Float32Array, delay: number): void {
    if (this.running) {
      const now = performance.now();
      const elapsed = Math.min((now - this.lastRead) / 1000, MAX_CATCH_UP);
      this.lastRead = now;
      const count = Math.floor(elapsed * SAMPLE_RATE);
      this.generator.fill(this.chunk, 0, count);
      this.ring.write(this.chunk, 0, count);
    }
    this.ring.readLatest(out, delay);
  }

  /** Samples are generated in readSamples (once per frame), then drained. */
  drain(out: Float32Array): number {
    return this.ring.drain(out);
  }
}
