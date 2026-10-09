import type { ExperienceSnapshot } from '../experience/types';
import { WasmAnalysis } from '../audio/features/WasmAnalysis';
import { ExperienceEngine } from '../experience/ExperienceEngine';
import type { AudioEvent } from '../experience/EventStream';
import { WorldTrace } from '../world/WorldTrace';

/*
 * Real-music validation: a locally supplied recording replayed through the
 * same path as live capture (WASM analysis in 10 ms batches → decoder →
 * ExperienceEngine → world), presented at a render rate with an audio delay.
 * Nothing looks ahead. The corpus is never committed (see docs/world-engine.md,
 * "Validation"); styles in a manifest only organise the report, they are
 * never given to the engine. Metrics describe behaviour, not "looks cool".
 */

export interface Pcm {
  sampleRate: number;
  channels: number;
  /** Interleaved samples, −1..1. */
  samples: Float32Array;
}

/** PCM 16/24/32-bit or IEEE float 32 WAV (also WAVE_FORMAT_EXTENSIBLE). */
export function parseWav(buffer: ArrayBuffer): Pcm {
  const view = new DataView(buffer);
  const tag = (at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let format = 0, channels = 0, sampleRate = 0, bits = 0, data = -1, size = 0;
  for (let at = 12; at + 8 <= view.byteLength;) {
    const id = tag(at), length = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      format = view.getUint16(at + 8, true); channels = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true); bits = view.getUint16(at + 22, true);
      if (format === 0xfffe) format = view.getUint16(at + 32, true);
    } else if (id === 'data') { data = at + 8; size = Math.min(length, view.byteLength - data); }
    at += 8 + length + (length & 1);
  }
  if (data < 0 || !channels || !sampleRate) throw new Error('missing fmt or data chunk');
  const bytes = bits / 8, count = Math.floor(size / bytes);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const at = data + i * bytes;
    if (format === 3 && bits === 32) samples[i] = view.getFloat32(at, true);
    else if (format === 1 && bits === 16) samples[i] = view.getInt16(at, true) / 32768;
    else if (format === 1 && bits === 24) samples[i] = ((view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) / 8388608);
    else if (format === 1 && bits === 32) samples[i] = view.getInt32(at, true) / 2147483648;
    else throw new Error(`unsupported WAV format ${format}/${bits} bit`);
  }
  return { sampleRate, channels, samples };
}

/** Beat annotation: one `time [position]` per line (position 1 = downbeat), as for the Rust corpus tool. */
export function parseBeats(text: string): { time: number; position: number }[] {
  return text.split('\n').map((line) => line.trim().split(/[\s,]+/)).filter((f) => f[0] && !Number.isNaN(+f[0]))
    .map((f) => ({ time: +f[0], position: f[1] ? +f[1] : 0 }));
}

export interface ReplayOptions {
  /** Diagnostics observation on the common audio grid; borrowed snapshot, read-only. */
  onGrid?: (snapshot: ExperienceSnapshot, audioTime: number) => void;
  /** Optional yielding for the DEV replay worker; never the live pipeline. */
  onProgress?: (seconds: number) => Promise<void>;
  /** Render rate of the presentation (fps) and analysis batch (frames). */
  fps?: number;
  batch?: number;
  /** Audio delay: the frame shows what was heard this long ago (s). */
  delay?: number;
  /** Trace sampling rate (Hz). */
  traceRate?: number;
  /** Stop after this many seconds (for the invariance pass). */
  limit?: number;
}

export interface ReplayResult {
  report: Record<string, number | string | null>;
  trace: WorldTrace;
  /** World positions/velocities on a fixed grid (1/6 s), for comparing runs. */
  grid: number[];
}

const TOLERANCE = 0.07;
const SKIP = 5;

