import { MAX_UNITS } from '../../show/GpuBudget';
import { TARGET_FPS } from '../../renderer/quality';
import type { App } from '../../app/App';
import type { ExperienceSnapshot } from '../../experience/types';
import type { DiagnosticsStore } from '../core/DiagnosticsStore';
import type { MetricRegistry } from '../metrics/MetricRegistry';
import type { ClockDomain, Domain, MetricStatus } from '../core/DiagnosticsTypes';
import type { RendererProbe } from './RendererProbe';
import { RecipeVisualizer } from '../../visual-engine/RecipeVisualizer';
import { MatterPrimitive } from '../../visual-engine/primitives/MatterPrimitive';
import { FieldTracerPrimitive } from '../../visual-engine/primitives/FieldTracerPrimitive';
import { WirePolygonPrimitive } from '../../visual-engine/primitives/WirePolygonPrimitive';

/** Explicit units override native model coefficients (which are not SI quantities). */
const UNITS: Record<string, string> = {
  particles: 'count', tracers: 'count', nodes: 'count', links: 'count', steps: 'count', 'tracer steps': 'count', 'sim ms': 'ms CPU',
  elements: 'count', vertices: 'count', primitives: 'count', present: 'count', rings: 'count', filaments: 'count', 'surface vertices': 'count',
  stepMs: 'ms CPU', bookMs: 'ms CPU', bonds: 'count', loops: 'count', formed: 'count', fractures: 'count', repairs: 'count',

  sample: 'sample', sampleRate: 'Hz', time: 's', partialHz: 'Hz', centroidHz: 'Hz', rolloffHz: 'Hz', spreadHz: 'Hz', instantaneousHz: 'Hz',
  noiseFloorDb: 'dBFS', bandDb: 'dBFS', bandFloorDb: 'dBFS', harmonicDb: 'dBFS', percussiveDb: 'dBFS',
  loudnessMomentary: 'LUFS', loudnessShort: 'LUFS', loudnessLong: 'LUFS', perceivedLoudness: 'LUFS',
  rms: 'FS', peak: 'FS', beatBpm: 'BPM', tempoBpm: 'BPM', resonatorBpm: 'BPM',
  angle: 'rad', spin: 'rad/s', torque: 'rad/s²', radius: 'vu', radialVelocity: 'vu/s', travel: 'vu', speed: 'vu/s', biasVelocity: 'vu/s',
  thrust: 'vu/s²', spinDrag: '1/s', travelDrag: '1/s', excitationRate: '1/s', shimmerRate: '1/s', charge: '1/s',
  releaseTime: 's', impulseTime: 's', nextBeatTime: 's', nextDownbeatTime: 's', nextPhraseTime: 's',
  transitionStart: 's', transitionEnd: 's', horizon: 's', predictionHorizon: 's', eventTime: 's', silenceDuration: 's',
};
export function metric(store: DiagnosticsStore, domain: Domain, id: string, value: number | null, time: number, unit: string, source: string,
  clock: ClockDomain = 'audio', status: MetricStatus = 'valid', method = 'producer value', lowerIsBetter = false): void {
  store.registry.set({ id, domain, unit, source, clock, method, lowerIsBetter }, value, time, status);
}
/**
 * Where each key of a group lives in a registry (one index, or one per element of a vector), resolved the first time
 * it is seen: afterwards a sample builds no ids and no definitions, which in Detailed were hundreds of strings per sample.
 */
