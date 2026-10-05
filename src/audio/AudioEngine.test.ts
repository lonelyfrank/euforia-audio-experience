import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AudioEngine } from './AudioEngine';
import { createCaptureProvider } from './capture/createCaptureProvider';
import type { AudioCaptureProvider } from './capture/AudioCaptureProvider';
import { WasmAnalysis } from './features/WasmAnalysis';

vi.mock('./capture/createCaptureProvider', () => ({ createCaptureProvider: vi.fn() }));
vi.mock('./features/WasmAnalysis', () => ({ WasmAnalysis: { create: vi.fn() } }));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function provider(start = async () => {}): AudioCaptureProvider {
  return { id: 'microphone', sampleRate: 48000, deviceName: 'Test', start: vi.fn(start), stop: vi.fn(async () => {}),
    readSamples: vi.fn(), onError: vi.fn() };
}

beforeEach(() => vi.clearAllMocks());

describe('AudioEngine source ownership', () => {
  it('skips superseded requests before opening a device', async () => {
    const engine = new AudioEngine();
    const last = provider();
    vi.mocked(createCaptureProvider).mockReturnValue(last);
    await Promise.all([engine.setSource('microphone'), engine.setSource('system'), engine.setSource('fake')]);
    expect(createCaptureProvider).toHaveBeenCalledTimes(1);
    expect(createCaptureProvider).toHaveBeenCalledWith('fake', undefined);
    expect(engine.state).toMatchObject({ source: 'fake', status: 'running' });
    await engine.stop();
  });

  it('finishes stopping an obsolete native capture before starting the next', async () => {
    const start = deferred();
    const started = deferred();
    const stopped = deferred();
    const stopping = deferred();
    const old = provider(() => { started.resolve(); return start.promise; });
    vi.mocked(old.stop).mockImplementation(() => { stopping.resolve(); return stopped.promise; });
    const next = provider();
    vi.mocked(createCaptureProvider).mockReturnValueOnce(old).mockReturnValueOnce(next);
    const engine = new AudioEngine();
    const first = engine.setSource('system');
    await started.promise;
    const second = engine.setSource('microphone');
    start.resolve();
    await stopping.promise;
    expect(next.start).not.toHaveBeenCalled();
    expect(engine.state).toMatchObject({ source: 'microphone', status: 'starting' });
    stopped.resolve();
    await Promise.all([first, second]);
    expect(engine.state).toMatchObject({ source: 'microphone', status: 'running' });
    await engine.stop();
  });

  it('does not publish a stale running state after WASM initialization', async () => {
    const creating = deferred();
    const module = deferred<WasmAnalysis>();
    const old = provider();
    old.drain = () => 0;
    const analysis = { dispose: vi.fn() } as unknown as WasmAnalysis;
    vi.mocked(WasmAnalysis.create).mockImplementation(() => { creating.resolve(); return module.promise; });
    vi.mocked(createCaptureProvider).mockReturnValueOnce(old).mockReturnValueOnce(provider());
    const engine = new AudioEngine();
    const states: string[] = [];
    engine.subscribe((s) => states.push(`${s.source}:${s.status}`));
    const first = engine.setSource('fake');
    await creating.promise;
    const second = engine.setSource('microphone');
    module.resolve(analysis);
    await Promise.all([first, second]);
    expect(states).not.toContain('fake:running');
    expect(analysis.dispose).toHaveBeenCalledOnce();
    await engine.stop();
  });

  it('recovers after a failed start and cleans up pending starts on stop', async () => {
    const broken = provider(async () => { throw new Error('unplugged'); });
    vi.mocked(createCaptureProvider).mockReturnValueOnce(broken).mockReturnValueOnce(provider());
    const engine = new AudioEngine();
    await engine.setSource('microphone');
    expect(engine.state).toMatchObject({ status: 'error', error: 'unplugged' });
    expect(broken.stop).toHaveBeenCalledOnce();
    const queued = engine.setSource('system');
    await engine.stop();
    await queued;
    expect(engine.state.status).toBe('idle');
    expect(createCaptureProvider).toHaveBeenCalledTimes(1);
  });
});
