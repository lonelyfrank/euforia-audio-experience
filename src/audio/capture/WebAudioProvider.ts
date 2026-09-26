import { BaseCaptureProvider } from './BaseCaptureProvider';

/** Window kept by the AnalyserNode; must be >= the analyzer FFT size. */
const TAP_SIZE = 8192;

/**
 * Base for providers backed by the Web Audio graph (audio files, browser
 * microphone). Samples are tapped with an AnalyserNode, which always holds
 * the most recent time-domain window.
 */
export abstract class WebAudioProvider extends BaseCaptureProvider {
  protected context: AudioContext | null = null;
  protected analyser: AnalyserNode | null = null;
  private readonly tap = new Float32Array(TAP_SIZE);

  /** Subclasses build their source node and connect it to `analyser`. */
  protected abstract connectSource(context: AudioContext, analyser: AnalyserNode): Promise<void>;
  protected abstract disconnectSource(): void;

  async start(): Promise<void> {
    await this.stop();
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = TAP_SIZE;
    this.context = context;
    this.analyser = analyser;
    this.sampleRate = context.sampleRate;
    try {
      await this.connectSource(context, analyser);
      await context.resume();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.disconnectSource();
    this.analyser?.disconnect();
    this.analyser = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') await context.close();
  }

  /** No delay support: the analyser only holds the newest window (files play in sync anyway). */
  readSamples(out: Float32Array): void {
    if (!this.analyser) {
      out.fill(0);
      return;
    }
    this.analyser.getFloatTimeDomainData(this.tap);
    const n = Math.min(out.length, TAP_SIZE);
    out.set(this.tap.subarray(TAP_SIZE - n));
    out.fill(0, n);
  }
}
