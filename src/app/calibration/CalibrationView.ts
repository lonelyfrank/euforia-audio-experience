import type { AudioEngine } from '../../audio/AudioEngine';
import { settingsStore } from '../../stores/settingsStore';
import { LoopbackMeter } from '../../timing/LoopbackMeter';
import { h } from '../../ui/dom';
import { ClickTrack } from './ClickTrack';

/** Audio delay limits (ms): negative values pull the picture earlier (a slow display). */
export const DELAY_MIN = -100;
export const DELAY_MAX = 400;
const STEP = 5;
/** Matched clicks before a suggestion is offered. */
const MIN_CLICKS = 8;

/**
 * Guided sync calibration. Euforia-Audio-Experience plays clicks through the system output; the
 * capture hears them like any music, the beat grid locks to them, and the
 * lamp flashes on each beat cue, through the whole real pipeline. The user
 * nudges the audio delay until flash and click coincide. Meanwhile the
 * clicks' emission times are matched with the detected attacks to measure
 * the capture path and suggest a starting value.
 */
export class CalibrationView {
  readonly element: HTMLElement;
  private readonly clicks: ClickTrack;
  private readonly meter = new LoopbackMeter();
  private readonly lamp: HTMLElement;
  private readonly delay: HTMLElement;
  private readonly status: HTMLElement;
  private readonly measured: HTMLElement;
  private readonly apply: HTMLButtonElement;
  private flash = 0;
  private suggestion = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly audio: AudioEngine,
    private readonly onClose: () => void,
  ) {
    this.clicks = new ClickTrack((time) => this.meter.emit(time));
    this.lamp = h('div', { class: 'app-calib__lamp', attrs: { 'aria-hidden': 'true' } });
    this.delay = h('span', { class: 'app-row__value' });
    this.status = h('p', { class: 'app-calib__line' });
    this.measured = h('p', { class: 'app-calib__line' });
    this.apply = h('button', { type: 'button', textContent: 'Apply', onclick: () => this.setDelay(this.suggestion) }) as HTMLButtonElement;
    const nudge = (ms: number, label: string) => h('button', { type: 'button', textContent: label, attrs: { 'aria-label': `${ms > 0 ? 'Later' : 'Earlier'} by ${Math.abs(ms)} ms` }, onclick: () => this.setDelay(settingsStore.get().audioDelay + ms) });
    this.element = h(
      'div',
      { class: 'app-panel app-calib', attrs: { role: 'dialog', 'aria-label': 'Sync calibration', 'aria-modal': 'false' } },
      h('div', { class: 'app-panel__head' }, h('h2', { class: 'app-panel__title' }, 'Sync calibration')),
      h('p', { class: 'app-calib__line' }, 'Pause your music. Euforia-Audio-Experience plays clicks: nudge the delay until the flash lands on the click.'),
      this.lamp,
      h('div', { class: 'app-row' }, h('span', { class: 'app-row__label' }, 'Audio delay ', this.delay), h('div', { class: 'app-seg' }, nudge(-STEP, '−'), nudge(STEP, '+'))),
      this.status,
      h('div', { class: 'app-row' }, this.measured, h('div', { class: 'app-seg' }, this.apply)),
      h('div', { class: 'app-panel__foot' }, h('span', {}, 'Esc to finish'), h('div', { class: 'app-seg' }, h('button', { type: 'button', textContent: 'Done', onclick: () => this.onClose() }))),
    );
    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.onClose();
      }
    });
    this.unsubscribe = settingsStore.subscribe((s) => (this.delay.textContent = `${s.audioDelay} ms`));
    this.delay.textContent = `${settingsStore.get().audioDelay} ms`;
  }

  get isOpen(): boolean {
    return this.element.classList.contains('is-open');
  }

  async open(): Promise<void> {
    this.meter.reset();
    this.status.textContent = this.audio.state.source === 'fake' ? 'The test signal cannot hear the clicks: choose System Audio (or Microphone) first.' : '';
    this.element.classList.add('is-open');
    this.element.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    try {
      await this.clicks.start();
    } catch {
      this.status.textContent = 'Audio output unavailable.';
    }
  }

  close(): void {
    this.element.classList.remove('is-open');
    void this.clicks.stop();
  }

  dispose(): void {
    this.unsubscribe();
    this.close();
  }

  /** Once per rendered frame while open. */
  frame(dt: number): void {
    if (!this.isOpen) return;
    const { timing, features, clock } = this.audio;
    for (let i = 0; i < features.onsets.count; i++) if (clock.ready) this.meter.detect(clock.toHost(features.onsets.items[i].time));
    this.flash = timing.beat ? 1 : this.flash * Math.exp(-dt / 0.06);
    this.lamp.style.opacity = String(0.12 + 0.88 * this.flash);
    if (this.audio.state.source !== 'fake') {
      this.status.textContent = timing.mode === 'grid' ? `Locked to the clicks · ${timing.bpm.toFixed(1)} BPM` : 'Listening for the clicks…';
    }
    if (this.meter.count >= MIN_CLICKS) {
      // Clicks are heard `outputLatency` after they reach the output; the capture path places them `median` late.
      this.suggestion = clampDelay(Math.round(((this.clicks.outputLatency - this.meter.median) * 1000) / STEP) * STEP);
      this.measured.textContent = `Capture path ${(this.meter.median * 1000).toFixed(0)} ± ${(this.meter.spread * 1000).toFixed(0)} ms · suggested ${this.suggestion} ms`;
      this.apply.disabled = false;
    } else {
      this.measured.textContent = 'Measuring the capture path…';
      this.apply.disabled = true;
    }
  }

  private setDelay(ms: number): void {
    settingsStore.set({ audioDelay: clampDelay(ms) });
  }
}

function clampDelay(ms: number): number {
  return Math.min(DELAY_MAX, Math.max(DELAY_MIN, ms));
}
