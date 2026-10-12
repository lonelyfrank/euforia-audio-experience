import type { App } from '../../app/App';
import { hzToPosition } from '../../audio/visual-response/spectrum';
import type { AudioFrame, MusicState } from '../../types/audio';
import { h } from '../../ui/dom';
import { barChart, lineChart, sparkline, SPECTRUM_RAMP, Trace, TRACE_LENGTH, TRACE_RATE, waveChart, type Sparkline } from './charts';
import { fixedPanel, legend, meter, panel, tile, TONE, writeMeter, writeText, writeTile, type Meter, type Tile } from './components';
import type { IconName } from './icons';

/**
 * Audio & Analysis (Shift+D): capture → acoustic analysis → clock, as the cockpit's panels. Presentation only: every
 * value is read from what the engine already publishes (`AudioFrame`, the visual response, the Rust analysis frame);
 * nothing is measured, analysed or decided here. The traces are the last ten seconds of values the panels show.
 */

type Read = (a: AudioFrame, r: MusicState) => number;
type Row = readonly [label: string, tone: string, read: Read, signed?: boolean];
interface Group { title: string; sub: string; icon: IconName; rows: readonly Row[] }
/** One panel of the view: brought up to date only while it is unfolded and on screen. */
interface Block { element: HTMLElement; visible: boolean; update(a: AudioFrame, r: MusicState): void }

const LOW = TONE.orange, MID = TONE.green, HIGH = TONE.cyan, HIT = TONE.magenta, LEVEL = TONE.violet, TEMPO = TONE.amber;

