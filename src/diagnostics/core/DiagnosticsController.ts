import { settingsStore, resolveDirection } from '../../stores/settingsStore';
import { matterLab } from '../../render-systems/forms/MatterForms';
import { structuralLab } from '../../visual-engine/primitives/WirePolygonPrimitive';
import { TEST_SIGNALS } from '../../audio/capture/testSignals';
import type { App } from '../../app/App';
import type { AudioEvent, EventCursor } from '../../experience/EventStream';
import { WorldTrace } from '../../world/WorldTrace';
import { worldLab } from '../../visual-engine/VisualWorld';
import { MatterPrimitive } from '../../visual-engine/primitives/MatterPrimitive';
import { FieldTracerPrimitive } from '../../visual-engine/primitives/FieldTracerPrimitive';
import { DiagnosticsStore } from './DiagnosticsStore';
import { DiagnosticsCollector } from './DiagnosticsCollector';
import type { DiagnosticMetric, DiagnosticReport, ReportMetadata } from './DiagnosticsTypes';
import { RendererProbe } from '../probes/RendererProbe';
import { collectEngine, metric, visualWorld } from '../probes/EngineProbes';
import { summarizeMatter } from '../probes/MatterSample';

export class DiagnosticsController {
  store: DiagnosticsStore | null = null;
  renderer: RendererProbe | null = null;
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
  private disposed = false;
  private lastScene = '';
  private lastNarrative = '';
  private readonly position = new Float32Array(256 * 4);
  private readonly velocity = new Float32Array(256 * 4);
  private readonly initialOnly = worldLab.only;
  private oldOnly = worldLab.only;
  private matterMetrics: DiagnosticMetric[] = [];
  constructor(readonly app: App) {}

  acquire(): () => void {
    if (this.disposed) throw new Error('Diagnostics disposed');
    if (this.users++ === 0) this.enable();
    let released = false;
    return () => { if (released || this.disposed) return; released = true; if (--this.users === 0) this.disable(); };
  }
  private enable(): void {
    this.oldOnly = worldLab.only;
    this.store = new DiagnosticsStore(120);
    this.renderer = new RendererProbe(this.app.directionDebug.renderer);
    this.collector = new DiagnosticsCollector(this.store, this.detailed ? 10 : 5);
    this.collector.register({ id: 'engine', sample: (store, now) => {
      collectEngine(this.app, store, this.renderer!, now, this.detailed);
      metric(store, 'diagnostics', 'diagnostics.collection', this.collectionMs, now, 'ms', 'DiagnosticsController', 'render', 'valid', 'previous collection incl aggregation and trace copy', true);
      metric(store, 'diagnostics', 'diagnostics.ui', this.uiMs, now, 'ms', 'DiagnosticsDashboard', 'render', 'valid', 'previous UI refresh incl DOM and chart', true);
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
    this.collector = null; this.renderer = null; this.store = null; this.trace = null; this.matterMetrics = [];
    this.recording = this.paused = this.readback = false;
    worldLab.only = this.oldOnly;
  }
  reset(): void {
    this.collector?.reset(); this.renderer?.frames.reset(); this.renderer?.timer.clear();
    this.session = this.app.audio.session;
    this.cursor = { time: -Infinity, seq: 0 };
    this.sampledAt = -Infinity; this.matterMetrics = []; this.lastScene = this.lastNarrative = '';
    this.trace = this.recording ? new WorldTrace(1200) : null;
    this.metadata = this.makeMetadata();
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
  isolate(id: string | null): void { worldLab.only = id ? new Set([id]) : null; this.reset(); }
  private readonly frame = (now: number): void => {
    if (!this.store || !this.collector) return;
    // Even paused diagnostics must not export values of the previous source.
    if (this.session !== this.app.audio.session) this.reset();
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
      if (!this.recording && this.store.count === 0 && (this.metadata?.scene !== scene || this.metadata.sampleRate !== audio.captureSampleRate || this.metadata.quality !== this.app.directionDebug.qualityTier || this.metadata.resolution !== this.resolution())) this.metadata = this.makeMetadata();
      if (this.lastScene && scene !== this.lastScene) this.note('scene-change', `${this.lastScene} → ${scene}; world not reset`, now);
      this.lastScene = scene;
      if (this.metadata && (this.metadata.scene !== scene || this.metadata.quality !== this.app.directionDebug.qualityTier || this.metadata.resolution !== this.resolution() || this.metadata.configuration !== this.configuration())) {
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
      observedAt: performance.now() / 1000, strength: event.strength, confidence: event.confidence,
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
    return { schema: 1, metadata: structuredClone(this.metadata ?? this.makeMetadata()), samples,
      duration: samples.length > 1 ? samples.at(-1)!.timestamp - samples[0].timestamp : 0,
      events: this.store?.events.map(e => ({ ...e })) ?? [], labels: { ...this.store?.labels }, limitations: [
        'Clock capture/audio in secondi di sessione; render/presentation in secondi host. ClockSync è stimato. Latenza fisica non misurata.',
        'Energia del mondo fenomenologica; input, dissipazione e momento angolare non osservabili come bilancio conservativo.',
        'CPU submit non è tempo GPU. Pass configurati includono layer eventualmente non disegnati. Risorse driver non conteggiate.',
        'Readback opt-in: prefisso di una riga, massimo 256 elementi, 1 Hz, full-float; non rappresentativo della popolazione. Half-float indisponibile.',
        'Eventi correlati allo snapshot osservato, senza attribuzione causale alle primitive. Evizioni stream: ' + this.app.audio.experience.events.evicted,
        'Traccia numerica: ultimi 120 campioni; timeline: ultimi 256 eventi. Campioni sostituiti: ' + (this.store?.evicted ?? 0),
        'Prestazioni live dipendono da carico, qualità adattiva e sorgente; gli obiettivi 1%/3%/5% richiedono baseline hardware.',
      ] };
  }
  private configuration(): string {
    const s = settingsStore.get(), d = resolveDirection(s);
    // Only settings, never PCM, device names or an engine snapshot.
    return [s.preset, s.quality, s.sensitivity, s.smoothing, s.beatResponse, s.audioDelay, s.reflection, s.reduceFlashing,
      s.direction, d.mood, d.moodIntensity, d.experience, d.autoDirection, d.rigMode, matterLab.form,
      structuralLab.active, structuralLab.view, structuralLab.sides, ...Object.values(structuralLab.tuning)].join('|');
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
  dispose(): void { if (this.disposed) return; this.disposed = true; this.users = 0; this.disable(); worldLab.only = this.initialOnly; }
}
