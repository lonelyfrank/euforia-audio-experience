/// <reference lib="webworker" />
import { AnalysisHost } from './AnalysisHost';
import type { FromWorker, ToWorker } from './analysisProtocol';
import { SEQUENCE } from './PcmRing';

/*
 * The browser's analysis thread: owns the WASM DSP, the DSP budget and (for
 * the synthetic source) the signal generator. Rendering never paces it: the
 * shared ring wakes it every couple of hops, the port and generator sources
 * on their own messages and timer.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;
/** Generator / no Atomics.waitAsync: polling period (ms). */
const POLL = 5;
type WaitAsync = (array: Int32Array, index: number, value: number, timeout?: number) => { async: boolean; value: Promise<string> | string };

let host: AnalysisHost | null = null;
let running = false;
let timer = 0;

function post(message: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

async function wake(state: Int32Array, waitAsync: WaitAsync): Promise<void> {
  while (running && host) {
    const sequence = Atomics.load(state, SEQUENCE);
    host.pump();
    const result = waitAsync(state, SEQUENCE, sequence, 100);
    if (result.async) await result.value;
  }
}

scope.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === 'recycle') {
    host?.recycle(message.buffer);
  } else if (message.type === 'start') {
    try {
      host = await AnalysisHost.create(message.options, {
        records: (batch, length, info) =>
          post({ type: 'records', buffer: batch.buffer as ArrayBuffer, length, info: { ...info }, posted: performance.timeOrigin + performance.now() }, [batch.buffer]),
        pcm: (mono, frames) => post({ type: 'pcm', buffer: mono.buffer as ArrayBuffer, frames }, [mono.buffer]),
      });
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      return;
    }
    running = true;
    const live = host;
    const waitAsync = (Atomics as unknown as { waitAsync?: WaitAsync }).waitAsync;
    if (message.port) {
      message.port.onmessage = (block: MessageEvent<Float32Array>) => { live.write(block.data); live.pump(); };
    } else if (message.options.source.kind === 'shared' && waitAsync) {
      void wake(live.ring.state, waitAsync.bind(Atomics));
    } else {
      timer = setInterval(() => live.pump(), POLL) as unknown as number;
    }
    post({ type: 'ready', shared: message.options.source.kind === 'shared', waits: !!waitAsync });
  } else if (message.type === 'stop') {
    running = false;
    clearInterval(timer);
    host?.dispose();
    host = null;
    scope.close();
  }
};
