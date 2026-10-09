import type { ClockSync } from '../../timing/ClockSync';
import type { AudioFrame } from '../../types/audio';
import { BrowserAnalysis, type RealtimeStats } from '../features/BrowserAnalysis';
import type { AnalysisDecoder } from '../features/decode';
import { BaseCaptureProvider } from './BaseCaptureProvider';

/**
 * Base for providers backed by the Web Audio graph (the browser microphone).
 * An AudioWorklet streams every stereo frame to the analysis worker (shared
 * ring or port), which analyses it for the music and for the scenes; only
 * its records come to this thread.
 */
export abstract class WebAudioProvider extends BaseCaptureProvider {
  protected context: AudioContext | null = null;
  private tap: AudioWorkletNode | null = null;
  private mute: GainNode | null = null;
  private scene = { sensitivity: 1, smoothing: 0.5 };
  analysis: BrowserAnalysis | null = null;

  /** Subclasses build their source node and connect it to `sink`. */
  protected abstract connectSource(context: AudioContext, sink: AudioNode): Promise<void>;
  protected abstract disconnectSource(): void;

  get epoch(): number {
    return this.analysis?.epoch ?? 0;
  }

  get stats(): RealtimeStats | null {
    return this.analysis?.stats ?? null;
  }

  async start(): Promise<void> {
    await this.stop();
    const context = new AudioContext();
    this.context = context;
    this.sampleRate = context.sampleRate;
    try {
      await context.audioWorklet.addModule(new URL('./tap.worklet.js', import.meta.url));
      const tap = new AudioWorkletNode(context, 'euforia-audio-experience-sample-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'max' });
      const analysis = await BrowserAnalysis.start(context.sampleRate, { kind: 'stream' }, this.scene);
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
