import type { DiagnosticsController } from '../../diagnostics/core/DiagnosticsController';
import { settingsStore } from '../../stores/settingsStore';
import { TEST_SIGNALS, type TestSignal } from '../../audio/capture/testSignals';
import { hzToPosition } from '../../audio/visual-response/spectrum';
import type { AudioFrame, MusicalState, VisualResponseFrame } from '../../types/audio';
import type { App } from '../App';
import { SECTION_NAMES } from '../../audio/features/decode';
import type { AudioEvent, EventCursor } from '../../experience/EventStream';
import type { ExperienceSnapshot } from '../../experience/types';
import { MORPHOLOGY_KEYS } from '../../morphology/SoundMorphology';
import { matterLab, type FormPin } from '../../render-systems/forms/MatterForms';
import { GEOMETRY_KEYS, SIGNED_TRAITS } from '../../visual-engine/geometry/GeometryState';
import { RecipeVisualizer } from '../../visual-engine/RecipeVisualizer';
import { worldLab } from '../../visual-engine/VisualWorld';
import { createMaterial, deriveMaterial, MATERIAL_KEYS } from '../../render-systems/materials/VisualMaterial';

/*
 * Development-only audio/visual debug overlay. Shows the analyzer output
 * (bands, levels, transients, spectrum) next to the derived visual response
 * and musical context, to tell whether a problem comes from the analysis, the
 * mapping or the scene. Also switches the synthetic test signals.
 * Open with ?debug or Shift+D. Loaded only when import.meta.env.DEV, so it
 * never ships in production. The shared DiagnosticsController records WorldTrace only after REC
 * in the Diagnostics dashboard; Shift+T exports that trace.
 *
 * The Matter block is the matter engine's laboratory view (docs/matter-engine.md):
 * the sound's morphology, the visual material derived from it, the state the
 * protagonist's matter is in, what it submits to the GPU and what the renderer
 * drew this frame. The second menu (or ?matter=wave|harmonic|particles) pins
 * the matter to one state, so each experiment can be looked at on its own.
 */

const COLUMN = 310;
const GAP = 16;
const WIDTH = COLUMN * 2 + GAP;
const ROW = 14;
const LABEL = 100;
const BAR = 150;
const COLORS = { low: '#f0a050', mid: '#6fd08c', high: '#6cc8f0', hit: '#e070d0', level: '#d8dcf0', tempo: '#f0e070', dim: '#5a607a' };

type Read = (a: AudioFrame, r: VisualResponseFrame) => number;
type Row = [label: string, color: string, read: Read];
type Section = [title: string, rows: Row[]];

const LEFT: Section[] = [
  [
    'AudioFrame · bands',
    [
      ['Bass', COLORS.low, (a) => a.bass],
      ['LowMid', COLORS.low, (a) => a.lowMid],
      ['Mid', COLORS.mid, (a) => a.mid],
      ['HighMid', COLORS.high, (a) => a.highMid],
      ['Treble', COLORS.high, (a) => a.treble],
    ],
  ],
  [
    'AudioFrame · levels & beat',
    [
      ['Volume', COLORS.level, (a) => a.volume],
      ['Energy', COLORS.level, (a) => a.energy],
      ['Loudness', COLORS.level, (a) => a.loudness],
      ['Onset', COLORS.hit, (a) => a.onset],
      ['BeatPulse', COLORS.hit, (a) => a.beatPulse],
      ['TempoConf', COLORS.tempo, (a) => a.tempoConfidence],
      ['BeatPhase', COLORS.tempo, (a) => a.beatPhase],
    ],
  ],
  [
    'AudioFrame · transients & texture',
    [
      ['LowFlux', COLORS.low, (a) => a.lowFlux],
      ['MidFlux', COLORS.mid, (a) => a.midFlux],
      ['HighFlux', COLORS.high, (a) => a.highFlux],
      ['RMS', COLORS.level, (a) => a.rms],
      ['Flatness', COLORS.level, (a) => a.flatness],
    ],
  ],
];

LEFT.push(['Section trends · −1…+1', [
  ['EnergyTrend', COLORS.level, (_, r) => r.music.energyTrend],
  ['MotionTrend', COLORS.mid, (_, r) => r.music.motionTrend],
  ['DensityTrend', COLORS.high, (_, r) => r.music.densityTrend],
  ['TensionTrend', COLORS.hit, (_, r) => r.music.tensionTrend],
  ['OpenTrend', COLORS.tempo, (_, r) => r.music.opennessTrend],
  ['RecentPeak', COLORS.level, (_, r) => r.music.recentPeak],
  ['RecentDrop', COLORS.hit, (_, r) => r.music.recentDrop],
]]);