export async function replay(pcm: Pcm, beats: { time: number; position: number }[] | null, options: ReplayOptions = {}): Promise<ReplayResult> {
  const { fps = 60, batch = Math.round(pcm.sampleRate / 100), delay = 0.1, traceRate = 20, limit = Infinity } = options;
  if (![pcm.sampleRate, pcm.channels, fps, batch, traceRate].every(x => Number.isFinite(x) && x > 0) || !Number.isInteger(batch) || !Number.isInteger(pcm.channels) || !Number.isFinite(delay) || delay < 0) throw new Error('Invalid replay configuration');
  // The analysis takes mono or stereo; more channels are folded to the first two.
  const channels = Math.min(2, pcm.channels);
  const frames = Math.min(Math.floor(pcm.samples.length / pcm.channels), Math.floor(limit * pcm.sampleRate));
  const wasm = await WasmAnalysis.create(pcm.sampleRate, channels);
  const engine = new ExperienceEngine();
  const decoder = wasm.decoder;
  decoder.onFrame = (a) => engine.ingest(a);
  decoder.onOnset = (o) => engine.onset(o);
  decoder.onBeat = (b) => engine.beat(b);
  decoder.onSection = (s) => engine.section(s);
  const trace = new WorldTrace(Math.ceil((frames / pcm.sampleRate) * traceRate) + 8);
  const chunk = new Float32Array(batch * channels);
  const beatTimes: number[] = [], downbeatTimes: number[] = [], beatBpm: number[] = [];
  const events: Record<string, number> = {};
  const anticipations: number[] = [], drops: number[] = [];
  const silences: { start: number; end: number }[] = [];
  const grid: number[] = [];
  let captured = 0, traced = -Infinity, smooth = 0, previous = NaN, maxEnergy = 0, maxSpeed = 0, saturated = 0, presented = 0;
  let anticipating = false, silenceAt = -1;
  decoder.onBeat = (b) => {
    engine.beat(b);
    beatTimes.push(b.time); beatBpm.push(b.bpm);
    if (b.downbeat) downbeatTimes.push(b.time);
  };
  const cursor = { time: -Infinity, seq: 0 };
  const onEvent = (e: AudioEvent) => {
    events[e.type] = (events[e.type] ?? 0) + 1;
    if (e.type === 'drop') drops.push(e.audioTime);
    if (e.type === 'silenceStart') silenceAt = e.audioTime;
    if (e.type === 'silenceEnd' && silenceAt >= 0) { silences.push({ start: silenceAt, end: e.audioTime }); silenceAt = -1; }
  };
  const total = frames / pcm.sampleRate;
  try {
    for (let f = 1; f <= Math.ceil(total * fps); f++) {
      const now = f / fps;
      if (options.onProgress && f % Math.ceil(fps) === 0) await options.onProgress(now);
      decoder.begin();
      while (captured + batch <= Math.min(frames, Math.floor(now * pcm.sampleRate))) {
        for (let i = 0; i < batch; i++) {
          const from = (captured + i) * pcm.channels;
          chunk[i * channels] = pcm.samples[from];
          if (channels === 2) chunk[i * 2 + 1] = pcm.samples[from + 1];
        }
        wasm.push(chunk);
        captured += batch;
      }
      const heard = now - delay;
      const s = engine.present(heard);
      if (!s) continue;
      engine.events.forEachHeard(cursor, heard, onEvent);
      presented++;
      const w = s.world;
      // Smoothness: the largest change of the presented radial body in one frame (no discontinuities).
      if (!Number.isNaN(previous)) smooth = Math.max(smooth, Math.abs(w.radius - previous));
      previous = w.radius;
      maxEnergy = Math.max(maxEnergy, w.energy); maxSpeed = Math.max(maxSpeed, Math.abs(w.speed));
      if (Math.max(w.excitation, w.shimmer, w.turbulence, w.potential, w.illumination) > 0.98) saturated++;
      const anticipation = s.state.anticipation > 0.4;
      if (anticipation && !anticipating) anticipations.push(s.state.time);
      anticipating = anticipation;
      if (heard - traced >= 1 / traceRate - 1e-9) { trace.sample(s); traced = heard; }
      if (Math.abs(now * 6 - Math.round(now * 6)) < 1e-6 && heard > 2) {
        grid.push(heard, w.radius, w.radialVelocity, w.angle, w.spin, w.travel, w.speed, w.bias, w.excitation, w.turbulence, w.potential);
        options.onGrid?.(s, heard);
      }
    }
  } finally { wasm.dispose(); }
  const report: Record<string, number | string | null> = {
    seconds: round(total), sampleRate: pcm.sampleRate, channels: pcm.channels, presentedFrames: presented,
    onsetsPerSecond: round((events.onset ?? 0) / total), beats: beatTimes.length,
    ...tempo(beatBpm, beatTimes),
    ...scoreBeats(beatTimes, downbeatTimes, beats),
    meterConfident: round(fraction(trace.column('meterConfidence'), (x) => x > 0.2)),
    meterMode: mode(trace.column('meter')),
    downbeatConfidence: round(mean(trace.column('downbeatConfidence'))),
    sections: events.sectionBoundary ?? 0, phrases: events.phraseBoundary ?? 0,
    sectionNoveltyP90: round(quantile(trace.column('sectionNovelty'), 0.9)),
    recurrenceMax: Math.max(0, ...trace.column('recurrence')),
    energyMean: round(mean(trace.column('energy'))), complexityMean: round(mean(trace.column('complexity'))),
    // Energy and complexity must stay distinct: a correlation near 1 would mean one generic intensity.
    energyComplexityCorrelation: round(correlation(trace.column('energy'), trace.column('complexity'))),
    predictionConfidence: round(mean(trace.column('predictionConfidence'))),
    anticipations: anticipations.length, drops: drops.length,
    // An anticipation episode not followed by a release within 8 s.
    falseAnticipations: anticipations.filter((t) => !drops.some((d) => d >= t && d - t <= 8)).length,
    impacts: events.impact ?? 0, silences: silences.length,
    worldEnergyMax: round(maxEnergy), worldSpeedMax: round(maxSpeed),
    worldSaturatedShare: round(saturated / Math.max(1, presented)),
    worldMaxRadialStepPerFrame: round(smooth),
    ...silenceDecay(trace, silences),
  };
  return { report, trace, grid };
}

