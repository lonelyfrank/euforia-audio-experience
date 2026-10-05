import type { ClockSync } from '../../timing/ClockSync';
import type { TestSignal } from '../capture/testSignals';
import { AnalysisHost, RING_SECONDS, type BatchInfo, type HostOptions, type HostSource } from './AnalysisHost';
import type { FromWorker, ToWorker } from './analysisProtocol';
import type { AnalysisDecoder } from './decode';
import { RECORD } from './layout';
import { PcmRing } from './PcmRing';
import { RecordStage } from './RecordStage';

/** Where the browser DSP runs and how PCM reaches it. */
export type AnalysisMode = 'worker-shared' | 'worker-port' | 'worker-timer' | 'main-thread';

/** What feeds the analysis: the AudioWorklet's stream, or the synthetic generator. */
export type BrowserSource = { kind: 'stream' } | { kind: 'generator'; signal: TestSignal };

/** Seconds of records kept between two rendered frames (a longer stall drops the oldest). */
const STAGE_SECONDS = 3;

export interface RealtimeStats {
  mode: AnalysisMode;
  /** DSP work / audio time, smoothed; DSP quality level (0 high … 2 low). */
  load: number;
  quality: number;
  /** Frames waiting in the PCM ring when the last batch left. */
  backlog: number;
  /** Seconds from the newest sample's arrival at the DSP to its batch being ready. */
  dspAge: number;
  /** Seconds from the worker posting a batch to the main thread receiving it. */
  transfer: number;
  /** f64 values staged for the next frame, and dropped by a stalled frame loop. */
  pending: number;
  dropped: number;
  lost: number;
  filled: number;
  batches: number;
}

/**
 * Main-thread handle of the browser analysis. Starts the analysis worker
 * (falling back to the main thread when workers are unavailable), gives the
 * AudioWorklet the shared ring or port to stream PCM into, and stages the
 * returned records like the native capture's: decoded once per rendered frame,
 * clock observations included. The DSP itself never runs on the frame loop
 * unless there is no worker.
 */
export class BrowserAnalysis {
  /** For the worklet: the shared ring, or the port to post blocks to. Null for the generator. */
  readonly link: { ring: SharedArrayBuffer | null; port: MessagePort | null } = { ring: null, port: null };
  readonly stats: RealtimeStats = { mode: 'main-thread', load: 0, quality: 0, backlog: 0, dspAge: 0, transfer: 0, pending: 0, dropped: 0, lost: 0, filled: 0, batches: 0 };
  /** Changes when the analysis restarted after losing audio: the capture clock started over. */
  epoch = 0;
  private readonly stage: RecordStage;
  private worker: Worker | null = null;
  private host: AnalysisHost | null = null;
  private disposed = false;

  private constructor(readonly sampleRate: number, private readonly onPcm: ((mono: Float32Array, frames: number) => void) | null) {
    const hops = Math.ceil((sampleRate / 256) * STAGE_SECONDS);
    this.stage = new RecordStage(hops * (RECORD.frame + RECORD.onset + RECORD.beat) + 64 * RECORD.clock);
  }

  static async start(sampleRate: number, source: BrowserSource, onPcm: ((mono: Float32Array, frames: number) => void) | null = null): Promise<BrowserAnalysis> {
    const analysis = new BrowserAnalysis(sampleRate, onPcm);
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

  /** Per rendered frame: main-thread fallback analyses here; then the staged records are decoded. */
  read(decoder: AnalysisDecoder, clock: ClockSync): void {
    this.poll();
    this.stats.pending = this.stage.pending;
    this.stats.dropped = this.stage.dropped;
    this.stage.drain(decoder, clock, this.sampleRate);
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
    return { sampleRate: this.sampleRate, source, adaptive: true };
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
      pcm: (mono, frames) => { this.onPcm?.(mono, frames); this.host?.recycle(mono.buffer as ArrayBuffer); },
    });
    this.stats.mode = 'main-thread';
  }

  private receive(message: FromWorker): void {
    if (this.disposed) return;
    if (message.type === 'records') {
      const batch = new Float64Array(message.buffer);
      this.accept(batch, message.length, message.info, (performance.timeOrigin + performance.now() - message.posted) / 1000);
    } else if (message.type === 'pcm') {
      this.onPcm?.(new Float32Array(message.buffer), message.frames);
    } else return;
    this.worker?.postMessage({ type: 'recycle', buffer: message.buffer } satisfies ToWorker, [message.buffer]);
  }

  private accept(batch: Float64Array, length: number, info: BatchInfo, transfer: number): void {
    if (info.epoch !== this.epoch) {
      // The capture clock restarted: nothing staged from the old epoch may reach the decoder.
      this.stage.clear();
      this.epoch = info.epoch;
    }
    this.stage.stage(batch, length, performance.now() / 1000);
    const s = this.stats;
    s.load = info.load;
    s.quality = info.quality;
    s.backlog = info.backlog;
    s.lost = info.lost;
    s.filled = info.filled;
    s.dspAge = batch[length - 1];
    s.transfer += (transfer - s.transfer) * 0.1;
    s.batches++;
  }
}
