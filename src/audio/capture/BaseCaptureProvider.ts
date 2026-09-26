import type { AudioSourceId } from '../../types/audio';
import type { AudioCaptureProvider } from './AudioCaptureProvider';

/** Shared plumbing (error listeners, identity) for capture providers. */
export abstract class BaseCaptureProvider implements AudioCaptureProvider {
  sampleRate = 48000;
  deviceName = '';
  private readonly errorListeners = new Set<(message: string) => void>();

  constructor(readonly id: AudioSourceId) {}

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract readSamples(out: Float32Array, delay: number): void;

  onError(listener: (message: string) => void): void {
    this.errorListeners.add(listener);
  }

  protected emitError(message: string): void {
    for (const listener of this.errorListeners) listener(message);
  }
}
