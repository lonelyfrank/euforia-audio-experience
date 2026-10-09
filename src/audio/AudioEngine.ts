import type { AudioFrame, AudioSourceId, CaptureStatus, MusicState } from '../types/audio';
import { AudioAnalyzer, FFT_SIZE, VOICE_WINDOW, type AnalyzerSettings } from './analysis/AudioAnalyzer';
import type { AudioCaptureProvider } from './capture/AudioCaptureProvider';
import { createCaptureProvider, type SourceOptions } from './capture/createCaptureProvider';
import { AnalysisDecoder } from './features/decode';
import type { RealtimeStats } from './features/BrowserAnalysis';
import { HOP } from './features/layout';
import { MusicInterpreter } from './interpretation/MusicInterpreter';
import { ClockSync } from '../timing/ClockSync';
import { ExperienceEngine } from '../experience/ExperienceEngine';
import { Timing } from '../timing/Timing';

/**
 * Hop frames a rendered frame decodes at most: this many times what arrives during one frame, and
 * never fewer than MIN_HOPS. After a stall the backlog is worked off over the next frames at this
 * pace instead of in one, so a late frame does not make the next one late too.
 */
const CATCH_UP = 4;
const MIN_HOPS = 12;

export interface AudioEngineState {
  source: AudioSourceId | null;
  status: CaptureStatus;
  deviceName: string;
  error: string | null;
}

/**
 * Glue between a capture provider and the analysis. Owns the active provider,
 * pulls its records once per frame and exposes the resulting AudioFrame and
 * the VisualResponseFrame derived from it. Knows nothing about visualizers.
 *
 * The analysis is spectrum-analysis (Rust): `features` is its musical side
 * (the latest hop frame on the capture clock, the onsets/beats decoded in
 * this rendered frame), `frame` its graphic side (levels, display spectrum,
 * waveform, voices: what the scenes draw). Neither runs on the frame loop:
 * native capture analyses on the capture thread, browser sources in the
 * analysis worker (BrowserAnalysis); every provider hands the records over
 * through `readFeatures` and `readScene`. No audio reaches this thread.
 *
 * `analyzer` is the TypeScript original of the graphic analysis: it owns the
 * AudioFrame the scenes hold, fades it out while no source is delivering,
 * and is the reference the Rust port is tested against.
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
  /** Silence for the analyzer while no source is delivering: the voice window and its newest FFT_SIZE samples. */
  private readonly silence = new Float32Array(VOICE_WINDOW);
  private readonly silenceWindow = this.silence.subarray(VOICE_WINDOW - FFT_SIZE);
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

  /** Where the DSP runs, what it costs and how its records travel (null while no source runs). Diagnostics. */
  get realtimeStats(): RealtimeStats | null {
    return this.provider?.stats ?? null;
  }

  /** Capture sample rate, unavailable until the source is running. */
  get captureSampleRate(): number | null { return this._state.status === 'running' ? this.provider?.sampleRate ?? null : null; }

  get visual(): MusicState {
    return this.response.frame;
  }


  configure(settings: Partial<AnalyzerSettings>): void {
    Object.assign(this.analyzer.settings, settings);
    this.provider?.setScene(this.analyzer.settings.sensitivity, this.analyzer.settings.smoothing);
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
      provider.setScene(this.analyzer.settings.sensitivity, this.analyzer.settings.smoothing);
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
    // Settings may have changed while it was starting.
    provider.setScene(this.analyzer.settings.sensitivity, this.analyzer.settings.smoothing);
    this.analyzer.reset();
    this.response.reset();
    this.frameInterval = 1 / 60;
    if (this._state.status !== 'error') {
      this.setState({ source, status: 'running', deviceName: provider.deviceName, error: null });
    }
  }

  /**
   * Pulls the analysis and derives the visual response. Call once per rendered frame: `now` is that
   * frame's requestAnimationFrame time (s, the clock of `performance.now()`), the instant the picture
   * is timed from; a time read later in the callback would carry how long the callback waited.
   */
  update(dt: number, now = performance.now() / 1000): AudioFrame {
    this.features.begin();
    const provider = this.provider;
    const sampleRate = provider?.sampleRate ?? 48000;
    if (provider && (provider.epoch ?? 0) !== this.epoch) {
      // The provider's analysis restarted after losing audio: its capture clock starts over.
      this.epoch = provider.epoch ?? 0;
      this.restartAnalysis();
    }
    this.frameInterval += (Math.min(dt, 0.1) - this.frameInterval) * 0.05;
    const arriving = (sampleRate / HOP) * this.frameInterval;
    provider?.readFeatures?.(this.features, this.clock, Math.max(MIN_HOPS, Math.ceil(arriving * CATCH_UP)));
    const { onsets } = this.features;
    this.timing.update(now, this.frameInterval, this.features.frame, onsets.items, onsets.count, this.clock, dt);
    const frame = this.analyzer.frame;
    if (provider?.readScene(frame, Math.round(this.delay * sampleRate), this.analyzer.settings.beatResponse)) {
      frame.time += dt;
      frame.sampleRate = sampleRate;
    } else {
      // No source, or none delivering yet: the picture falls silent through the same smoothing it rose with.
      this.analyzer.analyze(this.silenceWindow, sampleRate, dt, this.silence);
    }
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