/** The five bands keep their hues in every view (design system: Audio & Analysis). */
const BANDS: readonly Row[] = [
  ['Bass', TONE.orange, a => a.bass], ['Low Mid', TONE.amber, a => a.lowMid], ['Mid', TONE.green, a => a.mid],
  ['High Mid', TONE.electric, a => a.highMid], ['Treble', TONE.violet, a => a.treble],
];
const GROUPS: readonly Group[] = [
  { title: 'Levels & Beat', sub: 'AudioFrame', icon: 'sliders', rows: [
    ['Volume', LEVEL, a => a.volume], ['Energy', LEVEL, a => a.energy], ['Loudness', LEVEL, a => a.loudness], ['Onset', HIT, a => a.onset],
    ['Beat Pulse', HIT, a => a.beatPulse], ['Tempo Conf.', TEMPO, a => a.tempoConfidence], ['Beat Phase', TEMPO, a => a.beatPhase],
  ] },
  { title: 'Transients & Texture', sub: 'AudioFrame', icon: 'bolt', rows: [
    ['Low Flux', LOW, a => a.lowFlux], ['Mid Flux', MID, a => a.midFlux], ['High Flux', HIGH, a => a.highFlux], ['RMS', LEVEL, a => a.rms], ['Flatness', LEVEL, a => a.flatness],
  ] },
  { title: 'Section Trends', sub: '−1 … +1', icon: 'pulse', rows: [
    ['Energy', LEVEL, (_, r) => r.music.energyTrend, true], ['Motion', MID, (_, r) => r.music.motionTrend, true], ['Density', HIGH, (_, r) => r.music.densityTrend, true],
    ['Tension', HIT, (_, r) => r.music.tensionTrend, true], ['Openness', TEMPO, (_, r) => r.music.opennessTrend, true],
    ['Recent Peak', LEVEL, (_, r) => r.music.recentPeak], ['Recent Drop', HIT, (_, r) => r.music.recentDrop],
  ] },
  { title: 'Sonic Roles', sub: 'MusicState', icon: 'layers', rows: [
    ['Presence', LEVEL, (_, r) => r.presence], ['Weight', LOW, (_, r) => r.weight], ['Flow', MID, (_, r) => r.flow], ['Detail', HIGH, (_, r) => r.detail],
    ['Shimmer', HIGH, (_, r) => r.shimmer], ['Impact', HIT, (_, r) => r.impact], ['Trace', HIT, (_, r) => r.trace], ['Density', LEVEL, (_, r) => r.density],
    ['Motion', MID, (_, r) => r.motion], ['Openness', LEVEL, (_, r) => r.openness], ['Tension', HIT, (_, r) => r.tension],
    ['Audible Low', LOW, (_, r) => r.lowAudible], ['Audible Mid', MID, (_, r) => r.midAudible], ['Audible High', HIGH, (_, r) => r.highAudible],
  ] },
  { title: 'Music Context', sub: 'tempo clock · character', icon: 'music', rows: [
    ['State Conf.', LEVEL, (_, r) => r.stateConfidence], ['Tempo Lock', TEMPO, (_, r) => r.music.tempoLock], ['Beat', TEMPO, (_, r) => r.music.beats - Math.floor(r.music.beats)],
    ['Bar', TEMPO, (_, r) => (r.music.beats / 4) % 1], ['Intensity', LEVEL, (_, r) => r.music.intensity], ['Build', HIT, (_, r) => r.music.build], ['Drop', HIT, (_, r) => r.music.drop],
    ['Low Perc.', LOW, (_, r) => r.music.lowPercussion], ['Mid Perc.', MID, (_, r) => r.music.midPercussion], ['High Perc.', HIGH, (_, r) => r.music.highPercussion],
    ['Brightness', HIGH, (_, r) => r.music.brightness], ['Tonality', MID, (_, r) => r.music.tonality], ['Song Lock', LEVEL, (_, r) => r.music.songLock],
  ] },
];
const HISTORY = [['Loudness', TONE.violet], ['Presence', TONE.electric], ['Motion', TONE.green], ['Openness', TONE.amber], ['Tension', TONE.magenta]] as const;
const TICKS = [[50, '50'], [100, '100'], [250, '250'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']] as const;
/** Where the balance splits the spectrum into low, mid and high. */
const REGIONS = [250, 2000] as const;
const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const left = (position: number) => ({ left: `${(position * 100).toFixed(2)}%` });
/** A frequency in the unit that reads at its size: Hz below 1 kHz, kHz above. */
const writeHz = (target: Tile, hz: number): void => (hz < 1000 ? writeTile(target, hz.toFixed(0), 'Hz') : writeTile(target, (hz / 1000).toFixed(hz < 9950 ? 2 : 1), 'kHz'));
const scale = (fill: HTMLElement, value: number): void => {
  const next = `scaleX(${Math.max(0, Math.min(value || 0, 1)).toFixed(3)})`;
  if (fill.style.transform !== next) fill.style.transform = next;
};
const axis = (className: string, ...labels: string[]): HTMLElement => h('div', { class: className }, ...labels.map(label => h('span', {}, label)));

export class AudioAnalysis {
  readonly element = h('div', { class: 'ws-audio' });
  private readonly blocks: Block[] = [];
  private readonly deck: ((a: AudioFrame, r: MusicState) => void)[] = [];
  private readonly panels = new Map<Element, Block>();
  private readonly seen = new IntersectionObserver(entries => {
    for (const entry of entries) { const block = this.panels.get(entry.target); if (block) block.visible = entry.isIntersecting; }
  });
  private readonly traces = {
    tempo: new Trace(), onset: new Trace(), lufs: new Trace(), centroid: new Trace(), spread: new Trace(), rolloff: new Trace(), flux: new Trace(), energy: new Trace(),
    loudness: new Trace(), presence: new Trace(), motion: new Trace(), openness: new Trace(), tension: new Trace(),
  };
  private readonly history = [this.traces.loudness, this.traces.presence, this.traces.motion, this.traces.openness, this.traces.tension];
  private session = -1;
  private lastTime = performance.now();
  private pending = 0;

  constructor(private readonly app: App, inspector: HTMLElement, deck: HTMLElement) {
    for (const block of [this.spectrum(), this.bands(), this.pulse(), this.features(), this.timeline(), this.state(), ...GROUPS.map(group => this.levels(group))]) {
      this.blocks.push(block); this.panels.set(block.element, block); this.element.append(block.element);
    }
    inspector.append(this.element);
    deck.append(this.input(), this.track());
  }

  dispose(): void { this.seen.disconnect(); this.panels.clear(); this.element.remove(); }

  /** The view has just come into the inspector: every panel shows the present once, then its observer says which ones are in sight. */
  show(): void {
    for (const block of this.blocks) { block.visible = true; this.seen.unobserve(block.element); this.seen.observe(block.element); }
  }

  /** The traces advance at their own rate, whichever view is shown and whether or not anything is drawn. */
  sample(now: number): void {
    const audio = this.app.audio, t = this.traces;
    if (this.session !== audio.session) {
      this.session = audio.session; this.pending = 0;
      for (const trace of Object.values(t)) trace.reset();
    }
    this.pending += Math.min((now - this.lastTime) / 1000, TRACE_LENGTH / TRACE_RATE);
    this.lastTime = now;
    const a = audio.frame, r = audio.visual, f = audio.features.frame;
    while (this.pending >= 1 / TRACE_RATE) {
      this.pending -= 1 / TRACE_RATE;
      t.tempo.push(r.music.tempo); t.onset.push(a.onset); t.lufs.push(f.loudnessMomentary); t.energy.push(a.energy);
      t.centroid.push(a.centroidHz); t.spread.push(a.spreadHz); t.rolloff.push(a.rolloffHz); t.flux.push(r.spectralFlux);
      t.loudness.push(a.loudness); t.presence.push(r.presence); t.motion.push(r.motion); t.openness.push(r.openness); t.tension.push(r.tension);
    }
  }

  refresh(inspector: boolean, deck: boolean): void {
    const a = this.app.audio.frame, r = this.app.audio.visual;
    if (inspector && !this.element.hidden) {
      for (const block of this.blocks) if (block.visible && (!(block.element instanceof HTMLDetailsElement) || block.element.open)) block.update(a, r);
    }
    if (deck) for (const update of this.deck) update(a, r);
  }

  // ---- inspector ---------------------------------------------------------------------------

  private spectrum(): Block {
    const bars = barChart(SPECTRUM_RAMP), balance = h('div', { class: 'ws-balance' }), shares = h('span');
    const plot = h('div', { class: 'ws-plot' }, bars.element, ...REGIONS.map(hz => h('i', { class: 'ws-mark', style: left(hzToPosition(hz)) })));
    const element = panel({ title: 'Audio Spectrum', icon: 'bars', sub: 'AudioFrame · log frequency · 0 … 1' },
      h('div', { class: 'ws-chart ws-chart-spectrum' }, axis('ws-axis-y', '1.0', '0.5', '0'), plot),
      h('div', { class: 'ws-axis-x ws-axis-hz' }, ...TICKS.map(([hz, label]) => h('span', { style: left(hzToPosition(hz)) }, label))),
      h('div', { class: 'ws-caption' }, h('b', {}, 'Balance'), shares), balance);
    let shown = '';
    return { element, visible: true, update: (a, r) => {
      bars.update(a.spectrum);
      const low = r.lowShare * 100, mid = low + r.midShare * 100, high = mid + r.highShare * 100;
      const next = `linear-gradient(90deg,${LOW} 0 ${low.toFixed(1)}%,${MID} 0 ${mid.toFixed(1)}%,${HIGH} 0 ${high.toFixed(1)}%,transparent 0)`;
      if (next !== shown) balance.style.backgroundImage = shown = next;
      writeText(shares, `Low ${Math.round(r.lowShare * 100)}% · Mid ${Math.round(r.midShare * 100)}% · High ${Math.round(r.highShare * 100)}%`);
    } };
  }

  private bands(): Block {
    const tiles = BANDS.map(([label, tone]) => tile(label, { tone, bar: true }));
    const element = panel({ title: 'Frequency Bands', icon: 'spark', sub: 'AudioFrame · 0 … 1' }, h('div', { class: 'ws-metrics ws-bands' }, ...tiles.map(t => t.element)));
    return { element, visible: true, update: (a, r) => {
      BANDS.forEach(([, , read], i) => { const value = read(a, r); writeTile(tiles[i], value.toFixed(2)); scale(tiles[i].fill!, value); });
    } };
  }

  /** Rhythm, onsets and loudness side by side: a value, its last ten seconds and what qualifies it. */
  private pulse(): Block {
    const t = this.traces;
    const rhythm = this.mini('Rhythm & Tempo', 'clock', 'BPM', sparkline(TONE.magenta, false), 'Confidence', 'Detected');
    const onset = this.mini('Onset Analysis', 'bolt', 'Onset Rate', sparkline(TONE.electric), 'Transients', 'Beat');
    const loud = this.mini('Loudness', 'spk', 'LUFS', sparkline(TONE.violet, false), 'Short', 'RMS');
    return { element: h('div', { class: 'ws-minis' }, rhythm.element, onset.element, loud.element), visible: true, update: (a, r) => {
      const f = this.app.audio.features.frame;
      writeText(rhythm.value, r.music.tempo.toFixed(1)); rhythm.spark.update(t.tempo);
      writeText(rhythm.first, a.tempoConfidence.toFixed(2)); writeText(rhythm.second, a.bpm ? a.bpm.toFixed(1) : '—');
      writeText(onset.value, f.onsetDensity.toFixed(1)); writeText(onset.unit, '/s'); onset.spark.update(t.onset, 0, 1);
      writeText(onset.first, r.transient.toFixed(2)); writeText(onset.second, a.beat ? '● on' : '○ off');
      writeText(loud.value, f.loudnessMomentary.toFixed(1)); loud.spark.update(t.lufs);
      writeText(loud.first, f.loudnessShort.toFixed(1)); writeText(loud.second, a.rms.toFixed(2));
    } };
  }

  private mini(title: string, name: IconName, label: string, spark: Sparkline, first: string, second: string) {
    const value = h('strong', {}, '—'), unit = h('small'), a = h('b', {}, '—'), b = h('b', {}, '—');
    const element = fixedPanel({ title, icon: name }, h('span', { class: 'ws-mini-label' }, label), h('div', { class: 'ws-card-value' }, value, unit), h('div', {}, spark.element),
      h('div', { class: 'ws-mini-row' }, h('span', {}, first), a), h('div', { class: 'ws-mini-row' }, h('span', {}, second), b));
    element.classList.add('ws-mini');
    return { element, value, unit, spark, first: a, second: b };
  }

  private features(): Block {
    const t = this.traces;
    const tiles = [tile('Centroid', { spark: sparkline(TONE.cyan, false) }), tile('Flux', { spark: sparkline(TONE.violet, false) }),
      tile('Spread', { spark: sparkline(TONE.orange, false) }), tile('Roll-off', { spark: sparkline(TONE.cyan, false) })];
    const element = panel({ title: 'Spectral Features', icon: 'sliders', sub: 'AudioFrame · MusicState' }, h('div', { class: 'ws-metrics ws-features' }, ...tiles.map(x => x.element)));
    return { element, visible: true, update: (a, r) => {
      writeHz(tiles[0], a.centroidHz); tiles[0].spark!.update(t.centroid);
      writeTile(tiles[1], r.spectralFlux.toFixed(2)); tiles[1].spark!.update(t.flux, 0, 1);
      writeHz(tiles[2], a.spreadHz); tiles[2].spark!.update(t.spread);
      writeHz(tiles[3], a.rolloffHz); tiles[3].spark!.update(t.rolloff);
    } };
  }

  private timeline(): Block {
    const lines = lineChart(HISTORY.map(([, tone]) => tone));
    const element = panel({ title: 'History (10 s)', icon: 'clock', sub: '5 Hz · 0 … 1' },
      h('div', { class: 'ws-chart ws-chart-history' }, axis('ws-axis-y', '1.0', '0.5', '0.0'), h('div', { class: 'ws-plot' }, lines.element)),
      axis('ws-axis-x', '10s', '8s', '6s', '4s', '2s', '0s'), legend(HISTORY));
    return { element, visible: true, update: () => lines.update(this.history) };
  }

  private state(): Block {
    const tiles = ['State', 'Previous', 'Song', 'Noise Floor', 'Pace', 'Beats'].map(label => tile(label));
    const variation = barChart([TONE.amber], 0.3);
    const element = panel({ title: 'Musical State', icon: 'target', sub: 'interpretation' }, h('div', { class: 'ws-metrics ws-state' }, ...tiles.map(x => x.element)),
      h('div', { class: 'ws-caption' }, h('b', {}, 'Variation'), h('span', {}, 'per song · 0 … 1')), h('div', { class: 'ws-plot ws-variation' }, variation.element));
    return { element, visible: true, update: (_, r) => {
      const music = r.music;
      writeTile(tiles[0], r.state, `${r.stateAge.toFixed(1)} s`); writeTile(tiles[1], r.previousState); writeTile(tiles[2], `#${music.song}`);
      writeTile(tiles[3], this.app.audio.response.noiseFloor.toFixed(1), 'dB'); writeTile(tiles[4], `×${music.pace.toFixed(2)}`); writeTile(tiles[5], String(Math.floor(music.beats)));
      variation.update(music.variation);
    } };
  }

  private levels(group: Group): Block {
    const meters: Meter[] = group.rows.map(([label, tone, , signed]) => meter(label, tone, signed));
    const element = panel({ title: group.title, icon: group.icon, sub: group.sub }, h('div', { class: 'ws-meters' }, ...meters.map(m => m.element)));
    return { element, visible: true, update: (a, r) => { for (let i = 0; i < meters.length; i++) writeMeter(meters[i], group.rows[i][2](a, r)); } };
  }

  // ---- under the viewport --------------------------------------------------------------------

  /**
   * The signal as it arrives, and the device it comes from. Which source is in use is said once, in the toolbar; it is
   * chosen in the application, never from here.
   */
  private input(): HTMLElement {
    const device = h('strong', {}, '—'), level = h('strong', {}, '—'), fill = h('i'), wave = waveChart(TONE.violet);
    this.deck.push(a => {
      const { source, deviceName, status } = this.app.audio.state;
      writeText(device, deviceName || (source ? status : 'Nessuna sorgente'));
      // AudioFrame.loudness is −60…0 dBFS mapped onto 0…1: shown back in its own unit.
      writeText(level, (a.loudness * 60 - 60).toFixed(1)); scale(fill, a.loudness);
      wave.update(a.waveform);
    });
    return fixedPanel({ title: 'Audio Input', icon: 'spk' },
      h('div', { class: 'ws-input' }, h('div', { class: 'ws-stat ws-device' }, h('span', {}, 'Device'), h('div', { class: 'ws-card-value' }, device)),
        h('div', { class: 'ws-stat' }, h('span', {}, 'Input Level'), h('div', { class: 'ws-card-value' }, level, h('small', {}, 'dB')))),
      h('div', { class: 'ws-bar ws-level' }, fill), h('div', { class: 'ws-plot ws-waveform' }, wave.element));
  }

  /** What the analysis hears in it right now. */
  private track(): HTMLElement {
    const stats = ['BPM', 'Key', 'Energy'].map(label => ({ value: h('strong', {}, '—'), element: h('div', { class: 'ws-stat' }, h('span', {}, label)) }));
    for (const stat of stats) stat.element.append(h('div', { class: 'ws-card-value' }, stat.value));
    const energy = sparkline(TONE.violet);
    this.deck.push((a, r) => {
      const key = this.app.audio.features.frame.key;
      writeText(stats[0].value, r.music.tempo.toFixed(1)); writeText(stats[1].value, key < 0 ? '—' : `${KEYS[key % 12]}${key >= 12 ? 'm' : ''}`);
      writeText(stats[2].value, a.energy.toFixed(2));
      energy.update(this.traces.energy, 0, 1);
    });
    return fixedPanel({ title: 'Live Input', icon: 'music', sub: 'Analisi in tempo reale' },
      h('div', { class: 'ws-track' }, ...stats.map(s => s.element)), h('div', { class: 'ws-plot ws-energy' }, energy.element));
  }
}
