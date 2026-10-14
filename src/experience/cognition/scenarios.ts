import { newFrame, type AnalysisFrame, type BeatEvent, type OnsetEvent, type SectionEvent } from '../../audio/features/decode';
import type { CognitionContext, MusicalCognition } from './MusicalCognition';

/*
 * Synthetic feature sequences for the musical cognition: what the DSP would send for a piece of known form, hop by hop,
 * with the truth beside it (beats, downbeats, phrase boundaries, releases, transitions, silences). No audio: the frame
 * fields the cognition reads are written directly, and the beat tracker is a deliberately simple mock of the DSP's
 * (it locks after two seconds of pulse, follows a tempo change after 2.5 s, freewheels eight beats without support,
 * publishes a meter only when the downbeats are accented). The real tracker is exercised by the tests that run test
 * signals through the WASM analysis; these sequences test what the cognition makes of a given input, deterministically.
 */

export const HOP = 256 / 48000;
/** A segment of the piece. Metric segments last whole bars; the others, seconds. */
export interface Segment {
  kind: 'groove' | 'build' | 'drop' | 'breakdown' | 'pause' | 'noise' | 'gap';
  bars?: number;
  seconds?: number;
  bpm?: number;
  meter?: number;
  /** Harmonic pattern (a 4-bar cycle of roots); a phrase starts a new one. */
  pattern?: number;
  /** The pattern changes every this many bars (a phrase), counted from the segment's start; 0: never. */
  phrase?: number;
  /** 0..1: how much the downbeat's low end stands above the other beats' (0: four equal kicks). */
  accent?: number;
  /** Kick on alternate beats only, a snare between (felt at half the tempo). */
  halfTime?: boolean;
  /** Low-end hits halfway between the beats too (felt at twice the tempo). */
  offbeatKick?: boolean;
  /** Beats (index within the segment) whose kick is missing. */
  skip?: readonly number[];
}
export interface Scenario { id: string; label: string; segments: readonly Segment[] }
export interface Truth {
  beats: number[];
  downbeats: number[];
  phrases: number[];
  releases: number[];
  transitions: number[];
  silences: [number, number][];
  gaps: [number, number][];
  tempoChanges: number[];
  duration: number;
}
/** Where a run delivers what the DSP would. */
export interface ScenarioSink {
  /** Before the first hop: what the piece is (for an evaluation that samples against it). */
  start?(truth: Readonly<Truth>): void;
  hop(a: AnalysisFrame, context: CognitionContext, dt: number): void;
  onset(o: OnsetEvent): void;
  beat(b: BeatEvent): void;
  section(e: SectionEvent): void;
  /** The analysis stopped arriving (the next hop comes after a gap). */
  gap(): void;
}

