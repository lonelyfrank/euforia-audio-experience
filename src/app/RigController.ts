import type { AudioEngine } from '../audio/AudioEngine';
import { resolveDirection, type Settings } from '../stores/settingsStore';
import type { RigValues } from '../types/visualizer';
import { Dynamics } from '../dynamics/Dynamics';
import { CueScheduler } from '../dynamics/CueScheduler';
import { FlashGuard } from '../dynamics/FlashGuard';
import { ShowDirector } from '../show/ShowDirector';
import { GpuBudget } from '../show/GpuBudget';
import type { RigMode, ShowInput, ShowSink, SlotParam } from '../show/types';
import { SLOTS, type RenderEngine, type SceneSource, type SlotParams } from '../renderer/RenderEngine';
import { findVisualizer, visualizers } from '../visualizers/registry';
import type { AudioEvent, EventCursor } from '../experience/EventStream';

/** Connects analysis, timed dynamics and show decisions to the renderer's slots. */
export class RigController {
  /** Dynamics: fixture parameters driven by timed targets and impulses (see src/dynamics). */
  readonly dynamics = new Dynamics();
  private readonly glowPulse = this.dynamics.channel('glow.pulse', 'flash');
  /** Photosensitivity: one rate limit on every flash of the rig (glow pulse and strobes). */
  readonly flashGuard = new FlashGuard();
  private readonly cues = new CueScheduler(this.dynamics, this.glowPulse, true, this.flashGuard);
  readonly rig: RigValues = { time: 0, timed: false, glowPulse: 0, snapAt: -1, hits: this.cues.hits };
  /** The show: which fixtures (scenes) play, how, with which effects (see src/show). */
  readonly show = new ShowDirector();
  private readonly budget = new GpuBudget();
  /** Dynamics channels of each slot's generic parameters. */
  private readonly slotChannels = Array.from({ length: SLOTS }, (_, i) => ({
    intensity: this.dynamics.channel(`slot${i}.intensity`, 'glide', i === 0 ? 1 : 0),
    dim: this.dynamics.channel(`slot${i}.dim`, 'sparkle', 1),
    size: this.dynamics.channel(`slot${i}.size`, 'pulse', 1),
    offset: this.dynamics.channel(`slot${i}.offset`, 'swing', 0),
    strobe: this.dynamics.channel(`slot${i}.strobe`, 'flash'),
    tint: this.dynamics.channel(`slot${i}.tint`, 'glide'),
  }));
  private readonly showSink: ShowSink = {
    target: (slot, param, value, at) => this.dynamics.setTarget(this.slotChannel(slot, param), value, at),
    impulse: (slot, param, amount, at) =>
      this.dynamics.impulse(this.slotChannel(slot, param), param === 'strobe' ? this.flashGuard.admit(at, amount) : amount, at),
    snap: (at) => this.dynamics.snap(at, 0.5),
  };
  private readonly showInput: ShowInput = {
    time: 0, presence: 0, section: 0, sectionId: -1, barIndex: 0, phraseBar: 0, phraseBars: 8, nextPhraseTime: 0, beatBpm: 0,
    nextBeatTime: 0, barPhase: 0, dropExpected: 0, structureConfidence: 0, key: -1, gridWeight: 0,
  };
  private readonly showSettings: { mode: RigMode; scene: string } = { mode: 'preset', scene: '' };
  /** The fixture mounted in each slot, and one source object per scene (stable, so slots can compare). */
  private readonly mounted: (string | null)[] = Array.from({ length: SLOTS }, () => null);
  private readonly sources = new Map<string, SceneSource>();
  private readonly slotParams: SlotParams = { weight: 1, size: 1, offset: 0, mirror: false, flash: 0, tint: 0 };
  private session = -1;
  /** Position in the experience event stream (heard time, arrivals seen). */
  private readonly eventCursor: EventCursor = { time: -Infinity, seq: 0 };
  /** Every heard impact gets its own impulse at its own audio time, even several between two frames. */
  private readonly onEvent = (e: AudioEvent): void => {
    // A backlog after a stall is history, not something to flash now.
    if (e.type === 'impact' && e.audioTime > this.dynamics.time - 0.5) this.dynamics.impulse(this.experienceLight, this.flashGuard.admit(e.audioTime, e.strength), e.audioTime);
  };
  private readonly experienceLight = this.dynamics.channel('experience.light', 'flash');

  constructor(
    private readonly audio: AudioEngine,
    private readonly render: RenderEngine,
    private readonly settings: () => Settings,
  ) {}

  showScene(id: string): void {
    this.render.show(this.sourceFor(id));
    this.mounted[0] = id;
  }

