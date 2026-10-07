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
    dispose = vi.fn();
  },
}));
vi.mock('three/addons/postprocessing/EffectComposer.js', () => ({ EffectComposer: class {
  addPass = vi.fn(); setPixelRatio = vi.fn(); setSize = vi.fn(); render = vi.fn(); dispose = vi.fn();
} }));
vi.mock('./Layer', () => ({ Layer: class {
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
});
