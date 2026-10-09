import { expect, it } from 'vitest';
import { newFrame } from '../audio/features/decode';
import { createSnapshot } from '../experience/types';
import { DiagnosticsStore } from '../diagnostics/core/DiagnosticsStore';
import { DiagnosticsCollector } from '../diagnostics/core/DiagnosticsCollector';
import { collectSnapshot } from '../diagnostics/probes/EngineProbes';
import { RollingStatistics } from '../diagnostics/metrics/RollingStatistics';

it('measures bounded diagnostic collection/aggregation (synthetic CPU, not live overhead)', async () => {
  const rows: object[] = [];
  const snapshot = createSnapshot(newFrame());
  for (const detailed of [false, true]) {
    const store = new DiagnosticsStore(120), collector = new DiagnosticsCollector(store, detailed ? 10 : 5);
    collector.register({ id: 'snapshot', sample: store => collectSnapshot(store, snapshot, detailed) });
    const cost = new RollingStatistics(500);
    for (let i = 0; i < 600; i++) {
      const start = performance.now(); collector.sample(i, true);
      if (i >= 100) cost.push(performance.now() - start);
    }
    rows.push({ mode: detailed ? 'detailed' : 'basic', ...cost.summarize(), bufferBytes: store.bytes, metrics: store.registry.metrics.length });
    console.log(`Diagnostics ${detailed ? 'detailed' : 'basic'} collection ms ${JSON.stringify(cost.summarize())}; buffers=${store.bytes}; metrics=${store.registry.metrics.length}`);
    expect(store.count).toBe(120); expect(store.bytes).toBeLessThan(5 * 1024 * 1024);
    collector.dispose();
  }
  const path = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env.EUFORIA_DIAGNOSTICS_BENCH_REPORT;
  if (path) {
    const fs = await import(/* @vite-ignore */ 'node:fs/promises' as string);
    await fs.writeFile(path, JSON.stringify({ method: '100 warmup + 500 samples, snapshot collection and bounded trace copy; no DOM/GPU', rows }, null, 2));
  }
});
