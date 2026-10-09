import type { ClockSync } from '../../timing/ClockSync';
import type { AudioFrame } from '../../types/audio';
import type { TestSignal } from '../capture/testSignals';
import { AnalysisHost, RING_SECONDS, type BatchInfo, type HostOptions, type HostSource, type SceneSettings } from './AnalysisHost';
import type { FromWorker, ToWorker } from './analysisProtocol';
import type { AnalysisDecoder } from './decode';
import { PcmRing } from './PcmRing';
import { RecordStage } from './RecordStage';

/** Where the DSP runs and how PCM reaches it: the analysis worker (three ways), the main thread without workers, or the native capture thread. */
export type AnalysisMode = 'worker-shared' | 'worker-port' | 'worker-timer' | 'main-thread' | 'native';

/** What feeds the analysis: the AudioWorklet's stream, or the synthetic generator. */
export type BrowserSource = { kind: 'stream' } | { kind: 'generator'; signal: TestSignal };

export interface RealtimeStats {
  mode: AnalysisMode;
  /** DSP work / audio time, smoothed; DSP quality level (0 high … 2 low). */
  load: number;
  quality: number;
  /** Frames waiting in the PCM ring when the last batch left (browser sources). */
  backlog: number;
  /** Seconds from the newest sample's capture (native) or arrival at the DSP (browser) to its batch being sent. */
  dspAge: number;
  /** Seconds from the worker posting a batch to the main thread receiving it (browser sources). */
  transfer: number;
  /** f64 values staged for the next frames, and dropped by a stalled frame loop. */
  pending: number;
  dropped: number;
  /** Frames the capture lost, and frames the worklet filled with silence (cumulative). */
  lost: number;
  filled: number;
  /** Batches received, and holes in their sequence (a batch that never arrived). */
  batches: number;
  missed: number;
}

/**
 * Main-thread handle of the browser analysis. Starts the analysis worker
 * (falling back to the main thread when workers are unavailable), gives the
 * AudioWorklet the shared ring or port to stream PCM into, and stages the
 * returned records like the native capture's: decoded by the rendered frames,
 * clock observations included, the scenes' graphic analysis in its own feed.
 * The DSP itself never runs on the frame loop unless there is no worker, and
 * no PCM comes back.
 */
export class BrowserAnalysis {
  /** For the worklet: the shared ring, or the port to post blocks to. Null for the generator. */
  readonly link: { ring: SharedArrayBuffer | null; port: MessagePort | null } = { ring: null, port: null };
  readonly stats: RealtimeStats = { mode: 'main-thread', load: 0, quality: 0, backlog: 0, dspAge: 0, transfer: 0, pending: 0, dropped: 0, lost: 0, filled: 0, batches: 0, missed: 0 };
  private readonly stage: RecordStage;
  private worker: Worker | null = null;
  private host: AnalysisHost | null = null;
  private disposed = false;

  private constructor(readonly sampleRate: number, private scene: SceneSettings) {
    this.stage = new RecordStage(sampleRate);
  }

  /** Changes when the analysis restarted after losing audio: the capture clock started over. */
  get epoch(): number {
    return this.stage.epoch;
  }

  static async start(sampleRate: number, source: BrowserSource, scene: SceneSettings = { sensitivity: 1, smoothing: 0.5 }): Promise<BrowserAnalysis> {
    const analysis = new BrowserAnalysis(sampleRate, scene);
    if (typeof Worker !== 'undefined') {
      try {
        await analysis.startWorker(source);
        return analysis;
      } catch (error) {
        analysis.worker?.terminate();
        analysis.worker = null;
        console.warn('Analysis worker unavailable, analysing on the main thread:', error);
      }
    }
    await analysis.startHere(source);
    return analysis;
  }

