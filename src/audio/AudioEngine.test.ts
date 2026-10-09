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
    readScene: vi.fn(() => false), setScene: vi.fn(), onError: vi.fn() };
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

  it('shows the scene analysis of the source in the frame the scenes hold, and falls silent without one', async () => {
    const source = provider();
    vi.mocked(source.readScene).mockImplementation((frame) => { frame.volume = 0.8; frame.silent = false; return true; });
    vi.mocked(createCaptureProvider).mockReturnValue(source);
    const engine = new AudioEngine();
    const frame = engine.frame;
    engine.configure({ sensitivity: 1.3, smoothing: 0.4, beatResponse: false });
    engine.setDelay(0.055);
    await engine.setSource('microphone');
    // The producer analyses with the user's settings from its first frame, and learns of later changes.
    expect(source.setScene).toHaveBeenCalledWith(1.3, 0.4);
    engine.configure({ sensitivity: 0.9 });
    expect(source.setScene).toHaveBeenLastCalledWith(0.9, 0.4);
    const time = frame.time;
    engine.update(1 / 60);
    // The same object the scenes were given, 55 ms (2640 samples) behind the newest analysis, beat response off.
    expect(engine.frame).toBe(frame);
    expect(source.readScene).toHaveBeenLastCalledWith(frame, 2640, false);
    expect(frame.volume).toBe(0.8);
    expect(frame.time).toBeCloseTo(time + 1 / 60, 12);
    await engine.stop();
    for (let i = 0; i < 120; i++) engine.update(1 / 60);
    expect(frame.silent).toBe(true);
    expect(frame.volume).toBeLessThan(1e-3);
  });

  it('decodes a bounded number of hops per frame, more when frames are long, and times the frame from its own timestamp', async () => {
    const source = provider();
    source.readFeatures = vi.fn();
    vi.mocked(createCaptureProvider).mockReturnValue(source);
    const engine = new AudioEngine();
    await engine.setSource('system');
    const timed = vi.spyOn(engine.timing, 'update');
    engine.update(1 / 60, 123.456);
    expect(timed.mock.calls[0][0]).toBe(123.456);
    // 3.1 hops arrive per frame at 60 fps: four times that, so a backlog shrinks without a frame paying for all of it.
    expect(vi.mocked(source.readFeatures).mock.calls[0][2]).toBe(13);
    for (let i = 0; i < 200; i++) engine.update(1 / 20, 124 + i / 20);
    expect(vi.mocked(source.readFeatures).mock.calls.at(-1)![2]).toBe(Math.ceil((48000 / 256) * 0.05 * 4));
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
