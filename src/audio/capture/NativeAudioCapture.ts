import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { BaseCaptureProvider } from './BaseCaptureProvider';
import { SampleRingBuffer } from './SampleRingBuffer';

export type NativeSource = 'system' | 'microphone';

interface CaptureInfo {
  sampleRate: number;
  channels: number;
  deviceName: string;
}

/**
 * Receives PCM from the Rust capture backend (native/audio-capture):
 * - `system`: WASAPI loopback of the output device on Windows;
 * - `microphone`: the default input device.
 *
 * The backend downmixes to mono and streams little-endian f32 chunks over a
 * Tauri channel; they are accumulated in a ring buffer read by the analyzer.
 */
export class NativeAudioCapture extends BaseCaptureProvider {
  private readonly ring = new SampleRingBuffer(48000);
  private unlistenError: UnlistenFn | null = null;
  private session = 0;

  constructor(private readonly source: NativeSource) {
    super(source);
  }

  async start(): Promise<void> {
    await this.stop();
    this.ring.clear();
    const session = ++this.session;
    const channel = new Channel<ArrayBuffer | number[]>();
    channel.onmessage = (message) => {
      // Ignore late chunks from a previous session.
      if (session !== this.session) return;
      if (message instanceof ArrayBuffer) this.ring.write(new Float32Array(message));
      else this.ring.write(message);
    };
    this.unlistenError = await listen<string>('audio-capture-error', (event) => this.emitError(event.payload));
    const info = await invoke<CaptureInfo>('start_audio_capture', {
      source: this.source,
      onSamples: channel,
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
}
