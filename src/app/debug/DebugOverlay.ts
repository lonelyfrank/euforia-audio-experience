import { TEST_SIGNALS, type TestSignal } from '../../audio/capture/testSignals';
import { hzToPosition } from '../../audio/visual-response/spectrum';
import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import type { App } from '../App';

/*
 * Development-only audio/visual debug overlay. Shows the analyzer output
 * (bands, levels, transients, spectrum) next to the derived visual response
 * and musical context, to tell whether a problem comes from the analysis, the
 * mapping or the scene. Also switches the synthetic test signals.
 * Open with ?debug or Shift+D. Loaded only when import.meta.env.DEV, so it
 * never ships in production.
 */

const COLUMN = 280;
const GAP = 16;
const WIDTH = COLUMN * 2 + GAP;
const ROW = 14;
const LABEL = 74;
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
      ['Flatness', COLORS.level, (a) => a.flatness],
    ],
  ],
];

const RIGHT: Section[] = [
  [
    'VisualResponse',
    [
      ['Weight', COLORS.low, (_, r) => r.weight],
      ['Flow', COLORS.mid, (_, r) => r.flow],
      ['Detail', COLORS.high, (_, r) => r.detail],
      ['Shimmer', COLORS.high, (_, r) => r.shimmer],
      ['Impact', COLORS.hit, (_, r) => r.impact],
      ['Density', COLORS.level, (_, r) => r.density],
    ],
  ],
  [
    'Music context',
    [
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
const SPECTRUM_TOP = COLUMNS_HEIGHT + 3 * ROW + 16;
const HEIGHT = SPECTRUM_TOP + SPECTRUM_HEIGHT + 22;
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

  constructor(private readonly app: App) {
    this.root = document.createElement('div');
    this.root.style.cssText =
      'position:fixed;top:12px;right:12px;z-index:9999;padding:8px;border-radius:8px;background:rgba(6,8,18,.82);' +
      'font:11px ui-monospace,monospace;color:#d8dcf0;user-select:none;max-width:calc(100vw - 24px);overflow:auto;';

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
  };

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
    ctx.fillRect(x + LABEL, y - 4, Math.max(0, Math.min(value, 1)) * BAR, 8);
    ctx.fillStyle = '#d8dcf0';
    ctx.fillText(value.toFixed(2), x + LABEL + BAR + 8, y);
  }
}
