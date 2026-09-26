export type ShortcutAction =
  | 'toggleFullscreen'
  | 'escape'
  | 'nextVisualizer'
  | 'previousVisualizer'
  | 'togglePause';

/** Key bindings, by KeyboardEvent.code. Kept in one place so they can become user-configurable. */
export const KEY_BINDINGS: Record<ShortcutAction, string[]> = {
  toggleFullscreen: ['F11', 'KeyF'],
  escape: ['Escape'],
  nextVisualizer: ['ArrowRight'],
  previousVisualizer: ['ArrowLeft'],
  togglePause: ['Space'],
};

const actionByCode = new Map<string, ShortcutAction>();
for (const [action, codes] of Object.entries(KEY_BINDINGS) as [ShortcutAction, string[]][]) {
  for (const code of codes) actionByCode.set(code, action);
}

/** Installs the global keyboard handler. Returns a function that removes it. */
export function installShortcuts(handler: (action: ShortcutAction) => void): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    const target = event.target as HTMLElement | null;
    // Let form controls keep their own keys (arrows on sliders, typing, ...)
    // and buttons their activation keys.
    if (target?.closest('input, select, textarea')) return;
    if (target?.closest('button') && (event.code === 'Space' || event.code === 'Enter')) return;
    const action = actionByCode.get(event.code);
    if (!action) return;
    event.preventDefault();
    handler(action);
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
