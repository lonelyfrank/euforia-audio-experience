import { afterEach, expect, it, vi } from 'vitest';
import { ClickTrack } from './ClickTrack';

afterEach(() => vi.unstubAllGlobals());

it('cannot restart clicks when resume completes after the panel closed', async () => {
  let resume!: () => void;
  const pending = new Promise<void>((resolve) => { resume = resolve; });
  const close = vi.fn(async () => {});
  const interval = vi.fn();
  vi.stubGlobal('window', { clearInterval: vi.fn(), setInterval: interval });
  vi.stubGlobal('AudioContext', class {
    state = 'suspended';
    resume = () => pending;
    close = close;
  });
  const clicks = new ClickTrack(vi.fn());
  const start = clicks.start();
  await clicks.stop();
  resume();
  await start;
  expect(clicks.running).toBe(false);
  expect(close).toHaveBeenCalledOnce();
  expect(interval).not.toHaveBeenCalled();
});
