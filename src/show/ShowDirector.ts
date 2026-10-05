import { relationship } from './relationships';
import { FIXTURES, fixtureById } from './fixtures';
import { Rng, seedOf } from './rng';
import { SECTION_NAMES, type Decision, type EffectId, type RigMode, type SectionName, type ShowInput, type ShowSettings, type ShowSink, type SlotPlan } from './types';

/** Fixtures shown at once at most, per mode. */
const MODE_SLOTS: Readonly<Record<RigMode, number>> = { preset: 1, hybrid: 2, free: 3 };
/**
 * Bars a look holds before a phrase boundary may choose a new one; the
 * phrases in between vary only its colour (tint), so a section keeps a
 * recognizable look.
 */
const HOLD_BARS = 16;
/** Below this grid weight no effect is locked to the beat (honest fallback: atmosphere and transients). */
const GRID_EFFECTS = 0.3;
/** Structure confidence needed to vary the look at phrase boundaries. */
const PHRASE_CONFIDENCE = 0.4;
/** Brightness ceiling of the protagonist per section (the full level is kept for the peaks). */
const CEILING: Readonly<Record<SectionName, number>> = { intro: 0.6, build: 0.7, drop: 1, break: 0.45, outro: 0.5 };
/** Supporting fixtures stay this far below the protagonist. */
const SUPPORT = 0.45;
/** Intensity of the breath (near blackout) on the last beat before an expected drop. */
const BREATH = 0.1;
/** A build expects its drop at the phrase end above this. */
const DROP_EXPECTED = 0.7;
const LOG_SIZE = 32;
/** Most a phrase leans a fixture's colours toward its second hue (the lead hue stays dominant). */
const MAX_TINT = 0.35;

/** Effects that suit each section (weights for the seeded choice). */
const EFFECTS: Readonly<Record<SectionName, Partial<Record<EffectId, number>>>> = {
  intro: { none: 2, pulse: 1 },
  build: { pulse: 2, chase: 2 },
  drop: { pulse: 2, fan: 2, mirror: 1.5, sweep: 1 },
  break: { none: 2, sweep: 1 },
  outro: { none: 3, pulse: 0.5 },
};
const EFFECT_IDS: readonly EffectId[] = ['none', 'pulse', 'chase', 'sweep', 'fan', 'mirror'];

/**
 * The show's director: decides which fixtures (scenes) play, how bright, in
 * which hue of the user's palette, and which beat-locked effect runs; never
 * values per frame. It works on three time scales: the section (fixtures,
 * hue, effect), the bar (movement: sweep, fan) and the beat (pulse, chase:
 * impulses scheduled on the predicted beat). Colour follows the same three
 * scales within the user's palette: the section picks each fixture's lead
 * hue, each phrase leans it a little toward its second hue (tint), and beat
 * flashes take its accent hue. Rules of taste:
 *
 * - one protagonist at a time; supporting fixtures stay well below it;
 * - a section of a kind already heard comes back with that kind's look
 *   (a returning drop looks like the drop before); variations come at
 *   phrase boundaries;
 * - looks change at section changes, or at phrase boundaries after a hold
 *   (hybrid/free) — never in the middle of a phrase;
 * - symmetry by default; it breaks only in drops;
 * - a breath (near blackout) on the last beat before an expected drop, and
 *   a snap when the section lands;
 * - the full brightness is kept for drops;
 * - preset mode plays the user's scene as designed: full brightness, no
 *   added effects, no breath (those are direction choices);
 * - with a weak grid, no beat-locked effects (atmosphere and attacks only);
 * - no more fixtures than the GPU budget allows.
 *
 * Every choice is seeded from quantized features (section, tempo, key,
 * motif), so the same input gives the same decisions, each logged with why.
 * Pure logic: no rendering, no DOM; commands go out through a ShowSink.
 */
export class ShowDirector {
  readonly slots: SlotPlan[] = [0, 1, 2].map(() => ({ fixture: null, intensity: 0, size: 1, offset: 0, mirror: false, hue: 0, tint: 0 }));
  effect: EffectId = 'none';
  /** The effect actually running (none while the grid is weak). */
  activeEffect: EffectId = 'none';
  mode: RigMode = 'preset';
  /** GPU budget in fixture cost units (1 ≈ one average scene). */
  budget = 1;
  readonly log: Decision[] = [];

