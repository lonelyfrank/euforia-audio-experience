import { describe, expect, it } from 'vitest';
import { ShowDirector } from './ShowDirector';
import type { RigMode, ShowInput, ShowSink, SlotParam } from './types';

const BPM = 128;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
/** Sections (start bar, kind): intro, build, drop, a two-phrase break, drop. */
const SECTIONS: [number, number][] = [[0, 0], [8, 1], [16, 2], [32, 3], [48, 2]];
const BARS = 56;

interface Call { kind: 'target' | 'impulse' | 'snap'; slot: number; param: SlotParam | ''; value: number; at: number }

function sectionAt(bar: number) {
  let index = 0;
  for (let i = 0; i < SECTIONS.length; i++) if (bar >= SECTIONS[i][0]) index = i;
  return { index, start: SECTIONS[index][0], kind: SECTIONS[index][1] };
}

/** The analysis of a dance track, frame by frame (60 fps), as the director sees it. */
function inputs(gridWeight = 0.9): ShowInput[] {
  const out: ShowInput[] = [];
  for (let f = 0; f < BARS * BAR * 60; f++) {
    const t = f / 60;
    const bar = Math.floor(t / BAR);
    const s = sectionAt(bar);
    const phraseBars = s.kind === 2 ? 16 : 8;
    const phraseBar = (bar - s.start) % phraseBars;
    const barPhase = (t / BAR) % 1;
    const nextBeat = (Math.floor(t / BEAT) + 1) * BEAT;
    out.push({
      time: t, presence: 1, section: s.kind, sectionId: s.index, barIndex: bar, phraseBar, phraseBars,
      nextPhraseTime: (bar - phraseBar + phraseBars) * BAR, beatBpm: BPM, nextBeatTime: nextBeat, barPhase,
      dropExpected: s.kind === 1 ? Math.max(0, (phraseBar - 4) / 3) : 0, structureConfidence: 0.9, key: 9,
      gridWeight,
    });
  }
  return out;
}

function run(mode: RigMode, budget = 3, gridWeight = 0.9) {
  const director = new ShowDirector();
  director.setBudget(budget);
  const calls: Call[] = [];
  const sink: ShowSink = {
    target: (slot, param, value, at) => calls.push({ kind: 'target', slot, param, value, at }),
    impulse: (slot, param, value, at) => calls.push({ kind: 'impulse', slot, param, value, at }),
    snap: (at) => calls.push({ kind: 'snap', slot: -1, param: '', value: 0, at }),
  };
  const intensities: number[][] = [];
  for (const input of inputs(gridWeight)) {
    director.update(input, { mode, scene: 'galaxy' }, sink);
    intensities.push(director.slots.map((s) => s.intensity));
  }
  return { director, calls, intensities };
}

