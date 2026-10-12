import { describe, expect, it } from 'vitest';
import { escapeStep } from './components';
import { Experiment, type Laboratory } from './Experiment';

/** Laboratories that only say when they are built and ended. */
function setup(requested: Laboratory = 'structural') {
  const log: string[] = [];
  const experiment = new Experiment((lab) => { log.push(`+${lab}`); return { overrides: lab === 'solid' ? 2 : 0, dispose: () => { log.push(`-${lab}`); } }; }, requested, () => { log.push('restore'); });
  return { experiment, log };
}

describe('experiment lifecycle', () => {
  it('opens the laboratory asked for, and enters it again without building it twice', () => {
    const { experiment, log } = setup('solid');
    expect(experiment.running).toBeNull();
    expect(experiment.open()).toBe(true); expect(experiment.running).toBe('solid'); expect(experiment.overrides).toBe(2);
    // The same entry again (a shortcut, the sidebar, a start parameter): the laboratory running is left as it is.
    expect(experiment.open()).toBe(false); expect(experiment.open('solid')).toBe(false);
    expect(log).toEqual(['+solid']);
  });
  it('ends the laboratory that leaves before the next one starts, and never restores overrides for a switch', () => {
    const { experiment, log } = setup();
    experiment.open(); experiment.open('solid'); experiment.open('structural');
    expect(log).toEqual(['+structural', '-structural', '+solid', '-solid', '+structural']);
    expect(experiment.running).toBe('structural'); expect(experiment.overrides).toBe(0);
  });
  it('stops by ending the laboratory and giving the overrides back, as many times as it is asked', () => {
    const { experiment, log } = setup();
    experiment.open('solid'); experiment.stop();
    expect(log).toEqual(['+solid', '-solid', 'restore']); expect(experiment.running).toBeNull(); expect(experiment.overrides).toBe(0);
    experiment.stop();
    // A second stop has no laboratory to end: it only asks for the overrides again, which is a no-op for whoever holds none.
    expect(log).toEqual(['+solid', '-solid', 'restore', 'restore']);
    // The next entry opens the laboratory last asked for, not the one the session started with.
    expect(experiment.open()).toBe(true); expect(experiment.running).toBe('solid');
  });
  it('disposes once: the laboratory ends once and nothing opens afterwards', () => {
    const { experiment, log } = setup();
    experiment.open(); experiment.dispose(); experiment.dispose(); experiment.stop();
    expect(log.filter(entry => entry === '-structural')).toHaveLength(1);
    expect(experiment.open('solid')).toBe(false); expect(experiment.running).toBeNull(); expect(log).not.toContain('+solid');
  });
  it('leaves no laboratory behind when one fails to start', () => {
    const experiment = new Experiment((lab) => { if (lab === 'solid') throw new Error('no world'); return { overrides: 1, dispose: () => {} }; }, 'structural', () => {});
    experiment.open();
    expect(() => experiment.open('solid')).toThrow('no world');
    expect(experiment.running).toBeNull(); expect(experiment.overrides).toBe(0);
    expect(experiment.open('structural')).toBe(true);
  });
});

describe('Escape in the workspace', () => {
  it('closes a dialog first, asks once over overrides in force, and otherwise closes', () => {
    expect(escapeStep(true, 0)).toBe('dismiss'); expect(escapeStep(true, 3)).toBe('dismiss');
    expect(escapeStep(false, 3)).toBe('confirm');
    // A laboratory running untouched has nothing to lose: no question.
    expect(escapeStep(false, 0)).toBe('close');
  });
});
