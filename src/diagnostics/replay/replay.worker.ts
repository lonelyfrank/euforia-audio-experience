import { replayReport, syntheticPcm, type Scenario } from './ReplayController';
let paused = false;
let resume: (() => void) | null = null;
let running = false;
self.onmessage = (event: MessageEvent<{ signal?: Scenario; fps?: number; batch?: number; pause?: boolean }>) => {
  if (event.data.pause !== undefined) { paused = event.data.pause; if (!paused) { resume?.(); resume = null; } return; }
  if (running || !event.data.signal) return;
  running = true;
  const { signal, fps, batch } = event.data;
  void (async () => {
    try {
      const result = await replayReport(syntheticPcm(signal), `synthetic:${signal}`, { fps, batch, onProgress: async seconds => {
        self.postMessage({ progress: seconds });
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (paused) await new Promise<void>(resolve => { resume = resolve; });
      } });
      self.postMessage({ report: result.diagnostics });
    } catch (error) { self.postMessage({ error: String(error) }); }
    finally { running = false; }
  })();
};
