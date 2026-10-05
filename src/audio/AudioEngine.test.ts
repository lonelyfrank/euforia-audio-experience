import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AudioEngine } from './AudioEngine';
import { createCaptureProvider } from './capture/createCaptureProvider';
import type { AudioCaptureProvider } from './capture/AudioCaptureProvider';

vi.mock('./capture/createCaptureProvider', () => ({ createCaptureProvider: vi.fn() }));

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

  it('restarts everything on the capture clock when the provider analysis starts a new epoch', async () => {
    let epoch = 0;
    const source = provider();
    Object.defineProperty(source, 'epoch', { get: () => epoch });
    source.readFeatures = vi.fn();
    vi.mocked(createCaptureProvider).mockReturnValue(source);
    const engine = new AudioEngine();
    await engine.setSource('fake');
    engine.update(1 / 60);
    engine.clock.observe(10, 1);
    const session = engine.session;
    engine.update(1 / 60);
    expect(engine.session).toBe(session);
    expect(engine.clock.ready).toBe(true);
    epoch = 1;
    engine.update(1 / 60);
    expect(engine.session).toBe(session + 1);
    // The old clock mapping is gone before the new epoch's records are read.
    expect(engine.clock.ready).toBe(false);
    expect(vi.mocked(source.readFeatures!).mock.invocationCallOrder.length).toBe(3);
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
