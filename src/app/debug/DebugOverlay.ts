import type { DiagnosticsController } from '../../diagnostics/core/DiagnosticsController';
import { settingsStore } from '../../stores/settingsStore';
import type { App } from '../App';
import { SECTION_NAMES } from '../../audio/features/decode';
import type { AudioEvent, EventCursor } from '../../experience/EventStream';
import type { ExperienceSnapshot } from '../../experience/types';
import { MORPHOLOGY_KEYS } from '../../morphology/SoundMorphology';
import { matterLab } from '../../render-systems/forms/MatterForms';
import { GEOMETRY_KEYS, SIGNED_TRAITS } from '../../visual-engine/geometry/GeometryState';
import { worldLab } from '../../visual-engine/VisualWorld';
import { RecipeVisualizer } from '../../visual-engine/RecipeVisualizer';
import { createMaterial, deriveMaterial, MATERIAL_KEYS } from '../../render-systems/materials/VisualMaterial';
import { columnsFor, packRows } from './chartLayout';

/** Development chart adapter: retained analyzer/interpretation/world graphs in the workspace inspector.
 * The workspace clocks refreshes; no independent overlay, shortcut or animation loop.
 * The canvas is as wide as its host, in CSS pixels: readouts flow into the rows and columns that width allows
 * (one column in the inspector, two in a wide one) instead of being scaled down with it.
 * Numeric readouts are also available in the DOM metric registry below the charts.
 * Audio & Analysis is not drawn here: it has its own panels (diagnostics/workspace/AudioAnalysis.ts).
 */

const GAP = 16;
const ROW = 15;
const LABEL = 100;
/** Room after a bar for its value. */
const VALUE = 46;
const FONT = '11px "Geist Variable", Geist, system-ui, sans-serif';
/** The cockpit's series colours (design system tokens), as canvas needs them. */
const COLORS = { low: '#f08a3c', mid: '#2fd08a', high: '#38c6ff', hit: '#e27bd8', level: '#f3f1fa', tempo: '#f5b73b', dim: '#a6a4b8', track: '#1b1e46' };

type Bar = readonly [label: string, color: string, value: number];

/** The geometry traits beyond the material (those are shown with it). */
const GEOMETRY_TRAITS = GEOMETRY_KEYS.filter((key) => !(MATERIAL_KEYS as readonly string[]).includes(key));
const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** A labelled run of readouts: the label stays with the first one when the run wraps. */
const labelled = (label: string, items: readonly string[]): string[] => [`${label} ${items[0] ?? '–'}`, ...items.slice(1)];

export type DebugView = 'experience' | 'world' | 'matter';

export class DebugOverlay {
  private view: DebugView = 'experience';
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private session = -1;
  private visible = true;
  private readonly observer = new IntersectionObserver(entries => { this.visible = entries.some(e => e.isIntersecting); });
  /** The host's width as its observer last reported it: drawing never asks the layout for it. */
  private hostWidth = 0;
  private readonly sizes = new ResizeObserver(entries => { this.hostWidth = Math.floor(entries[entries.length - 1].contentRect.width); });
  /** The canvas in CSS pixels: as wide as its host, as tall as the view's readouts need at that width. */
  private width = 0;
  private height = 0;
  private columns: 1 | 2 = 1;
  /** Where the next row goes (its vertical middle). */
  private y = 0;
  private frameMs = 16;
  private lastBeat = 0;
  private readonly eventCursor: EventCursor = { time: -Infinity, seq: 0 };
  /** The last heard events (copies, oldest first). */
  private readonly recentEvents: AudioEvent[] = [];
  private readonly keepEvent = (event: AudioEvent): void => {
    if (event.type === 'onset' || event.type === 'beat') return;
    this.recentEvents.push({ ...event });
    if (this.recentEvents.length > 5) this.recentEvents.shift();
  };
  private lastCue = 0;
  /** The protagonist's material, derived here from the same world view and snapshot the scene uses. */
  private readonly material = createMaterial();
  /** What the renderer drew last frame (its counters are summed over the frame's passes while the overlay is open). */
  private readonly releaseDiagnostics: () => void;
  private readonly drawn = { calls: 0, triangles: 0, points: 0, lines: 0 };
  private readonly fits = (row: string): boolean => this.ctx.measureText(row).width <= this.width;
  private readonly emit = (row: string): void => { this.ctx.fillText(row, 0, this.y, this.width); this.y += ROW; };

