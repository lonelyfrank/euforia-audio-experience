import { h } from '../../ui/dom';

export const writeText = (node: HTMLElement, value: string): void => { if (node.textContent !== value) node.textContent = value; };
export const button = (label: string, action: () => void, title = label): HTMLButtonElement =>
  h('button', { type: 'button', title, onclick: action }, label);
export function metricCard(label: string): { element: HTMLElement; value: HTMLElement } {
  const value = h('strong', {}, '—');
  return { element: h('div', { class: 'ws-card' }, h('span', {}, label), value), value };
}
export function section(title: string, ...children: HTMLElement[]): HTMLElement {
  return h('section', { class: 'ws-section' }, h('h2', {}, title), ...children);
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
