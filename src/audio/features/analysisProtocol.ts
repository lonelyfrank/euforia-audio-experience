import type { BatchInfo, HostOptions, SceneSettings } from './AnalysisHost';

/** Main thread → analysis worker. */
export type ToWorker =
  | { type: 'start'; options: HostOptions; port: MessagePort | null }
  | { type: 'recycle'; buffer: ArrayBuffer }
  | { type: 'scene'; scene: SceneSettings }
  | { type: 'stop' };

/** Analysis worker → main thread. `posted` is `timeOrigin + now()` (ms), comparable across threads. */
export type FromWorker =
  | { type: 'ready'; shared: boolean; waits: boolean }
  | { type: 'error'; message: string }
  | { type: 'records'; buffer: ArrayBuffer; length: number; info: BatchInfo; posted: number };
