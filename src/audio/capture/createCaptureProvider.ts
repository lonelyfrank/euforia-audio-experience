import { isDesktop, supportsSystemAudio } from '../../platform';
import type { AudioSourceId } from '../../types/audio';
import type { AudioCaptureProvider } from './AudioCaptureProvider';
import { BrowserMicrophoneCapture } from './BrowserMicrophoneCapture';
import { FakeAudioProvider } from './FakeAudioProvider';
import { FileAudioProvider } from './FileAudioProvider';
import { NativeAudioCapture } from './NativeAudioCapture';
import type { TestSignal } from './testSignals';

export interface SourceOptions {
  /** Required for the `file` source. */
  file?: File | null;
  /** Signal for the `fake` source (default: a 124 BPM beat). */
  signal?: TestSignal;
}

/** Whether a source can work in the current environment. */
export function isSourceAvailable(source: AudioSourceId): boolean {
  return source !== 'system' || supportsSystemAudio;
}

export function createCaptureProvider(source: AudioSourceId, options: SourceOptions = {}): AudioCaptureProvider {
  switch (source) {
    case 'system':
      if (!isDesktop) throw new Error('System audio capture requires the desktop app.');
      return new NativeAudioCapture('system');
    case 'microphone':
      return isDesktop ? new NativeAudioCapture('microphone') : new BrowserMicrophoneCapture();
    case 'file':
      if (!options.file) throw new Error('No audio file selected.');
      return new FileAudioProvider(options.file);
    case 'fake':
      return new FakeAudioProvider(options.signal);
  }
}