  private reset(): void {
    this.dynamics.restart();
    this.cues.reset();
    this.flashGuard.reset();
    this.eventCursor.time = -Infinity;
    this.eventCursor.seq = 0;
    this.show.reset();
    this.budget.reset();
    // A source can be changed during the pre-drop dimming cue.
    for (const c of this.slotChannels) this.dynamics.setTarget(c.dim, 1, this.audio.timing.heardTime);
  }

  /** Analysis events → Dynamics (on the heard audio clock) → fixture values for the renderer. */
  update(dt: number): void {
    const { features, timing, clock } = this.audio;
    if (this.session !== this.audio.session || timing.heardTime < this.dynamics.time - 1) {
      this.reset();
      this.session = this.audio.session;
    }
    this.rig.experience = clock.ready ? this.audio.experience.present(timing.heardTime) : undefined;
    if (!clock.ready) {
      this.rig.timed = false;
      this.rig.glowPulse = 0;
      this.rig.snapAt = -1;
      return;
    }
    const { onsets, sections } = features;
    this.cues.update(features.frame, timing.gridWeight, onsets.items, onsets.count, sections.items, sections.count);
    const experience = this.rig.experience;
    if (experience) this.audio.experience.events.forEachHeard(this.eventCursor, timing.heardTime, this.onEvent);
    this.directShow(dt);
    this.dynamics.advance(timing.heardTime);
    this.applyShow();
    this.rig.time = timing.heardTime;
    this.rig.timed = true;
    this.rig.glowPulse = this.dynamics.value(this.glowPulse);
    this.rig.experienceLight = this.dynamics.value(this.experienceLight);
    // Section boundaries snap every Director's dynamics too (no trail of the build into the drop).
    this.rig.snapAt = sections.count > 0 ? sections.items[sections.count - 1].time : -1;
  }

  /** The show director's decisions for this frame (targets and impulses go to the Dynamics layer). */
  private directShow(dt: number): void {
    const f = this.rig.experience?.acoustic ?? this.audio.features.frame;
    const i = this.showInput;
    i.time = this.audio.timing.heardTime;
    i.presence = f.presence;
    i.section = f.section;
    i.sectionId = f.sectionId;
    i.barIndex = f.barIndex;
    i.phraseBar = f.phraseBar;
    i.phraseBars = f.phraseBars;
    i.nextPhraseTime = f.nextPhraseTime;
    i.beatBpm = f.beatBpm;
    i.nextBeatTime = f.nextBeatTime;
    i.barPhase = f.barPhase;
    i.dropExpected = this.rig.experience?.state.anticipation ?? f.dropExpected;
    i.structureConfidence = f.structureConfidence * f.meterConfidence;
    i.key = f.key;
    i.experience = this.rig.experience;
    i.meter = f.meter;
    i.meterConfidence = f.meterConfidence;
    i.gridWeight = this.audio.timing.gridWeight;
    const s = this.settings();
    this.showSettings.mode = resolveDirection(s).rigMode;
    this.showSettings.scene = s.scene;
    this.show.setBudget(this.budget.update(this.render.measuredFps, dt, this.render.qualityTier));
    this.show.update(i, this.showSettings, this.showSink);
    const lead = this.show.slots[0];
    let sceneIndex = -1;
    for (let v = 0; v < visualizers.length; v++) if (visualizers[v].id === lead.fixture) sceneIndex = v;
    this.audio.experience.memory.recordVisual(i.time, sceneIndex, lead.hue, lead.intensity);
  }

  /** Mounts the planned fixtures and hands their parameters (Dynamics values) to the renderer. */
  private applyShow(): void {
    for (let s = 0; s < SLOTS; s++) {
      const plan = this.show.slots[s];
      if (plan.fixture !== this.mounted[s]) {
        this.render.setSlot(s, plan.fixture ? this.sourceFor(plan.fixture) : null);
        this.mounted[s] = plan.fixture;
      }
      this.render.setSlotHue(s, plan.hue);
      const c = this.slotChannels[s];
      const p = this.slotParams;
      p.weight = Math.max(0, this.dynamics.value(c.intensity) * this.dynamics.value(c.dim));
      p.size = this.dynamics.value(c.size);
      p.offset = this.dynamics.value(c.offset);
      p.mirror = plan.mirror;
      p.flash = this.dynamics.value(c.strobe);
      p.tint = Math.max(0, this.dynamics.value(c.tint));
      this.render.setSlotParams(s, p);
    }
  }

  private slotChannel(slot: number, param: SlotParam): number {
    return this.slotChannels[slot][param];
  }

  /** One source object per scene id (so a slot can tell whether its fixture changed). */
  private sourceFor(id: string): SceneSource {
    let source = this.sources.get(id);
    if (!source) {
      const def = findVisualizer(id) ?? visualizers[0];
      source = { create: () => def.create(def.preset), preset: def.preset, direction: def.direction };
      this.sources.set(id, source);
    }
    return source;
  }
}