  constructor(private readonly app: App, private readonly diagnostics: DiagnosticsController, parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'ws-debug';
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Grafici live; valori e unità disponibili nel registro metriche sottostante');
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.font = FONT;
    this.root.append(this.canvas);
    parent.append(this.root);
    this.observer.observe(this.root);
    this.sizes.observe(this.root);
    // Shared totals are measured by the observer at the RenderEngine frame boundary.
    this.releaseDiagnostics = diagnostics.acquire();
  }

  dispose(): void {
    this.observer.disconnect();
    this.sizes.disconnect();
    this.releaseDiagnostics();
    this.root.remove();
  }

  setView(view: DebugView): void {
    if (view === this.view && this.height > 0) return;
    this.view = view;
    // Measured again by the next refresh.
    this.height = 0;
  }

  /** Draws the current view, when somebody can see it. */
  refresh(): void {
    if (!this.visible) return;
    if (this.session !== this.app.audio.session) {
      this.session = this.app.audio.session;
      this.lastBeat = this.lastCue = 0; this.recentEvents.length = 0;
      this.eventCursor.time = -Infinity; this.eventCursor.seq = 0;
    }
    // Until its observer has spoken (the first draw after mounting) the host is asked once.
    const width = this.hostWidth || Math.floor(this.root.clientWidth);
    if (width <= 0) return;
    if (width !== this.width) { this.width = width; this.columns = columnsFor(width); this.height = 0; }
    this.frameMs = this.diagnostics.renderer?.frameMs ?? 0;
    Object.assign(this.drawn, this.diagnostics.renderer?.drawn);
    this.paint();
    // The canvas grows to what the view needs at this width (and is drawn again); it never shrinks under a row that wrapped.
    if (this.y > this.height) { this.resize(this.y); this.paint(); }
  }

  private resize(height: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.height = Math.ceil(height);
    this.canvas.width = Math.round(this.width * dpr); this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.font = FONT; this.ctx.textBaseline = 'middle';
  }

  private paint(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.lineWidth = 1;
    this.y = ROW / 2 + 2;
    const snapshot = this.app.audio.experience.presented;
    if (this.view === 'experience') { this.drawDirection(); this.drawAnalysis(snapshot); }
    else if (this.view === 'world') this.drawWorld(snapshot);
    else { this.drawMatter(snapshot); this.y += ROW / 2; this.drawVisualWorld(); }
    this.y -= ROW / 2 - 4;
  }

  // ---- layout: rows and columns that follow the host's width -----------------------------

  private get column(): number { return (this.width - GAP * (this.columns - 1)) / this.columns; }

  /** Short readouts on as few rows as the width allows. */
  private flow(color: string, parts: readonly string[], separator = ' · '): void {
    this.ctx.fillStyle = color;
    packRows(parts, separator, this.fits, this.emit);
  }

  /** Readouts in the host's columns: two side by side in a wide inspector, one under the other in a narrow one. */
  private bars(rows: readonly Bar[]): void {
    const step = this.column + GAP;
    rows.forEach(([label, color, value], i) => this.bar(label, color, value, (i % this.columns) * step, this.y + Math.floor(i / this.columns) * ROW));
    this.y += Math.ceil(rows.length / this.columns) * ROW;
  }

  // ---- Experience & Direction -------------------------------------------------------------

  /** What the direction chose and how it modulates the scene. */
  private drawDirection(): void {
    const audio = this.app.audio.frame, state = this.app.audio.visual;
    const engine = this.app.directionDebug;
    const direction = engine.effectiveDirection;
    const modulation = engine.modulation;
    this.flow(COLORS.level, [settingsStore.get().scene, direction.mood, direction.experience, `auto ${direction.autoDirection ? engine.autoDirection.confidence.toFixed(2) : 'off'}`]);
    this.flow(COLORS.level, [`Centroid ${audio.centroidHz.toFixed(0)} Hz`, `rolloff ${audio.rolloffHz.toFixed(0)} Hz`, `spread ${audio.spreadHz.toFixed(0)} Hz`]);
    this.flow(COLORS.level, [`Short energy ${state.shortEnergy.toFixed(2)}`, `Δ ${state.energyDelta.toFixed(2)}`, `range ${state.dynamicRange.toFixed(2)}`, `transient ${state.transient.toFixed(2)}`]);
    if (modulation) {
      this.bars([
        ['Scale', COLORS.low, modulation.scale], ['Distortion', COLORS.mid, modulation.distortion],
        ['Camera', COLORS.tempo, modulation.cameraMotion], ['Particles', COLORS.high, modulation.particleEmission],
        ['Bloom', COLORS.level, modulation.bloom], ['Persistence', COLORS.hit, modulation.persistence],
        ['Impact', COLORS.hit, modulation.impact], ['Visibility', COLORS.level, modulation.visibility],
      ]);
    }
    this.y += 6;
  }

