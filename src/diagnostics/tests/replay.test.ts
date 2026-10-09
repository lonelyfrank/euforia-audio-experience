import { describe, expect, it } from 'vitest';
import { replay } from '../../validation/replay';
import { replayReport, SCENARIOS, syntheticPcm } from '../replay/ReplayController';
import { compareReports } from '../replay/ReplayComparison';
import { validateReport } from '../replay/validateReport';

describe('diagnostics on the real WASM replay path', () => {
  it('preserves world, events and reports at OFF/ON and 30/60/144 FPS with distinct batches', { timeout: 120000 }, async () => {
    const pcm = syntheticPcm('buildDrop', 20);
    const off = await replay(pcm, null, { fps: 60, batch: 480 });
    const on = await replayReport(pcm, 'synthetic:buildDrop', { fps: 60, batch: 480 });
    expect(on.grid).toEqual(off.grid); expect(on.report).toEqual(off.report); expect(on.trace.toCsv()).toEqual(off.trace.toCsv());
    expect(validateReport(on.diagnostics)).toBe(on.diagnostics);
    for (const [fps, batch] of [[30, 256], [144, 2048]]) {
      const other = await replayReport(pcm, 'synthetic:buildDrop', { fps, batch });
      expect(other.grid.length).toBe(on.grid.length);
      for (let i = 0; i < on.grid.length; i++) expect(other.grid[i]).toBeCloseTo(on.grid[i], 8);
      const comparison = compareReports(on.diagnostics, other.diagnostics);
      expect(comparison.compatible).toBe(true);
      for (const m of comparison.metrics.filter(m => m.domain === 'world')) if (m.absolute !== null) expect(Math.abs(m.absolute)).toBeLessThan(1e-8);
    }
  });
  it.each(SCENARIOS)('reproduces synthetic %s, finite states and anonymous report', { timeout: 30000 }, async signal => {
    const a = syntheticPcm(signal, 4), b = syntheticPcm(signal, 4);
    expect(a.samples.length).toBe(b.samples.length);
    expect(a.samples.every((value, i) => value === b.samples[i])).toBe(true);
    const run = await replayReport(a, `synthetic:${signal}`);
    expect(run.grid.length).toBeGreaterThan(0); expect(run.grid.every(Number.isFinite)).toBe(true);
    expect(run.diagnostics.samples.length).toBeGreaterThan(0);
    expect(JSON.stringify(run.diagnostics)).not.toContain('"samples":[0');
    if (signal === 'silence') expect(run.report.worldEnergyMax).toBe(0);
  });
});
