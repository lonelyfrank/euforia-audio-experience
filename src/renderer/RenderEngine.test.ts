import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Three from 'three';
import { AudioAnalyzer } from '../audio/analysis/AudioAnalyzer';
import { VisualResponse } from '../audio/visual-response/VisualResponse';
import { VisualDirector } from '../director/VisualDirector';
import { RenderEngine, type SceneSource } from './RenderEngine';
import type { QualityProfile } from '../types/visualizer';
import preset from '../visualizers/tunnel/preset.json';

vi.mock('three', async (original) => ({
  ...await original<typeof Three>(),
  WebGLRenderer: class {
    domElement = { remove: vi.fn() };
    setClearColor = vi.fn();
    setPixelRatio = vi.fn();
    setSize = vi.fn();
    setRenderTarget = vi.fn();
    render = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock('./Layer', () => ({ Layer: class {
  ready = true;
  director = new VisualDirector();
  visualizer = { setPalette: vi.fn() };
  texture = null;
  update = vi.fn();
  render = vi.fn();
  resize = vi.fn();
  setLayout = vi.fn();
  dispose = vi.fn();
  constructor(_renderer: unknown, readonly source: SceneSource, readonly quality: QualityProfile) {}
} }));

let tick: FrameRequestCallback;
beforeEach(() => {
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { tick = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const input = { audio: new AudioAnalyzer().frame, response: new VisualResponse().frame };
  const host = { clientWidth: 800, clientHeight: 600, appendChild: vi.fn() } as unknown as HTMLElement;
  const engine = new RenderEngine(host, () => input);
  const source = (): SceneSource => ({ create: vi.fn(), preset });
  const layers = [];
  for (let slot = 0; slot < 3; slot++) {
    engine.setSlot(slot, source());
    engine.setSlotParams(slot, { weight: 1, size: 1, offset: 0, mirror: false, flash: 0, tint: 0, structure: 1 });
    layers.push(engine['slots'][slot].current!);
    engine.setSlot(slot, source());
    layers.push(engine['slots'][slot].current!);
  }
  engine.start();
  return { engine, layers };
}

describe('render composition budget', () => {
  it('updates all live layers but renders at most four, even during simultaneous crossfades', () => {
    const { engine, layers } = setup();
    tick(performance.now() + 16);
    expect(layers.filter((layer) => vi.mocked(layer.update).mock.calls.length > 0)).toHaveLength(6);
    expect(layers.filter((layer) => vi.mocked(layer.render).mock.calls.length > 0)).toHaveLength(4);
    engine.dispose();
    for (const layer of layers) expect(layer.dispose).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it('does not spend a GPU pass or composition slot on invisible fixtures', () => {
    const { engine, layers } = setup();
    engine.setSlotParams(0, { weight: 0, size: 1, offset: 0, mirror: false, flash: 0, tint: 0, structure: 1 });
    tick(performance.now() + 16);
    expect(layers[0].render).not.toHaveBeenCalled();
    expect(layers[1].render).not.toHaveBeenCalled();
    for (const layer of layers.slice(2)) expect(layer.render).toHaveBeenCalledOnce();
    engine.dispose();
  });

  it('times the frame from its own timestamp and never steps the scenes more than the simulations integrate', () => {
    const calls: [number, number][] = [];
    const input = { audio: new AudioAnalyzer().frame, response: new VisualResponse().frame };
    const host = { clientWidth: 800, clientHeight: 600, appendChild: vi.fn() } as unknown as HTMLElement;
    const engine = new RenderEngine(host, (dt, now) => { calls.push([dt, now]); return input; });
    engine.start();
    const start = performance.now();
    tick(start + 16);
    tick(start + 76);
    tick(start + 1076);
    expect(calls[1][0]).toBeCloseTo(0.06, 6);
    // A second-long stall is not a second-long step.
    expect(calls[2][0]).toBeCloseTo(0.08, 9);
    expect(calls[2][1]).toBeCloseTo((start + 1076) / 1000, 9);
    engine.dispose();
  });
});

describe('scene changes', () => {
  function single() {
    const input = { audio: new AudioAnalyzer().frame, response: new VisualResponse().frame };
    const host = { clientWidth: 800, clientHeight: 600, appendChild: vi.fn() } as unknown as HTMLElement;
    const engine = new RenderEngine(host, () => input);
    const source = (): SceneSource => ({ create: vi.fn(), preset });
    const slot = engine['slots'][0];
    engine.show(source());
    engine.start();
    let now = performance.now();
    const frames = (count: number, ms: number) => { for (let i = 0; i < count; i++) tick(now += ms); };
    return { engine, source, slot, frames };
  }

  it('keeps the outgoing scene on screen until the incoming one has compiled, then crosses them', () => {
    const { engine, source, slot, frames } = single();
    frames(2, 16);
    const outgoing = slot.current!;
    engine.show(source());
    const incoming = slot.current!;
    (incoming as unknown as { ready: boolean }).ready = false;
    vi.mocked(outgoing.render).mockClear();
    frames(30, 16);
    // Half a second of compiling: the old scene alone, untouched; the new one neither stepped nor drawn.
    expect(slot.mix).toBe(0);
    expect(outgoing.render).toHaveBeenCalledTimes(30);
    expect(incoming.update).not.toHaveBeenCalled();
    expect(incoming.render).not.toHaveBeenCalled();
    (incoming as unknown as { ready: boolean }).ready = true;
    frames(1, 16);
    expect(incoming.update).toHaveBeenCalledOnce();
    expect(slot.mix).toBeGreaterThan(0);
    engine.dispose();
  });

  it('crosses in 0.9 s of real time, whatever the frame rate', () => {
    for (const ms of [1000 / 144, 1000 / 60, 1000 / 20, 1000 / 12]) {
      const { engine, source, slot, frames } = single();
      frames(2, ms);
      const outgoing = slot.current!;
      engine.show(source());
      const before = Math.floor(880 / ms);
      frames(before, ms);
      expect(slot.previous, `${ms} ms`).toBe(outgoing);
      frames(Math.ceil(920 / ms) - before, ms);
      expect(slot.previous, `${ms} ms`).toBeNull();
      expect(outgoing.dispose).toHaveBeenCalledOnce();
      engine.dispose();
    }
  });

  it('drops a scene replaced before it was ever shown, without losing the one on screen', () => {
    const { engine, source, slot, frames } = single();
    frames(2, 16);
    const onScreen = slot.current!;
    engine.show(source());
    const skipped = slot.current!;
    (skipped as unknown as { ready: boolean }).ready = false;
    frames(3, 16);
    engine.show(source());
    expect(skipped.dispose).toHaveBeenCalledOnce();
    expect(onScreen.dispose).not.toHaveBeenCalled();
    expect(slot.previous).toBe(onScreen);
    frames(80, 16);
    expect(slot.previous).toBeNull();
    expect(onScreen.dispose).toHaveBeenCalledOnce();
    engine.dispose();
  });
});
