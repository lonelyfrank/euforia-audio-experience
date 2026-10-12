import { worldLab } from '../../visual-engine/VisualWorld';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_SIGNALS } from '../../audio/capture/testSignals';
import { AudioEngine } from '../../audio/AudioEngine';
import type { App } from '../../app/App';
import { DiagnosticsController } from '../core/DiagnosticsController';
import type { DiagnosticReport } from '../core/DiagnosticsTypes';
import { exportReport } from '../replay/ReportExporter';
import { validateReport } from '../replay/validateReport';
import { matterLab } from '../../render-systems/forms/MatterForms';
import { structuralLab } from '../../visual-engine/primitives/WirePolygonPrimitive';

function setup() {
  const gl = { getExtension: () => null, getParameter: () => 'test WebGL', isContextLost: () => false };
  const info = { autoReset: true, reset: vi.fn(), render: { calls: 7, points: 9, triangles: 3, lines: 2 }, memory: { geometries: 4, textures: 5 } };
  const renderer = { info, getContext: () => gl, domElement: { width: 1280, height: 720 }, getPixelRatio: () => 1 };
  const directionDebug = { renderer, qualityTier: 'high', current: null, diagnostics: null, load: { fps: 60, limit: 'none', reduced: false, step: 0, logicShare: 0, steady: true } };
  const audio = new AudioEngine();
  const app = { audio, directionDebug } as unknown as App;
  return { controller: new DiagnosticsController(app), audio, directionDebug, info };
}
afterEach(() => { worldLab.only = null; matterLab.form = 'auto'; structuralLab.tuning.coherence = null; });
describe('shared diagnostic lifecycle (mock renderer)', () => {
  it('does no collection while off; shares counters, restores renderer and frees all buffers on last close', () => {
    const { controller: c, directionDebug: r, info } = setup();
    expect(c.store).toBeNull(); expect(r.diagnostics).toBeNull();
    const a = c.acquire(), b = c.acquire();
    const probe = c.renderer!;
    probe.begin(1000, 1 / 60); expect(info.autoReset).toBe(false); probe.sourceDone(); probe.end(2, 1, 7);
    expect(info.autoReset).toBe(true); expect(probe.drawn.calls).toBe(7); expect(c.store!.registry.metrics.length).toBeGreaterThan(10);
    a(); a(); expect(c.store).not.toBeNull(); b();
    expect(c.store).toBeNull(); expect(c.renderer).toBeNull(); expect(r.diagnostics).toBeNull(); expect(c.trace).toBeNull();
    c.dispose(); expect(() => c.acquire()).toThrow();
  });
  it('distinguishes collection pause from recording and resets old session data even during a pause', () => {
    const { controller: c, audio } = setup(), release = c.acquire();
    c.setRecording(true);
    const tick = (time: number) => { c.renderer!.begin(time, 1 / 60); c.renderer!.sourceDone(); c.renderer!.end(0, 0, 0); };
    tick(1000); expect(c.store!.count).toBe(1);
    c.paused = true; tick(2000); expect(c.store!.count).toBe(1);
    audio.session++; tick(3000); expect(c.store!.count).toBe(0); expect(c.report().metadata.session).toBe(audio.session);
    Object.assign(audio.state, { source: 'fake', status: 'running', deviceName: TEST_SIGNALS.find(s => s.id === 'tone400')!.label });
    vi.spyOn(audio, 'captureSampleRate', 'get').mockReturnValue(48000);
    c.paused = false; tick(4000);
    expect(c.report().metadata.source).toBe('synthetic:tone400');
    expect(c.report().metadata.sampleRate).toBe(48000); expect(c.store!.count).toBe(1);
    c.setRecording(false); tick(5000); expect(c.store!.count).toBe(1);
    release(); expect(c.readback).toBe(false); expect(c.recording).toBe(false);
  });
  it('gives the renderer its own counter setting back after a frame that threw', () => {
    const { controller: c, info } = setup(), release = c.acquire(), probe = c.renderer!;
    probe.begin(1000, 1 / 60);
    // The frame above never reached end(): the next one must not save the probe's own `false` as the renderer's setting.
    probe.begin(1016, 1 / 60); probe.sourceDone(); probe.end(0, 0, 0);
    expect(info.autoReset).toBe(true);
    probe.begin(1032, 1 / 60); release();
    expect(info.autoReset).toBe(true);
  });
  it('keeps what was measured when a primitive is isolated, and marks where the configuration changed', () => {
    const { controller: c } = setup(), release = c.acquire();
    const tick = (time: number) => { c.renderer!.begin(time, 1 / 60); c.renderer!.sourceDone(); c.renderer!.end(0, 0, 0); };
    const segmentOf = (sample: DiagnosticReport['samples'][number]) => sample.metrics.find(m => m.id === 'diagnostics.segment')?.value;
    c.setRecording(true);
    tick(1000); tick(2000);
    const frames = c.renderer!.frames.count, trace = c.trace;
    c.isolate('surface', 'diagnostics');
    // Nothing is cleared by isolating: the buffer, the rolling statistics and the recorded trace go on.
    expect([c.store!.count, c.renderer!.frames.count, c.trace]).toEqual([2, frames, trace]);
    tick(3000); tick(4000);
    c.isolate(null, 'diagnostics'); tick(5000);
    const report = c.report();
    expect(report.samples.map(segmentOf)).toEqual([0, 0, 1, 1, 2]);
    expect(report.segments!.map(s => [s.index, s.from, s.changed, s.origin])).toEqual([
      [0, 1, [], null], [1, 3, ['isolate: all → surface'], 'diagnostics'], [2, 5, ['isolate: surface → all'], 'diagnostics']]);
    // The time under the configuration says when a rolling statistic stops mixing two of them.
    expect(report.samples.map(s => s.metrics.find(m => m.id === 'diagnostics.segmentAge')?.value)).toEqual([0, 1, 0, 1, 0]);
    const changes = report.events.filter(e => e.type === 'configuration-change');
    expect(changes.map(e => e.observedAt)).toEqual([3, 5]);
    expect(changes[0].context).toContain('isolate: all → surface'); expect(changes[0].context).toContain('origin diagnostics');
    // The whole report is not one homogeneous measure, and says so; the isolation it went through stays named.
    expect(report.metadata.experimental).toEqual(expect.arrayContaining(['mixed-configuration', 'isolate:surface']));
    expect(report.events.map(e => e.observedAt)).toEqual([...report.events.map(e => e.observedAt)].sort((a, b) => a - b));
    for (const format of ['csv', 'md'] as const) expect(exportReport(report, format)).toContain('isolate: all → surface');
    expect(exportReport(report, 'csv').split('\n').filter(line => line.startsWith('"segment"'))).toHaveLength(3);
    expect(validateReport(JSON.parse(exportReport(report, 'json'))).segments).toHaveLength(3);
    // The explicit reset still clears everything, and the measures start again from one configuration.
    c.reset();
    expect([c.store!.count, c.store!.events.length, c.segmentCount]).toEqual([0, 0, 0]);
    tick(6000);
    expect([c.report().samples.map(segmentOf), c.report().segments!.length, c.report().metadata.experimental]).toEqual([[0], 1, []]);
    release();
  });
  it('segments by whatever changes the configuration, names who asked when known, and restarts on a new audio session', () => {
    const { controller: c, audio } = setup(), release = c.acquire();
    const tick = (time: number) => { c.renderer!.begin(time, 1 / 60); c.renderer!.sourceDone(); c.renderer!.end(0, 0, 0); };
    c.setRecording(true); tick(1000);
    // A laboratory's own slider is not in the ledger: the group of what changed stands for the origin.
    structuralLab.tuning.coherence = 0.8; tick(2000);
    c.overrides.set('matter.form', matterLab, 'form', 'wave', 'experiment controls'); tick(3000);
    expect(c.report().segments!.slice(1).map(s => [s.changed, s.origin])).toEqual([
      [['structural.tuning.coherence: — → 0.8'], 'structural'], [['matter.form: auto → wave'], 'experiment controls']]);
    // Two changes between two samples are one boundary: a segment is what a sample was measured under.
    c.isolate('surface'); c.overrides.releaseAll('stop experiment'); structuralLab.tuning.coherence = null; tick(4000);
    expect(c.report().segments!.at(-1)).toMatchObject({ index: 3, changed: ['matter.form: wave → auto', 'structural.tuning.coherence: 0.8 → —'], origin: 'stop experiment' });
    expect(c.store!.count).toBe(4);
    // A real change of audio session applies the invalidation rule: old measures and their segments are dropped.
    audio.session++; tick(5000);
    expect([c.store!.count, c.report().segments!.map(s => s.index), c.report().metadata.experimental]).toEqual([1, [0], []]);
    release();
  });
  it('does not call the present mixed when nothing is retained', () => {
    const { controller: c } = setup(), release = c.acquire();
    const tick = (time: number) => { c.renderer!.begin(time, 1 / 60); c.renderer!.sourceDone(); c.renderer!.end(0, 0, 0); };
    tick(1000); c.isolate('surface'); tick(2000);
    const live = c.report();
    // Not recording: the report is one sample of now, under the configuration of now.
    expect([live.samples.length, live.segments!.map(s => s.index), live.metadata.experimental]).toEqual([1, [1], ['isolate:surface']]);
    expect(live.events.some(e => e.type === 'configuration-change')).toBe(true);
    release();
  });
  it('rejects malformed segments in an imported report', () => {
    const { controller: c } = setup(), release = c.acquire(), report = c.report();
    for (const segments of [{}, [{ index: 0.5, from: 1, changed: [], configuration: '' }], [{ index: 0, from: 1, changed: [1], configuration: '' }], [{ index: 0, from: NaN, changed: [], configuration: '' }]]) {
      expect(() => validateReport({ ...report, segments })).toThrow();
    }
    release();
  });
  it('supports repeated mount/unmount without retained queries or traces', () => {
    const { controller: c } = setup();
    for (let i = 0; i < 12; i++) { const release = c.acquire(); c.setRecording(true); c.setDetailed(i % 2 === 0); c.reset(); release(); expect(c.store).toBeNull(); }
    const release = c.acquire(); c.isolate('surface'); expect(worldLab.only?.has('surface')).toBe(true);
    c.dispose(); c.dispose(); release(); expect(worldLab.only).toBeNull();
  });
});
