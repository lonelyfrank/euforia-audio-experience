import { describe, expect, it, vi } from 'vitest';
import { DiagnosticsStore } from '../core/DiagnosticsStore';
import { DiagnosticsCollector } from '../core/DiagnosticsCollector';
import { MetricRegistry } from '../metrics/MetricRegistry';
import { RollingStatistics } from '../metrics/RollingStatistics';
import type { DiagnosticReport, MetricDefinition } from '../core/DiagnosticsTypes';
import { exportReport } from '../replay/ReportExporter';
import { compareReports } from '../replay/ReplayComparison';
import { validateReport } from '../replay/validateReport';
import { newFrame } from '../../audio/features/decode';
import { createSnapshot } from '../../experience/types';
import { collectSnapshot, group } from '../probes/EngineProbes';
import { summarizeMatter } from '../probes/MatterSample';
import { GpuTimer } from '../probes/RendererProbe';

const def: MetricDefinition = { id: 'cpu', source: 'test', domain: 'render', unit: 'ms', clock: 'render', method: 'measured', lowerIsBetter: true };
function report(value = 1): DiagnosticReport {
  return { schema: 1, metadata: { engineVersion: '1', gitSha: null, startedAt: '2026-10-08', os: 'test', backend: 'test', gpu: null, capabilities: [], quality: 'high', resolution: '1920x1080', source: 'synthetic:tone400', sampleRate: 48000, session: 1, detail: 'basic', sampleHz: 5, profiling: false, readback: false, scene: 'test', seed: 1, experimental: [] },
    duration: 1, samples: [{ timestamp: 1, metrics: [{ ...def, value, timestamp: 1, status: 'valid' }] }], events: [], labels: {}, limitations: ['not GPU time'] };
}
describe('diagnostic data contracts', () => {
  it('retains zero but invalidates missing/nonfinite values and invalid clocks', () => {
    const registry = new MetricRegistry(1);
    registry.set(def, 0, 1); expect(registry.metrics[0].value).toBe(0);
    for (const value of [null, NaN, Infinity]) { registry.set(def, value, 2); expect(registry.metrics[0].status).toBe('unavailable'); expect(registry.metrics[0].value).toBeNull(); }
    registry.set(def, 2, NaN); expect(registry.metrics[0].value).toBeNull();
    registry.set(def, 2, 3, 'estimated'); expect(registry.metrics[0].status).toBe('estimated');
    expect(() => registry.register({ ...def, unit: 's' })).toThrow();
    expect(() => registry.register({ ...def, id: 'other' })).toThrow();
  });
  it('bounds traces and does not backfill later metrics into older samples', () => {
    const store = new DiagnosticsStore(2);
    store.registry.set(def, 1, 1); store.capture(1);
    store.registry.set(def, 2, 2); store.capture(2);
    store.registry.set({ ...def, id: 'new' }, 7, 3); store.registry.set(def, 3, 3); store.capture(3);
    const rows = store.exportSamples();
    expect(rows.map(s => s.timestamp)).toEqual([2, 3]); expect(rows[0].metrics[1].value).toBeNull(); expect(store.evicted).toBe(1);
    store.registry.set(def, 8, 8); expect(rows[1].metrics[0].value).toBe(3);
    store.reset(); expect(store.count).toBe(0); expect(store.registry.metrics[0].value).toBeNull();
    expect(() => new DiagnosticsStore(0)).toThrow();
  });
  it('samples at its own cadence, recovers from clock reset and contains faulty probes', () => {
    const store = new DiagnosticsStore(2), collector = new DiagnosticsCollector(store, 5), run = vi.fn();
    collector.register({ id: 'bad', sample: () => { throw new Error('failure'); } });
    collector.register({ id: 'good', sample: (store, time) => { run(); store.registry.set(def, 2, time); } });
    expect(collector.sample(NaN, true)).toBe(false);
    collector.sample(1, true); collector.sample(1.1, true); collector.sample(1.21, false);
    expect(run).toHaveBeenCalledTimes(2); expect(store.count).toBe(1); expect(store.events).toHaveLength(2);
    collector.sample(0, true); expect(run).toHaveBeenCalledTimes(3);
    collector.reset(); expect(store.events).toHaveLength(0); collector.dispose();
  });
  it('computes exact nearest-rank percentiles on a rolling window', () => {
    const stats = new RollingStatistics(100);
    expect(stats.summarize().mean).toBeNull();
    for (let i = 1; i <= 100; i++) stats.push(i);
    expect(stats.summarize()).toEqual({ mean: 50.5, p95: 95, p99: 99 });
    stats.push(NaN); stats.push(-1); stats.push(101); expect(stats.summarize().mean).toBe(51.5);
    stats.reset(); expect(stats.count).toBe(0);
  });
  it('exports an empty report, missing values, quotes and metadata without PCM', () => {
    const r = report(); r.samples[0].metrics[0].id = 'a,"b'; r.samples[0].metrics[0].value = null; r.samples[0].metrics[0].status = 'unavailable';
    expect(JSON.parse(exportReport(r, 'json')).samples[0].metrics[0].value).toBeNull();
    expect(exportReport(r, 'csv')).toContain('"a,""b"'); expect(exportReport(r, 'csv')).toContain('metadata');
    expect(exportReport(r, 'md')).toContain('Unavailable'); r.samples = [];
    expect(exportReport(r, 'md')).toContain('Limiti'); expect(exportReport(r, 'json')).not.toContain('PCM');
    expect(validateReport(r)).toBe(r); expect(() => validateReport({})).toThrow();
  });
  it('compares compatible costs without interpreting world values as performance regressions', () => {
    const a = report(2), b = report(3);
    expect(compareReports(a, b).metrics[0]).toMatchObject({ absolute: 1, relative: 0.5, result: 'regression-candidate' });
    expect(compareReports(report(0), report(1)).metrics[0]).toMatchObject({ absolute: 1, relative: null, result: 'change-from-zero' });
    a.samples[0].metrics[0].lowerIsBetter = false;
    expect(compareReports(a, b).metrics[0].result).toBe('change');
    b.metadata.resolution = '960x540'; expect(compareReports(a, b).compatible).toBe(false); expect(compareReports(a, b).metrics[0].absolute).toBeNull();
    b.metadata.resolution = a.metadata.resolution; b.metadata.experimental = ['mixed-configuration']; expect(compareReports(a, b).compatible).toBe(false);
  });
  it('observes snapshot, intent confidence and physical state without mutation', () => {
    const snapshot = createSnapshot(newFrame()); snapshot.intents[0].strength = 0.8; snapshot.intents[0].confidence = 0.5;
    snapshot.world.energy = 0.3; const before = structuredClone(snapshot), store = new DiagnosticsStore(1);
    collectSnapshot(store, snapshot, true);
    expect(snapshot).toEqual(before);
    expect(store.registry.metrics.find(m => m.id === 'intent.expand')?.value).toBe(0.4);
    expect(store.registry.metrics.find(m => m.id === 'world.energy')?.status).toBe('estimated');
    expect(store.registry.metrics.find(m => m.id === 'world.dissipation')?.value).toBeNull();
    expect(store.registry.metrics.find(m => m.id === 'invariants.nonfinite')?.value).toBe(0);
    snapshot.world.energy = NaN; snapshot.world.coherence = 2; collectSnapshot(store, snapshot);
    expect(store.registry.metrics.find(m => m.id === 'invariants.nonfinite')?.value).toBe(1);
    expect(store.registry.metrics.find(m => m.id === 'invariants.fieldDomain')?.value).toBe(1);
  });
  it('resolves a group once per registry and keeps reading the producer afterwards', () => {
    const store = new DiagnosticsStore(1), data = { level: 1, name: 'a', bands: new Float32Array([1, 2]) };
    const value = (id: string) => store.registry.metrics.find(m => m.id === id);
    group(store, 'audio', 'g', data, 1, 'test', true);
    expect(store.registry.metrics.map(m => m.id)).toEqual(['g.level', 'g.bands[0]', 'g.bands[1]']);
    data.level = 5; data.bands[1] = 7; data.name = 'b'; store.registry.invalidate();
    group(store, 'audio', 'g', data, 2, 'test', true);
    expect(store.registry.metrics).toHaveLength(3);
    expect(value('g.level')).toMatchObject({ value: 5, timestamp: 2, status: 'valid' }); expect(value('g.bands[1]')?.value).toBe(7);
    expect(store.labels['g.name']).toBe('b');
    // Basic after Detailed: the vectors are no longer read, so they are unavailable instead of stale.
    store.registry.invalidate(); group(store, 'audio', 'g', data, 3, 'test');
    expect(value('g.bands[1]')?.value).toBeNull(); expect(value('g.level')?.value).toBe(5);
    const other = new DiagnosticsStore(1); group(other, 'audio', 'g', data, 1, 'test');
    expect(other.registry.metrics.map(m => m.id)).toEqual(['g.level']);
  });
  it('computes sampled dispersion/speed and excludes invalid states', () => {
    const p = new Float32Array([-1, 0, 0, 0, 1, 0, 0, 0, NaN, 0, 0, 0]);
    const v = new Float32Array([3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(summarizeMatter(p, v, 3)).toMatchObject({ x: 0, dispersion: 1, speed: 2.5, maxSpeed: 5, kinetic: 6.25, invalid: 1 });
    expect(summarizeMatter(p, v, 0).speed).toBeNull();
  });
  it('bounds GPU queries, waits for availability, drops disjoint results and releases resources', () => {
    let ready = false, disjoint = false;
    const gl = { getExtension: () => ({ TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 }), isContextLost: () => false,
      getParameter: () => disjoint, createQuery: vi.fn(() => ({})), beginQuery: vi.fn(), endQuery: vi.fn(), deleteQuery: vi.fn(),
      QUERY_RESULT_AVAILABLE: 3, QUERY_RESULT: 4, getQueryParameter: vi.fn((_: unknown, p: number) => p === 3 ? ready : 2e6) };
    const timer = new GpuTimer(gl as unknown as WebGL2RenderingContext);
    timer.begin(); timer.end(); expect(gl.createQuery).not.toHaveBeenCalled();
    timer.enabled = true;
    for (let i = 0; i < 9; i++) { timer.begin(); timer.end(); }
    expect(gl.createQuery).toHaveBeenCalledTimes(4); expect(timer.ms).toBeNull();
    ready = true; timer.begin(); timer.end(); expect(timer.ms).toBe(2);
    disjoint = true; timer.begin(); expect(timer.ms).toBeNull(); expect(gl.deleteQuery).toHaveBeenCalledTimes(5);
    timer.dispose();
  });
  it('sees what lasts one frame: hitches, steps of the heard clock and bursts of ingestion', async () => {
    const { PresentationProbe } = await import('../probes/PresentationProbe');
    const p = new PresentationProbe();
    let heard = 10, hops = 0;
    const frame = (ms: number, clockStep = ms / 1000, decoded = 3) => { heard += clockStep; hops += decoded; p.frame(ms, heard, hops); };
    for (let i = 0; i < 200; i++) frame(1000 / 60);
    // On time and regular: nothing to report.
    expect(p.janks).toBe(0);
    expect(p.heardError.summarize().p99).toBeLessThan(1e-6);
    expect(p.hops.summarize().mean).toBe(3);
    // A frame on time whose shown moment jumped 9 ms: motion stutters although nothing was late.
    frame(1000 / 60, 1 / 60 + 0.009);
    expect(p.maxHeardError).toBeCloseTo(9, 6);
    expect(p.janks).toBe(0);
    // A 120 ms stall, then the backlog decoded within the per-frame bound.
    frame(120, 0.12, 0);
    frame(1000 / 60, 1 / 60, 13);
    expect([p.over33, p.over50, p.over100, p.janks]).toEqual([1, 1, 1, 1]);
    expect(p.maxHops).toBe(13);
    expect(p.frames).toBe(203);
    // A restart of the session (counters back to zero) is not a negative burst, and a clock that is not ready is not an error.
    p.frame(1000 / 60, NaN, 0);
    p.frame(1000 / 60, 0.5, 3);
    expect(p.hops.summarize().p99).toBeLessThanOrEqual(13);
    p.reset();
    expect([p.frames, p.janks, p.maxHops, p.maxHeardError, p.heardError.count]).toEqual([0, 0, 0, 0, 0]);
  });
  it('gives the median of a window', () => {
    const stats = new RollingStatistics(100);
    expect(stats.median()).toBeNull();
    for (let i = 1; i <= 99; i++) stats.push(i);
    expect(stats.median()).toBe(50);
  });
});
