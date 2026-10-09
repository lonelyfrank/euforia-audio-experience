import { worldLab } from '../../visual-engine/VisualWorld';
import { describe, expect, it, vi } from 'vitest';
import { TEST_SIGNALS } from '../../audio/capture/testSignals';
import { AudioEngine } from '../../audio/AudioEngine';
import type { App } from '../../app/App';
import { DiagnosticsController } from '../core/DiagnosticsController';

function setup() {
  const gl = { getExtension: () => null, getParameter: () => 'test WebGL', isContextLost: () => false };
  const info = { autoReset: true, reset: vi.fn(), render: { calls: 7, points: 9, triangles: 3, lines: 2 }, memory: { geometries: 4, textures: 5 } };
  const renderer = { info, getContext: () => gl, domElement: { width: 1280, height: 720 }, getPixelRatio: () => 1 };
  const directionDebug = { renderer, qualityTier: 'high', current: null, diagnostics: null, load: { fps: 60, limit: 'none', reduced: false, step: 0, logicShare: 0, steady: true } };
  const audio = new AudioEngine();
  const app = { audio, directionDebug } as unknown as App;
  return { controller: new DiagnosticsController(app), audio, directionDebug, info };
}
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
  it('supports repeated mount/unmount without retained queries or traces', () => {
    const { controller: c } = setup();
    for (let i = 0; i < 12; i++) { const release = c.acquire(); c.setRecording(true); c.setDetailed(i % 2 === 0); c.reset(); release(); expect(c.store).toBeNull(); }
    const release = c.acquire(); c.isolate('surface'); expect(worldLab.only?.has('surface')).toBe(true);
    c.dispose(); c.dispose(); release(); expect(worldLab.only).toBeNull();
  });
});
