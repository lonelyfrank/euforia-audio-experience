import type { AudioFrame, AudioSourceId, CaptureStatus, MusicState } from '../types/audio';
import { AudioAnalyzer, FFT_SIZE, VOICE_WINDOW, type AnalyzerSettings } from './analysis/AudioAnalyzer';
import type { AudioCaptureProvider } from './capture/AudioCaptureProvider';
import { createCaptureProvider, type SourceOptions } from './capture/createCaptureProvider';
import { AnalysisDecoder } from './features/decode';
import { WasmAnalysis } from './features/WasmAnalysis';
import { MusicInterpreter } from './interpretation/MusicInterpreter';
import { ClockSync } from '../timing/ClockSync';
import { Timing } from '../timing/Timing';

/** Mono samples drained per step into the WebAssembly analysis. */
const DRAIN_CHUNK = 4096;

export interface AudioEngineState {
  source: AudioSourceId | null;
  status: CaptureStatus;
  deviceName: string;
  error: string | null;
}

/**
 * Glue between a capture provider and the analysis. Owns the active provider,
 * pulls samples once per frame and exposes the resulting AudioFrame and the
 * VisualResponseFrame derived from it. Knows nothing about visualizers.
 *
 * `features` is the Rust analysis (spectrum-analysis): the latest frame on
 * the capture clock and the onsets/beats since the previous rendered frame.
 * Browser sources run it as WebAssembly here; native capture runs it on the
 * capture thread. The TypeScript AudioAnalyzer still feeds the scenes.
 */
export class AudioEngine {
  readonly analyzer = new AudioAnalyzer();
  readonly response = new MusicInterpreter();
  readonly features = new AnalysisDecoder();
  /** Capture clock → host clock, and what to show in the frame being rendered (beat cues, attacks, grid weight). */
  readonly clock = new ClockSync();
  readonly timing = new Timing();
  private frameInterval = 1 / 60;
  private wasm: WasmAnalysis | null = null;
  private readonly drained = new Float32Array(DRAIN_CHUNK);
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


  configure(settings: Partial<AnalyzerSettings>): void {
    Object.assign(this.analyzer.settings, settings);
  }

  /** Output latency after the capture point (s): the scenes' analysis is delayed by it and cues are timed to it. */
  setDelay(seconds: number): void {
    this.delay = Math.max(seconds, 0);
    this.timing.latency.output = this.delay;
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
    this.features.reset();
    this.clock.reset();
    this.timing.reset();
    await this.startFeatures(provider, token);
    this.setState({ source, status: 'running', deviceName: provider.deviceName, error: null });
  }

  /** Pull + analyse + derive the visual response. Call once per rendered frame. */
  update(dt: number): AudioFrame {
    this.features.begin();
    if (this.provider) this.provider.readSamples(this.samples, Math.round(this.delay * this.provider.sampleRate));
    else this.samples.fill(0);
    this.provider?.readFeatures?.(this.features, this.clock);
    if (this.provider?.drain && this.wasm) {
      let n: number;
      let pushed = false;
      do {
        n = this.provider.drain(this.drained);
        if (n > 0) {
          this.wasm.push(this.drained, n);
          pushed = true;
        }
      } while (n === this.drained.length);
      // The newest sample was captured at most now (browser sources hand samples over as they come).
      if (pushed) this.clock.observe(performance.now() / 1000, this.features.frame.time);
    }
    this.frameInterval += (Math.min(dt, 0.1) - this.frameInterval) * 0.05;
    const { onsets } = this.features;
    this.timing.update(performance.now() / 1000, this.frameInterval, this.features.frame, onsets.items, onsets.count, this.clock, dt);
    const frame = this.analyzer.analyze(this.fftSamples, this.provider?.sampleRate ?? 48000, dt, this.samples);
    this.response.update(frame, dt);
    return frame;
  }

  /** Browser sources: a WebAssembly analysis at the provider's rate (once the module is compiled). */
  private async startFeatures(provider: AudioCaptureProvider, token: number): Promise<void> {
    if (!provider.drain) return;
    try {
      const analysis = await WasmAnalysis.create(provider.sampleRate, 1, this.features);
      if (token !== this.switchToken) {
        analysis.dispose();
        return;
      }
      this.wasm = analysis;
    } catch (error) {
      // The scenes don't depend on it yet: keep running without the extended analysis.
      console.warn('Analysis module unavailable:', error);
    }
  }

  private async releaseProvider(): Promise<void> {
    this.wasm?.dispose();
    this.wasm = null;
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
