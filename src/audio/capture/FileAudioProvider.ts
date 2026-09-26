import type { Playback } from './AudioCaptureProvider';
import { WebAudioProvider } from './WebAudioProvider';

/** Plays a local audio file (looped) and analyses it. Dropped onto the window. */
export class FileAudioProvider extends WebAudioProvider {
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private readonly timeline: Playback = { position: 0, duration: 0 };

  constructor(private readonly file: File) {
    super('file');
    this.deviceName = file.name;
  }

  protected async connectSource(context: AudioContext, analyser: AnalyserNode): Promise<void> {
    const buffer = await context.decodeAudioData(await this.file.arrayBuffer());
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(analyser);
    analyser.connect(context.destination);
    source.start();
    this.source = source;
    this.startedAt = context.currentTime;
    this.timeline.duration = buffer.duration;
  }

  /** Reused object: read it, don't keep it. */
  playback(): Playback {
    const { context, timeline } = this;
    timeline.position = context && timeline.duration > 0 ? (context.currentTime - this.startedAt) % timeline.duration : 0;
    return timeline;
  }

  protected disconnectSource(): void {
    if (!this.source) return;
    this.source.stop();
    this.source.disconnect();
    this.source = null;
  }
}
