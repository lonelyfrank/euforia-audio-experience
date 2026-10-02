import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AnalysisDecoder } from '../features/decode';
import { BaseCaptureProvider } from './BaseCaptureProvider';
import { SampleRingBuffer } from './SampleRingBuffer';

export type NativeSource = 'system' | 'microphone';

interface CaptureInfo {
  sampleRate: number;
  channels: number;
  deviceName: string;
}

/** f64 values of analysis records buffered between two frames (a stall beyond it drops the oldest batch). */
const FEATURE_BUFFER = 1 << 16;

/**
 * Receives PCM and the analysis from the Rust capture backend:
 * - `system`: WASAPI loopback of the output device on Windows, the output's monitor on Linux;
 * - `microphone`: the default input device.
 *
 * Two Tauri channels: mono little-endian f32 PCM (accumulated in a ring
 * buffer for the scenes' TypeScript analyzer) and the event records of
 * spectrum-analysis, which runs on the capture thread (decoded once per frame).
 */
export class NativeAudioCapture extends BaseCaptureProvider {
  private readonly ring = new SampleRingBuffer(48000);
  private readonly records = new Float64Array(FEATURE_BUFFER);
  private recordCount = 0;
  private unlistenError: UnlistenFn | null = null;
  private session = 0;

  constructor(private readonly source: NativeSource) {
    super(source);
  }

  async start(): Promise<void> {
    await this.stop();
    this.ring.clear();
    this.recordCount = 0;
    const session = ++this.session;
    const channel = new Channel<ArrayBuffer | number[]>();
    channel.onmessage = (message) => {
      // Ignore late chunks from a previous session.
      if (session !== this.session) return;
      if (message instanceof ArrayBuffer) this.ring.write(new Float32Array(message));
      else this.ring.write(message);
    };
    const features = new Channel<ArrayBuffer | number[]>();
    features.onmessage = (message) => {
      if (session !== this.session || !(message instanceof ArrayBuffer)) return;
      this.stage(new Float64Array(message));
    };
    this.unlistenError = await listen<string>('audio-capture-error', (event) => this.emitError(event.payload));
    const info = await invoke<CaptureInfo>('start_audio_capture', {
      source: this.source,
      onSamples: channel,
      onFeatures: features,
    });
    this.sampleRate = info.sampleRate;
    this.deviceName = info.deviceName;
  }

  async stop(): Promise<void> {
    this.session++;
    this.unlistenError?.();
    this.unlistenError = null;
    await invoke('stop_audio_capture');
  }

  readSamples(out: Float32Array, delay: number): void {
    this.ring.readLatest(out, delay);
  }

  readFeatures(decoder: AnalysisDecoder): void {
    if (this.recordCount === 0) return;
    decoder.decode(this.records, this.recordCount);
    this.recordCount = 0;
  }

  /** Appends a batch of records (whole records only; if the frame loop stalled, older ones are dropped). */
  private stage(batch: Float64Array): void {
    if (batch.length > this.records.length) return;
    if (this.recordCount + batch.length > this.records.length) this.recordCount = 0;
    this.records.set(batch, this.recordCount);
    this.recordCount += batch.length;
  }
}
