import { h, svg } from './dom';
import { icon, type IconName } from './icons';

export interface DialItem {
  id: string;
  label: string;
  icon?: IconName;
  /** Trusted markup used instead of an icon (preset swatches). */
  iconHtml?: string;
  selected?: boolean;
}

export interface DialMenu {
  caption?: string;
  layout?: 'ring' | 'arc';
  items: DialItem[];
}

export interface DialOptions {
  menu(key: string): DialMenu;
  onSelect(menu: string, id: string): void;
  onCore(): void;
}

/* Motion (tokens: dur-expand, dur-collapse, ease-out, ease-in). */
const EXPAND_MS = 560;
const EXPAND_STAGGER = 32;
const COLLAPSE_MS = 240;
const COLLAPSE_STAGGER = 12;
const SWAP_DELAY = 120;
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)';
/** Rotation (deg) of the curved path items travel along. */
const ROOT_SWING = -42;
const SUB_SWING = -64;

interface ItemElement {
  el: HTMLElement;
  button: HTMLButtonElement;
  angle: number;
  id: string;
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * The single core button and the radial wheel it expands into. Items travel
 * out of the core along an arc (Web Animations, 9 polar keyframes) and back.
 */
export class Dial {
  readonly element: HTMLElement;
  readonly core: HTMLButtonElement;
  private readonly items: HTMLElement;
  private readonly caption: HTMLElement;
  private current: string | null = null;
  private elements: ItemElement[] = [];
  private panelOpen = false;

  constructor(
    private readonly options: DialOptions,
    private readonly radius = 110,
  ) {
    this.core = h(
      'button',
      { type: 'button', class: 'halo-core', attrs: { 'aria-label': 'Visualizer controls', 'aria-expanded': 'false', 'aria-haspopup': 'menu' } },
      h('span', { class: 'halo-core__icon halo-core__icon--main' }, svg(icon('bars'))),
      h('span', { class: 'halo-core__icon halo-core__icon--back' }, svg(icon('back'))),
    );
    this.core.addEventListener('click', () => options.onCore());
    this.items = h('div', { class: 'halo-dock__items', attrs: { role: 'menu', 'aria-label': 'Controls' } });
    this.items.addEventListener('keydown', (e) => this.onMenuKey(e));
    this.caption = h('div', { class: 'halo-dock__caption', attrs: { 'aria-hidden': 'true' } });
    this.element = h(
      'div',
      { class: 'halo-dock' },
      h('div', { class: 'halo-guide', attrs: { 'aria-hidden': 'true' } }),
      this.caption,
      this.items,
      this.core,
    );
  }

  get menu(): string | null {
    return this.current;
  }

  open(key: string): void {
    const menu = this.options.menu(key);
    const wasOpen = this.current !== null;
    const focusInside = this.element.contains(document.activeElement);
    if (wasOpen) this.exit(this.elements);
    this.current = key;
    this.caption.textContent = menu.caption ?? '';
    this.element.classList.add('is-open');
    this.element.classList.toggle('is-sub', key !== 'root');
    this.items.setAttribute('aria-label', menu.caption ?? 'Controls');
    this.elements = this.build(menu);
    this.enter(this.elements, key === 'root' ? ROOT_SWING : SUB_SWING, wasOpen ? SWAP_DELAY : 0);
    this.syncCore();
    // Focus moves into the ring only if it was already in the dock (keyboard use).
    this.focusItem(0, focusInside);
  }

  close(): void {
    if (this.current === null) return;
    const hadFocus = this.element.contains(document.activeElement);
    this.exit(this.elements);
    this.elements = [];
    this.current = null;
    this.element.classList.remove('is-open', 'is-sub');
    this.syncCore();
    if (hadFocus) this.core.focus();
  }

  select(id: string): void {
    for (const item of this.elements) item.el.classList.toggle('is-selected', item.id === id);
  }

  /** While the settings panel is open the core shows the accent ring and a back chevron. */
  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    this.core.classList.toggle('is-active', open);
    this.syncCore();
  }