  private section: SectionName = 'intro';
  private sectionId = -1;
  private lastChangeBar = 0;
  private lastBar = -1;
  private lastBeat = -Infinity;
  private beats = 0;
  private breathAt = -1;
  private scene = '';
  private started = false;
  private readonly weights = new Float64Array(FIXTURES.length);
  /** The last look chosen for each kind of section (reused when that kind comes back). */
  private readonly looks = new Map<SectionName, Look>();
  private readonly motifs = new Map<number, Look>();
  private input: ShowInput | undefined;

  /** New capture clock: forget predictions and looks from the previous source. */
  reset(): void {
    this.started = false;
    this.section = 'intro';
    this.sectionId = this.lastBar = -1;
    this.lastChangeBar = this.beats = 0;
    this.lastBeat = -Infinity;
    this.breathAt = -1;
    this.effect = this.activeEffect = 'none';
    this.looks.clear();
    this.motifs.clear();
    this.log.length = 0;
  }

  /** Cuts supporting fixtures on the next update; extra budget waits for a musical decision. */
  setBudget(units: number): void {
    this.budget = Math.max(1, units);
  }

  update(input: ShowInput, settings: ShowSettings, sink: ShowSink): void {
    this.input = input;
    if (!this.started || settings.mode !== this.mode || (settings.scene !== this.scene && settings.mode !== 'free')) {
      this.started = true;
      this.looks.clear();
      this.mode = settings.mode;
      this.scene = settings.scene;
      this.section = SECTION_NAMES[input.section] ?? 'intro';
      this.decideLook(input, sink, `${settings.mode} mode, scene ${settings.scene}`);
    }
    // Section level: a new section changes the look at once (a strong moment).
    if (input.sectionId !== this.sectionId && input.sectionId >= 0) {
      const first = this.sectionId < 0;
      this.sectionId = input.sectionId;
      this.section = SECTION_NAMES[input.section] ?? 'intro';
      if (!first) {
        sink.snap(input.time);
        const e = input.experience?.state;
        const look = this.mode === 'preset' ? undefined : e ? (e.recurrence > 0 ? this.motifs.get(e.motif) : undefined) : this.looks.get(this.section);
        if (look) this.applyLook(input, sink, look, `section → ${this.section}, returns with its look`);
        else this.decideLook(input, sink, `section → ${this.section}`);
      }
    }
    // Phrase level: hybrid and free vary the look at phrase boundaries, after a hold.
    if (input.barIndex !== this.lastBar) {
      this.lastBar = input.barIndex;
      const phrase = input.phraseBar === 0 && this.mode !== 'preset' && input.structureConfidence >= PHRASE_CONFIDENCE;
      if (phrase && input.barIndex - this.lastChangeBar >= HOLD_BARS && (!input.experience || input.time >= input.experience.plan.transitionStart)) {
        this.decideLook(input, sink, `phrase boundary after ${input.barIndex - this.lastChangeBar} bars`);
      } else if (phrase && input.barIndex !== this.lastChangeBar) {
        this.tintPhrase(input, sink);
      }
    }
    this.constrainBudget(input.time, sink);
    this.breathe(input, sink);
    this.activeEffect = input.gridWeight >= GRID_EFFECTS ? this.effect : 'none';
    this.scheduleBeat(input, sink);
  }