/** Tempo stability: median BPM, interquartile spread relative to it, jumps > 4% between beats (after the lock-in). */
function tempo(bpm: number[], times: number[]): Record<string, number | null> {
  const kept = bpm.filter((_, i) => times[i] > SKIP && bpm[i] > 0);
  if (kept.length < 4) return { bpmMedian: null, bpmIqrRatio: null, bpmJumps: null };
  const median = quantile(kept, 0.5);
  let jumps = 0;
  for (let i = 1; i < kept.length; i++) if (Math.abs(kept[i] - kept[i - 1]) / kept[i - 1] > 0.04) jumps++;
  return { bpmMedian: round(median), bpmIqrRatio: round((quantile(kept, 0.75) - quantile(kept, 0.25)) / median), bpmJumps: jumps };
}

/** Beat / downbeat F1 at ±70 ms and median phase error, after the first 5 s (as the Rust corpus tool). */
function scoreBeats(found: number[], downbeats: number[], truth: { time: number; position: number }[] | null): Record<string, number | null> {
  if (!truth) return { beatF1: null, beatPhaseMs: null, downbeatF1: null };
  const ref = truth.filter((b) => b.time > SKIP);
  const [f1, errors] = match(found.filter((t) => t > SKIP), ref.map((b) => b.time));
  const downRef = ref.filter((b) => b.position === 1).map((b) => b.time);
  return {
    beatF1: round(f1), beatPhaseMs: errors.length ? round(quantile(errors, 0.5) * 1000) : null,
    downbeatF1: downRef.length ? round(match(downbeats.filter((t) => t > SKIP), downRef)[0]) : null,
  };
}

function match(found: number[], ref: number[]): [number, number[]] {
  const used = new Uint8Array(found.length);
  const errors: number[] = [];
  for (const r of ref) {
    let best = -1;
    for (let i = 0; i < found.length; i++) if (!used[i] && Math.abs(found[i] - r) <= TOLERANCE && (best < 0 || Math.abs(found[i] - r) < Math.abs(found[best] - r))) best = i;
    if (best >= 0) { used[best] = 1; errors.push(Math.abs(found[best] - r)); }
  }
  const precision = found.length ? errors.length / found.length : 0, recall = ref.length ? errors.length / ref.length : 0;
  return [precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0, errors];
}

/** World energy half-life in silences of at least 2 s (the decay is part of the experience). */
function silenceDecay(trace: WorldTrace, silences: { start: number; end: number }[]): Record<string, number | null> {
  const time = trace.column('time'), energy = trace.column('worldEnergy');
  const halfLives: number[] = [];
  let rising = 0;
  for (const { start, end } of silences) {
    if (end - start < 2) continue;
    let i = time.findIndex((t) => t >= start);
    if (i < 0) continue;
    const initial = energy[i];
    for (let j = i + 1; j < time.length && time[j] <= end; j++) if (energy[j] > energy[j - 1] + 1e-6) rising++;
    for (; i < time.length && time[i] <= end; i++) if (energy[i] <= initial / 2) { halfLives.push(time[i] - start); break; }
  }
  return { silenceHalfLife: halfLives.length ? round(quantile(halfLives, 0.5)) : null, silenceEnergyRises: rising };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
function mean(x: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i];
  return x.length ? sum / x.length : 0;
}
function quantile(x: ArrayLike<number>, q: number): number {
  const sorted = Array.from(x).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] : 0;
}
function fraction(x: ArrayLike<number>, test: (v: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < x.length; i++) if (test(x[i])) n++;
  return x.length ? n / x.length : 0;
}
function mode(x: ArrayLike<number>): number {
  const counts = new Map<number, number>();
  for (let i = 0; i < x.length; i++) counts.set(x[i], (counts.get(x[i]) ?? 0) + 1);
  let best = 0, count = -1;
  for (const [value, n] of counts) if (n > count) { best = value; count = n; }
  return best;
}
function correlation(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}