  /** The Rust analysis (spectrum-analysis) as received this frame, then timing, dynamics, the show and the Experience snapshot. */
  private drawAnalysis(e: ExperienceSnapshot): void {
    const { ctx } = this;
    const features = this.app.audio.features;
    const f = features.frame;
    if (features.beats.count > 0) this.lastBeat = performance.now();
    const beatLit = performance.now() - this.lastBeat < 90;
    const key = f.key < 0 ? '–' : `${KEYS[f.key % 12]}${f.key >= 12 ? 'm' : ''}`;
    this.flow(COLORS.dim, ['Analysis (Rust)', `capture clock ${f.time.toFixed(2)} s`, features.frames ? 'live' : 'no frames']);
    this.flow(COLORS.level, [
      `presence ${f.presence.toFixed(2)}`, `${f.loudnessMomentary.toFixed(1)} / ${f.loudnessShort.toFixed(1)} LUFS`, `slope ${f.loudnessSlope.toFixed(1)} LU/s`,
      `centroid ${f.centroidHz.toFixed(0)} Hz`, `perc ${f.percussive.toFixed(2)}`, `width ${f.width.toFixed(2)}`, f.clipping > 0.1 ? 'CLIP' : '',
    ]);
    this.flow(beatLit ? COLORS.hit : COLORS.tempo, [
      `${beatLit ? '●' : '○'} grid ${f.beatBpm.toFixed(1)} (${f.beatConfidence.toFixed(2)})`, `beat ${f.beatPhase.toFixed(2)} bar ${f.barPhase.toFixed(2)}`,
      `downbeat ${f.downbeatConfidence.toFixed(2)}`, `tempo ${f.tempoBpm.toFixed(1)} (${f.tempoConfidence.toFixed(2)})`,
      `onsets ${f.onsetDensity.toFixed(1)}/s`, `key ${key} (${f.keyConfidence.toFixed(2)})`,
    ]);

    // Timing: what this frame shows and the measured latencies.
    const { timing, clock } = this.app.audio;
    if (timing.beat) this.lastCue = performance.now();
    const cueLit = performance.now() - this.lastCue < 90;
    const ms = (s: number) => `${(s * 1000).toFixed(0)} ms`;
    this.flow(cueLit ? COLORS.hit : COLORS.level, [
      `${cueLit ? '●' : '○'} cue`, `${timing.mode} ${timing.gridWeight.toFixed(2)}`, `beat ${timing.beatPhase.toFixed(2)} bar ${timing.barPhase.toFixed(2)}`,
      `lead ${ms(timing.lead)}`, `clock ${clock.ready ? 'synced' : '–'}`,
    ]);
    this.flow(COLORS.dim, [
      `Latency: attack→frame ${ms(timing.onsetDelay)} + render ${ms(timing.renderLatency)} = ${ms(timing.onsetDelay + timing.renderLatency)}`,
      `attacks shown ${ms(timing.impactLate)} after heard`, `output ${ms(timing.latency.output)}`,
    ]);
    const section = SECTION_NAMES[f.section] ?? '?';
    const nextPhrase = f.nextPhraseTime > 0 && clock.ready ? `${(clock.toHost(f.nextPhraseTime) - performance.now() / 1000).toFixed(1)} s` : '–';
    this.flow(COLORS.mid, [
      `${section.toUpperCase()} #${f.sectionId}${f.sectionReturn >= 0 ? ` (returns #${f.sectionReturn})` : ''}`, `${f.sectionBars} bars`, `bar ${f.barIndex}`,
      `phrase ${f.phraseBar + 1}/${f.phraseBars} next in ${nextPhrase}`, `novelty ${f.novelty.toFixed(2)}`,
      `sim 4/8/16 ${[...f.similarity].map((x) => x.toFixed(2)).join('/')}`, `drop ${f.dropExpected.toFixed(2)}`,
      `meter ${f.meter || '?'} (${f.meterConfidence.toFixed(2)})`, `conf ${f.structureConfidence.toFixed(2)}`,
    ]);
    this.y += 6;

    // Dynamics: every channel with its type and coefficients: springs ω, ζ (1 while snapped); followers rise/fall; envelopes decay.
    const dynamics = this.app.dynamics;
    const guard = this.app.flashGuard;
    this.flow(COLORS.dim, [
      `Dynamics (${(1 / dynamics.step).toFixed(0)} Hz, audio clock ${dynamics.time.toFixed(2)} s${dynamics.dropped ? `, ${dynamics.dropped} events dropped` : ''})`,
      `flash guard ≥${ms(guard.limits.gap)} apart, max ${guard.limits.max}, ${guard.limited} limited`,
    ]);
    const step = this.column + GAP;
    for (let c = 0; c < dynamics.channelCount; c++) {
      const s = dynamics.inspect(c);
      const params = s.omega > 0 ? ` ω${s.omega.toFixed(1)} ζ${s.zeta.toFixed(2)}` : s.rise > 0 ? ` ↑${ms(s.rise)} ↓${ms(s.fall)}` : ` τ${ms(s.fall)}`;
      const x = (c % this.columns) * step, y = this.y + Math.floor(c / this.columns) * ROW;
      ctx.fillStyle = s.value > 0.02 ? COLORS.hit : COLORS.dim;
      ctx.fillText(s.name, x, y, LABEL - 4);
      ctx.fillText(`${s.value.toFixed(2)} ${s.type}${params}`, x + LABEL, y, this.column - LABEL);
    }
    this.y += Math.ceil(dynamics.channelCount / this.columns) * ROW + 6;

    // Show: the director's mode, budget and effect, the slots, and its last decisions with why.
    const show = this.app.show;
    this.flow(COLORS.tempo, [
      `Show ${show.mode}`, `budget ${show.budget.toFixed(1)}`, `effect ${show.activeEffect}${show.activeEffect !== show.effect ? ` (${show.effect} needs a grid)` : ''}`,
      ...show.slots.map((s, i) => (s.fixture ? `${i === 0 ? '★' : '·'}${s.fixture} ${s.intensity.toFixed(2)} h${s.hue}${s.tint > 0 ? `+${s.tint.toFixed(2)}` : ''}${s.mirror ? ' ⇋' : ''}` : '–')),
    ]);
    for (const d of show.log.slice(-5)) this.flow(COLORS.dim, [`${d.time.toFixed(1)} s  ${d.what}`, `← ${d.why}`], '  ');
    this.y += 6;

    const engine = this.app.audio;
    const a = e.acoustic, state = e.state, plan = e.plan, physics = e.physics;
    const rt = engine.realtimeStats;
    const ahead = (time: number) => (time > 0 ? `+${ms(time - state.time)}` : '–');
    const q = a.loudnessQuantiles;
    engine.experience.events.forEachHeard(this.eventCursor, timing.heardTime, this.keepEvent);
    const level = COLORS.level;
    this.flow(level, rt
      ? [`Realtime ${rt.mode}`, `DSP ${(rt.load * 100).toFixed(1)}% core q${rt.quality}`, `DSP age ${ms(rt.dspAge)}`, `transfer ${ms(rt.transfer)}`, `ring backlog ${rt.backlog}`,
        `staged ${rt.pending} dropped ${rt.dropped}`, `lost ${rt.lost} filled ${rt.filled}`, `${rt.batches} batches`]
      : ['Realtime native capture thread', `attack→frame ${ms(timing.onsetDelay)}`]);
    this.flow(level, ['Experience', `heard snapshot ${state.time.toFixed(2)} s`, `${state.narrative} (${state.narrativeConfidence.toFixed(2)})`, `${state.trajectory} (${state.trajectoryConfidence.toFixed(2)})`]);
    this.flow(level, [`Physical RMS ${a.rms.toFixed(3)}`, `peak ${a.peak.toFixed(3)}`, `crest ${a.crest.toFixed(2)}`, `entropy ${a.entropy.toFixed(2)}`, `complexity ${a.complexity.toFixed(2)}`]);
    this.flow(level, [`Tonal H ${a.harmonicity.toFixed(2)}`, `inH ${a.inharmonicity.toFixed(2)}`, `rough ${a.roughness.toFixed(2)}`, `phase ${a.phaseCoherence.toFixed(2)}`,
      `H/P/R ${a.harmonicShare.toFixed(2)}/${a.percussiveShare.toFixed(2)}/${a.residualShare.toFixed(2)}`]);
    this.flow(level, [`Perceptual M ${a.loudnessMomentary.toFixed(1)} S ${a.loudnessShort.toFixed(1)}`, `range~ ${a.loudnessRange.toFixed(1)} LU`, `bright ${a.perceivedBrightness.toFixed(2)}`, `DSP ${a.dspQuality}`]);
    this.flow(level, [`Context P10/50/90/95 ${q[0].toFixed(1)}/${q[1].toFixed(1)}/${q[2].toFixed(1)}/${q[3].toFixed(1)}`, `pos ${a.loudnessPosition.toFixed(2)}`,
      `band above floor ${[...a.bandLevel].map((x) => x.toFixed(1)).join(' ')}`]);
    this.flow(level, [`Spatial width ${a.width.toFixed(2)}`, `corr ${a.correlation.toFixed(2)}`, `mid/side ${a.midEnergy.toFixed(4)}/${a.sideEnergy.toFixed(4)}`, `pan ${a.balance.toFixed(2)}`]);
    this.flow(level, [`Music BPM ${a.beatBpm.toFixed(1)}`, `meter ${a.meter || '?'} conf ${a.meterConfidence.toFixed(2)}`, `bar ${state.barPhase.toFixed(2)}`, `phrase ${state.phrasePhase.toFixed(2)}`, `novelty ${state.novelty.toFixed(2)}`]);
    this.flow(level, [`Forecast beat ${ahead(state.nextBeatTime)} (${state.nextBeatConfidence.toFixed(2)})`, `downbeat ${ahead(state.nextDownbeatTime)} (${state.nextDownbeatConfidence.toFixed(2)})`,
      `phrase ${ahead(state.nextPhraseTime)} (${state.nextPhraseConfidence.toFixed(2)})`, `horizon ${state.predictionHorizon.toFixed(1)} s`]);
    this.flow(level, [`Likely continue ${state.likelyContinuation.toFixed(2)}`, `build ${state.likelyBuild.toFixed(2)}`, `release ${state.likelyRelease.toFixed(2)}`, `boundary ${state.likelyBoundary.toFixed(2)}`,
      `conf ${state.predictionConfidence.toFixed(2)}`]);
    this.flow(level, [`Anticipation ${state.anticipation.toFixed(2)} (${state.anticipationConfidence.toFixed(2)})`, `stored ${state.releasePotential.toFixed(2)}`, `release ${state.release.toFixed(2)}`,
      `motif ${state.motif}/${state.recurrence}`, `dE ${state.energyVelocity.toFixed(2)}/s`]);
    this.flow(level, [`Entropy ${state.visualEntropy.toFixed(2)}`, `fatigue ${state.fatigue.toFixed(2)}`, `energy/complexity ${state.energy.toFixed(2)}/${state.complexity.toFixed(2)}`, `rel loud ${state.relativeLoudness.toFixed(2)}`]);
    this.flow(level, [`Plan ${plan.currentIntent} → ${plan.nextIntent} ${plan.horizon.toFixed(1)} s`, `window ${ahead(plan.transitionStart)}…${ahead(plan.transitionEnd)} (${plan.transitionConfidence.toFixed(2)})`,
      `confidence ${plan.confidence.toFixed(2)}`, `continuity ${plan.sceneContinuity.toFixed(2)}`]);
    this.flow(level, labelled('Intents', e.intents.filter((i) => i.strength * i.confidence > 0.05).map((i) => `${i.kind} ${(i.strength * i.confidence).toFixed(2)}`)));
    this.flow(level, [`Physics ${physics.activeResonators} modes`, `E ${physics.energy.toFixed(3)}`, `damping ${physics.damping.toFixed(2)}`, `waves ${physics.waveActivity.toFixed(2)}`,
      `silence ${state.silenceKind} ${state.silenceDuration.toFixed(1)} s`]);
    this.flow(level, labelled('Events', this.recentEvents.map((x) => `${x.type}@${x.audioTime.toFixed(2)}${x.band >= 0 ? `/b${x.band}` : ''} ${x.strength.toFixed(2)}·${x.confidence.toFixed(2)}`)), '  ');
    ctx.fillStyle = COLORS.high;
    ctx.fillText('ERB', 0, this.y);
    const pitch = Math.min(12, (this.width - 40) / 24);
    for (let b = 0; b < 24; b++) ctx.fillRect(40 + b * pitch, this.y - 10, pitch * 2 / 3, a.erb[b] * 10);
    this.y += ROW;
  }

  // ---- World & Physics ----------------------------------------------------------------------

  /** The persistent world as presented (heard time), its held forces and the protagonist's adapter output. */
  private drawWorld(e: ExperienceSnapshot): void {
    const w = e.world, f = w.forces;
    this.flow(COLORS.dim, [`World · ${w.time.toFixed(2)} s`, `E ${w.energy.toFixed(3)}`, `kinetic ${w.kinetic.toFixed(3)}`, `elastic ${w.elastic.toFixed(3)}`, `stored ${w.stored.toFixed(3)}`, `waves ${w.wave.toFixed(3)}`, 'Shift+T trace']);
    this.bars([
      ['±Pressure', COLORS.low, w.radius], ['±Spin', COLORS.mid, w.spin / 3],
      ['Speed', COLORS.mid, w.speed / 6], ['±Lateral', COLORS.tempo, w.bias],
      ['Excitation', COLORS.hit, w.excitation], ['Shimmer', COLORS.high, w.shimmer],
      ['Turbulence', COLORS.hit, w.turbulence], ['Coherence', COLORS.mid, w.coherence],
      ['Potential', COLORS.tempo, w.potential], ['Illumination', COLORS.level, w.illumination],
      ['Openness', COLORS.level, w.openness], ['Energy /4', COLORS.level, w.energy / 4],
    ]);
    const age = (t: number) => (Number.isFinite(t) ? `${(w.time - t).toFixed(1)} s ago` : '–');
    this.y += 4;
    this.flow(COLORS.level, [
      `Forces rest ${f.radialRest.toFixed(2)}`, `torque ${f.torque.toFixed(2)} (drag ${f.spinDrag.toFixed(2)})`, `thrust ${f.thrust.toFixed(2)} (drag ${f.travelDrag.toFixed(2)})`,
      `lateral ${f.biasRest.toFixed(2)}`, `charge ${f.charge.toFixed(2)}`, `impulse ${w.impulseStrength.toFixed(2)} ${age(w.impulseTime)}`, `release ${w.releaseStrength.toFixed(2)} ${age(w.releaseTime)}`,
    ]);
    const view = this.app.directionDebug.current?.director.world;
    if (view) this.flow(COLORS.level, [`Adapter (protagonist) travel ${view.travel.toFixed(1)}`, `turn ${view.turn.toFixed(2)}`, `per frame ${view.dTravel.toFixed(3)} / ${view.dTurn.toFixed(4)}`, `disorder ${view.disorder.toFixed(2)}`]);
  }

  // ---- Matter & Geometry ----------------------------------------------------------------------

  /** Sound → material → matter: the morphology heard, the material derived from it, the protagonist's matter and the GPU's work. */
  private drawMatter(e: ExperienceSnapshot): void {
    const layer = this.app.directionDebug.current, scene = layer?.visualizer.debug;
    const state = e.state, m = e.morphology;
    const share = (key: string) => (scene && key in scene ? `${Math.round(scene[key] * 100)}%` : '–');
    this.flow(COLORS.dim, [
      `Matter · state ${matterLab.form === 'auto' ? 'auto' : `pinned ${matterLab.form}`}`, `wave ${share('wave')}`, `harmonic ${share('harmonic')}`, `particles ${share('free')}`,
      `${scene?.particles ?? '–'} elements`, `${this.frameMs.toFixed(1)} ms (${this.app.directionDebug.measuredFps.toFixed(0)} fps)`,
    ]);
    this.bars(MORPHOLOGY_KEYS.map((key): Bar => [key, COLORS.mid, m[key]]));
    this.y += 4;
    this.flow(COLORS.dim, ['Material (what kind of matter could stand for this sound)']);
    const view = layer?.director.world;
    if (view) deriveMaterial(this.material, view, e);
    this.bars(MATERIAL_KEYS.map((key): Bar => [key, COLORS.high, this.material[key]]));
    this.y += 4;
    this.flow(COLORS.level, [
      `Prediction conf ${state.predictionConfidence.toFixed(2)}`, `build ${state.likelyBuild.toFixed(2)}`, `release ${state.likelyRelease.toFixed(2)}`, `boundary ${state.likelyBoundary.toFixed(2)}`,
      `anticipation ${state.anticipation.toFixed(2)} × ${state.anticipationConfidence.toFixed(2)}`, `→ charge ${e.world.forces.charge.toFixed(3)}/s`, `→ potential ${e.world.potential.toFixed(2)}`,
    ]);
    // What the protagonist reports about its render systems (Spectral Matter: state, forms, fields, fronts, memory, simulation).
    this.flow(COLORS.level, labelled('Scene', scene ? Object.entries(scene).map(([key, value]) => `${key} ${Number.isInteger(value) ? value : value.toFixed(2)}`) : []));
    const d = this.drawn, memory = this.app.directionDebug.renderer.info.memory;
    this.flow(COLORS.dim, [
      `GPU frame: ${d.calls} draw calls`, `${d.triangles} triangles`, `${d.points} points`, `${d.lines} lines`, `${memory.geometries} geometries`, `${memory.textures} textures`,
      `${this.app.directionDebug.renderer.info.programs?.length ?? 0} programs`, `quality ${this.app.directionDebug.qualityTier}`,
    ]);
  }

  /**
   * The protagonist's visual world, when it is one (docs/visual-engine.md): its structural budget, the geometry the
   * sound asks for, how present each primitive is and what it submits, and the fields they all share.
   */
  private drawVisualWorld(): void {
    const scene = this.app.directionDebug.current?.visualizer;
    if (!(scene instanceof RecipeVisualizer)) {
      this.flow(COLORS.dim, ['Visual World', 'the protagonist is a legacy scene (no world, no primitives)']);
      return;
    }
    const world = scene.world, d = world.debug, g = world.mapper.state;
    this.flow(COLORS.dim, [
      'Visual World', `recipe ${world.recipe.id}`, `entropy budget ${d.budget.toFixed(2)} (ceiling ${d.ceiling.toFixed(2)})`, `${d.present}/${d.primitives} primitives`,
      `${d.elements} elements`, `${d.vertices} vertices`, worldLab.only ? `pinned to ${[...worldLab.only].join(', ')}` : '',
    ]);
    this.bars(GEOMETRY_TRAITS.map((key): Bar => [SIGNED_TRAITS.includes(key) ? `± ${key}` : key, COLORS.tempo, g[key]]));
    this.y += 4;
    this.flow(COLORS.level, labelled('Primitives', world.mounted.map((m) => `${m.slot.id} ${m.presence.value > 0.004 ? `${Math.round(m.presence.value * 100)}%` : 'off'} ${m.primitive.vertices}v`)));
    const f = world.fields;
    const active = (Object.keys(f) as (keyof typeof f)[]).filter((key) => key !== 'turn' && !key.endsWith('Scale') && Math.abs(f[key]) > 0.01).map((key) => `${key} ${f[key].toFixed(1)}`);
    this.flow(COLORS.dim, [...labelled('Fields', active), `fronts ${d.waves}`, `GPU budget ${this.app.show.budget.toFixed(1)} units`]);
  }

  private bar(label: string, color: string, value: number, x: number, y: number): void {
    const { ctx } = this;
    const width = this.column - LABEL - VALUE;
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(label, x, y, LABEL - 4);
    ctx.fillStyle = COLORS.track;
    ctx.fillRect(x + LABEL, y - 4, width, 8);
    ctx.fillStyle = color;
    if (label.endsWith('Trend') || label.startsWith('±')) {
      ctx.fillRect(x + LABEL + width / 2, y - 4, Math.max(-1, Math.min(value, 1)) * width / 2, 8);
    } else ctx.fillRect(x + LABEL, y - 4, Math.max(0, Math.min(value, 1)) * width, 8);
    ctx.fillStyle = COLORS.level;
    ctx.fillText(value.toFixed(2), x + LABEL + width + 8, y);
  }
}
