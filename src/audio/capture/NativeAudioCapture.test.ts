import { expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { NativeAudioCapture } from './NativeAudioCapture';
import { ClockSync } from '../../timing/ClockSync';
import { AnalysisDecoder } from '../features/decode';
import { CLOCK_FIELDS, RECORD, TAG, WIRE_VERSION } from '../features/layout';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

/** A batch that is only its clock record. */
function clockBatch(sample: number, sequence = 0): ArrayBuffer {
  const batch = new Float64Array(RECORD.clock);
  batch[0] = TAG.clock;
  batch[CLOCK_FIELDS.sample[0]] = sample;
  batch[CLOCK_FIELDS.sequence[0]] = sequence;
  return batch.buffer;
}

type StartArgs = { onFeatures: { onmessage(message: ArrayBuffer): void }; scene: { sensitivity: number; smoothing: number } };

it('uses the negotiated rate for clock records arriving before start resolves', async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== 'start_audio_capture') return undefined;
    (args as StartArgs).onFeatures.onmessage(clockBatch(44100));
    return { sampleRate: 44100, channels: 2, deviceName: '44.1 kHz', wireVersion: WIRE_VERSION };
  });
  const capture = new NativeAudioCapture('system');
  const clock = new ClockSync();
  const observed = vi.spyOn(clock, 'observe');
  await capture.start();
  capture.readFeatures(new AnalysisDecoder(), clock);
  expect(observed).toHaveBeenCalledWith(expect.any(Number), 1, 0);
  await capture.stop();
});

it('refuses a backend that encodes another version of the wire', async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'start_audio_capture' ? { sampleRate: 48000, channels: 2, deviceName: 'old', wireVersion: WIRE_VERSION - 1 } : undefined);
  const capture = new NativeAudioCapture('system');
  await expect(capture.start()).rejects.toThrow(/wire/);
  // The capture it had started is released.
  expect(vi.mocked(invoke).mock.calls.at(-1)![0]).toBe('stop_audio_capture');
});

it('starts the capture with the scene settings and forwards later changes; one channel, no PCM', async () => {
  const starts: StartArgs[] = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== 'start_audio_capture') return undefined;
    starts.push(args as StartArgs);
    return { sampleRate: 48000, channels: 2, deviceName: 'dev', wireVersion: WIRE_VERSION };
  });
  const capture = new NativeAudioCapture('microphone');
  capture.setScene(1.4, 0.3);
  // Not running yet: nothing to tell the backend.
  expect(invoke).not.toHaveBeenCalledWith('set_scene_settings', expect.anything());
  await capture.start();
  expect(starts[0].scene).toEqual({ sensitivity: 1.4, smoothing: 0.3 });
  expect(Object.keys(starts[0]).sort()).toEqual(['onFeatures', 'scene', 'source']);
  capture.setScene(0.8, 0.6);
  expect(invoke).toHaveBeenCalledWith('set_scene_settings', { scene: { sensitivity: 0.8, smoothing: 0.6 } });
  await capture.stop();
});

it('counts a batch that never arrived', async () => {
  let send: (message: ArrayBuffer) => void = () => {};
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== 'start_audio_capture') return undefined;
    send = (message) => (args as StartArgs).onFeatures.onmessage(message);
    return { sampleRate: 48000, channels: 2, deviceName: 'dev', wireVersion: WIRE_VERSION };
  });
  const capture = new NativeAudioCapture('system');
  await capture.start();
  send(clockBatch(480, 0));
  send(clockBatch(960, 1));
  send(clockBatch(1920, 3));
  capture.readFeatures(new AnalysisDecoder(), new ClockSync());
  expect(capture.stats).toMatchObject({ mode: 'native', batches: 3, missed: 1 });
  await capture.stop();
});