const RIGHT: Section[] = [
  [
    'MusicState · sonic roles',
    [
      ['Presence', COLORS.level, (_, r) => r.presence],
      ['Weight', COLORS.low, (_, r) => r.weight],
      ['Flow', COLORS.mid, (_, r) => r.flow],
      ['Detail', COLORS.high, (_, r) => r.detail],
      ['Shimmer', COLORS.high, (_, r) => r.shimmer],
      ['Impact', COLORS.hit, (_, r) => r.impact],
      ['Trace', COLORS.hit, (_, r) => r.trace],
      ['Density', COLORS.level, (_, r) => r.density],
      ['Motion', COLORS.mid, (_, r) => r.motion],
      ['Openness', COLORS.level, (_, r) => r.openness],
      ['Tension', COLORS.hit, (_, r) => r.tension],
      ['Audible L', COLORS.low, (_, r) => r.lowAudible],
      ['Audible M', COLORS.mid, (_, r) => r.midAudible],
      ['Audible H', COLORS.high, (_, r) => r.highAudible],
    ],
  ],
  [
    'Music context',
    [
      ['State conf.', COLORS.level, (_, r) => r.stateConfidence],
      ['TempoLock', COLORS.tempo, (_, r) => r.music.tempoLock],
      ['Beat', COLORS.tempo, (_, r) => r.music.beats - Math.floor(r.music.beats)],
      ['Bar', COLORS.tempo, (_, r) => (r.music.beats / 4) % 1],
      ['Intensity', COLORS.level, (_, r) => r.music.intensity],
      ['Build', COLORS.hit, (_, r) => r.music.build],
      ['Drop', COLORS.hit, (_, r) => r.music.drop],
      ['LowPerc', COLORS.low, (_, r) => r.music.lowPercussion],
      ['MidPerc', COLORS.mid, (_, r) => r.music.midPercussion],
      ['HighPerc', COLORS.high, (_, r) => r.music.highPercussion],
      ['Brightness', COLORS.high, (_, r) => r.music.brightness],
      ['Tonality', COLORS.mid, (_, r) => r.music.tonality],
      ['SongLock', COLORS.level, (_, r) => r.music.songLock],
    ],
  ],
];

const rowsOf = (sections: Section[]) => sections.reduce((n, [, rows]) => n + rows.length + 1, 0);
const COLUMNS_HEIGHT = 8 + Math.max(rowsOf(LEFT), rowsOf(RIGHT)) * ROW;
const SPECTRUM_HEIGHT = 60;
const SPECTRUM_TOP = COLUMNS_HEIGHT + 4 * ROW + 16;
/** Ten seconds sampled at 20 Hz, independent of rendering frame rate. */
const HISTORY_RATE = 20;
const HISTORY = 10 * HISTORY_RATE;
const HISTORY_HEIGHT = 40;
const HISTORY_TOP = SPECTRUM_TOP + SPECTRUM_HEIGHT + 22 + ROW;
const DIRECTOR_TOP = HISTORY_TOP + HISTORY_HEIGHT + 20;
const ANALYSIS_TOP = DIRECTOR_TOP + 7 * ROW + 6;
const DYNAMICS_TOP = ANALYSIS_TOP + 6 * ROW + 6;
/** Room for 20 Dynamics channels (two per row). */
const DYNAMICS_ROWS = 11;
const SHOW_TOP = DYNAMICS_TOP + DYNAMICS_ROWS * ROW + 6;
const EXPERIENCE_TOP = SHOW_TOP + 7 * ROW;
/** Experience block: text lines, then the ERB row. */
const EXPERIENCE_LINES = 16;
const WORLD_TOP = EXPERIENCE_TOP + (EXPERIENCE_LINES + 1) * ROW + 6;
/** World block: title, six rows of paired bars, forces, adapter. */
const WORLD_ROWS = 9;
const MATTER_TOP = WORLD_TOP + WORLD_ROWS * ROW + 6;
/** Matter block: title, morphology and material as paired bars, prediction, the scene's own numbers (two lines), the renderer. */
const MORPHOLOGY_ROWS = Math.ceil(MORPHOLOGY_KEYS.length / 2);
const MATERIAL_ROWS = Math.ceil(MATERIAL_KEYS.length / 2);
const MATTER_ROWS = 1 + MORPHOLOGY_ROWS + 1 + MATERIAL_ROWS + 4;
const WORLD_ENGINE_TOP = MATTER_TOP + MATTER_ROWS * ROW + 6;
/** Visual World block: title, the geometry traits beyond the material as paired bars, the primitives, the fields. */
const GEOMETRY_TRAITS = GEOMETRY_KEYS.filter((key) => !(MATERIAL_KEYS as readonly string[]).includes(key));
const GEOMETRY_ROWS = Math.ceil(GEOMETRY_TRAITS.length / 2);
const WORLD_ENGINE_ROWS = 1 + GEOMETRY_ROWS + 3;
const HEIGHT = WORLD_ENGINE_TOP + WORLD_ENGINE_ROWS * ROW;
const FORM_PINS: readonly FormPin[] = ['auto', 'particles', 'wave', 'harmonic'];
const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const STATE_COLORS: Record<MusicalState, string> = {
  silent: COLORS.dim,
  calm: COLORS.high,
  rising: COLORS.tempo,
  active: COLORS.mid,
  peak: COLORS.hit,
  falling: COLORS.low,
};
const LOW_END = hzToPosition(250);
const MID_END = hzToPosition(2000);

