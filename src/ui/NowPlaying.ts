import { h, svg } from './dom';
import { icon } from './icons';

export interface Track {
  title: string;
  artist: string;
  /** Name of what produces the audio (app, device, file). */
  source: string;
  /** Live input has no timeline: times are hidden and the waveform is fully lit. */
  live: boolean;
  /** Seconds; only meaningful when not live. */
  duration: number;
}

const BARS = 96;

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Title, artist, a small realtime waveform, times and the audio source.
 * Always on screen; dims or hides on idle following the stage's data-track.
 */
export class NowPlaying {
  readonly element: HTMLElement;
  private readonly title = h('h1', { class: 'halo-np__title' });
  private readonly artist = h('div', { class: 'halo-np__artist' });
  private readonly wave = h('canvas', { class: 'halo-np__wave', attrs: { 'aria-hidden': 'true' } });
  private readonly position = h('span', { class: 'halo-np__pos' });
  private readonly duration = h('span', { class: 'halo-np__dur' });
  private readonly source = h('span', { class: 'halo-np__src' });
  private readonly context: CanvasRenderingContext2D;
  /** Static envelope giving the waveform its shape; the audio level modulates it. */
  private readonly envelope = new Float32Array(BARS);
  private track: Track = { title: '', artist: '', source: '', live: true, duration: 0 };
  private pos = 0;
  private shownSecond = -1;

  constructor() {
    this.element = h(
      'section',
      { class: 'halo-np', attrs: { 'aria-label': 'Now playing' } },
      this.title,
      this.artist,
      this.wave,
      h('div', { class: 'halo-np__times' }, this.position, this.duration),
      h('div', { class: 'halo-np__source' }, h('span', { class: 'halo-np__glyph' }, svg(icon('source'))), this.source),
    );
    this.context = this.wave.getContext('2d')!;
    for (let i = 0; i < BARS; i++) {
      const u = i / BARS;
      this.envelope[i] = 0.06 + 0.1 * Math.abs(Math.sin(u * 23.1) * Math.sin(u * 7.3 + 1)) + 0.05 * Math.sin(u * 51) ** 2;
    }
  }

  set(track: Track): void {
    this.track = track;
    this.title.textContent = track.title;
    this.artist.textContent = track.artist;
    this.source.textContent = track.source;
    this.duration.textContent = formatTime(track.duration);
    this.element.classList.toggle('is-live', track.live);
    this.shownSecond = -1;
  }

  /** Current playback position in seconds (tracks with a timeline). */
  setPosition(seconds: number): void {
    this.pos = seconds;
    const second = Math.floor(seconds);
    if (second !== this.shownSecond) {
      this.shownSecond = second;
      this.position.textContent = formatTime(seconds);
    }
  }

  /** Redraws the waveform; call every frame with the smoothed level (0..1). */
  draw(level: number, now: number): void {
    const { context: c, wave } = this;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = wave.clientWidth || 248;
    const hgt = wave.clientHeight || 24;
    if (wave.width !== Math.round(w * ratio)) {
      wave.width = Math.round(w * ratio);
      wave.height = Math.round(hgt * ratio);
    }
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    c.clearRect(0, 0, w, hgt);

    const { live, duration } = this.track;
    const progress = live ? 0.62 : duration > 0 ? Math.min(this.pos / duration, 1) : 0;
    const base = hgt - 1.5;
    const head = w * progress;

    c.fillStyle = 'rgba(255,255,255,.2)';
    c.fillRect(0, base, w, 1);
    c.fillStyle = 'rgba(214,204,255,.9)';
    c.fillRect(0, base, live ? w : head, 1);

    c.beginPath();
    c.moveTo(0, base);
    for (let i = 0; i <= BARS; i++) {
      const x = (i * w) / BARS;
      const d = (x - head) / (w * 0.09);
      const bump = Math.exp(-d * d);
      const a =
        this.envelope[Math.min(i, BARS - 1)] * (0.5 + level * 0.8) +
        bump * (0.3 + level * 0.9) * (0.72 + 0.28 * Math.sin(now / 90 + i * 1.7));
      c.lineTo(x, base - Math.min(1, a) * (hgt - 3));
    }
    c.lineTo(w, base);
    c.closePath();

    // Played part in lilac at 78%, the rest white at 16%.
    const split = Math.min(Math.max(live ? 1 : progress, 0.001), 0.999);
    const gradient = c.createLinearGradient(0, 0, w, 0);
    gradient.addColorStop(0, 'rgba(206,192,255,.78)');
    gradient.addColorStop(split, 'rgba(206,192,255,.78)');
    gradient.addColorStop(Math.min(1, split + 0.001), 'rgba(255,255,255,.16)');
    gradient.addColorStop(1, 'rgba(255,255,255,.16)');
    c.fillStyle = gradient;
    c.fill();
  }
}
