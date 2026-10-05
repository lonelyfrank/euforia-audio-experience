import type { ClockSync } from '../../timing/ClockSync';
import { BrowserAnalysis } from '../features/BrowserAnalysis';
import type { AnalysisDecoder } from '../features/decode';
import { BaseCaptureProvider } from './BaseCaptureProvider';
import { SampleRingBuffer } from './SampleRingBuffer';

/** Seconds of samples kept (the analysis window plus the maximum audio delay, with margin). */
const RING_SECONDS = 2;

/**
 * Base for providers backed by the Web Audio graph (the browser microphone).
 * An AudioWorklet streams every stereo frame to the analysis worker (shared
 * ring or port) and posts blocks to this thread, where their mono mix fills a
 * ring buffer for the scenes, so the audio delay works as with native capture.
 */
export abstract class WebAudioProvider extends BaseCaptureProvider {
  protected context: AudioContext | null = null;
  private readonly mono = new Float32Array(1024);
  private tap: AudioWorkletNode | null = null;
  private mute: GainNode | null = null;
  private ring = new SampleRingBuffer(48000 * RING_SECONDS);
  analysis: BrowserAnalysis | null = null;

  /** Subclasses build their source node and connect it to `sink`. */
  protected abstract connectSource(context: AudioContext, sink: AudioNode): Promise<void>;
  protected abstract disconnectSource(): void;

  get epoch(): number {
    return this.analysis?.epoch ?? 0;
  }

  async start(): Promise<void> {
    await this.stop();
    const context = new AudioContext();
    this.context = context;
    this.sampleRate = context.sampleRate;
    this.ring = new SampleRingBuffer(Math.ceil(context.sampleRate * RING_SECONDS));
    try {
      await context.audioWorklet.addModule(new URL('./tap.worklet.js', import.meta.url));
      const tap = new AudioWorkletNode(context, 'halo-sample-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'max' });
      tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const pcm = event.data;
        for (let i = 0; i < pcm.length / 2; i++) this.mono[i] = (pcm[i * 2] + pcm[i * 2 + 1]) * 0.5;
        this.ring.write(this.mono, 0, pcm.length / 2);
      };
      const analysis = await BrowserAnalysis.start(context.sampleRate, { kind: 'stream' });
      this.analysis = analysis;
      const { ring, port } = analysis.link;
      tap.port.postMessage({ type: 'analysis', ring, port }, port ? [port] : []);
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
    this.analysis?.dispose();
    this.analysis = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') await context.close();
  }

  readSamples(out: Float32Array, delay: number): void {
    this.ring.readLatest(out, delay);
  }

  readFeatures(decoder: AnalysisDecoder, clock: ClockSync): void {
    this.analysis?.read(decoder, clock);
  }
}
