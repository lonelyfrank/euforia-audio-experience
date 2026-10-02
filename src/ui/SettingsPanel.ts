import { settingsStore, type Settings, type TrackInfoMode } from '../stores/settingsStore';
import { h, svg } from './dom';
import { icon } from './icons';

type NumberKey = 'sensitivity' | 'smoothing' | 'audioDelay' | 'moodIntensity';
type ToggleKey = 'beatResponse' | 'hideCursor' | 'reflection';

const VERSION = `Halo ${__APP_VERSION__}`;

/**
 * The one conventional panel: floats above the core, opened from Settings on
 * the wheel. Every control applies (and persists) immediately.
 */
export class SettingsPanel {
  readonly element: HTMLElement;
  private readonly refreshers: Array<(s: Settings) => void> = [];

  constructor(onClose: () => void, onCalibrate: () => void) {
    const close = h('button', { type: 'button', class: 'halo-panel__x', attrs: { 'aria-label': 'Close settings' }, onclick: () => onClose() }, svg(icon('close')));
    this.element = h(
      'div',
      { class: 'halo-panel', attrs: { role: 'dialog', 'aria-label': 'Settings', 'aria-modal': 'false' } },
      h('div', { class: 'halo-panel__head' }, h('h2', { class: 'halo-panel__title' }, 'Settings'), close),
      this.row('Mood intensity', this.range('moodIntensity', 0, 1, 0.05, 'Mood intensity')),
      this.row('Sensitivity', this.range('sensitivity', 0.4, 1.8, 0.05)),
      this.row('Smoothing', this.range('smoothing', 0, 0.95, 0.05)),
      this.row('Beat response', this.toggle('beatResponse', 'Beat response')),
      this.row(
        'Track info',
        this.segmented<TrackInfoMode>('trackInfo', 'Track info', [
          ['always', 'Always'],
          ['dim', 'Dim'],
          ['hidden', 'Hidden'],
        ]),
      ),
      this.row(
        'Hide controls after',
        this.segmented<number>('hideDelay', 'Hide controls after', [
          [3000, '3s'],
          [5000, '5s'],
          [10000, '10s'],
        ]),
      ),
      this.row('Hide cursor when idle', this.toggle('hideCursor', 'Hide cursor when idle')),
      this.row('Water reflection', this.toggle('reflection', 'Water reflection')),
      this.delayRow(),
      this.row('Sync', h('div', { class: 'halo-seg' }, h('button', { type: 'button', textContent: 'Calibrate…', onclick: () => onCalibrate() }))),
      h('div', { class: 'halo-panel__foot' }, h('span', {}, 'Esc to close'), h('span', {}, VERSION)),
    );
    this.element.addEventListener('keydown', (e) => this.trapFocus(e));
    settingsStore.subscribe((s) => this.refreshers.forEach((refresh) => refresh(s)));
    this.refreshers.forEach((refresh) => refresh(settingsStore.get()));
  }

  get isOpen(): boolean {
    return this.element.classList.contains('is-open');
  }

  open(): void {
    this.element.classList.add('is-open');
    this.element.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
  }

  close(): void {
    this.element.classList.remove('is-open');
  }

  private row(label: string, control: HTMLElement): HTMLElement {
    return h('div', { class: 'halo-row' }, h('span', { class: 'halo-row__label' }, label), control);
  }

  /** Output latency compensation, e.g. ~150–250 ms for Bluetooth headphones. */
  private delayRow(): HTMLElement {
    const value = h('span', { class: 'halo-row__value' });
    this.refreshers.push((s) => (value.textContent = `${s.audioDelay} ms`));
    return h(
      'div',
      { class: 'halo-row', attrs: { title: 'Delay the visuals to match the sound (Bluetooth headphones: ~150–250 ms; negative for a slow display)' } },
      h('span', { class: 'halo-row__label' }, 'Audio delay ', value),
      this.range('audioDelay', -100, 400, 5, 'Audio delay'),
    );
  }

  private range(key: NumberKey, min: number, max: number, step: number, label = key === 'sensitivity' ? 'Sensitivity' : 'Smoothing'): HTMLElement {
    const input = h('input', {
      type: 'range',
      class: 'halo-range',
      min: String(min),
      max: String(max),
      step: String(step),
      attrs: { 'aria-label': label },
    });
    const paint = (value: number) => {
      input.value = String(value);
      input.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
    };
    input.addEventListener('input', () => settingsStore.set({ [key]: Number(input.value) }));
    this.refreshers.push((s) => paint(s[key]));
    return input;
  }

  private toggle(key: ToggleKey, label: string): HTMLElement {
    const button = h('button', { type: 'button', class: 'halo-toggle', attrs: { role: 'switch', 'aria-label': label } }, h('span'));
    button.addEventListener('click', () => settingsStore.set((s) => ({ [key]: !s[key] })));
    this.refreshers.push((s) => button.setAttribute('aria-checked', String(s[key])));
    return button;
  }

  private segmented<T extends Settings['trackInfo'] | Settings['hideDelay']>(
    key: 'trackInfo' | 'hideDelay',
    label: string,
    options: [T, string][],
  ): HTMLElement {
    const group = h('div', { class: 'halo-seg', attrs: { role: 'group', 'aria-label': label } });
    const buttons = options.map(([value, text]) => {
      const button = h('button', { type: 'button', textContent: text });
      button.addEventListener('click', () => settingsStore.set({ [key]: value }));
      group.append(button);
      return button;
    });
    this.refreshers.push((s) => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(s[key] === options[i][0]))));
    return group;
  }

  /** Keeps Tab inside the panel while it is open. */
  private trapFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(this.element.querySelectorAll<HTMLElement>('button, input'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      last.focus();
      event.preventDefault();
    } else if (!event.shiftKey && document.activeElement === last) {
      first.focus();
      event.preventDefault();
    }
  }
}