const groove = (bars: number, more: Partial<Segment> = {}): Segment => ({ kind: 'groove', bars, ...more });
export const SCENARIOS: readonly Scenario[] = [
  { id: 'stable', label: 'Groove stabile, frasi di 8 battute', segments: [groove(48, { accent: 0.5, phrase: 8 })] },
  { id: 'tempoChange', label: 'Cambio di tempo 120 → 132', segments: [groove(16, { bpm: 120, accent: 0.5, phrase: 8 }), groove(16, { bpm: 132, accent: 0.5, phrase: 8, pattern: 2 })] },
  { id: 'halfTime', label: 'Half-time a 172 (cassa a beat alterni)', segments: [groove(24, { bpm: 172, halfTime: true, accent: 0.3 })] },
  { id: 'doubleTime', label: 'Double-time a 86 (bassi anche fra i beat)', segments: [groove(16, { bpm: 86, offbeatKick: true, accent: 0.3 })] },
  { id: 'waltz', label: 'Metro 3/4 a 150', segments: [groove(32, { bpm: 150, meter: 3, accent: 0.6, phrase: 8 })] },
  { id: 'meterChange', label: 'Cambio di metro 4/4 → 3/4', segments: [groove(16, { accent: 0.6, phrase: 8 }), groove(24, { bpm: 124, meter: 3, accent: 0.6, pattern: 3, phrase: 8 })] },
  { id: 'dropout', label: 'Due casse mancanti nel groove', segments: [groove(24, { accent: 0.5, phrase: 8, skip: [64, 65] })] },
  { id: 'shortPause', label: 'Pausa di due beat, poi ripresa a tempo', segments: [groove(12, { accent: 0.5 }), { kind: 'pause', seconds: 2 * 60 / 124 }, groove(12, { accent: 0.5 })] },
  { id: 'longPause', label: 'Pausa di 6 s, poi ripresa', segments: [groove(12, { accent: 0.5 }), { kind: 'pause', seconds: 6 }, groove(12, { accent: 0.5, pattern: 1 })] },
  { id: 'loop', label: 'Loop di 4 battute ripetuto', segments: [groove(32, { accent: 0.5 })] },
  { id: 'phrases16', label: 'Frasi di 16 battute', segments: [groove(64, { accent: 0.5, phrase: 16 })] },
  { id: 'offPhrase', label: 'Cambio fuori dalla frase attesa', segments: [groove(36, { accent: 0.5, phrase: 8 }), groove(16, { accent: 0.5, pattern: 5, phrase: 8 })] },
  { id: 'buildDrop', label: 'Groove → build → drop', segments: [groove(16, { accent: 0.5, phrase: 8 }), { kind: 'build', bars: 8, pattern: 1 }, { kind: 'drop', bars: 16, accent: 0.5, pattern: 2, phrase: 8 }] },
  { id: 'lateDrop', label: 'Build oltre la frase, drop in ritardo', segments: [groove(16, { accent: 0.5, phrase: 8 }), { kind: 'build', bars: 12, pattern: 1 }, { kind: 'drop', bars: 16, accent: 0.5, pattern: 2, phrase: 8 }] },
  { id: 'falseBuild', label: 'Build senza drop (si spegne)', segments: [groove(16, { accent: 0.5, phrase: 8 }), { kind: 'build', bars: 8, pattern: 1 }, { kind: 'breakdown', bars: 16, pattern: 3 }] },
  { id: 'noise', label: 'Audio non musicale (rumore)', segments: [{ kind: 'noise', seconds: 30 }] },
  { id: 'silence', label: 'Silenzio prolungato', segments: [{ kind: 'pause', seconds: 20 }] },
  { id: 'sourceLost', label: 'Sorgente interrotta per 3 s', segments: [groove(12, { accent: 0.5 }), { kind: 'gap', seconds: 3 }, groove(12, { accent: 0.5 })] },
];

const ROOTS = [[0, 5, 7, 3], [2, 9, 4, 11], [7, 0, 2, 5], [9, 4, 11, 6], [3, 10, 5, 8], [6, 1, 8, 11]];
const pulsed = (k: Segment['kind']): boolean => k === 'groove' || k === 'drop' || k === 'build';
const metric = (k: Segment['kind']): boolean => k === 'groove' || k === 'drop' || k === 'build' || k === 'breakdown';

interface Hit { time: number; strength: number; low: number; region: number }
interface Planned { start: number; end: number; segment: Segment; period: number; meter: number; firstBar: number }

/** Deterministic pseudo-random sequence (the noise segments, the tracker's jitter). */
class Lcg { private s = 12345; next(): number { this.s = (this.s * 1103515245 + 12345) & 0x7fffffff; return this.s / 0x7fffffff; } }

