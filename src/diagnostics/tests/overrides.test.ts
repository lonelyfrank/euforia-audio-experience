import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../audio/AudioEngine';
import type { App } from '../../app/App';
import { worldLab } from '../../visual-engine/VisualWorld';
import { DiagnosticsController, ISOLATION } from '../core/DiagnosticsController';
import { OverrideLedger } from '../core/Overrides';

describe('override ledger', () => {
  it('remembers what an override replaced once, however many times it is changed', () => {
    const ledger = new OverrideLedger(), target = { form: 'auto' };
    ledger.set('form', target, 'form', 'wave'); ledger.set('form', target, 'form', 'harmonic'); ledger.set('form', target, 'form', 'particles');
    expect([target.form, ledger.size, ledger.has('form')]).toEqual(['particles', 1, true]);
    expect(ledger.release('form')).toBe(true);
    expect([target.form, ledger.size]).toEqual(['auto', 0]);
  });
  it('gives a state back once: a second owner releasing after the first changes nothing', () => {
    const ledger = new OverrideLedger(), target = { only: null as ReadonlySet<string> | null };
    ledger.set('only', target, 'only', new Set(['surface']));
    ledger.releaseAll();
    // Somebody sets the switch after the release: a later release (another component closing) must not undo it.
    const later = new Set(['matter']); target.only = later;
    expect(ledger.release('only')).toBe(false); ledger.releaseAll();
    expect(target.only).toBe(later);
  });
  it('ends an override that is set back to what it replaced, and never counts a write of the value already there', () => {
    const ledger = new OverrideLedger(), target = { balance: null as number | null }, changes = vi.fn();
    ledger.onChange = changes;
    ledger.set('balance', target, 'balance', null); expect([ledger.size, changes.mock.calls.length]).toEqual([0, 0]);
    ledger.set('balance', target, 'balance', 1, 'controls'); ledger.set('balance', target, 'balance', null, 'controls');
    expect([target.balance, ledger.size]).toEqual([null, 0]); expect(changes.mock.calls).toEqual([['balance', 'controls'], ['balance', 'controls']]);
  });
  it('holds an override that is not a property under its first restore, and runs it once', () => {
    const ledger = new OverrideLedger(), first = vi.fn(), second = vi.fn();
    ledger.hold('source', first); ledger.hold('source', second);
    expect(ledger.size).toBe(1);
    ledger.releaseAll(); ledger.releaseAll();
    expect(first).toHaveBeenCalledTimes(1); expect(second).not.toHaveBeenCalled();
  });
  it('survives a restore that releases again', () => {
    const ledger = new OverrideLedger(), target = { a: 0, b: 0 };
    ledger.hold('reentrant', () => ledger.releaseAll()); ledger.set('a', target, 'a', 1); ledger.set('b', target, 'b', 2);
    ledger.releaseAll();
    expect([target, ledger.size]).toEqual([{ a: 0, b: 0 }, 0]);
  });
});

describe('primitive isolation has one owner', () => {
  function setup() {
    const gl = { getExtension: () => null, getParameter: () => 'test WebGL', isContextLost: () => false };
    const info = { autoReset: true, reset: vi.fn(), render: { calls: 0, points: 0, triangles: 0, lines: 0 }, memory: { geometries: 0, textures: 0 } };
    const renderer = { info, getContext: () => gl, domElement: { width: 1280, height: 720 }, getPixelRatio: () => 1 };
    const directionDebug = { renderer, qualityTier: 'high', current: null, diagnostics: null, load: { fps: 60, limit: 'none', reduced: false, step: 0, logicShare: 0, steady: true } };
    return new DiagnosticsController({ audio: new AudioEngine(), directionDebug } as unknown as App);
  }
  afterEach(() => { worldLab.only = null; });
  it('restores the isolation that was there before the first override, whoever asked for the later ones', () => {
    const c = setup(), release = c.acquire();
    c.isolate(['surface', 'matter'], '?primitives');
    expect([...worldLab.only!]).toEqual(['surface', 'matter']);
    c.isolate('structure'); expect([...worldLab.only!]).toEqual(['structure']); expect(c.overrides.size).toBe(1);
    // "All primitives" is what was there before: the override ends instead of becoming an override of its own.
    c.isolate(null); expect([worldLab.only, c.overrides.has(ISOLATION)]).toEqual([null, false]);
    release(); c.dispose();
  });
  it('gives isolation back when the experiment releases it, and not a second time when diagnostics close', () => {
    const c = setup(), release = c.acquire();
    c.isolate('surface');
    c.overrides.releaseAll('stop experiment'); expect(worldLab.only).toBeNull();
    // Diagnostics closing and the controller being disposed used to write their own remembered value back, in sequence.
    const later = new Set(['matter']); worldLab.only = later;
    release(); expect(worldLab.only).toBe(later);
    c.dispose(); c.dispose(); expect(worldLab.only).toBe(later);
  });
  it('still gives it back when diagnostics close with an isolation in force', () => {
    const c = setup(), release = c.acquire();
    c.isolate('surface'); release();
    expect([worldLab.only, c.overrides.size]).toEqual([null, 0]);
    c.dispose();
  });
});