  /** Per rendered frame: main-thread fallback analyses here; then the staged records are decoded, at most `maxFrames` hops of them. */
  read(decoder: AnalysisDecoder, clock: ClockSync, maxFrames?: number): void {
    this.poll();
    this.stage.drain(decoder, clock, this.sampleRate, maxFrames);
    const s = this.stats, t = this.stage.stats;
    s.load = t.load; s.quality = t.quality; s.lost = t.lost; s.dspAge = t.age;
    s.pending = t.pending; s.dropped = t.dropped; s.batches = t.batches; s.missed = t.missed;
  }

  /** The scenes' graphic analysis for the frame being rendered (see SceneFeed). */
  readScene(frame: AudioFrame, delay: number, beatResponse: boolean): boolean {
    return this.stage.scenes.read(frame, delay, beatResponse);
  }

  /** The scenes' analysis settings; they apply from its next frame. */
  setScene(scene: SceneSettings): void {
    this.scene = scene;
    this.worker?.postMessage({ type: 'scene', scene } satisfies ToWorker);
    this.host?.setScene(scene);
  }

  /** Main-thread fallback only: generate/analyse what is due now. */
  poll(): void {
    this.host?.pump();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker?.postMessage({ type: 'stop' } satisfies ToWorker);
    this.worker?.terminate();
    this.worker = null;
    this.host?.dispose();
    this.host = null;
    this.link.port?.close();
  }

  private options(source: HostSource): HostOptions {
    return { sampleRate: this.sampleRate, source, adaptive: true, scene: this.scene };
  }

  private async startWorker(source: BrowserSource): Promise<void> {
    const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    let hostSource: HostSource;
    let port: MessagePort | null = null;
    if (source.kind === 'generator') hostSource = source;
    else if (typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated) {
      const ring = new SharedArrayBuffer(PcmRing.bytes(this.sampleRate * RING_SECONDS, 2));
      this.link.ring = ring;
      hostSource = { kind: 'shared', ring };
    } else {
      const channel = new MessageChannel();
      this.link.port = channel.port1;
      port = channel.port2;
      hostSource = { kind: 'port' };
    }
    const ready = new Promise<FromWorker & { type: 'ready' }>((resolve, reject) => {
      worker.onerror = (event) => reject(new Error(event.message || 'analysis worker failed'));
      worker.onmessage = (event: MessageEvent<FromWorker>) => {
        const message = event.data;
        if (message.type === 'ready') resolve(message);
        else if (message.type === 'error') reject(new Error(message.message));
        else this.receive(message);
      };
    });
    worker.postMessage({ type: 'start', options: this.options(hostSource), port } satisfies ToWorker, port ? [port] : []);
    const started = await ready;
    worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    this.stats.mode = source.kind === 'generator' ? 'worker-timer' : started.shared ? 'worker-shared' : 'worker-port';
  }

  private async startHere(source: BrowserSource): Promise<void> {
    const hostSource: HostSource = source.kind === 'generator' ? source : { kind: 'port' };
    if (source.kind === 'stream') {
      const channel = new MessageChannel();
      this.link.port = channel.port1;
      channel.port2.onmessage = (block: MessageEvent<Float32Array>) => this.host?.write(block.data);
    }
    this.host = await AnalysisHost.create(this.options(hostSource), {
      records: (batch, length, info) => { this.accept(batch, length, info, 0); this.host?.recycle(batch.buffer as ArrayBuffer); },
    });
    this.stats.mode = 'main-thread';
  }

  private receive(message: FromWorker): void {
    if (this.disposed) return;
    if (message.type !== 'records') return;
    const batch = new Float64Array(message.buffer);
    this.accept(batch, message.length, message.info, (performance.timeOrigin + performance.now() - message.posted) / 1000);
    this.worker?.postMessage({ type: 'recycle', buffer: message.buffer } satisfies ToWorker, [message.buffer]);
  }

  private accept(batch: Float64Array, length: number, info: BatchInfo, transfer: number): void {
    this.stage.stage(batch, length, performance.now() / 1000);
    const s = this.stats;
    s.backlog = info.backlog;
    s.filled = info.filled;
    s.transfer += (transfer - s.transfer) * 0.1;
  }
}
