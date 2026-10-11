import { afterEach, describe, expect, it, vi } from 'vitest';
import { isEditing, shortcutView } from './components';
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