const slots = new WeakMap<MetricRegistry, Map<string, Map<string, number | Int32Array>>>();
const WORLD_ESTIMATES = ['kinetic', 'elastic', 'stored', 'wave', 'energy'];
export function group(store: DiagnosticsStore, domain: Domain, prefix: string, data: object, time: number, source: string, arrays = false, clock: ClockDomain = 'audio'): void {
  const registry = store.registry, record = data as Record<string, unknown>;
  let groups = slots.get(registry);
  if (!groups) slots.set(registry, groups = new Map());
  let known = groups.get(prefix);
  if (!known) groups.set(prefix, known = new Map());
  const define = (id: string, key: string): number => registry.register({ id, domain, unit: UNITS[key] ?? 'model unit', source, clock, method: 'producer value', lowerIsBetter: false });
  for (const key in record) {
    const value = record[key];
    if (typeof value === 'number') {
      let at = known.get(key);
      if (typeof at !== 'number') known.set(key, at = define(`${prefix}.${key}`, key));
      registry.setAt(at, (key === 'meter' || key.startsWith('next') && key.endsWith('Time')) && value <= 0 ? null : value, time,
        prefix === 'world' && WORLD_ESTIMATES.includes(key) ? 'estimated' : 'valid');
    } else if (typeof value === 'string') store.labels[`${prefix}.${key}`] = value;
    else if (arrays && ArrayBuffer.isView(value) && 'length' in value) {
      const a = value as Float32Array;
      let at = known.get(key);
      if (!(at instanceof Int32Array) || at.length !== a.length) {
        at = new Int32Array(a.length);
        for (let i = 0; i < a.length; i++) at[i] = define(`${prefix}.${key}[${i}]`, key);
        known.set(key, at);
      }
      for (let i = 0; i < a.length; i++) registry.setAt(at[i], a[i], time);
    }
  }
}
/** Shared by live diagnostics and offline replay, always reads the already presented snapshot. */
export function collectSnapshot(store: DiagnosticsStore, snapshot: ExperienceSnapshot, detailed = false): void {
  const s = snapshot, time = s.state.time;
  group(store, 'experience', 'experience', s.state, time, 'ExperienceEngine');
  group(store, 'experience', 'plan', s.plan, time, 'ExperiencePlanner');
  group(store, 'experience', 'morphology', s.morphology, time, 'SoundMorphology');
  for (const intent of s.intents) {
    metric(store, 'experience', `intent.${intent.kind}`, intent.strength * intent.confidence, intent.time, '0..1', 'ExperiencePlanner', 'audio', 'valid', 'strength × confidence');
    metric(store, 'experience', `intentConfidence.${intent.kind}`, intent.confidence, intent.time, '0..1', 'ExperiencePlanner');
  }
  group(store, 'world', 'world', s.world, s.world.time, 'WorldState');
  group(store, 'world', 'forces', s.world.forces, s.world.time, 'WorldForces');
  let nonfinite = 0, outside = 0;
  for (const [key, value] of Object.entries(s.world)) if (typeof value === 'number' && !Number.isFinite(value) && !(['releaseTime', 'impulseTime'].includes(key) && value === -Infinity)) nonfinite++;
  for (const value of Object.values(s.world.forces)) if (!Number.isFinite(value)) nonfinite++;
  for (const key of ['excitation', 'shimmer', 'turbulence', 'coherence', 'potential', 'illumination', 'openness'] as const) if (s.world[key] < -1e-9 || s.world[key] > 1 + 1e-9) outside++;
  metric(store, 'world', 'invariants.nonfinite', nonfinite, s.world.time, 'count', 'WorldState validation');
  metric(store, 'world', 'invariants.fieldDomain', outside, s.world.time, 'count', 'WorldState validation', 'audio', 'valid', 'seven 0..1 fields; tolerance 1e-9; no repairs');

  group(store, 'physics', 'physics', s.physics, s.physics.time, 'ResonantPhysics', detailed);
  group(store, 'physics', 'resonance', s.resonance, time, 'MultiscaleResonance', detailed);
  // The model does not expose these as a conserved balance.
  for (const id of ['inputEnergy', 'dissipation', 'angularMomentum']) metric(store, 'world', `world.${id}`, null, s.world.time, 'unavailable', 'WorldState');
}
export function visualWorld(app: App) {
  const scene = app.directionDebug.current?.visualizer;
  return scene instanceof RecipeVisualizer ? scene.world : null;
}
export function collectEngine(app: App, store: DiagnosticsStore, render: RendererProbe, now: number, detailed: boolean): void {
  const audio = app.audio, ready = audio.clock.ready && audio.features.frames > 0 && audio.state.status === 'running';
  const analysis = audio.features.frame, rt = audio.realtimeStats;
  store.labels['audio.source'] = audio.state.source ?? 'none'; store.labels['audio.status'] = audio.state.status;
  store.labels['audio.backend'] = rt?.mode ?? 'native or inactive';
  if (ready) group(store, 'audio', 'audio', analysis, analysis.time, 'Rust AnalysisFrame', detailed, 'capture');
  metric(store, 'audio', 'capture.sampleRate', audio.captureSampleRate, now, 'Hz', 'AudioCaptureProvider', 'render');
  metric(store, 'audio', 'capture.hops', audio.features.frames, now, 'hop', 'AnalysisDecoder', 'render');
  metric(store, 'audio', 'capture.frames', ready ? analysis.sample : null, now, 'sample frames', 'AnalysisFrame.sample', 'render');
  for (const id of ['channels', 'hardwareBuffer', 'batchCpuMs']) metric(store, 'audio', `capture.${id}`, null, now, id === 'batchCpuMs' ? 'ms' : 'count', 'capture unavailable', 'render');
  const units: Record<string, string> = { load: 'ratio', quality: 'tier', backlog: 'sample frames', dspAge: 's', transfer: 's', pending: 'f64 values', dropped: 'f64 values', lost: 'sample frames', filled: 'sample frames', batches: 'batch' };
  for (const key of Object.keys(units)) metric(store, 'audio', `pipeline.${key}`, ready && rt ? rt[key as keyof typeof rt] as number : null, now, units[key], 'BrowserAnalysis', 'render', key === 'load' || key === 'transfer' ? 'estimated' : 'valid');
  const timing = audio.timing;
  metric(store, 'audio', 'clock.analysis', ready ? analysis.time : null, analysis.time, 's', 'AnalysisFrame', 'capture');
  metric(store, 'audio', 'clock.captureHost', ready ? audio.clock.toHost(analysis.time) : null, now, 's', 'ClockSync', 'render', 'estimated');
  metric(store, 'audio', 'clock.heard', ready ? timing.heardTime : null, timing.heardTime, 's', 'Timing', 'audio', 'estimated');
  metric(store, 'audio', 'clock.presentationHost', ready ? timing.presentTime : null, timing.presentTime, 's', 'Timing', 'presentation', 'estimated');
  metric(store, 'audio', 'clock.renderHost', now, now, 's', 'performance.now', 'render');
  metric(store, 'audio', 'latency.configuredOutput', timing.latency.output, now, 's', 'Timing', 'render', 'valid', 'configured compensation, not measured latency');
  metric(store, 'audio', 'latency.renderEstimate', ready ? timing.renderLatency : null, now, 's', 'Timing', 'render', 'estimated');
  metric(store, 'audio', 'latency.physical', null, now, 's', 'external calibration required', 'render');
  metric(store, 'audio', 'latency.analysisLead', ready ? timing.lead : null, now, 's', 'Timing', 'render', 'estimated');
  if (ready && audio.experience.ready) collectSnapshot(store, audio.experience.presented, detailed);

  const world = visualWorld(app);
  if (world) {
    group(store, 'geometry', 'geometry', world.mapper.state, world.frame.time, 'SonicGeometryMapper');
    group(store, 'geometry', 'visualWorld', world.debug, world.frame.time, 'VisualWorld');
    group(store, 'physics', 'field', world.fields, world.frame.time, 'SpatialFields');
    for (const m of world.mounted) {
      const prefix = `primitive.${world.recipe.id}.${m.slot.id}`;
      metric(store, 'geometry', `${prefix}.presence`, m.presence.value, world.frame.time, '0..1', 'VisualWorld');
      metric(store, 'geometry', `${prefix}.target`, m.target, world.frame.time, '0..1', 'VisualWorld');
      metric(store, 'geometry', `${prefix}.cost`, m.slot.base ? 0 : m.slot.cost ?? 1, world.frame.time, 'budget share', 'WorldRecipe');
      metric(store, 'geometry', `${prefix}.elements`, m.primitive.elements, world.frame.time, 'count', 'Primitive');
      metric(store, 'geometry', `${prefix}.vertices`, m.primitive.vertices, world.frame.time, 'count', 'Primitive');
      if (m.primitive.debug) group(store, 'matter', `${prefix}.debug`, m.primitive.debug, world.frame.time, 'Primitive.debug');
      if (m.primitive instanceof MatterPrimitive || m.primitive instanceof FieldTracerPrimitive) {
        const sim = m.primitive.simulation;
        metric(store, 'matter', `${prefix}.targetBits`, sim.fullFloat ? 32 : 16, world.frame.time, 'bits/component', 'Simulation');
        metric(store, 'matter', `${prefix}.pingPong`, sim.diagnosticTarget, world.frame.time, 'index', 'Simulation');
        metric(store, 'matter', `${prefix}.stateTextures`, 4, world.frame.time, 'count', 'Simulation');
        metric(store, 'matter', `${prefix}.stateBytes`, m.primitive.elements * 4 * 4 * (sim.fullFloat ? 4 : 2), world.frame.time, 'bytes', 'Simulation', 'audio', 'estimated', 'state attachments only, excludes driver overhead');
      }
      if (m.primitive instanceof WirePolygonPrimitive) group(store, 'matter', 'structural', m.primitive.system.stats, world.frame.time, 'StructuralSystem');
    }
  }
  const r = app.directionDebug.renderer, stats = render.frames.summarize();
  for (const [key, value] of Object.entries(render.drawn)) metric(store, 'render', `render.${key}`, value, now, 'count', 'renderer.info', 'render');
  for (const [key, value] of Object.entries(r.info.memory)) metric(store, 'render', `render.${key}`, value, now, 'count', 'renderer.info.memory', 'render');
  for (const [key, value] of Object.entries(stats)) metric(store, 'render', `frame.${key}`, value, now, 'ms', 'RAF intervals', 'render', 'valid', 'last 300 real frames, nearest-rank quantiles', true);
  metric(store, 'render', 'budget.maxUnits', MAX_UNITS[app.directionDebug.qualityTier], now, 'fixture units', 'GpuBudget.MAX_UNITS', 'render');
  metric(store, 'render', 'budget.targetFrame', 1000 / TARGET_FPS, now, 'ms', 'QualityController.TARGET_FPS', 'render');
  metric(store, 'render', 'budget.frameRatio', stats.mean === null ? null : stats.mean / (1000 / TARGET_FPS), now, 'ratio', 'RAF / target frame', 'render');
  metric(store, 'render', 'frame.instant', render.frameMs, now, 'ms', 'RAF interval', 'render');
  metric(store, 'render', 'fps.instant', render.frameMs > 0 ? 1000 / render.frameMs : null, now, 'fps', 'RAF interval', 'render');
  metric(store, 'render', 'fps.mean', stats.mean ? 1000 / stats.mean : null, now, 'fps', 'RAF intervals', 'render');
  metric(store, 'render', 'cpu.source', render.sourceMs, now, 'ms', 'performance.now', 'render', 'valid', 'frameSource: graphics analysis + decode + rig, not worker DSP', true);
  metric(store, 'render', 'cpu.renderSubmit', render.renderSubmitMs, now, 'ms', 'performance.now', 'render', 'valid', 'scene updates + GPU command submission, not GPU execution', true);
  metric(store, 'render', 'gpu.frame', render.timer.ms, now, 'ms', 'EXT_disjoint_timer_query_webgl2', 'render', 'valid', 'asynchronous completed query, includes simulation and composition', true);
  for (const [key, value] of Object.entries({ layers: render.layers, crossfades: render.crossfades, configuredPasses: render.passes, width: r.domElement.width, height: r.domElement.height, pixelRatio: r.getPixelRatio() })) metric(store, 'render', `render.${key}`, value, now, key === 'width' || key === 'height' ? 'px' : 'count', 'RenderEngine', 'render');
  for (const key of ['gpuMemoryTotal', 'renderTargetsTotal', 'actuallyVisibleParticles']) metric(store, 'render', `render.${key}`, null, now, 'unavailable', 'not exposed', 'render');
}
