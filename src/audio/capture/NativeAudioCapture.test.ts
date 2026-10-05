import { expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { NativeAudioCapture } from './NativeAudioCapture';
import { ClockSync } from '../../timing/ClockSync';
import { AnalysisDecoder } from '../features/decode';
import { TAG } from '../features/layout';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

it('uses the negotiated rate for clock records arriving before start resolves', async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'stop_audio_capture') return undefined;
    const { onFeatures } = args as { onFeatures: { onmessage(message: ArrayBuffer): void } };
    onFeatures.onmessage(Float64Array.of(TAG.clock, 44100, 0).buffer);
    return { sampleRate: 44100, channels: 2, deviceName: '44.1 kHz' };
  });
  const capture = new NativeAudioCapture('system');
  const clock = new ClockSync();
  const observed = vi.spyOn(clock, 'observe');
  await capture.start();
  capture.readFeatures(new AnalysisDecoder(), clock);
  expect(observed).toHaveBeenCalledWith(expect.any(Number), 1, 0);
  await capture.stop();
});
