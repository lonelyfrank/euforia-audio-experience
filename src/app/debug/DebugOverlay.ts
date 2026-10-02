import { settingsStore } from '../../stores/settingsStore';
import { TEST_SIGNALS, type TestSignal } from '../../audio/capture/testSignals';
import { hzToPosition } from '../../audio/visual-response/spectrum';
import type { AudioFrame, MusicalState, VisualResponseFrame } from '../../types/audio';
import type { App } from '../App';
import { GENRE_NAMES, SECTION_NAMES } from '../../audio/features/decode';

/*
 * Development-only audio/visual debug overlay. Shows the analyzer output
 * (bands, levels, transients, spectrum) next to the derived visual response
 * and musical context, to tell whether a problem comes from the analysis, the
 * mapping or the scene. Also switches the synthetic test signals.
 * Open with ?debug or Shift+D. Loaded only when import.meta.env.DEV, so it
 * never ships in production.
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
const HEIGHT = ANALYSIS_TOP + 6 * ROW;
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

export function installDebugOverlay(app: App): void {
  let overlay: DebugOverlay | null = null;
  const toggle = () => {
    if (overlay) {
      overlay.dispose();
      overlay = null;
    } else {
      overlay = new DebugOverlay(app);
    }
  };
  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyD' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) toggle();
  });
  if (new URLSearchParams(location.search).has('debug')) toggle();
}

class DebugOverlay {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private rafId = 0;
  private lastTime = performance.now();
  private frameMs = 16;
  private lastBeat = 0;
  private lastCue = 0;
  /** Ring buffers of the history strip. */
  private readonly energy = new Float32Array(HISTORY);
  private readonly presence = new Float32Array(HISTORY);
  private readonly motion = new Float32Array(HISTORY);
  private readonly openness = new Float32Array(HISTORY);
  private readonly tension = new Float32Array(HISTORY);
  private historyTime = 0;
  private head = 0;

  constructor(private readonly app: App) {
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

    this.root.append(select, this.canvas);
    document.body.append(this.root);
    this.rafId = requestAnimationFrame(this.draw);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.root.remove();
  }

  private readonly draw = (now: number): void => {
    this.rafId = requestAnimationFrame(this.draw);
    this.frameMs += (now - this.lastTime - this.frameMs) * 0.05;
    const dt = Math.min((now - this.lastTime) / 1000, HISTORY / HISTORY_RATE);
    this.lastTime = now;

    const { ctx } = this;
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
      this.bar('Expansion', COLORS.low, modulation.expansion, 0, DIRECTOR_TOP + ROW * 3);
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
    const genre = f.genre.indexOf(Math.max(...f.genre));
    const nextPhrase = f.nextPhraseTime > 0 && clock.ready ? `${(clock.toHost(f.nextPhraseTime) - performance.now() / 1000).toFixed(1)} s` : '–';
    ctx.fillStyle = COLORS.mid;
    ctx.fillText(
      `${section.toUpperCase()} #${f.sectionId}${f.sectionReturn >= 0 ? ` (returns #${f.sectionReturn})` : ''} · ${f.sectionBars} bars · bar ${f.barIndex} · phrase ${f.phraseBar + 1}/${f.phraseBars} next in ${nextPhrase} · ` +
        `novelty ${f.novelty.toFixed(2)} · sim 4/8/16 ${[...f.similarity].map((x) => x.toFixed(2)).join('/')} · drop ${f.dropExpected.toFixed(2)} · ${GENRE_NAMES[genre]} (${f.structureConfidence.toFixed(2)})`,
      0,
      ANALYSIS_TOP + ROW * 5,
    );
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(
      `Latency: attack→frame ${ms(timing.onsetDelay)} + render ${ms(timing.renderLatency)} = ${ms(timing.onsetDelay + timing.renderLatency)} · ` +
        `attacks shown ${ms(timing.impactLate)} after heard · output ${ms(timing.latency.output)}`,
      0,
      ANALYSIS_TOP + ROW * 4,
    );
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
    if (label.endsWith('Trend')) {
      const width = Math.max(-1, Math.min(value, 1)) * BAR / 2;
      ctx.fillRect(x + LABEL + BAR / 2, y - 4, width, 8);
    } else ctx.fillRect(x + LABEL, y - 4, Math.max(0, Math.min(value, 1)) * BAR, 8);
    ctx.fillStyle = '#d8dcf0';
    ctx.fillText(value.toFixed(2), x + LABEL + BAR + 8, y);
  }
}
