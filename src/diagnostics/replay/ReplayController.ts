import { SignalGenerator, type TestSignal } from '../../audio/capture/testSignals';
import { replay, type Pcm, type ReplayOptions } from '../../validation/replay';
import { DiagnosticsStore } from '../core/DiagnosticsStore';
import type { DiagnosticReport } from '../core/DiagnosticsTypes';
import { collectSnapshot, group } from '../probes/EngineProbes';

export const SCENARIOS = ['silence', 'tone400', 'singleImpulse', 'impulses', 'sweep', 'whiteNoise', 'buildDrop', 'drop', 'phrases', 'stereoWidth'] as const;
export type Scenario = typeof SCENARIOS[number];
export function syntheticPcm(signal: Scenario, seconds = 20, sampleRate = 48000): Pcm {
  if (!SCENARIOS.includes(signal) || !Number.isFinite(seconds) || seconds <= 0 || seconds > 120 || sampleRate < 8000 || sampleRate > 192000) throw new Error('Invalid synthetic scenario');
  const frames = Math.floor(seconds * sampleRate), samples = new Float32Array(frames * 2);
  const generator = new SignalGenerator(signal === 'singleImpulse' ? 'impulses' : signal === 'drop' ? 'beat124' : signal as TestSignal, sampleRate);
  generator.fillStereo(samples, frames);
  if (signal === 'singleImpulse') samples.fill(0, 2);
  if (signal === 'drop') samples.fill(0, Math.floor(frames / 2) * 2);
  return { samples, sampleRate, channels: 2 };
}
/** Reuses the existing replay, DSP, ExperienceEngine and WorldTrace. No audio in the exported report. */
export async function replayReport(pcm: Pcm, source: string, options: ReplayOptions = {}) {
  const store = new DiagnosticsStore(120);
  const result = await replay(pcm, null, { ...options, onGrid: (snapshot, audioTime) => {
    store.registry.invalidate(); collectSnapshot(store, snapshot);
    group(store, 'audio', 'audio', snapshot.acoustic, snapshot.acoustic.time, 'Rust AnalysisFrame', false, 'capture');
    store.capture(audioTime); options.onGrid?.(snapshot, audioTime);
  } });
  const report: DiagnosticReport = {
    schema: 1, metadata: { engineVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'test', gitSha: import.meta.env.VITE_GIT_SHA ?? null,
      startedAt: new Date().toISOString(), os: 'offline', backend: 'WASM CPU replay', gpu: null, capabilities: ['common-audio-grid-6Hz'], quality: 'DSP high fixed',
      resolution: 'none', source, sampleRate: pcm.sampleRate, session: 0, detail: 'basic', sampleHz: 6, profiling: false, readback: false, scene: null, seed: 1, experimental: [], configuration: 'reset-state;DSP-high;delay=' + (options.delay ?? 0.1) },
    duration: Number(result.report.seconds), samples: store.exportSamples(), events: [], labels: { ...store.labels, fps: String(options.fps ?? 60), batch: String(options.batch ?? Math.round(pcm.sampleRate / 100)) },
    limitations: ['Replay CPU PCM → WASM → Experience → World. Nessuna simulazione GPU o regia delle scene.',
      'Griglia audio comune 1/6 s dopo 2 s, ultimi 120 campioni. Seed 1 solo per SignalGenerator; stato iniziale vergine.',
      'Clock e batching conservati dal replay esistente. Il corpus resta locale; il report non contiene PCM.'],
  };
  return { ...result, diagnostics: report };
}
