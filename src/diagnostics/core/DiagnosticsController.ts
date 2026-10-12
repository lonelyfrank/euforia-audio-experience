import { settingsStore, resolveDirection } from '../../stores/settingsStore';
import { matterLab } from '../../render-systems/forms/MatterForms';
import { structuralLab } from '../../visual-engine/primitives/WirePolygonPrimitive';
import { solidLab } from '../../visual-engine/structural/SolidTypes';
import { TEST_SIGNALS } from '../../audio/capture/testSignals';
import type { App } from '../../app/App';
import type { AudioEvent, EventCursor } from '../../experience/EventStream';
import { WorldTrace } from '../../world/WorldTrace';
import { worldLab } from '../../visual-engine/VisualWorld';
import { MatterPrimitive } from '../../visual-engine/primitives/MatterPrimitive';
import { FieldTracerPrimitive } from '../../visual-engine/primitives/FieldTracerPrimitive';
import { DiagnosticsStore } from './DiagnosticsStore';
import { OverrideLedger } from './Overrides';
import { DiagnosticsCollector } from './DiagnosticsCollector';
import type { ConfigurationSegment, DiagnosticMetric, DiagnosticReport, ReportMetadata } from './DiagnosticsTypes';
import { RendererProbe } from '../probes/RendererProbe';
import { PresentationProbe } from '../probes/PresentationProbe';
import { collectEngine, metric, visualWorld } from '../probes/EngineProbes';
import { summarizeMatter } from '../probes/MatterSample';
import { tunnelLab } from '../../visualizers/tunnel/motion';

/** The ledger's key for primitive isolation. */
export const ISOLATION = 'world.only';
/** Segments kept: more changes than this within the retained samples drop the oldest boundary. */
const SEGMENTS = 64;
/** `name: before → after` for every setting that differs between two configurations written in the same order. */
function difference(names: string, before: string, after: string): string[] {
  const name = names.split('|'), a = before.split('|'), b = after.split('|');
  if (a.length !== name.length || b.length !== name.length) return ['configuration: changed'];
  const changed: string[] = [];
  for (let i = 0; i < name.length; i++) if (a[i] !== b[i]) changed.push(`${name[i]}: ${a[i] || '—'} → ${b[i] || '—'}`);
  return changed;
}

/**
 * Collects while somebody observes. What clears the measures is told apart from what only marks them:
 *
 * - **reset** (buffer, events, rolling statistics, trace, segments): a new audio session, the start of a recording, a
 *   change of the instrument itself (Detailed, GPU profiling, readback) and the explicit `reset()`;
 * - **segment** (nothing cleared): any change of configuration — settings, primitive isolation, Matter form, tunnel,
 *   a laboratory's state. The change is written to the timeline with what it was and what it is, and the samples
 *   that follow carry the new segment's index.
 */
export class DiagnosticsController {
  store: DiagnosticsStore | null = null;
  renderer: RendererProbe | null = null;
  /** Per-frame pacing of the presentation: heard clock, ingestion, hitches (present while diagnostics are open). */
  presentation: PresentationProbe | null = null;
  trace: WorldTrace | null = null;
  paused = false;
  recording = false;
  detailed = false;
  readback = false;
  uiMs = 0;
  collectionMs = 0;
  metadata: ReportMetadata | null = null;
  private collector: DiagnosticsCollector | null = null;
  private users = 0;
  private session = -1;
  private cursor: EventCursor = { time: -Infinity, seq: 0 };
  private sampledAt = -Infinity;
  /** The frame being observed, in host seconds: the one clock of everything written to the timeline. */
  private now = 0;
  private disposed = false;
  private lastScene = '';
  private lastNarrative = '';
  private lastQuality = '';
  private lastResyncs = 0;
  private readonly position = new Float32Array(256 * 4);
  private readonly velocity = new Float32Array(256 * 4);
  /**
   * The one owner of the temporary development overrides (isolation, Matter form, tunnel, test signal). They are given
   * back when the experiment stops and, at the latest, when the last user of the diagnostics leaves.
   */
  readonly overrides = new OverrideLedger();
  private matterMetrics: DiagnosticMetric[] = [];
  /** The configurations measured since the last reset, oldest first; the last one is in force. */
  private readonly segments: ConfigurationSegment[] = [];
  private segmentIndex = 0;
  /** Who asked for the override that changed last, until the next sampling tick writes it down. */
  private origin: string | null = null;
  constructor(readonly app: App) { this.overrides.onChange = (_key, origin) => { this.origin = origin; }; }
  /** How many configurations the measures since the last reset span. */
  get segmentCount(): number { return this.segmentIndex + (this.segments.length ? 1 : 0); }

