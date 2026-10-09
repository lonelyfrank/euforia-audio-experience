import type { AudioFrame, AudioSourceId, CaptureStatus, MusicState } from '../types/audio';
import { AudioAnalyzer, FFT_SIZE, VOICE_WINDOW, type AnalyzerSettings } from './analysis/AudioAnalyzer';
import type { AudioCaptureProvider } from './capture/AudioCaptureProvider';
import { createCaptureProvider, type SourceOptions } from './capture/createCaptureProvider';
import { AnalysisDecoder } from './features/decode';
import type { RealtimeStats } from './features/BrowserAnalysis';
import { MusicInterpreter } from './interpretation/MusicInterpreter';
import { ClockSync } from '../timing/ClockSync';
import { ExperienceEngine } from '../experience/ExperienceEngine';
import { Timing } from '../timing/Timing';

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
 * It never runs on the frame loop: native capture runs it on the capture
 * thread, browser sources in the analysis worker (BrowserAnalysis). Every
 * provider hands its records over through `readFeatures`. The TypeScript
 * AudioAnalyzer still feeds the scenes' graphics.
 */
export class AudioEngine {
  readonly analyzer = new AudioAnalyzer();
  readonly response = new MusicInterpreter();
  readonly features = new AnalysisDecoder();
  readonly experience = new ExperienceEngine();

  constructor() {
    const { features, experience } = this;
    features.onFrame = (frame) => experience.ingest(frame);
    features.onOnset = (onset) => experience.onset(onset);
    features.onBeat = (beat) => experience.beat(beat);
    features.onSection = (section) => experience.section(section);
  }
  /** Capture clock → host clock, and what to show in the frame being rendered (beat cues, attacks, grid weight). */
  readonly clock = new ClockSync();
  readonly timing = new Timing();
  private frameInterval = 1 / 60;
  private epoch = 0;
  private provider: AudioCaptureProvider | null = null;
  /** Latest samples: the voice window, whose newest FFT_SIZE samples (a fixed view) feed the FFT. */
  private readonly samples = new Float32Array(VOICE_WINDOW);
  private readonly fftSamples = this.samples.subarray(VOICE_WINDOW - FFT_SIZE);
  private readonly listeners = new Set<(state: AudioEngineState) => void>();
  private switchToken = 0;
  /** Native providers share one backend capture: starts/stops must never overlap. */
  private sourceQueue: Promise<void> = Promise.resolve();
  /** Changes whenever the analysis starts over, even after a very short session. */
  session = 0;
  /** Seconds the analysis lags the capture, to line up with output latency (e.g. Bluetooth). */
  private delay = 0;
  private _state: AudioEngineState = { source: null, status: 'idle', deviceName: '', error: null };

  get state(): AudioEngineState {
    return this._state;
  }

  get frame(): AudioFrame {
    return this.analyzer.frame;
  }

  /** Browser sources: where the DSP runs and what it costs (null for native capture). Debug. */
  get realtimeStats(): RealtimeStats | null {
    return this.provider?.analysis?.stats ?? null;
  }

  /** Capture sample rate, unavailable until the source is running. */
  get captureSampleRate(): number | null { return this._state.status === 'running' ? this.provider?.sampleRate ?? null : null; }

  get visual(): MusicState {
    return this.response.frame;
  }


  configure(settings: Partial<AnalyzerSettings>): void {
    Object.assign(this.analyzer.settings, settings);
  }

  /**
   * Output latency after the capture point (s): cues are timed to it, and the
   * scenes' analysis is delayed by it. Negative values (a display slower than
   * estimated) pull the cues earlier; the analysis cannot run early.
   */
  setDelay(seconds: number): void {
    this.delay = Math.max(seconds, 0);
    this.timing.latency.output = seconds;
  }

  subscribe(listener: (state: AudioEngineState) => void): () => void {
    this.listeners.add(listener);
    listener(this._state);
    return () => this.listeners.delete(listener);
  }

  /** Stops the current provider and starts a new one. Last call wins. */
  setSource(source: AudioSourceId, options?: SourceOptions): Promise<void> {
    const token = ++this.switchToken;
    this.setState({ source, status: 'starting', deviceName: '', error: null });
    this.sourceQueue = this.sourceQueue.then(() => this.switchSource(token, source, options));
    return this.sourceQueue;
  }

  /** Releases capture and WASM, including an in-flight source change. */
  stop(): Promise<void> {
    ++this.switchToken;
    this.sourceQueue = this.sourceQueue.then(async () => {
      await this.releaseProvider();
      this.clock.reset();
      this.setState({ source: null, status: 'idle', deviceName: '', error: null });
    });
    return this.sourceQueue;
  }

  private async switchSource(token: number, source: AudioSourceId, options?: SourceOptions): Promise<void> {
    if (token !== this.switchToken) return;
    await this.releaseProvider();
    if (token !== this.switchToken) return;
    let provider: AudioCaptureProvider | null = null;
    try {
      provider = createCaptureProvider(source, options);
      provider.onError((message) => {
        if (token === this.switchToken && this.provider === provider) this.setState({ ...this._state, status: 'error', error: message });
      });
      await provider.start();
    } catch (error) {
      await provider?.stop().catch(() => undefined);
      if (token === this.switchToken) this.setState({ source, status: 'error', deviceName: '', error: errorMessage(error) });
      return;
    }
    if (token !== this.switchToken) {
      // A newer setSource() superseded this one while starting.
      await provider.stop().catch(() => undefined);
      return;
    }
    this.provider = provider;
    this.epoch = provider.epoch ?? 0;
    this.analyzer.reset();
    this.response.reset();
    this.frameInterval = 1 / 60;
    if (this._state.status !== 'error') {
      this.setState({ source, status: 'running', deviceName: provider.deviceName, error: null });
    }
  }

  /** Pull + analyse + derive the visual response. Call once per rendered frame. */
  update(dt: number): AudioFrame {
    this.features.begin();
    if (this.provider) this.provider.readSamples(this.samples, Math.round(this.delay * this.provider.sampleRate));
    else this.samples.fill(0);
    if (this.provider && (this.provider.epoch ?? 0) !== this.epoch) {
      // The provider's analysis restarted after losing audio: its capture clock starts over.
      this.epoch = this.provider.epoch ?? 0;
      this.restartAnalysis();
    }
    this.provider?.readFeatures?.(this.features, this.clock);
    this.frameInterval += (Math.min(dt, 0.1) - this.frameInterval) * 0.05;
    const { onsets } = this.features;
    this.timing.update(performance.now() / 1000, this.frameInterval, this.features.frame, onsets.items, onsets.count, this.clock, dt);
    const frame = this.analyzer.analyze(this.fftSamples, this.provider?.sampleRate ?? 48000, dt, this.samples);
    this.response.update(frame, dt);
    return frame;
  }

  private async releaseProvider(): Promise<void> {
    const provider = this.provider;
    this.provider = null;
    this.restartAnalysis();
    if (provider) await provider.stop().catch(() => undefined);
  }

  /** Session reset of everything that lives on the capture clock. */
  private restartAnalysis(): void {
    this.features.reset();
    this.experience.reset();
    this.clock.reset();
    this.timing.reset();
    this.session++;
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
