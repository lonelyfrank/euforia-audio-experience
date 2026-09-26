import { WebAudioProvider } from './WebAudioProvider';

/**
 * Microphone through getUserMedia. Used when the app runs in a plain browser
 * (`npm run dev`); the desktop build captures the microphone natively.
 */
export class BrowserMicrophoneCapture extends WebAudioProvider {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  constructor() {
    super('microphone');
  }

  protected async connectSource(context: AudioContext, analyser: AnalyserNode): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access is not available in this environment.');
    }
    // Raw signal: voice processing would flatten the music we want to analyse.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.stream = stream;
    this.deviceName = stream.getAudioTracks()[0]?.label || 'Microphone';
    this.source = context.createMediaStreamSource(stream);
    // Not connected to the destination: we only listen.
    this.source.connect(analyser);
  }

  protected disconnectSource(): void {
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}