export function installDebugOverlay(app: App, diagnostics: DiagnosticsController): () => void {
  let overlay: DebugOverlay | null = null;
  const toggle = () => {
    if (overlay) {
      overlay.dispose();
      overlay = null;
    } else {
      overlay = new DebugOverlay(app, diagnostics);
    }
  };
  const onKey = (event: KeyboardEvent) => {
    if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === 'KeyD') toggle();
    if (event.code === 'KeyT') download(`euforia-audio-experience-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, diagnostics.trace?.toCsv() ?? 'time\n');
  };
  window.addEventListener('keydown', onKey);
  const query = new URLSearchParams(location.search);
  const pin = query.get('matter') as FormPin | null;
  if (pin && FORM_PINS.includes(pin)) matterLab.form = pin;
  // ?primitives=matter,surface: a visual world shows exactly these primitive systems, whatever the sound.
  const only = query.get('primitives');
  if (only) worldLab.only = new Set(only.split(',').filter(Boolean));
  if (query.has('debug')) toggle();
  return () => {
    window.removeEventListener('keydown', onKey);
    overlay?.dispose();
    matterLab.form = 'auto';
    worldLab.only = null;
  };
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

class DebugOverlay {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private rafId = 0;
  private lastTime = performance.now();
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
  /** Ring buffers of the history strip. */
  private readonly energy = new Float32Array(HISTORY);
  private readonly presence = new Float32Array(HISTORY);
  private readonly motion = new Float32Array(HISTORY);
  private readonly openness = new Float32Array(HISTORY);
  private readonly tension = new Float32Array(HISTORY);
  private historyTime = 0;
  private head = 0;
  /** The protagonist's material, derived here from the same world view and snapshot the scene uses. */
  private readonly material = createMaterial();
  /** What the renderer drew last frame (its counters are summed over the frame's passes while the overlay is open). */
  private readonly releaseDiagnostics: () => void;
  private readonly drawn = { calls: 0, triangles: 0, points: 0, lines: 0 };

  constructor(private readonly app: App, private readonly diagnostics: DiagnosticsController) {
    this.root = document.createElement('div');
    this.root.style.cssText =
      'position:fixed;top:12px;right:12px;z-index:9999;padding:8px;border-radius:8px;background:rgba(6,8,18,.82);' +
      'font:11px ui-monospace,monospace;color:#d8dcf0;user-select:none;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;';

    const select = document.createElement('select');
    select.style.cssText = 'width:100%;margin-bottom:6px;font:inherit;background:#12152a;color:inherit;border:1px solid #2a2f4a;';
    select.append(new Option('Test signal…', ''));
    for (const s of TEST_SIGNALS) select.append(new Option(s.label, s.id));
    select.addEventListener('change', () => {
      if (select.value) void app.playTestSignal(select.value as TestSignal);
      select.blur();
    });

    const dpr = window.devicePixelRatio || 1;
    this.canvas = document.createElement('canvas');
    this.canvas.width = WIDTH * dpr;
    this.canvas.height = HEIGHT * dpr;
    this.canvas.style.cssText = `display:block;width:${WIDTH}px;height:${HEIGHT}px;`;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);

    const pin = document.createElement('select');
    pin.style.cssText = select.style.cssText;
    for (const form of FORM_PINS) pin.append(new Option(`Matter: ${form}`, form));
    pin.value = matterLab.form;
    pin.addEventListener('change', () => {
      matterLab.form = pin.value as FormPin;
      pin.blur();
    });

    this.root.append(select, pin, this.canvas);
    document.body.append(this.root);
    // Shared totals are measured by the observer at the RenderEngine frame boundary.
    this.releaseDiagnostics = diagnostics.acquire();
    this.rafId = requestAnimationFrame(this.draw);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.releaseDiagnostics();
    this.root.remove();
  }

  private readonly draw = (now: number): void => {
    this.rafId = requestAnimationFrame(this.draw);
    this.frameMs += (now - this.lastTime - this.frameMs) * 0.05;
    const dt = Math.min((now - this.lastTime) / 1000, HISTORY / HISTORY_RATE);
    this.lastTime = now;

    const { ctx } = this;
    Object.assign(this.drawn, this.diagnostics.renderer?.drawn);
    const audio = this.app.audio.frame;
    const response = this.app.audio.visual;
    const music = response.music;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.textBaseline = 'middle';
    this.column(LEFT, 0, audio, response);
    this.column(RIGHT, COLUMN + GAP, audio, response);

    let y = COLUMNS_HEIGHT;
    ctx.fillStyle = COLORS.tempo;
    ctx.fillText(
      `Tempo ${music.tempo.toFixed(1)} (detected ${audio.bpm ? audio.bpm.toFixed(1) : '–'})  pace ×${music.pace.toFixed(2)}   ` +
        `song #${music.song}   ${this.frameMs.toFixed(1)} ms${audio.beat ? '   ● beat' : ''}`,
      0,
      y,
    );
    y += ROW;
    ctx.fillStyle = STATE_COLORS[response.state];
    ctx.fillText(`State: ${response.state} ${response.stateAge.toFixed(1)}s ← ${response.previousState}`, 0, y);
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(`noise floor ${this.app.audio.response.noiseFloor.toFixed(1)} dB`, COLUMN + GAP, y);
    y += ROW;

    // Spectral balance (left) and per-song variation (right).
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('Balance L / M / H', 0, y);
    ctx.fillText('Variation (per song)', COLUMN + GAP, y);
    y += ROW - 4;
    let x = 0;
    for (const [share, color] of [
      [response.lowShare, COLORS.low],
      [response.midShare, COLORS.mid],
      [response.highShare, COLORS.high],
    ] as const) {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, share * COLUMN, 8);
      x += share * COLUMN;
    }
    const cell = COLUMN / music.variation.length;
    for (let i = 0; i < music.variation.length; i++) {
      ctx.fillStyle = '#1a1e36';
      ctx.fillRect(COLUMN + GAP + i * cell, y - 10, cell - 3, 20);
      ctx.fillStyle = COLORS.tempo;
      const h = music.variation[i] * 20;
      ctx.fillRect(COLUMN + GAP + i * cell, y + 10 - h, cell - 3, h);
    }

    // Spectrum with the region boundaries used by the balance.
    const top = SPECTRUM_TOP;
    const { spectrum } = audio;
    const w = WIDTH / spectrum.length;
    for (let i = 0; i < spectrum.length; i++) {
      const p = (i + 0.5) / spectrum.length;
      ctx.fillStyle = p < LOW_END ? COLORS.low : p < MID_END ? COLORS.mid : COLORS.high;
      const h = spectrum[i] * SPECTRUM_HEIGHT;
      ctx.fillRect(i * w, top + SPECTRUM_HEIGHT - h, Math.max(w - 0.5, 0.5), h);
    }
    ctx.fillStyle = COLORS.dim;
    for (const [p, label] of [
      [LOW_END, '250'],
      [MID_END, '2k'],
    ] as const) {
      ctx.fillRect(p * WIDTH, top, 1, SPECTRUM_HEIGHT);
      ctx.fillText(label, p * WIDTH + 3, top + SPECTRUM_HEIGHT + 10);
    }

    this.historyTime += dt;
    while (this.historyTime >= 1 / HISTORY_RATE) {
      this.historyTime -= 1 / HISTORY_RATE;
      this.energy[this.head] = audio.loudness;
      this.presence[this.head] = response.presence;
      this.motion[this.head] = response.motion;
      this.openness[this.head] = response.openness;
      this.tension[this.head] = response.tension;
      this.head = (this.head + 1) % HISTORY;
    }
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('History 10 s:', 0, HISTORY_TOP - ROW / 2 - 2);
    ctx.fillStyle = COLORS.level;
    ctx.fillText('loudness', 90, HISTORY_TOP - ROW / 2 - 2);
    ctx.fillStyle = COLORS.low;
    ctx.fillText('presence', 160, HISTORY_TOP - ROW / 2 - 2);
    ctx.fillStyle = COLORS.mid;
    ctx.fillText('motion', 230, HISTORY_TOP - ROW / 2 - 2);
    ctx.fillStyle = COLORS.tempo;
    ctx.fillText('openness', 290, HISTORY_TOP - ROW / 2 - 2);
    ctx.fillStyle = COLORS.hit;
    ctx.fillText('tension', 365, HISTORY_TOP - ROW / 2 - 2);
    ctx.fillStyle = '#1a1e36';
    ctx.fillRect(0, HISTORY_TOP, WIDTH, HISTORY_HEIGHT);
    this.trace(this.energy, COLORS.level);
    this.trace(this.presence, COLORS.low);
    this.trace(this.motion, COLORS.mid);
    this.trace(this.openness, COLORS.tempo);
    this.trace(this.tension, COLORS.hit);
    const engine = this.app.directionDebug;
    const direction = engine.effectiveDirection;
    const modulation = engine.modulation;
    ctx.fillStyle = COLORS.level;
    ctx.fillText(`${settingsStore.get().scene} · ${direction.mood} · ${direction.experience} · auto ${direction.autoDirection ? engine.autoDirection.confidence.toFixed(2) : 'off'}`, 0, DIRECTOR_TOP);
    ctx.fillText(`Centroid ${audio.centroidHz.toFixed(0)} Hz · rolloff ${audio.rolloffHz.toFixed(0)} Hz · spread ${audio.spreadHz.toFixed(0)} Hz`, 0, DIRECTOR_TOP + ROW);
    const state = this.app.audio.visual;
    ctx.fillText(`Short energy ${state.shortEnergy.toFixed(2)} · Δ ${state.energyDelta.toFixed(2)} · range ${state.dynamicRange.toFixed(2)} · transient ${state.transient.toFixed(2)}`, 0, DIRECTOR_TOP + ROW * 2);
    if (modulation) {
      this.bar('Scale', COLORS.low, modulation.scale, 0, DIRECTOR_TOP + ROW * 3);
      this.bar('Distortion', COLORS.mid, modulation.distortion, COLUMN + GAP, DIRECTOR_TOP + ROW * 3);
      this.bar('Camera', COLORS.tempo, modulation.cameraMotion, 0, DIRECTOR_TOP + ROW * 4);
      this.bar('Particles', COLORS.high, modulation.particleEmission, COLUMN + GAP, DIRECTOR_TOP + ROW * 4);
      this.bar('Bloom', COLORS.level, modulation.bloom, 0, DIRECTOR_TOP + ROW * 5);
      this.bar('Persistence', COLORS.hit, modulation.persistence, COLUMN + GAP, DIRECTOR_TOP + ROW * 5);
      this.bar('Impact', COLORS.hit, modulation.impact, 0, DIRECTOR_TOP + ROW * 6);
      this.bar('Visibility', COLORS.level, modulation.visibility, COLUMN + GAP, DIRECTOR_TOP + ROW * 6);
    }
    this.drawAnalysis();
  };

  /** The Rust analysis (spectrum-analysis), as received this frame: capture clock, levels, timbre, grid, key. */
  private drawAnalysis(): void {
    const { ctx } = this;
    const features = this.app.audio.features;
    const f = features.frame;
    if (features.beats.count > 0) this.lastBeat = performance.now();
    const beatLit = performance.now() - this.lastBeat < 90;
    const key = f.key < 0 ? '–' : `${KEYS[f.key % 12]}${f.key >= 12 ? 'm' : ''}`;
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(`Analysis (Rust) · capture clock ${f.time.toFixed(2)} s · ${features.frames ? 'live' : 'no frames'}`, 0, ANALYSIS_TOP);
    ctx.fillStyle = COLORS.level;
    ctx.fillText(
      `presence ${f.presence.toFixed(2)} · ${f.loudnessMomentary.toFixed(1)} / ${f.loudnessShort.toFixed(1)} LUFS · slope ${f.loudnessSlope.toFixed(1)} LU/s · ` +
        `centroid ${f.centroidHz.toFixed(0)} Hz · perc ${f.percussive.toFixed(2)} · width ${f.width.toFixed(2)}${f.clipping > 0.1 ? ' · CLIP' : ''}`,
      0,
      ANALYSIS_TOP + ROW,
    );
    ctx.fillStyle = beatLit ? COLORS.hit : COLORS.tempo;
    ctx.fillText(
      `${beatLit ? '●' : '○'} grid ${f.beatBpm.toFixed(1)} (${f.beatConfidence.toFixed(2)}) beat ${f.beatPhase.toFixed(2)} bar ${f.barPhase.toFixed(2)} ` +
        `downbeat ${f.downbeatConfidence.toFixed(2)} · tempo ${f.tempoBpm.toFixed(1)} (${f.tempoConfidence.toFixed(2)}) · ` +
        `onsets ${f.onsetDensity.toFixed(1)}/s · key ${key} (${f.keyConfidence.toFixed(2)})`,
      0,
      ANALYSIS_TOP + ROW * 2,
    );

    // Timing: what this frame shows and the measured latencies.
    const { timing, clock } = this.app.audio;
    if (timing.beat) this.lastCue = performance.now();
    const cueLit = performance.now() - this.lastCue < 90;
    const ms = (s: number) => `${(s * 1000).toFixed(0)} ms`;
    ctx.fillStyle = cueLit ? COLORS.hit : COLORS.level;
    ctx.fillText(
      `${cueLit ? '●' : '○'} cue · ${timing.mode} ${timing.gridWeight.toFixed(2)} · beat ${timing.beatPhase.toFixed(2)} bar ${timing.barPhase.toFixed(2)} · lead ${ms(timing.lead)} · ` +
        `clock ${clock.ready ? 'synced' : '–'}`,
      0,
      ANALYSIS_TOP + ROW * 3,
    );
    const section = SECTION_NAMES[f.section] ?? '?';
    const nextPhrase = f.nextPhraseTime > 0 && clock.ready ? `${(clock.toHost(f.nextPhraseTime) - performance.now() / 1000).toFixed(1)} s` : '–';
    ctx.fillStyle = COLORS.mid;
    ctx.fillText(
      `${section.toUpperCase()} #${f.sectionId}${f.sectionReturn >= 0 ? ` (returns #${f.sectionReturn})` : ''} · ${f.sectionBars} bars · bar ${f.barIndex} · phrase ${f.phraseBar + 1}/${f.phraseBars} next in ${nextPhrase} · ` +
        `novelty ${f.novelty.toFixed(2)} · sim 4/8/16 ${[...f.similarity].map((x) => x.toFixed(2)).join('/')} · drop ${f.dropExpected.toFixed(2)} · meter ${f.meter || "?"} (${f.meterConfidence.toFixed(2)}) · conf ${f.structureConfidence.toFixed(2)}`,
      0,
      ANALYSIS_TOP + ROW * 5,
    );
    // Dynamics: every channel with its type and coefficients: springs ω, ζ (1 while snapped); followers rise/fall; envelopes decay.
    const dynamics = this.app.dynamics;
    ctx.fillStyle = COLORS.dim;
    const guard = this.app.flashGuard;
    ctx.fillText(
      `Dynamics (${(1 / dynamics.step).toFixed(0)} Hz, audio clock ${dynamics.time.toFixed(2)} s${dynamics.dropped ? `, ${dynamics.dropped} events dropped` : ''}) · ` +
        `flash guard ≥${ms(guard.limits.gap)} apart, max ${guard.limits.max}, ${guard.limited} limited`,
      0,
      DYNAMICS_TOP,
    );
    for (let c = 0; c < dynamics.channelCount; c++) {
      const s = dynamics.inspect(c);
      const params = s.omega > 0 ? ` ω${s.omega.toFixed(1)} ζ${s.zeta.toFixed(2)}` : s.rise > 0 ? ` ↑${ms(s.rise)} ↓${ms(s.fall)}` : ` τ${ms(s.fall)}`;
      ctx.fillStyle = s.value > 0.02 ? COLORS.hit : COLORS.dim;
      ctx.fillText(`${s.name.padEnd(16)}${s.value.toFixed(2).padStart(6)} ${s.type}${params}`, (c % 2) * (COLUMN + GAP), DYNAMICS_TOP + ROW * (1 + (c >> 1)));
    }
    // Show: the director's mode, budget and effect, the slots, and its last decisions with why.
    const show = this.app.show;
    ctx.fillStyle = COLORS.tempo;
    const slots = show.slots.map((s, i) => (s.fixture ? `${i === 0 ? '★' : '·'}${s.fixture} ${s.intensity.toFixed(2)} h${s.hue}${s.tint > 0 ? `+${s.tint.toFixed(2)}` : ''}${s.mirror ? ' ⇋' : ''}` : '–')).join('  ');
    ctx.fillText(`Show ${show.mode} · budget ${show.budget.toFixed(1)} · effect ${show.activeEffect}${show.activeEffect !== show.effect ? ` (${show.effect} needs a grid)` : ''} · ${slots}`, 0, SHOW_TOP);
    ctx.fillStyle = COLORS.dim;
    show.log.slice(-5).forEach((d, i) => ctx.fillText(`${d.time.toFixed(1)} s  ${d.what}  ← ${d.why}`, 0, SHOW_TOP + ROW * (i + 1)));
    const engine = this.app.audio;
    const e = engine.experience.presented;
    const a = e.acoustic, state = e.state, plan = e.plan, physics = e.physics;
    const rt = engine.realtimeStats;
    const ahead = (time: number) => (time > 0 ? `+${ms(time - state.time)}` : '–');
    const q = a.loudnessQuantiles;
    engine.experience.events.forEachHeard(this.eventCursor, timing.heardTime, this.keepEvent);
    const recent = this.recentEvents.map((x) => `${x.type}@${x.audioTime.toFixed(2)}${x.band >= 0 ? `/b${x.band}` : ''} ${x.strength.toFixed(2)}·${x.confidence.toFixed(2)}`).join('  ');
    const lines = [
      rt
        ? `Realtime ${rt.mode} · DSP ${(rt.load * 100).toFixed(1)}% core q${rt.quality} · DSP age ${ms(rt.dspAge)} · transfer ${ms(rt.transfer)} · ring backlog ${rt.backlog} · staged ${rt.pending} dropped ${rt.dropped} · lost ${rt.lost} filled ${rt.filled} · ${rt.batches} batches`
        : `Realtime native capture thread · attack→frame ${ms(timing.onsetDelay)}`,
      `Experience · heard snapshot ${state.time.toFixed(2)} s · ${state.narrative} (${state.narrativeConfidence.toFixed(2)}) / ${state.trajectory} (${state.trajectoryConfidence.toFixed(2)})`,
      `Physical RMS ${a.rms.toFixed(3)} peak ${a.peak.toFixed(3)} crest ${a.crest.toFixed(2)} entropy ${a.entropy.toFixed(2)} complexity ${a.complexity.toFixed(2)}`,
      `Tonal H ${a.harmonicity.toFixed(2)} inH ${a.inharmonicity.toFixed(2)} rough ${a.roughness.toFixed(2)} phase ${a.phaseCoherence.toFixed(2)} · H/P/R ${a.harmonicShare.toFixed(2)}/${a.percussiveShare.toFixed(2)}/${a.residualShare.toFixed(2)}`,
      `Perceptual M ${a.loudnessMomentary.toFixed(1)} S ${a.loudnessShort.toFixed(1)} range~ ${a.loudnessRange.toFixed(1)} LU · bright ${a.perceivedBrightness.toFixed(2)} DSP ${a.dspQuality}`,
      `Context P10/50/90/95 ${q[0].toFixed(1)}/${q[1].toFixed(1)}/${q[2].toFixed(1)}/${q[3].toFixed(1)} pos ${a.loudnessPosition.toFixed(2)} · band above floor ${[...a.bandLevel].map((x) => x.toFixed(1)).join(' ')}`,
      `Spatial width ${a.width.toFixed(2)} corr ${a.correlation.toFixed(2)} mid/side ${a.midEnergy.toFixed(4)}/${a.sideEnergy.toFixed(4)} pan ${a.balance.toFixed(2)}`,
      `Music BPM ${a.beatBpm.toFixed(1)} meter ${a.meter || '?'} conf ${a.meterConfidence.toFixed(2)} bar ${state.barPhase.toFixed(2)} phrase ${state.phrasePhase.toFixed(2)} novelty ${state.novelty.toFixed(2)}`,
      `Forecast beat ${ahead(state.nextBeatTime)} (${state.nextBeatConfidence.toFixed(2)}) downbeat ${ahead(state.nextDownbeatTime)} (${state.nextDownbeatConfidence.toFixed(2)}) phrase ${ahead(state.nextPhraseTime)} (${state.nextPhraseConfidence.toFixed(2)}) · horizon ${state.predictionHorizon.toFixed(1)} s`,
      `Likely continue ${state.likelyContinuation.toFixed(2)} build ${state.likelyBuild.toFixed(2)} release ${state.likelyRelease.toFixed(2)} boundary ${state.likelyBoundary.toFixed(2)} · conf ${state.predictionConfidence.toFixed(2)}`,
      `Anticipation ${state.anticipation.toFixed(2)} (${state.anticipationConfidence.toFixed(2)}) stored ${state.releasePotential.toFixed(2)} release ${state.release.toFixed(2)} · motif ${state.motif}/${state.recurrence} · dE ${state.energyVelocity.toFixed(2)}/s`,
      `Entropy ${state.visualEntropy.toFixed(2)} fatigue ${state.fatigue.toFixed(2)} energy/complexity ${state.energy.toFixed(2)}/${state.complexity.toFixed(2)} rel loud ${state.relativeLoudness.toFixed(2)}`,
      `Plan ${plan.currentIntent} → ${plan.nextIntent} ${plan.horizon.toFixed(1)} s · window ${ahead(plan.transitionStart)}…${ahead(plan.transitionEnd)} (${plan.transitionConfidence.toFixed(2)}) · confidence ${plan.confidence.toFixed(2)} continuity ${plan.sceneContinuity.toFixed(2)}`,
      `Intents ${e.intents.filter((i) => i.strength * i.confidence > 0.05).map((i) => `${i.kind} ${(i.strength * i.confidence).toFixed(2)}`).join(' · ') || '–'}`,
      `Physics ${physics.activeResonators} modes · E ${physics.energy.toFixed(3)} damping ${physics.damping.toFixed(2)} waves ${physics.waveActivity.toFixed(2)} · silence ${state.silenceKind} ${state.silenceDuration.toFixed(1)} s`,
      `Events ${recent || '–'}`,
    ];
    ctx.fillStyle = COLORS.level;
    lines.forEach((line, i) => ctx.fillText(line, 0, EXPERIENCE_TOP + i * ROW));
    ctx.fillStyle = COLORS.high;
    ctx.fillText('ERB', 0, EXPERIENCE_TOP + EXPERIENCE_LINES * ROW);
    for (let b = 0; b < 24; b++) ctx.fillRect(40 + b * 12, EXPERIENCE_TOP + EXPERIENCE_LINES * ROW - 10, 8, a.erb[b] * 10);

    this.drawWorld(e);
    this.drawMatter(e);
    this.drawVisualWorld();

    ctx.fillStyle = COLORS.dim;
    ctx.fillText(
      `Latency: attack→frame ${ms(timing.onsetDelay)} + render ${ms(timing.renderLatency)} = ${ms(timing.onsetDelay + timing.renderLatency)} · ` +
        `attacks shown ${ms(timing.impactLate)} after heard · output ${ms(timing.latency.output)}`,
      0,
      ANALYSIS_TOP + ROW * 4,
    );
  }

  /** The persistent world as presented (heard time), its held forces and the protagonist's adapter output. */
  private drawWorld(e: ExperienceSnapshot): void {
    const { ctx } = this;
    const w = e.world, f = w.forces;
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(`World · ${w.time.toFixed(2)} s · E ${w.energy.toFixed(3)} = kinetic ${w.kinetic.toFixed(3)} + elastic ${w.elastic.toFixed(3)} + stored ${w.stored.toFixed(3)} + waves ${w.wave.toFixed(3)} · Shift+T trace`, 0, WORLD_TOP);
    const rows: [string, string, number][] = [
      ['±Pressure', COLORS.low, w.radius], ['±Spin', COLORS.mid, w.spin / 3],
      ['Speed', COLORS.mid, w.speed / 6], ['±Lateral', COLORS.tempo, w.bias],
      ['Excitation', COLORS.hit, w.excitation], ['Shimmer', COLORS.high, w.shimmer],
      ['Turbulence', COLORS.hit, w.turbulence], ['Coherence', COLORS.mid, w.coherence],
      ['Potential', COLORS.tempo, w.potential], ['Illumination', COLORS.level, w.illumination],
      ['Openness', COLORS.level, w.openness], ['Energy /4', COLORS.level, w.energy / 4],
    ];
    rows.forEach(([label, color, value], i) => this.bar(label, color, value, (i % 2) * (COLUMN + GAP), WORLD_TOP + ROW * (1 + (i >> 1))));
    const age = (t: number) => (Number.isFinite(t) ? `${(w.time - t).toFixed(1)} s ago` : '–');
    ctx.fillStyle = COLORS.level;
    ctx.fillText(
      `Forces rest ${f.radialRest.toFixed(2)} torque ${f.torque.toFixed(2)} (drag ${f.spinDrag.toFixed(2)}) thrust ${f.thrust.toFixed(2)} (drag ${f.travelDrag.toFixed(2)}) ` +
        `lateral ${f.biasRest.toFixed(2)} charge ${f.charge.toFixed(2)} · impulse ${w.impulseStrength.toFixed(2)} ${age(w.impulseTime)} · release ${w.releaseStrength.toFixed(2)} ${age(w.releaseTime)}`,
      0,
      WORLD_TOP + ROW * 7,
    );
    const view = this.app.directionDebug.current?.director.world;
    if (view) ctx.fillText(`Adapter (protagonist) travel ${view.travel.toFixed(1)} turn ${view.turn.toFixed(2)} · per frame ${view.dTravel.toFixed(3)} / ${view.dTurn.toFixed(4)} · disorder ${view.disorder.toFixed(2)}`, 0, WORLD_TOP + ROW * 8);
  }

  /** Sound → material → matter: the morphology heard, the material derived from it, the protagonist's matter and the GPU's work. */
  private drawMatter(e: ExperienceSnapshot): void {
    const { ctx } = this;
    const layer = this.app.directionDebug.current, scene = layer?.visualizer.debug;
    const state = e.state, m = e.morphology;
    const share = (key: string) => (scene && key in scene ? `${Math.round(scene[key] * 100)}%` : '–');
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(
      `Matter · state ${matterLab.form === 'auto' ? 'auto' : `pinned ${matterLab.form}`}: wave ${share('wave')} · harmonic ${share('harmonic')} · particles ${share('free')}` +
        ` · ${scene?.particles ?? '–'} elements · ${this.frameMs.toFixed(1)} ms (${this.app.directionDebug.measuredFps.toFixed(0)} fps)`,
      0, MATTER_TOP);
    let row = 1;
    MORPHOLOGY_KEYS.forEach((key, i) => this.bar(key, COLORS.mid, m[key], (i % 2) * (COLUMN + GAP), MATTER_TOP + ROW * (row + (i >> 1))));
    row += MORPHOLOGY_ROWS;
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('Material (what kind of matter could stand for this sound)', 0, MATTER_TOP + ROW * row++);
    const view = layer?.director.world;
    if (view) deriveMaterial(this.material, view, e);
    MATERIAL_KEYS.forEach((key, i) => this.bar(key, COLORS.high, this.material[key], (i % 2) * (COLUMN + GAP), MATTER_TOP + ROW * (row + (i >> 1))));
    row += MATERIAL_ROWS;
    ctx.fillStyle = COLORS.level;
    ctx.fillText(
      `Prediction conf ${state.predictionConfidence.toFixed(2)} · build ${state.likelyBuild.toFixed(2)} release ${state.likelyRelease.toFixed(2)} boundary ${state.likelyBoundary.toFixed(2)}` +
        ` · anticipation ${state.anticipation.toFixed(2)} × ${state.anticipationConfidence.toFixed(2)} → charge ${e.world.forces.charge.toFixed(3)}/s → potential ${e.world.potential.toFixed(2)}`,
      0, MATTER_TOP + ROW * row++);
    // What the protagonist reports about its render systems (Spectral Matter: state, forms, fields, fronts, memory, simulation).
    const entries = scene ? Object.entries(scene).map(([key, value]) => `${key} ${Number.isInteger(value) ? value : value.toFixed(2)}`) : [];
    const half = Math.ceil(entries.length / 2);
    ctx.fillText(entries.length ? `Scene ${entries.slice(0, half).join(' · ')}` : 'Scene –', 0, MATTER_TOP + ROW * row++);
    if (entries.length > 1) ctx.fillText(`      ${entries.slice(half).join(' · ')}`, 0, MATTER_TOP + ROW * row);
    row++;
    const d = this.drawn, memory = this.app.directionDebug.renderer.info.memory;
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(
      `GPU frame: ${d.calls} draw calls · ${d.triangles} triangles · ${d.points} points · ${d.lines} lines · ${memory.geometries} geometries · ${memory.textures} textures` +
        ` · ${this.app.directionDebug.renderer.info.programs?.length ?? 0} programs · quality ${this.app.directionDebug.qualityTier}`,
      0, MATTER_TOP + ROW * row);
  }

  /**
   * The protagonist's visual world, when it is one (docs/visual-engine.md): its structural budget, the geometry the
   * sound asks for, how present each primitive is and what it submits, and the fields they all share.
   */
  private drawVisualWorld(): void {
    const { ctx } = this;
    const scene = this.app.directionDebug.current?.visualizer;
    ctx.fillStyle = COLORS.dim;
    if (!(scene instanceof RecipeVisualizer)) {
      ctx.fillText('Visual World · the protagonist is a legacy scene (no world, no primitives)', 0, WORLD_ENGINE_TOP);
      return;
    }
    const world = scene.world, d = world.debug, g = world.mapper.state;
    ctx.fillText(
      `Visual World · recipe ${world.recipe.id} · entropy budget ${d.budget.toFixed(2)} (ceiling ${d.ceiling.toFixed(2)}) · ${d.present}/${d.primitives} primitives` +
        ` · ${d.elements} elements · ${d.vertices} vertices${worldLab.only ? ` · pinned to ${[...worldLab.only].join(', ')}` : ''}`,
      0, WORLD_ENGINE_TOP);
    let row = 1;
    GEOMETRY_TRAITS.forEach((key, i) => this.bar(SIGNED_TRAITS.includes(key) ? `± ${key}` : key, COLORS.tempo, g[key], (i % 2) * (COLUMN + GAP), WORLD_ENGINE_TOP + ROW * (row + (i >> 1))));
    row += GEOMETRY_ROWS;
    ctx.fillStyle = COLORS.level;
    ctx.fillText(
      `Primitives ${world.mounted.map((m) => `${m.slot.id} ${m.presence.value > 0.004 ? `${Math.round(m.presence.value * 100)}%` : 'off'} ${m.primitive.vertices}v`).join(' · ')}`,
      0, WORLD_ENGINE_TOP + ROW * row++);
    const f = world.fields;
    const active = (Object.keys(f) as (keyof typeof f)[]).filter((key) => key !== 'turn' && !key.endsWith('Scale') && Math.abs(f[key]) > 0.01).map((key) => `${key} ${f[key].toFixed(1)}`);
    const half = Math.ceil(active.length / 2);
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(`Fields ${active.slice(0, half).join(' · ')}`, 0, WORLD_ENGINE_TOP + ROW * row++);
    ctx.fillText(`       ${active.slice(half).join(' · ')} · fronts ${d.waves} · GPU budget ${this.app.show.budget.toFixed(1)} units`, 0, WORLD_ENGINE_TOP + ROW * row);
  }

  private trace(values: Float32Array, color: string): void {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < HISTORY; i++) {
      const v = values[(this.head + i) % HISTORY];
      const x = (i / (HISTORY - 1)) * WIDTH;
      const y = HISTORY_TOP + HISTORY_HEIGHT - 1 - Math.max(0, Math.min(v, 1)) * (HISTORY_HEIGHT - 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  private column(sections: Section[], x: number, audio: AudioFrame, response: VisualResponseFrame): void {
    const { ctx } = this;
    let y = 8;
    for (const [title, rows] of sections) {
      ctx.fillStyle = COLORS.dim;
      ctx.fillText(title, x, y);
      y += ROW;
      for (const [label, color, read] of rows) {
        this.bar(label, color, read(audio, response), x, y);
        y += ROW;
      }
    }
  }

  private bar(label: string, color: string, value: number, x: number, y: number): void {
    const { ctx } = this;
    ctx.fillStyle = '#9aa0bc';
    ctx.fillText(label, x, y);
    ctx.fillStyle = '#1a1e36';
    ctx.fillRect(x + LABEL, y - 4, BAR, 8);
    ctx.fillStyle = color;
    if (label.endsWith('Trend') || label.startsWith('±')) {
      const width = Math.max(-1, Math.min(value, 1)) * BAR / 2;
      ctx.fillRect(x + LABEL + BAR / 2, y - 4, width, 8);
    } else ctx.fillRect(x + LABEL, y - 4, Math.max(0, Math.min(value, 1)) * BAR, 8);
    ctx.fillStyle = '#d8dcf0';
    ctx.fillText(value.toFixed(2), x + LABEL + BAR + 8, y);
  }
}
