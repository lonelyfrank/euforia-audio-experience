import { afterEach, describe, expect, it, vi } from 'vitest';
import { Color, PerspectiveCamera, Scene, Vector2, type WebGLRenderer } from 'three';
import { Layer } from './Layer';
import { QUALITY_PROFILES } from './quality';
import preset from '../visualizers/tunnel/preset.json';

afterEach(() => vi.useRealTimers());

describe('layer preparation lifetime', () => {
  it('cancels the fallback when disposed before a driver finishes compiling', async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const compiled = new Promise<void>(resolve => { complete = resolve; });
    const renderer = {
      getPixelRatio: () => 1, getSize: () => new Vector2(800, 450),
      getRenderTarget: () => null, setRenderTarget: vi.fn(), compileAsync: () => compiled,
    } as unknown as WebGLRenderer;
    const visualizer = { scene: new Scene(), camera: new PerspectiveCamera(), init() {}, resize() {}, setPalette() {}, update() {}, dispose: vi.fn() };
    const layer = new Layer(renderer, { preset, create: () => visualizer }, QUALITY_PROFILES.low,
      { width: 800, height: 450, pixelRatio: 1 }, [new Color(), new Color(), new Color()],
      { centerX: 0.5, centerY: 0.5, horizon: 0.7, reflection: 0 });
    expect(vi.getTimerCount()).toBe(1);
    layer.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(4000);
    complete(); await compiled; await Promise.resolve();
    expect(layer.ready).toBe(false);
    expect(visualizer.dispose).toHaveBeenCalledOnce();
  });
});
