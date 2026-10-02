import type { AudioFrame, AudioSourceId, CaptureStatus, MusicState } from '../types/audio';
import { AudioAnalyzer, FFT_SIZE, VOICE_WINDOW, type AnalyzerSettings } from './analysis/AudioAnalyzer';
import type { AudioCaptureProvider, Playback } from './capture/AudioCaptureProvider';
import { createCaptureProvider, type SourceOptions } from './capture/createCaptureProvider';
import { MusicInterpreter } from './interpretation/MusicInterpreter';

export interface AudioEngineState {
  source: AudioSourceId | null;
  status: CaptureStatus;
  deviceName: string;
  error: string | null;
}

/**
 * Glue between a capture provider and the analyzer. Owns the active provider,
 * pulls samples once per frame and exposes the resulting AudioFrame and the
 * VisualResponseFrame derived from it. Knows nothing about visualizers.
 */
export class AudioEngine {
  readonly analyzer = new AudioAnalyzer();
  readonly response = new MusicInterpreter();
  private provider: AudioCaptureProvider | null = null;
  /** Latest samples: the voice window, whose newest FFT_SIZE samples (a fixed view) feed the FFT. */
  private readonly samples = new Float32Array(VOICE_WINDOW);
  private readonly fftSamples = this.samples.subarray(VOICE_WINDOW - FFT_SIZE);
  private readonly listeners = new Set<(state: AudioEngineState) => void>();
  private switchToken = 0;
  /** Seconds the analysis lags the capture, to line up with output latency (e.g. Bluetooth). */
  private delay = 0;
  private _state: AudioEngineState = { source: null, status: 'idle', deviceName: '', error: null };

  get state(): AudioEngineState {
    return this._state;
  }

  get frame(): AudioFrame {
    return this.analyzer.frame;
  }

  get visual(): MusicState {
    return this.response.frame;
  }

  /** Timeline of the active source, or null for live input. */
  get playback(): Playback | null {
    return this.provider?.playback?.() ?? null;
  }

  configure(settings: Partial<AnalyzerSettings>): void {
    Object.assign(this.analyzer.settings, settings);
  }

  setDelay(seconds: number): void {
    this.delay = Math.max(seconds, 0);
  }

  subscribe(listener: (state: AudioEngineState) => void): () => void {
    this.listeners.add(listener);
    listener(this._state);
    return () => this.listeners.delete(listener);
  }

  /** Stops the current provider and starts a new one. Last call wins. */
  async setSource(source: AudioSourceId, options?: SourceOptions): Promise<void> {
    const token = ++this.switchToken;
    await this.releaseProvider();
    this.setState({ source, status: 'starting', deviceName: '', error: null });
    let provider: AudioCaptureProvider | null = null;
    try {
      provider = createCaptureProvider(source, options);
      provider.onError((message) => {
        if (this.provider === provider) this.setState({ ...this._state, status: 'error', error: message });
      });
      await provider.start();
    } catch (error) {
      await provider?.stop().catch(() => undefined);
      if (token === this.switchToken) this.setState({ source, status: 'error', deviceName: '', error: errorMessage(error) });
      return;
    }
    if (token !== this.switchToken) {
      // A newer setSource() superseded this one while starting.
      await provider.stop();
      return;
    }
    this.provider = provider;
    this.analyzer.reset();
    this.response.reset();
    this.setState({ source, status: 'running', deviceName: provider.deviceName, error: null });
  }

  /** Pull + analyse + derive the visual response. Call once per rendered frame. */
  update(dt: number): AudioFrame {
    if (this.provider) this.provider.readSamples(this.samples, Math.round(this.delay * this.provider.sampleRate));
    else this.samples.fill(0);
    const frame = this.analyzer.analyze(this.fftSamples, this.provider?.sampleRate ?? 48000, dt, this.samples);
    this.response.update(frame, dt);
    return frame;
  }

  private async releaseProvider(): Promise<void> {
    const provider = this.provider;
    this.provider = null;
    if (provider) await provider.stop().catch(() => undefined);
  }

  private setState(state: AudioEngineState): void {
    this._state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown audio error';
}