  acquire(): () => void {
    if (this.disposed) throw new Error('Diagnostics disposed');
    if (this.users++ === 0) this.enable();
    let released = false;
    return () => { if (released || this.disposed) return; released = true; if (--this.users === 0) this.disable(); };
  }
  private enable(): void {
    this.store = new DiagnosticsStore(120);
    this.renderer = new RendererProbe(this.app.directionDebug.renderer);
    this.presentation = new PresentationProbe();
    this.collector = new DiagnosticsCollector(this.store, this.detailed ? 10 : 5);
    this.collector.register({ id: 'engine', sample: (store, now) => {
      // Before the sample is taken: it belongs to the configuration in force now.
      const segment = this.observe(now);
      collectEngine(this.app, store, this.renderer!, now, this.detailed, this.presentation!);
      metric(store, 'diagnostics', 'diagnostics.segment', segment.index, now, 'index', 'DiagnosticsController', 'render', 'valid', 'configuration segment of this sample; see report.segments');
      metric(store, 'diagnostics', 'diagnostics.segmentAge', now - segment.from, now, 's', 'DiagnosticsController', 'render', 'valid', 'time under this configuration; a rolling statistic is of one configuration only once this exceeds its window');
      metric(store, 'diagnostics', 'diagnostics.collection', this.collectionMs, now, 'ms', 'DiagnosticsController', 'render', 'valid', 'previous collection incl aggregation and trace copy', true);
      metric(store, 'diagnostics', 'diagnostics.ui', this.uiMs, now, 'ms', 'EngineWorkspace', 'render', 'valid', 'previous workspace refresh incl cards, DOM and visible charts', true);
      metric(store, 'diagnostics', 'diagnostics.bufferBytes', store.bytes, now, 'bytes', 'DiagnosticsStore', 'render', 'valid', 'typed buffers only, excludes objects/DOM');
      if (this.readback) {
        if (now - this.sampledAt >= 1) {
          this.sampleMatter(now);
          this.matterMetrics = store.registry.metrics.filter(m => m.id.startsWith('sample.')).map(m => ({ ...m }));
        } else for (const m of this.matterMetrics) store.registry.set(m, m.value, m.timestamp, m.status);
      }
    } });
    this.renderer.onFrame = this.frame;
    this.app.directionDebug.diagnostics = this.renderer;
    this.reset();
  }
  private disable(): void {
    this.app.directionDebug.diagnostics = null;
    this.collector?.dispose(); this.renderer?.dispose();
    this.collector = null; this.renderer = null; this.presentation = null; this.store = null; this.trace = null; this.matterMetrics = [];
    this.recording = this.paused = this.readback = false;
    // Whatever is still held (nothing, after a workspace that stopped its experiment) goes back now, and only once.
    this.overrides.releaseAll('diagnostics closed');
  }
  reset(): void {
    this.collector?.reset(); this.renderer?.frames.reset(); this.renderer?.timer.clear(); this.presentation?.reset();
    this.session = this.app.audio.session;
    this.lastQuality = ''; this.lastResyncs = this.app.audio.clock.resyncs;
    this.cursor = { time: -Infinity, seq: 0 };
    this.sampledAt = -Infinity; this.matterMetrics = []; this.lastScene = this.lastNarrative = '';
    this.trace = this.recording ? new WorldTrace(1200) : null;
    this.segments.length = 0; this.segmentIndex = 0; this.origin = null;
    this.metadata = this.makeMetadata();
  }
  /**
   * The segment the sample of this tick belongs to. A configuration that differs from the last one seen starts a new
   * segment and is written to the timeline; nothing measured before is touched.
   */
  private observe(now: number): ConfigurationSegment {
    const configuration = this.configuration(), last = this.segments.at(-1);
    if (last?.configuration === configuration) return last;
    const changed = last ? difference(this.configuration(true), last.configuration, configuration) : [];
    // Without somebody who asked (a laboratory's slider, a setting), the groups of what changed say where it came from.
    const origin = last ? this.origin ?? ([...new Set(changed.map(entry => entry.slice(0, entry.search(/[.:]/))))].join(', ') || null) : null;
    const segment: ConfigurationSegment = { index: last ? ++this.segmentIndex : 0, from: now, audioTime: this.app.audio.experience.ready ? this.app.audio.timing.heardTime : null, changed, origin, configuration };
    if (this.segments.length === SEGMENTS) this.segments.shift();
    this.segments.push(segment);
    this.origin = null;
    if (last) {
      this.note('configuration-change', `segment ${segment.index} · ${changed.join('; ')} · origin ${origin ?? 'unknown'}; measures before this are of segment ${last.index}`, now);
      const isolated = worldLab.only && `isolate:${[...worldLab.only].join(',')}`;
      if (isolated && this.metadata && !this.metadata.experimental.includes(isolated)) this.metadata.experimental.push(isolated);
    }
    return segment;
  }
  setRecording(on: boolean): void {
    this.recording = on;
    if (on) this.reset();
  }
  setDetailed(on: boolean): void { this.detailed = on; if (this.collector) this.collector.hz = on ? 10 : 5; this.reset(); }
  setProfiling(on: boolean): void {
    if (this.renderer) { this.renderer.timer.enabled = on; this.renderer.timer.clear(); }
    this.reset();
  }
  setReadback(on: boolean): void { this.readback = on; this.reset(); }
  /**
   * Shows only the named primitives of the visual world, or all of them with `null`: the one way `worldLab.only` is
   * written. A change of configuration, not a reset: what was measured stays, and the next sample opens a segment.
   */
  isolate(ids: string | readonly string[] | null, origin = 'diagnostics'): void {
    const list = typeof ids === 'string' ? [ids] : ids ?? [];
    this.overrides.set(ISOLATION, worldLab, 'only', list.length ? new Set(list) : null, origin);
  }
  private readonly frame = (now: number): void => {
    if (!this.store || !this.collector) return;
    this.now = now;
    // Even paused diagnostics must not export values of the previous source.
    if (this.session !== this.app.audio.session) this.reset();
    // Every frame, not at the sampling cadence: a hitch or a step of the clock lasts one frame.
    const engine = this.app.audio;
    this.presentation?.frame(this.renderer?.frameMs ?? 0, engine.clock.ready ? engine.timing.heardTime : NaN, engine.features.frames);
    if (this.metadata?.sampleRate === null && this.app.audio.captureSampleRate !== null) {
      this.metadata.sampleRate = this.app.audio.captureSampleRate;
      this.metadata.source = this.sourceCategory();
    }
    if (this.paused) return;
    const currentScene = this.app.directionDebug.current?.source.preset.name ?? 'none';
    if (currentScene !== this.lastScene) { this.sampledAt = -Infinity; this.matterMetrics = []; }
    const start = performance.now();
    if (this.collector.sample(now, this.recording)) {
      const audio = this.app.audio, ready = audio.clock.ready && audio.experience.ready && audio.state.status === 'running';
      if (ready) {
        audio.experience.events.forEachHeard(this.cursor, audio.timing.heardTime, this.event);
        if (this.recording) this.trace?.sample(audio.experience.presented);
        const narrative = audio.experience.presented.state.narrative;
        if (this.lastNarrative && narrative !== this.lastNarrative) this.note('narrative-change', `${this.lastNarrative} → ${narrative}`, now);
        this.lastNarrative = narrative;
      }
      const scene = this.app.directionDebug.current?.source.preset.name ?? 'none';
      // Nothing retained (no recording): the report is the present alone, so its metadata follow the present.
      const configuration = this.segments.at(-1)?.configuration;
      const m = this.metadata;
      if (!this.recording && this.store.count === 0 && (!m || (m.scene ?? 'none') !== scene || m.sampleRate !== audio.captureSampleRate || m.quality !== this.app.directionDebug.qualityTier || m.resolution !== this.resolution() || m.configuration !== configuration)) this.metadata = this.makeMetadata();
      if (this.lastScene && scene !== this.lastScene) this.note('scene-change', `${this.lastScene} → ${scene}; world not reset`, now);
      this.lastScene = scene;
      const load = this.app.directionDebug.load;
      const quality = `${this.app.directionDebug.qualityTier} step ${load.step} @ ${this.resolution()}`;
      if (this.lastQuality && quality !== this.lastQuality) this.note('quality-change', `${this.lastQuality} → ${quality}; limit ${load.limit}`, now);
      this.lastQuality = quality;
      if (audio.clock.resyncs !== this.lastResyncs) { this.note('clock-resync', `capture ↔ host mapping restarted (${audio.clock.resyncs})`, now); this.lastResyncs = audio.clock.resyncs; }
      // No scene yet is 'none' here and null in the metadata: the same thing, not a change.
      if (this.metadata && ((this.metadata.scene ?? 'none') !== scene || this.metadata.quality !== this.app.directionDebug.qualityTier || this.metadata.resolution !== this.resolution() || this.metadata.configuration !== configuration)) {
        if (!this.metadata.experimental.includes('mixed-configuration')) this.metadata.experimental.push('mixed-configuration');
      }
      this.collectionMs = performance.now() - start;
    }
  };
  private readonly event = (event: AudioEvent): void => {
    const snapshot = this.app.audio.experience.presented;
    const world = visualWorld(this.app);
    const primitives = world?.mounted.filter(m => m.presence.value > 0.004).map(m => `${m.slot.id}:${m.presence.value.toFixed(2)}`).join(',') ?? 'unavailable';
    this.store?.event({ id: `${this.session}:${event.seq}`, type: event.type, audioTime: event.audioTime,
      // The frame's time, as the notes: a musical event and a change noted in the same frame stay in the order they were written.
      observedAt: this.now, strength: event.strength, confidence: event.confidence,
      context: `snapshot ${snapshot.state.time.toFixed(4)}; plan ${snapshot.plan.currentIntent} (${snapshot.plan.confidence.toFixed(3)}); world ${snapshot.world.time.toFixed(4)} E≈${snapshot.world.energy.toFixed(4)}; thrust=${snapshot.world.forces.thrust.toFixed(3)} spin=${snapshot.world.spin.toFixed(3)}; recipe ${world?.recipe.id ?? 'legacy'}; primitive ${primitives}; correlazione temporale` });
  };
  private note(type: string, context: string, now: number): void {
    this.store?.event({ id: `${type}:${now}`, type, context, observedAt: now, audioTime: this.app.audio.experience.ready ? this.app.audio.timing.heardTime : null, strength: null, confidence: null });
  }
  private sampleMatter(now: number): void {
    this.sampledAt = now;
    const world = visualWorld(this.app);
    if (!world || !this.store) return;
    for (const m of world.mounted) {
      if (!(m.primitive instanceof MatterPrimitive || m.primitive instanceof FieldTracerPrimitive)) continue;
      const start = performance.now();
      const count = m.primitive.simulation.readDiagnosticSample(this.position, this.velocity);
      const stats = summarizeMatter(this.position, this.velocity, count);
      for (const [key, value] of Object.entries(stats)) metric(this.store, 'matter', `sample.${world.recipe.id}.${m.slot.id}.${key}`, count ? value : null, world.frame.time,
        key === 'speed' || key === 'maxSpeed' ? 'vu/s' : key === 'kinetic' ? 'vu²/s²' : key === 'count' || key === 'invalid' ? 'count' : 'vu', 'GPU prefix readback', 'audio', 'valid', 'at most 256 first-row elements at 1 Hz; kinetic = mean(v²/2), unit mass');
      metric(this.store, 'diagnostics', 'diagnostics.readback', performance.now() - start, now, 'ms', 'performance.now', 'render', 'valid', 'synchronous two-attachment sample; experimental', true);
    }
  }
  report(): DiagnosticReport {
    const samples = this.store?.exportSamples() ?? [];
    if (!samples.length && this.store?.registry.metrics.length) samples.push({ timestamp: performance.now() / 1000, metrics: this.store.registry.metrics.map(m => ({ ...m })) });
    // Only the configurations the retained samples were measured under: from the one in force at the oldest sample.
    let first = this.segments.length - 1;
    while (first > 0 && this.segments[first].from > samples[0]?.timestamp) first--;
    return { schema: 1, metadata: structuredClone(this.metadata ?? this.makeMetadata()), samples,
      segments: this.segments.slice(Math.max(0, first)).map(s => ({ ...s, changed: [...s.changed] })),
      duration: samples.length > 1 ? samples.at(-1)!.timestamp - samples[0].timestamp : 0,
      events: this.store?.events.map(e => ({ ...e })) ?? [], labels: { ...this.store?.labels }, limitations: [
        'Clock capture/audio in secondi di sessione; render/presentation in secondi host. ClockSync è stimato. Latenza fisica non misurata.',
        'Energia del mondo fenomenologica; input, dissipazione e momento angolare non osservabili come bilancio conservativo.',
        'CPU submit non è tempo GPU. Pass configurati includono layer eventualmente non disegnati. Risorse driver non conteggiate.',
        'Readback opt-in: prefisso di una riga, massimo 256 elementi, 1 Hz, full-float; non rappresentativo della popolazione. Half-float indisponibile.',
        'Eventi correlati allo snapshot osservato, senza attribuzione causale alle primitive. Evizioni stream: ' + this.app.audio.experience.events.evicted,
        'Traccia numerica: ultimi 120 campioni; timeline: ultimi 256 eventi. Campioni sostituiti: ' + (this.store?.evicted ?? 0),
        'Prestazioni live dipendono da carico, qualità adattiva e sorgente; gli obiettivi 1%/3%/5% richiedono baseline hardware.',
        'Un cambio di configurazione non azzera le misure: apre un segmento (segments, metrica diagnostics.segment per campione). Le statistiche su finestra mobile (frame.*, fps.mean, presentation: 300 frame) mescolano due configurazioni finché diagnostics.segmentAge è più breve della finestra; medie su campioni di segmenti diversi non sono una misura omogenea.',
      ] };
  }
  /**
   * What a measure was taken under: settings and DEV overrides, in a fixed order. With `names`, what each position is.
   * Only settings, never PCM, device names or an engine snapshot.
   */
  private configuration(names = false): string {
    const out: unknown[] = [], put = (name: string, value: unknown): void => { out.push(names ? name : value); };
    const all = (group: string, values: object): void => { for (const [key, value] of Object.entries(values)) put(`${group}.${key}`, value); };
    const s = settingsStore.get(), d = resolveDirection(s);
    put('settings.preset', s.preset); put('settings.quality', s.quality); put('settings.sensitivity', s.sensitivity); put('settings.smoothing', s.smoothing);
    put('settings.beatResponse', s.beatResponse); put('settings.audioDelay', s.audioDelay); put('settings.reflection', s.reflection); put('settings.reduceFlashing', s.reduceFlashing);
    put('settings.direction', s.direction); put('direction.mood', d.mood); put('direction.moodIntensity', d.moodIntensity); put('direction.experience', d.experience);
    put('direction.autoDirection', d.autoDirection); put('direction.rigMode', d.rigMode); put('matter.form', matterLab.form);
    put('structural.active', structuralLab.active); put('structural.view', structuralLab.view); put('structural.sides', structuralLab.sides); all('structural.tuning', structuralLab.tuning);
    put('solid.active', solidLab.active); put('solid.kind', solidLab.kind); put('solid.view', solidLab.view); all('solid.tuning', solidLab.tuning); all('solid.material', solidLab.material);
    put('isolate', worldLab.only ? [...worldLab.only].join(',') : 'all'); put('tunnel.balance', tunnelLab.balance ?? 'preset');
    return out.join('|');
  }
  private sourceCategory(): string {
    return this.app.audio.state.source === 'fake' ? `synthetic:${TEST_SIGNALS.find(s => s.label === this.app.audio.state.deviceName)?.id ?? 'unknown'}` : this.app.audio.state.source ?? 'none';
  }
  private resolution(): string { const c = this.app.directionDebug.renderer.domElement; return `${c.width}x${c.height}`; }
  private makeMetadata(): ReportMetadata {
    const world = visualWorld(this.app), gl = this.app.directionDebug.renderer.getContext();
    return { engineVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev', gitSha: import.meta.env.VITE_GIT_SHA ?? null,
      startedAt: new Date().toISOString(), os: navigator.platform, backend: 'WebGL2', gpu: String(gl.getParameter(gl.RENDERER)),
      capabilities: [this.renderer?.timer.supported ? 'timer-query' : 'no-timer-query'], quality: this.app.directionDebug.qualityTier,
      resolution: this.resolution(), source: this.sourceCategory(), sampleRate: this.app.audio.captureSampleRate,
      session: this.app.audio.session, detail: this.detailed ? 'detailed' : 'basic', sampleHz: this.detailed ? 10 : 5,
      profiling: this.renderer?.timer.enabled ?? false, readback: this.readback, scene: this.app.directionDebug.current?.source.preset.name ?? null,
      seed: world?.recipe.seed ?? null, configuration: this.configuration(), experimental: worldLab.only ? [`isolate:${[...worldLab.only].join(',')}`] : [] };
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.users = 0; this.disable(); }
}
