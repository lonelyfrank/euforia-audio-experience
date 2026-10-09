import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ClockSync } from '../../timing/ClockSync';
import type { AudioFrame } from '../../types/audio';
import type { RealtimeStats } from '../features/BrowserAnalysis';
import type { AnalysisDecoder } from '../features/decode';
import { WIRE_VERSION } from '../features/layout';
import { RecordStage } from '../features/RecordStage';
import { BaseCaptureProvider } from './BaseCaptureProvider';

export type NativeSource = 'system' | 'microphone';

interface CaptureInfo {
  sampleRate: number;
  channels: number;
  deviceName: string;
  wireVersion?: number;
}

/**
 * Receives the analysis from the Rust capture backend:
 * - `system`: WASAPI loopback of the output device on Windows, the output's monitor on Linux;
 * - `microphone`: the default input device.
 *
 * One Tauri channel carries the records of spectrum-analysis, which runs on
 * the capture thread: the musical analysis (every hop) and the scenes' graphic
 * one, about one message per scene frame. They wait in a stage until a frame
 * decodes them; no PCM crosses the boundary.
 */
export class NativeAudioCapture extends BaseCaptureProvider {
  private readonly stage = new RecordStage(48000);
  private unlistenError: UnlistenFn | null = null;
  private session = 0;
  private running = false;
  private scene = { sensitivity: 1, smoothing: 0.5 };
  readonly stats: RealtimeStats = { mode: 'native', load: 0, quality: 0, backlog: 0, dspAge: 0, transfer: 0, pending: 0, dropped: 0, lost: 0, filled: 0, batches: 0, missed: 0 };

  constructor(private readonly source: NativeSource) {
    super(source);
  }

  get epoch(): number {
    return this.stage.epoch;
  }

  async start(): Promise<void> {
    await this.stop();
    this.stage.clear();
    const session = ++this.session;
    const features = new Channel<ArrayBuffer | number[]>();
    features.onmessage = (message) => {
      // Ignore late batches from a previous session.
      if (session !== this.session || !(message instanceof ArrayBuffer)) return;
      const batch = new Float64Array(message);
      this.stage.stage(batch, batch.length, performance.now() / 1000);
    };
    this.unlistenError = await listen<string>('audio-capture-error', (event) => this.emitError(event.payload));
    const info = await invoke<CaptureInfo>('start_audio_capture', { source: this.source, scene: this.scene, onFeatures: features });
    // The backend is versioned with the decoder: a stale binary would be read with the wrong layout.
    if ((info.wireVersion ?? 1) !== WIRE_VERSION) {
      await this.stop();
      throw new Error(`The desktop backend speaks wire ${info.wireVersion ?? 1}, the frontend ${WIRE_VERSION}: rebuild the app.`);
    }
    this.sampleRate = info.sampleRate;
    this.deviceName = info.deviceName;
    this.stage.resize(info.sampleRate);
    this.running = true;
  }

  async stop(): Promise<void> {
    this.session++;
    this.running = false;
    this.unlistenError?.();
    this.unlistenError = null;
    await invoke('stop_audio_capture');
  }

  readFeatures(decoder: AnalysisDecoder, clock: ClockSync, maxFrames?: number): void {
    const stage = this.stage;
    stage.drain(decoder, clock, this.sampleRate, maxFrames);
    const s = this.stats, t = stage.stats;
    s.load = t.load; s.quality = t.quality; s.dspAge = t.age; s.lost = t.lost;
    s.pending = t.pending; s.dropped = t.dropped; s.batches = t.batches; s.missed = t.missed;
  }

  readScene(frame: AudioFrame, delay: number, beatResponse: boolean): boolean {
    return this.stage.scenes.read(frame, delay, beatResponse);
  }

  setScene(sensitivity: number, smoothing: number): void {
    this.scene = { sensitivity, smoothing };
    if (this.running) void invoke('set_scene_settings', { scene: this.scene }).catch(() => undefined);
  }
}