  /** Returning looks and already mounted supports must respect a reduced GPU budget too. */
  private constrainBudget(time: number, sink: ShowSink): void {
    let cost = 0;
    let full = false;
    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s];
      if (!slot.fixture) continue;
      const next = cost + (fixtureById(slot.fixture)?.cost ?? 1);
      if (s > 0 && (full || next > this.budget)) {
        full = true;
        this.record(time, `release ${slot.fixture}`, `GPU budget ${this.budget.toFixed(1)}`);
        slot.fixture = null;
        slot.intensity = 0;
        sink.target(s, 'intensity', 0, time);
      } else cost = next;
    }
  }

  /** Section-level choice: fixtures, hue, effect, symmetry and brightness. */
  private decideLook(input: ShowInput, sink: ShowSink, why: string): void {
    const motif = input.experience?.state.motif ?? -1;
    const rng = new Rng(seedOf(input.sectionId, Math.round(input.beatBpm / 2), input.key, motif, input.barIndex, MODE_INDEX[this.mode]));
    const section = this.section;
    // Fixtures within the mode's slots and the GPU budget.
    const lead = this.mode === 'free' ? this.pickFixture(rng, section, []) : this.scene;
    const chosen = [lead];
    let cost = fixtureById(lead)?.cost ?? 1;
    let wantSupports = this.mode === 'free' ? (section === 'drop' ? 2 : section === 'build' ? 1 : rng.next() < 0.4 ? 1 : 0) : section === 'drop' ? 1 : 0;
    if (input.experience) {
      const entropy = input.experience.plan.desiredEntropy;
      wantSupports = Math.min(wantSupports, entropy > 0.65 ? 2 : entropy > 0.35 ? 1 : 0);
    }
    for (let i = 0; i < wantSupports && chosen.length < MODE_SLOTS[this.mode]; i++) {
      const id = this.pickFixture(rng, section, chosen);
      const c = fixtureById(id)?.cost ?? 1;
      if (cost + c > this.budget) break;
      chosen.push(id);
      cost += c;
    }
    // Hue: the palette's primary leads the drops; elsewhere a seeded choice among its three.
    // Preset plays the scene as designed: its own colours, no effects.
    const preset = this.mode === 'preset';
    const hue = section === 'drop' || preset ? 0 : Math.floor(rng.next() * 3);
    // Symmetry by default; it breaks only in drops (and then the mirror effect makes no sense).
    const asymmetric = !preset && section === 'drop' && rng.next() < 0.35;
    const effect = preset ? 'none' : (EFFECT_IDS[rng.pick(EFFECT_IDS.map((e) => (asymmetric && e === 'mirror' ? 0 : EFFECTS[section][e] ?? 0)))] ?? 'none');
    const look: Look = { fixtures: chosen, hue, effect, asymmetric };
    this.looks.set(section, look);
    if (motif >= 0) this.motifs.set(motif, look);
    this.applyLook(input, sink, look, `${why}; cost ${cost.toFixed(1)}/${this.budget.toFixed(1)}`);
  }

  /** Puts a look on the slots: fixtures, hue, symmetry, brightness, effect. */
  private applyLook(input: ShowInput, sink: ShowSink, look: Look, why: string): void {
    const { fixtures: chosen, hue, effect, asymmetric } = look;
    const ceiling = this.mode === 'preset' ? 1 : Math.min(CEILING[this.section], input.experience?.plan.maxIntensity ?? 1);
    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s];
      slot.fixture = chosen[s] ?? null;
      slot.hue = (hue + s) % 3;
      slot.intensity = slot.fixture ? (s === 0 ? ceiling : ceiling * SUPPORT) : 0;
      slot.mirror = s > 0 && !asymmetric;
      slot.offset = s === 0 ? 0 : asymmetric ? (s === 1 ? 0.18 : -0.08) : s === 1 ? 0.15 : -0.15;
      slot.size = s === 0 ? 1 : 0.8;
      // A new look starts in its pure hues; phrases lean them later.
      slot.tint = 0;
      sink.target(s, 'tint', 0, input.time);
      sink.target(s, 'intensity', slot.intensity, input.time);
      sink.target(s, 'offset', slot.offset, input.time);
      sink.target(s, 'size', slot.size, input.time);
    }
    this.effect = effect;
    this.lastChangeBar = input.barIndex;
    this.breathAt = -1;
    this.record(input.time, `${chosen.join(' + ')} · hue ${hue} · ${effect}${asymmetric ? ' · asymmetric' : ''} · ceiling ${ceiling}`, why);
  }

  /** Phrase level: each fixture's colours lean toward its second hue by a seeded amount (the look stays). */
  private tintPhrase(input: ShowInput, sink: ShowSink): void {
    const rng = new Rng(seedOf(input.sectionId, input.barIndex, input.key, MODE_INDEX[this.mode], 7));
    const amounts: string[] = [];
    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s];
      if (!slot.fixture) continue;
      slot.tint = Math.round(rng.next() * MAX_TINT * 100) / 100;
      sink.target(s, 'tint', slot.tint, input.time);
      amounts.push(slot.tint.toFixed(2));
    }
    this.record(input.time, `tint ${amounts.join(' / ')}`, `phrase at bar ${input.barIndex}`);
  }

  /** A fixture for the section, weighted by affinity, not already playing. */
  private pickFixture(rng: Rng, section: SectionName, taken: readonly string[]): string {
    for (let i = 0; i < FIXTURES.length; i++) {
      const f = FIXTURES[i];
      const e = this.input?.experience;
      const relation = relationship(this.slots[0].fixture, f.id);
      const continuity = e?.plan.sceneContinuity ?? 0.5;
      const affinity = e ? relation * continuity + (1 - relation) * e.plan.contrastTarget + 0.2 : 1;
      this.weights[i] = taken.includes(f.id) ? 0 : f.affinity[section] ** 2 * affinity;
    }
    const i = rng.pick(this.weights);
    return FIXTURES[i < 0 ? 0 : i].id;
  }

  /** The last beat before an expected drop: a breath, then the drop lands on the boundary. */
  private breathe(input: ShowInput, sink: ShowSink): void {
    if (input.experience && input.experience.plan.nextIntent !== 'expand') return;
    if ((input.meter !== undefined && input.meter === 0) || this.mode === 'preset' || this.section !== 'build' || input.dropExpected < DROP_EXPECTED || input.nextPhraseTime <= 0 || input.beatBpm <= 0) return;
    if (input.phraseBar !== input.phraseBars - 1 || this.breathAt === input.nextPhraseTime) return;
    const period = 60 / input.beatBpm;
    this.breathAt = input.nextPhraseTime;
    for (let s = 0; s < this.slots.length; s++) {
      if (!this.slots[s].fixture) continue;
      sink.target(s, 'dim', BREATH, input.nextPhraseTime - period);
      // Back on the boundary (the drop's own decision will set its look; a missed drop gets its light back).
      sink.target(s, 'dim', 1, input.nextPhraseTime);
    }
    sink.snap(input.nextPhraseTime);
    this.record(input.time, `breath at ${(input.nextPhraseTime - period).toFixed(2)} s`, `build, drop expected ${input.dropExpected.toFixed(2)} at the phrase end`);
  }

  /** Beat level: the next predicted beat, once, with the running effect's impulses and targets. */
  private scheduleBeat(input: ShowInput, sink: ShowSink): void {
    if (input.nextBeatTime <= 0 || input.beatBpm <= 0) return;
    const period = 60 / input.beatBpm;
    if (input.nextBeatTime <= this.lastBeat + period / 2) return;
    this.lastBeat = input.nextBeatTime;
    const at = input.nextBeatTime;
    const meter = input.meter === undefined ? 4 : input.meter;
    const position = meter > 0 ? (Math.floor(input.barPhase * meter) + 1) % meter : 0;
    const downbeat = meter > 0 && (input.meterConfidence ?? 1) > 0.2 && position === 0;
    const weight = input.gridWeight;
    let active = 0;
    for (const slot of this.slots) if (slot.fixture) active++;
    this.beats++;
    switch (this.activeEffect) {
      case 'pulse':
        for (let s = 0; s < active; s++) sink.impulse(s, 'strobe', (s === 0 ? 0.8 : 0.4) * weight * (downbeat ? 1 : 0.7), at);
        break;
      case 'chase': {
        // Around the fixtures, one per beat; with a single fixture, accents on the downbeat.
        const s = active > 1 ? this.beats % active : 0;
        sink.impulse(s, 'strobe', (active > 1 || downbeat ? 0.9 : 0.35) * weight, at);
        break;
      }
      case 'sweep':
        for (let s = 1; s < active; s++) sink.target(s, 'offset', (s === 1 ? 1 : -1) * 0.18 * Math.sin((Math.PI / 2) * position), at);
        break;
      case 'fan':
        if (downbeat) for (let s = 0; s < active; s++) sink.impulse(s, 'size', 0.08 * weight, at);
        break;
      case 'mirror':
        if (downbeat) for (let s = 0; s < active; s++) sink.impulse(s, 'strobe', 0.6 * weight, at);
        break;
      case 'none':
        break;
    }
  }

  private record(time: number, what: string, why: string): void {
    if (this.log.length >= LOG_SIZE) this.log.shift();
    this.log.push({ time, what, why });
  }
}

interface Look {
  fixtures: string[];
  hue: number;
  effect: EffectId;
  asymmetric: boolean;
}

const MODE_INDEX: Readonly<Record<RigMode, number>> = { preset: 0, hybrid: 1, free: 2 };