describe('ShowDirector', () => {
  it('never manufactures geometric motion: size and offset only follow looks and the world', () => {
    const { calls, director } = run('free');
    expect(calls.filter((c) => c.kind === 'impulse' && (c.param === 'size' || c.param === 'offset'))).toHaveLength(0);
    // Without a world (no experience) the movement effects keep the look's framing exactly.
    const framings = new Set(calls.filter((c) => c.param === 'size' || c.param === 'offset').map((c) => c.value.toFixed(6)));
    for (const value of framings) expect(['1.000000', '0.800000', '0.000000', '0.150000', '-0.150000', '0.180000', '-0.080000']).toContain(value);
    expect(director.log.some((entry) => /sweep|fan/.test(entry.what))).toBe(true);
  });

  it('forgets future beats when the capture clock restarts', () => {
    const { director } = run('free');
    const sink: ShowSink = { target: () => {}, impulse: () => {}, snap: () => {} };
    director.reset();
    const fresh = new ShowDirector();
    fresh.setBudget(director.budget);
    const calls = (d: ShowDirector) => {
      const out: number[] = [];
      for (const input of inputs().slice(0, 600)) d.update(input, { mode: 'free', scene: 'galaxy' },
        { ...sink, impulse: (_slot, _param, _value, at) => out.push(at) });
      return out;
    };
    expect(calls(director)).toEqual(calls(fresh));
    expect(director.log).toEqual(fresh.log);
  });

  it('releases supports as soon as the budget drops and also constrains returning looks', () => {
    const director = new ShowDirector();
    const sink: ShowSink = { target: () => {}, impulse: () => {}, snap: () => {} };
    const frames = inputs();
    const drop = frames.find((f) => f.section === 2)!;
    // Room for any three fixtures (the two heaviest cost 1.2 each).
    director.setBudget(3.4);
    director.update(drop, { mode: 'free', scene: 'galaxy' }, sink);
    expect(director.slots.filter((s) => s.fixture)).toHaveLength(3);
    director.setBudget(1);
    director.update({ ...drop, time: drop.time + 0.1 }, { mode: 'free', scene: 'galaxy' }, sink);
    expect(director.slots.filter((s) => s.fixture)).toHaveLength(1);
    director.update(frames.find((f) => f.section === 3)!, { mode: 'free', scene: 'galaxy' }, sink);
    director.update(frames.find((f) => f.sectionId === 4)!, { mode: 'free', scene: 'galaxy' }, sink);
    expect(director.slots.filter((s) => s.fixture)).toHaveLength(1);
  });

  it('makes the same decisions for the same input', () => {
    const a = run('free');
    const b = run('free');
    expect(b.director.log).toEqual(a.director.log);
    expect(b.calls).toEqual(a.calls);
  });

  it('changes the look only at section changes or phrase boundaries, never mid-phrase', () => {
    for (const mode of ['hybrid', 'free'] as const) {
      const { director } = run(mode);
      expect(director.log.length).toBeGreaterThan(3);
      for (const d of director.log.filter((x) => !x.what.startsWith('breath'))) {
        const bar = d.time / BAR;
        // On a downbeat…
        expect(Math.abs(bar - Math.round(bar)) * BAR).toBeLessThan(1 / 60 + 1e-9);
        // …that starts a section or a phrase.
        const s = sectionAt(Math.round(bar));
        const phraseBars = s.kind === 2 ? 16 : 8;
        expect((Math.round(bar) - s.start) % phraseBars).toBe(0);
      }
    }
  });

  it('keeps one protagonist and the full brightness for the drops', () => {
    const { intensities } = run('free');
    intensities.forEach((slots, f) => {
      const [lead, ...others] = slots;
      for (const o of others) expect(o).toBeLessThanOrEqual(lead * 0.45 + 1e-9);
      const kind = sectionAt(Math.floor(f / 60 / BAR)).kind;
      if (lead === 1) expect(kind).toBe(2);
    });
  });

  it('breathes on the last beat before an expected drop and snaps when it lands', () => {
    const { calls, director } = run('hybrid');
    const drop = 16 * BAR;
    const breath = calls.find((c) => c.kind === 'target' && c.slot === 0 && c.param === 'dim' && c.value <= 0.1 + 1e-9);
    expect(breath).toBeDefined();
    expect(breath!.at).toBeCloseTo(drop - BEAT, 6);
    expect(calls.some((c) => c.kind === 'snap' && Math.abs(c.at - drop) < 1e-6)).toBe(true);
    expect(director.log.some((d) => d.what.startsWith('breath') && d.why.includes('drop expected'))).toBe(true);
  });

  it('locks effects to the predicted beats, and drops them when the grid is weak', () => {
    const strong = run('free');
    const beats = strong.calls.filter((c) => c.kind === 'impulse');
    expect(beats.length).toBeGreaterThan(20);
    for (const c of beats) expect(Math.abs(c.at / BEAT - Math.round(c.at / BEAT)) * BEAT).toBeLessThan(1e-6);
    const weak = run('free', 3, 0.1);
    expect(weak.calls.filter((c) => c.kind === 'impulse')).toHaveLength(0);
    expect(weak.director.activeEffect).toBe('none');
  });

  it('brings a returning section back with its look', () => {
    const { director } = run('free');
    const drops = director.log.filter((d) => d.why.includes('section → drop'));
    expect(drops).toHaveLength(2);
    expect(drops[1].why).toContain('returns with its look');
    expect(drops[1].what).toBe(drops[0].what);
    for (const d of director.log) expect(d.what.includes('mirror') && d.what.includes('asymmetric')).toBe(false);
  });

  it('respects the GPU budget and the mode', () => {
    const tight = run('free', 1);
    expect(tight.intensities.every((s) => s[1] === 0 && s[2] === 0)).toBe(true);
    const wide = run('free', 3.4);
    expect(wide.intensities.some((s) => s[1] > 0 && s[2] > 0)).toBe(true);
    const preset = run('preset', 3);
    expect(preset.director.slots[0].fixture).toBe('galaxy');
    expect(preset.intensities.every((s) => s[0] === 1 && s[1] === 0)).toBe(true);
    // Preset plays the scene as designed: its own colours, no added effects, no breath.
    expect(preset.director.log.every((d) => d.what.includes('hue 0') && d.what.includes('none') && !d.what.includes('asymmetric'))).toBe(true);
    expect(preset.calls.filter((c) => c.kind === 'impulse' || c.param === 'dim')).toHaveLength(0);
    const hybrid = run('hybrid', 3);
    for (const d of hybrid.director.log) if (!d.what.startsWith('breath') && !d.what.startsWith('tint')) expect(d.what.startsWith('galaxy')).toBe(true);
  });

  it('varies colour at three time scales: hue per look, tint per phrase, flashes on beats', () => {
    const { calls, director } = run('free');
    const tints = calls.filter((c) => c.param === 'tint');
    const leaning = tints.filter((c) => c.value > 0);
    expect(leaning.length).toBeGreaterThan(0);
    for (const c of tints) {
      expect(c.value).toBeLessThanOrEqual(0.35);
      // Only on a phrase's first downbeat.
      const bar = Math.round(c.at / BAR);
      expect(Math.abs(c.at - bar * BAR)).toBeLessThan(1 / 60 + 1e-9);
      const s = sectionAt(bar);
      expect((bar - s.start) % (s.kind === 2 ? 16 : 8)).toBe(0);
    }
    // A new look starts in its pure hues.
    for (const d of director.log.filter((x) => x.what.includes(' · hue '))) {
      expect(tints.some((c) => c.value === 0 && Math.abs(c.at - d.time) < 1e-9)).toBe(true);
    }
    // Preset never leans the scene's colours.
    expect(run('preset').calls.filter((c) => c.param === 'tint' && c.value > 0)).toHaveLength(0);
  });
});