  /** Writes the smoothed audio level (0..1) that drives the core's pulse. */
  setLevel(level: number): void {
    this.element.style.setProperty('--lvl', level.toFixed(3));
  }

  private syncCore(): void {
    const back = (this.current !== null && this.current !== 'root') || this.panelOpen;
    this.core.classList.toggle('is-back', back);
    this.core.setAttribute('aria-expanded', String(this.current !== null));
    this.core.setAttribute('aria-label', back ? 'Back' : this.current ? 'Close controls' : 'Visualizer controls');
  }

  private angles(count: number, layout: DialMenu['layout']): number[] {
    if (layout === 'arc') {
      if (count === 2) return [-135, -45];
      return Array.from({ length: count }, (_, k) => -162 + (144 * k) / (count - 1));
    }
    return Array.from({ length: count }, (_, k) => -90 + (k * 360) / count);
  }

  private build(menu: DialMenu): ItemElement[] {
    const angles = this.angles(menu.items.length, menu.layout);
    return menu.items.map((item, k) => {
      const button = h('button', {
        type: 'button',
        class: 'halo-item__disc',
        tabIndex: -1,
        attrs: { role: menu.caption ? 'menuitemradio' : 'menuitem', 'aria-label': item.label },
      });
      if (menu.caption) button.setAttribute('aria-checked', String(!!item.selected));
      button.innerHTML = item.iconHtml ?? icon(item.icon ?? 'source');
      button.addEventListener('click', () => {
        if (this.current) this.options.onSelect(this.current, item.id);
      });
      const el = h(
        'div',
        { class: `halo-item${item.selected ? ' is-selected' : ''}` },
        button,
        h('span', { class: 'halo-item__label', attrs: { 'aria-hidden': 'true' } }, item.label),
      );
      this.items.append(el);
      return { el, button, angle: angles[k], id: item.id };
    });
  }

  private keyframes(angle: number, swing: number): Keyframe[] {
    const frames: Keyframe[] = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const r = this.radius * (0.22 + 0.78 * t);
      const a = ((angle + swing * (1 - t)) * Math.PI) / 180;
      frames.push({
        transform: `translate(${(Math.cos(a) * r).toFixed(2)}px, ${(Math.sin(a) * r).toFixed(2)}px) scale(${(0.5 + 0.5 * t).toFixed(3)})`,
        opacity: Math.min(1, t * 1.4),
      });
    }
    return frames;
  }

  private enter(list: ItemElement[], swing: number, delay: number): void {
    const instant = reducedMotion.matches;
    list.forEach((item, k) => {
      item.el.animate(this.keyframes(item.angle, swing), {
        duration: instant ? 0 : EXPAND_MS,
        delay: instant ? 0 : delay + k * EXPAND_STAGGER,
        easing: EASE_OUT,
        fill: 'both',
      });
    });
  }

  private exit(list: ItemElement[]): void {
    const instant = reducedMotion.matches;
    list.forEach((item, k) => {
      item.button.disabled = true;
      const animation = item.el.animate(this.keyframes(item.angle, -24).reverse(), {
        duration: instant ? 0 : COLLAPSE_MS,
        delay: instant ? 0 : (list.length - 1 - k) * COLLAPSE_STAGGER,
        easing: EASE_IN,
        fill: 'both',
      });
      animation.onfinish = () => item.el.remove();
    });
  }

  /** Roving focus: arrows move around the ring, Home/End jump to the ends. */
  private onMenuKey(event: KeyboardEvent): void {
    const index = this.elements.findIndex((item) => item.button === document.activeElement);
    if (index < 0) return;
    const n = this.elements.length;
    const moves: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (event.key in moves) this.focusItem((index + moves[event.key] + n) % n, true);
    else if (event.key === 'Home') this.focusItem(0, true);
    else if (event.key === 'End') this.focusItem(n - 1, true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  private focusItem(index: number, focus: boolean): void {
    this.elements.forEach((item, k) => (item.button.tabIndex = k === index ? 0 : -1));
    if (focus) this.elements[index]?.button.focus();
  }
}
