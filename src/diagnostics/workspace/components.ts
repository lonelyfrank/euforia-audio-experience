import { h } from '../../ui/dom';
import type { Sparkline } from './charts';
import { icon, type IconName } from './icons';

/** The design system's series and state colours, as the shell's scoped tokens. */
export const TONE = {
  ink: 'var(--ws-text)', violet: 'var(--ws-accent)', electric: 'var(--ws-electric)', cyan: 'var(--ws-cyan)', magenta: 'var(--ws-magenta)',
  green: 'var(--ws-green)', amber: 'var(--ws-warning)', orange: 'var(--ws-orange)', red: 'var(--ws-red)',
} as const;

export const writeText = (node: HTMLElement, value: string): void => { if (node.textContent !== value) node.textContent = value; };
export const button = (label: string, action: () => void, title = label): HTMLButtonElement =>
  h('button', { type: 'button', title, onclick: action }, label);

export interface PanelHead { title: string; icon?: IconName; sub?: string; right?: Node }
const heading = ({ title, icon: name, sub, right }: PanelHead): (Node | false | undefined | '')[] =>
  [name && icon(name, 15), h('b', { class: 'ws-panel-title' }, title), sub && h('span', { class: 'ws-panel-sub' }, sub), right && h('span', { class: 'ws-panel-right' }, right)];
/**
 * A cockpit panel the user can fold from its header: a folded panel is out of layout, so what it holds is not in view
 * and stops drawing.
 */
export function panel(head: PanelHead | string, ...children: HTMLElement[]): HTMLDetailsElement {
  return h('details', { class: 'ws-section', open: true }, h('summary', {}, ...heading(typeof head === 'string' ? { title: head } : head)), h('div', { class: 'ws-section-body' }, ...children));
}
/** The same panel where it always shows (under the viewport, or a small one in a row of panels). */
export function fixedPanel(head: PanelHead, ...children: HTMLElement[]): HTMLElement {
  return h('div', { class: 'ws-section' }, h('div', { class: 'ws-panel-head' }, ...heading(head)), h('div', { class: 'ws-section-body' }, ...children));
}
export const retitle = (target: HTMLElement, title: string): void => writeText(target.querySelector<HTMLElement>('.ws-panel-title')!, title);
export const liveBadge = (): HTMLElement => h('span', { class: 'ws-live' }, h('i'), 'LIVE');
/** More than one series always comes with its names: a coloured dot and a word. */
export const legend = (items: readonly (readonly [label: string, tone: string])[]): HTMLElement =>
  h('span', { class: 'ws-legend' }, ...items.map(([label, tone]) => h('span', {}, h('i', { style: { background: tone } }), label)));

export interface Tile { element: HTMLElement; value: HTMLElement; unit: HTMLElement; spark?: Sparkline; fill?: HTMLElement }
/** A measure: its name, its value in tabular numerals with the unit beside it, and optionally its last seconds or its level. */
export function tile(label: string, options: { tone?: string; spark?: Sparkline; bar?: boolean } = {}): Tile {
  const value = h('strong', {}, '—'), unit = h('small');
  const fill = options.bar ? h('i', { style: { background: options.tone ?? TONE.violet } }) : undefined;
  if (options.tone && options.bar) value.style.color = options.tone;
  const element = h('div', { class: 'ws-card' }, h('span', {}, label), h('div', { class: 'ws-card-value' }, value, unit),
    options.spark?.element, fill && h('div', { class: 'ws-bar' }, fill));
  return { element, value, unit, spark: options.spark, fill };
}
/** A measure that is not there keeps the registry's word, in the secondary ink and at a size that fits a narrow tile. */
export function writeTile(target: Tile, value: string | null, unit = ''): void {
  target.element.classList.toggle('ws-card-missing', value === null);
  writeText(target.value, value ?? 'Unavailable'); writeText(target.unit, value === null ? '' : unit);
}

export interface Meter { element: HTMLElement; fill: HTMLElement; value: HTMLElement; shown: number }
/** A named level on a track; `signed` draws −1…+1 from the middle. */
export function meter(label: string, tone: string, signed = false): Meter {
  const fill = h('i', { style: { background: tone } }), value = h('span', { class: 'ws-meter-value' }, '—');
  return { element: h('div', { class: signed ? 'ws-meter ws-meter-signed' : 'ws-meter' }, h('span', { class: 'ws-meter-label' }, label), h('span', { class: 'ws-bar' }, fill), value), fill, value, shown: NaN };
}
/** Written only when the two decimals shown change: a steady level costs nothing. */
export function writeMeter(target: Meter, value: number): void {
  const shown = Math.round((Number.isFinite(value) ? value : 0) * 100);
  if (shown === target.shown) return;
  target.shown = shown;
  target.fill.style.transform = `scaleX(${Math.max(-1, Math.min(shown / 100, 1))})`;
  target.value.textContent = (shown / 100).toFixed(2);
}
/** Includes shadow-DOM form controls (event.target alone is the host). */
export function isEditing(event: KeyboardEvent): boolean {
  return event.composedPath().some(node => node instanceof HTMLElement &&
    (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)));
}
export type WorkspaceView = 'overview' | 'audio' | 'experience' | 'world' | 'matter' | 'render' | 'laboratories' | 'diagnostics';
export function shortcutView(event: KeyboardEvent, tools: boolean): WorkspaceView | null {
  if (event.repeat || isEditing(event) || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.code === 'KeyG') return 'diagnostics';
  if (tools && event.code === 'KeyD') return 'audio';
  if (tools && event.code === 'KeyE') return 'laboratories';
  return null;
}

/** The three columns: navigation folded to its icons, the inspector there or not and how wide, the viewport alone. */
export interface WorkspaceLayout { collapsed: boolean; inspector: boolean; wide: boolean; expanded: boolean }
export type LayoutAction = 'sidebar' | 'inspector' | 'wide' | 'viewport' | 'reveal';
export const INITIAL_LAYOUT: WorkspaceLayout = { collapsed: false, inspector: true, wide: false, expanded: false };
/**
 * What each control does to the columns. Every change is one step (never an animated width): the renderer sizes its
 * targets once per change. Nothing is forgotten by hiding: a closed inspector comes back at the width it had.
 */
export function nextLayout(layout: WorkspaceLayout, action: LayoutAction): WorkspaceLayout {
  switch (action) {
    case 'sidebar': return { ...layout, collapsed: !layout.collapsed };
    case 'viewport': return { ...layout, expanded: !layout.expanded };
    case 'wide': return { ...layout, wide: !layout.wide };
    // The inspector's button always answers with something to see: from the viewport alone it brings the inspector back.
    case 'inspector': return layout.expanded ? { ...layout, expanded: false, inspector: true } : { ...layout, inspector: !layout.inspector };
    // A shortcut asks for a station (the scene with that view's inspector beside it), whatever was folded away before.
    case 'reveal': return { ...layout, expanded: false, inspector: true };
  }
}
export const inspectorShown = (layout: WorkspaceLayout): boolean => layout.inspector && !layout.expanded;
