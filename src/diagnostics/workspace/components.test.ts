import { afterEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_LAYOUT, inspectorShown, isEditing, nextLayout, shortcutView, type LayoutAction } from './components';
class ElementStub {
  constructor(readonly tagName: string, readonly isContentEditable = false) {}
}
function key(code: string, patch: Partial<KeyboardEvent> = {}, path: unknown[] = []): KeyboardEvent {
  return { code, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, repeat: false, composedPath: () => path, ...patch } as KeyboardEvent;
}
afterEach(() => vi.unstubAllGlobals());
describe('workspace keyboard routing', () => {
  it('routes all three entries to one navigation vocabulary and gates development entries', () => {
    vi.stubGlobal('HTMLElement', ElementStub);
    expect(shortcutView(key('KeyD'), true)).toBe('audio');
    expect(shortcutView(key('KeyE'), true)).toBe('laboratories');
    expect(shortcutView(key('KeyG'), true)).toBe('diagnostics');
    expect(shortcutView(key('KeyD'), false)).toBeNull();
    expect(shortcutView(key('KeyE'), false)).toBeNull();
    expect(shortcutView(key('KeyG'), false)).toBe('diagnostics');
  });
  it('ignores inputs inside a shadow root and inherited contenteditable descendants', () => {
    vi.stubGlobal('HTMLElement', ElementStub);
    for (const node of [new ElementStub('INPUT'), new ElementStub('SELECT'), new ElementStub('TEXTAREA'), new ElementStub('SPAN', true)]) {
      const event = key('KeyE', {}, [node, new ElementStub('ASIDE')]);
      expect(isEditing(event)).toBe(true); expect(shortcutView(event, true)).toBeNull();
    }
    expect(shortcutView(key('KeyE', {}, [new ElementStub('BUTTON')]), true)).toBe('laboratories');
  });
  it('ignores repeats, unshifted and modified chords', () => {
    vi.stubGlobal('HTMLElement', ElementStub);
    for (const patch of [{ repeat: true }, { shiftKey: false }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) expect(shortcutView(key('KeyG', patch), true)).toBeNull();
  });
});
describe('workspace columns', () => {
  const after = (...actions: LayoutAction[]) => actions.reduce(nextLayout, INITIAL_LAYOUT);
  it('opens as three columns and gives a shortcut the whole station back, whatever was folded away', () => {
    expect(INITIAL_LAYOUT).toEqual({ collapsed: false, inspector: true, wide: false, expanded: false });
    for (const folded of [after('inspector'), after('viewport'), after('inspector', 'viewport')]) {
      expect(inspectorShown(folded)).toBe(false);
      expect(inspectorShown(nextLayout(folded, 'reveal'))).toBe(true);
    }
    // The sidebar stays as the user left it: a shortcut asks for the inspector, not for a wider navigation.
    expect(after('sidebar', 'inspector', 'reveal')).toMatchObject({ collapsed: true, inspector: true, expanded: false });
  });
  it('hides without forgetting: the inspector returns at the width it had, the viewport alone restores both columns', () => {
    expect(after('wide', 'inspector', 'inspector')).toEqual({ ...INITIAL_LAYOUT, wide: true });
    expect(after('wide', 'sidebar', 'viewport', 'viewport')).toEqual({ ...INITIAL_LAYOUT, wide: true, collapsed: true });
    expect(after('inspector', 'viewport', 'viewport').inspector).toBe(false);
  });
  it('lets the inspector button always show something: from the viewport alone it brings the inspector back', () => {
    expect(after('inspector', 'viewport', 'inspector')).toMatchObject({ inspector: true, expanded: false });
    expect(inspectorShown(after('viewport', 'inspector'))).toBe(true);
    expect(inspectorShown(after('inspector'))).toBe(false);
  });
  it('never mutates the layout it is given', () => {
    const frozen = Object.freeze({ ...INITIAL_LAYOUT });
    for (const action of ['sidebar', 'inspector', 'wide', 'viewport', 'reveal'] as const) expect(nextLayout(frozen, action)).not.toBe(frozen);
  });
});