/** Runs `scenario` into `sink`; returns the truth. Allocation per run, not per hop beyond the event objects reused. */
export function runScenario(scenario: Scenario, sink: ScenarioSink): Truth {
  const truth: Truth = { beats: [], downbeats: [], phrases: [], releases: [], transitions: [], silences: [], gaps: [], tempoChanges: [], duration: 0 };
  // ---- the form, as times ----
  const plan: Planned[] = [], hits: Hit[] = [], kicks: number[] = [];
  const random = new Lcg();
  let t = 0.5, bpm = 124, bar = 0, previous: Segment | null = null;
  for (const s of scenario.segments) {
    if (s.bpm && s.bpm !== bpm && previous && metric(previous.kind)) truth.tempoChanges.push(t);
    bpm = s.bpm ?? bpm;
    const meter = s.meter ?? 4, period = 60 / bpm;
    if (metric(s.kind)) {
      const bars = s.bars ?? 8, start = t;
      if (previous && previous.kind !== s.kind) truth.transitions.push(start);
      if (s.kind === 'drop') truth.releases.push(start);
      for (let b = 0; b < bars; b++) {
        const barStart = start + b * meter * period;
        if (pulsed(s.kind)) truth.downbeats.push(barStart);
        if (s.phrase && b % s.phrase === 0 && pulsed(s.kind)) truth.phrases.push(barStart);
        for (let k = 0; k < meter; k++) {
          const index = b * meter + k, at = barStart + k * period, progress = (b + k / meter) / bars;
          if (s.kind === 'groove' || s.kind === 'drop') {
            truth.beats.push(at);
            const accent = k === 0 ? 1 : 1 - (s.accent ?? 0) * 0.5;
            const kick = !(s.skip?.includes(index)) && !(s.halfTime && index % 2 === 1);
            if (kick) { hits.push({ time: at, strength: s.kind === 'drop' && index === 0 ? 1 : 0.8, low: 0.9 * accent, region: 0 }); kicks.push(at); }
            if (s.halfTime && index % 2 === 1) hits.push({ time: at, strength: 0.7, low: 0.25, region: 1 });
            hits.push({ time: at + period / 2, strength: 0.35, low: 0.02, region: 2 });
            if (s.offbeatKick) hits.push({ time: at + period / 2, strength: 0.7, low: 0.8 * accent, region: 0 });
          } else if (s.kind === 'build') {
            truth.beats.push(at);
            const division = 2 ** Math.min(3, Math.floor(progress * 4));
            for (let d = 0; d < division; d++) hits.push({ time: at + d * period / division, strength: 0.3 + 0.5 * progress, low: 0.3, region: 1 });
            kicks.push(at);
          } else if (k === 0) hits.push({ time: at + 0.01, strength: 0.2, low: 0.1, region: 1 });
        }
      }
      t = start + bars * meter * period;
      plan.push({ start, end: t, segment: s, period, meter, firstBar: bar });
      bar += bars;
    } else {
      const seconds = s.seconds ?? 4, start = t;
      if (s.kind === 'pause') truth.silences.push([start, start + seconds]);
      if (s.kind === 'gap') truth.gaps.push([start, start + seconds]);
      if (s.kind === 'noise') for (let x = start + random.next(); x < start + seconds; x += 0.4 + random.next() * 1.2) hits.push({ time: x, strength: 0.3 + 0.3 * random.next(), low: 0.05, region: 2 });
      t = start + seconds;
      plan.push({ start, end: t, segment: s, period, meter, firstBar: bar });
    }
    previous = s;
  }
  t += 1;
  truth.duration = t;
  hits.sort((a, b) => a.time - b.time);
  sink.start?.(truth);

  // ---- the hops ----
  const a = newFrame();
  const onset: OnsetEvent = { sample: 0, time: 0, strength: 0, region: 0, low: 0 };
  const beat: BeatEvent = { sample: 0, time: 0, index: 0, barPosition: 0, downbeat: 0, bpm: 0, confidence: 0, downbeatConfidence: 0 };
  const section: SectionEvent = { sample: 0, time: 0, kind: 0, previous: 0, id: 0, bar: 0, confidence: 0.5, novelty: 0.5 };
  const context = { anticipation: 0, anticipationConfidence: 0 };
  const tracker = { tracking: false, period: 0, next: 0, conf: 0, missed: 0, pulseFor: 0, index: 0, retempoAt: -1, accentBars: 0 };
  let nextHit = 0, sectionsDone = 0, time = 0, segmentAt = 0, lastTime = 0;
  const sections = plan.filter((p, i) => i > 0 && metric(p.segment.kind) && p.segment.kind !== plan[i - 1].segment.kind)
    .map(p => ({ time: p.start + p.period, at: p.start, kind: p.segment.kind === 'drop' ? 2 : p.segment.kind === 'breakdown' ? 3 : p.segment.kind === 'build' ? 1 : 0 }));
  let id = 0;
  while (time < truth.duration) {
    time += HOP;
    while (segmentAt < plan.length - 1 && time >= plan[segmentAt].end) segmentAt++;
    const p = plan[segmentAt], s = time < p.end && time >= p.start ? p.segment : null;
    const kind = s?.kind ?? 'pause';
    if (kind === 'gap') {
      // Nothing arrives; the next hop jumps the gap.
      tracker.tracking = false; tracker.conf = 0; tracker.pulseFor = 0;
      while (nextHit < hits.length && hits[nextHit].time < p.end) nextHit++;
      time = p.end; sink.gap(); lastTime = time;
      continue;
    }
    const dt = time - lastTime; lastTime = time;
    const progress = s && metric(kind) ? (time - p.start) / (p.end - p.start) : 0;
    const barInSegment = s && metric(kind) ? Math.floor((time - p.start) / (p.meter * p.period)) : 0;
    const sound = kind !== 'pause';
    // Frame: levels, spectral shape, low end, chroma, attacks.
    const level = kind === 'drop' ? -14 : kind === 'groove' ? -16 : kind === 'build' ? -24 + 10 * progress : kind === 'breakdown' ? -26 : -18;
    const sub = kind === 'groove' || kind === 'drop' ? 0 : kind === 'build' ? -30 : kind === 'breakdown' ? -60 : -25;
    const pattern = (s?.pattern ?? 0) + (s?.phrase ? Math.floor(barInSegment / s.phrase) : 0);
    a.time = time; a.sample = Math.round(time * 48000);
    a.presence = sound ? 1 : 0; a.sounding = sound ? 1 : 0; a.silent = sound ? 0 : 1;
    a.loudnessMomentary = sound ? level : -70;
    a.loudnessPosition = !sound ? 0 : kind === 'drop' ? 0.85 : kind === 'groove' ? 0.6 : kind === 'build' ? 0.3 + 0.6 * progress : kind === 'breakdown' ? 0.2 : 0.5;
    for (let b = 0; b < 8; b++) a.bandDb[b] = !sound ? -120 : b === 0 ? level + sub : level - 6 - 2 * b + 1.5 * Math.sin(pattern * 1.7 + b);
    for (let b = 0; b < 8; b++) a.bandLevel[b] = sound ? 0.8 : 0;
    const roots = ROOTS[pattern % ROOTS.length], root = metric(kind) ? roots[(kind === 'groove' || kind === 'drop' ? barInSegment : 0) % 4] : 0;
    for (let c = 0; c < 12; c++) a.chroma[c] = kind === 'noise' ? 0.3 : c === root ? 1 : c === (root + 7) % 12 ? 0.6 : 0.1;
    a.chromaConfidence = !sound ? 0 : kind === 'noise' ? 0.1 : 0.7;
    a.percussiveShare = !sound ? 0 : kind === 'groove' || kind === 'drop' ? 0.45 : kind === 'build' ? 0.35 : kind === 'breakdown' ? 0.05 : 0.2;
    a.flatness = kind === 'noise' ? 0.8 : kind === 'build' ? 0.2 + 0.4 * progress : 0.15;
    let strength = 0, density = 0;
    for (let i = Math.max(0, nextHit - 40); i < Math.min(hits.length, nextHit + 4); i++) {
      const h = hits[i];
      if (h.time <= time && h.time > time - 2) density++;
      if (h.time <= time) strength = Math.max(strength, h.strength * Math.exp(-(time - h.time) / 0.03));
    }
    a.onsetStrength = sound ? strength : 0; a.onsetDensity = sound ? density / 2 : 0;
    // The experience's build evidence (what ExperienceEngine would give the cognition).
    context.anticipation = kind === 'build' ? 0.2 + 0.6 * progress : sound ? 0.1 : 0;
    context.anticipationConfidence = sound ? 0.7 : 0;

    // Mock tracker.
    const truePulse = s && pulsed(kind);
    tracker.pulseFor = truePulse ? tracker.pulseFor + dt : 0;
    if (!tracker.tracking && tracker.pulseFor >= 2 && s) {
      tracker.tracking = true; tracker.period = p.period; tracker.conf = 0.2; tracker.missed = 0;
      tracker.next = p.start + Math.ceil((time - p.start) / p.period) * p.period;
    }
    if (tracker.tracking && s && pulsed(kind) && Math.abs(p.period - tracker.period) > 1e-6) {
      // A new tempo: the tracker keeps its period until the disagreement has lasted 2.5 s.
      if (tracker.retempoAt < 0) tracker.retempoAt = time + 2.5;
      else if (time >= tracker.retempoAt) { tracker.period = p.period; tracker.next = p.start + Math.ceil((time - p.start) / p.period) * p.period; tracker.retempoAt = -1; }
    }
    if (tracker.tracking) {
      if (time >= tracker.next) {
        const at = tracker.next;
        const supported = kicks.some(k => Math.abs(k - at) < 0.05);
        if (supported) { tracker.conf += (0.95 - tracker.conf) * 0.25; tracker.missed = 0; } else { tracker.conf *= 0.8; tracker.missed++; }
        const accented = s && (s.accent ?? 0) > 0 && metric(kind);
        if (accented && s && Math.abs(((at - p.start) / p.period) % p.meter) < 0.01) tracker.accentBars++;
        const position = s && metric(kind) ? Math.round((at - p.start) / p.period) % p.meter : tracker.index % 4;
        a.meter = accented && tracker.accentBars >= 8 ? p.meter : 0;
        a.meterConfidence = a.meter > 0 ? 0.6 : 0;
        a.downbeatConfidence = accented && tracker.accentBars >= 6 ? 0.7 * tracker.conf : 0;
        Object.assign(beat, { sample: Math.round(at * 48000), time: at, index: tracker.index++, barPosition: accented ? position : tracker.index % 4,
          downbeat: (accented ? position : tracker.index % 4) === 0 ? 1 : 0, bpm: 60 / tracker.period, confidence: tracker.conf, downbeatConfidence: a.downbeatConfidence });
        if (tracker.missed > 8) { tracker.tracking = false; tracker.conf = 0; tracker.accentBars = 0; }
        else { sink.beat(beat); tracker.next += tracker.period; }
        // A grid kept on the beats it hears.
        if (s && truePulse) { const k = Math.round((tracker.next - p.start) / p.period); const near = p.start + k * p.period; if (Math.abs(near - tracker.next) < 0.2 * p.period && tracker.retempoAt < 0) tracker.next = near; }
      }
    }
    a.beatBpm = tracker.tracking ? 60 / tracker.period : 0; a.beatConfidence = tracker.tracking ? tracker.conf : 0;
    a.beatPhase = tracker.tracking ? Math.max(0, Math.min(1, 1 - (tracker.next - time) / tracker.period)) : 0;
    a.nextBeatTime = tracker.tracking ? tracker.next : 0;
    a.tempoBpm = a.beatBpm; a.tempoConfidence = a.beatConfidence;
    if (!tracker.tracking) { a.meter = 0; a.meterConfidence = 0; a.downbeatConfidence = 0; }

    sink.hop(a, context, dt);
    // Onsets are reported a hop after their peak; sections a beat after their downbeat.
    while (nextHit < hits.length && hits[nextHit].time <= time - HOP) {
      const h = hits[nextHit++];
      Object.assign(onset, { sample: Math.round(h.time * 48000), time: h.time, strength: h.strength, region: h.region, low: h.low });
      if (h.time >= (plan[segmentAt]?.start ?? 0) - 1) sink.onset(onset);
    }
    while (sectionsDone < sections.length && sections[sectionsDone].time <= time) {
      const e = sections[sectionsDone++];
      Object.assign(section, { sample: Math.round(e.at * 48000), time: e.at, kind: e.kind, id: ++id });
      sink.section(section);
    }
  }
  return truth;
}

/** A sink that drives a MusicalCognition directly (as ExperienceEngine does: interrupt on a gap). */
export function cognitionSink(c: MusicalCognition): ScenarioSink {
  return {
    hop: (a, context, dt) => c.hop(a, context, dt), onset: (o) => c.onset(o), beat: (b) => c.beat(b), section: (e) => c.section(e), gap: () => c.interrupt(),
  };
}
