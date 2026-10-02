import { BaseCaptureProvider } from './BaseCaptureProvider';
import { SampleRingBuffer } from './SampleRingBuffer';

/** Seconds of samples kept (the analysis window plus the maximum audio delay, with margin). */
const RING_SECONDS = 2;

/**
 * Base for providers backed by the Web Audio graph (the browser microphone).
 * An AudioWorklet forwards every sample into a ring buffer, so the analysis
 * sees the whole signal and the audio delay works as with native capture.
 */
export abstract class WebAudioProvider extends BaseCaptureProvider {
  protected context: AudioContext | null = null;
  private tap: AudioWorkletNode | null = null;
  private mute: GainNode | null = null;
  private ring = new SampleRingBuffer(48000 * RING_SECONDS);

  /** Subclasses build their source node and connect it to `sink`. */
  protected abstract connectSource(context: AudioContext, sink: AudioNode): Promise<void>;
  protected abstract disconnectSource(): void;

  async start(): Promise<void> {
    await this.stop();
    const context = new AudioContext();
    this.context = context;
    this.sampleRate = context.sampleRate;
    this.ring = new SampleRingBuffer(Math.ceil(context.sampleRate * RING_SECONDS));
    try {
      await context.audioWorklet.addModule(new URL('./tap.worklet.js', import.meta.url));
      const tap = new AudioWorkletNode(context, 'halo-sample-tap', { numberOfInputs: 1, numberOfOutputs: 1 });
      tap.port.onmessage = (event: MessageEvent<Float32Array>) => this.ring.write(event.data);
      // Pulled through a silent gain so the graph keeps processing; nothing is heard.
      const mute = context.createGain();
      mute.gain.value = 0;
      tap.connect(mute).connect(context.destination);
      this.tap = tap;
      this.mute = mute;
      await this.connectSource(context, tap);
      await context.resume();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.disconnectSource();
    if (this.tap) this.tap.port.onmessage = null;
    this.tap?.disconnect();
    this.mute?.disconnect();
    this.tap = null;
    this.mute = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') await context.close();
  }

  readSamples(out: Float32Array, delay: number): void {
    this.ring.readLatest(out, delay);
  }

  drain(out: Float32Array): number {
    return this.ring.drain(out);
  }
}
