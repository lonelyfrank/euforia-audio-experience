import type { ExperienceSnapshot } from '../experience/types';
/** How freely the show is directed. */
export type RigMode = 'preset' | 'hybrid' | 'free';

export type SectionName = 'intro' | 'build' | 'drop' | 'break' | 'outro';
export const SECTION_NAMES: readonly SectionName[] = ['intro', 'build', 'drop', 'break', 'outro'];

/** Beat-locked effects across the active fixtures. */
export type EffectId = 'none' | 'pulse' | 'chase' | 'sweep' | 'fan' | 'mirror';

/** A fixture: one of the existing scenes, with what it costs to render and where it fits. */
export interface FixtureSpec {
  id: string;
  /** GPU cost relative to an average scene (1). */
  cost: number;
  /** How well it suits each kind of section (0..1). */
  affinity: Readonly<Record<SectionName, number>>;
}

/** One slot of the rig: a fixture and the targets of its generic parameters. */
export interface SlotPlan {
  fixture: string | null;
  /** 0..1: brightness/opacity ceiling (the protagonist is the brightest). */
  intensity: number;
  /** Scale around the scene centre (1 = as designed). */
  size: number;
  /** Horizontal offset (fraction of the width, ±). */
  offset: number;
  /** Mirrored left/right (symmetry). */
  mirror: boolean;
  /** Which palette hue leads this fixture (0..2): the palette stays the user's. */
  hue: number;
  /** 0..1: lean toward the fixture's second hue, varied per phrase. */
  tint: number;
  /**
   * 0..1: how much structure the fixture may carry (how many of a visual world's primitive systems, how complex): the
   * protagonist of a drop everything, a quiet section or a supporting fixture less. A ceiling, not a command: what
   * shows under it is the sound's doing.
   */
  structure: number;
}

/** What the show reads each frame (capture-clock times; see the analysis frame). */
export interface ShowInput {
  /** Audio time heard when this frame is seen. */
  time: number;
  presence: number;
  /** Section: 0 intro … 4 outro, and its id. */
  section: number;
  sectionId: number;
  barIndex: number;
  phraseBar: number;
  phraseBars: number;
  nextPhraseTime: number;
  beatBpm: number;
  nextBeatTime: number;
  barPhase: number;
  dropExpected: number;
  structureConfidence: number;
  key: number;
  experience?: ExperienceSnapshot;
  meter?: number;
  meterConfidence?: number;
  /** 0..1: how much the grid can be trusted (Timing's gate weight). */
  gridWeight: number;
}

export interface ShowSettings {
  mode: RigMode;
  /** The user's scene: the protagonist in preset and hybrid mode. */
  scene: string;
}

/**
 * Timed commands for the Dynamics layer: slot parameters by name. `dim`
 * multiplies the intensity for quick dips (the breath before a drop), so
 * the intensity itself can glide slowly; `tint` leans the fixture's colours
 * toward its second hue (the phrase's colour).
 */
export type SlotParam = 'intensity' | 'dim' | 'size' | 'offset' | 'strobe' | 'tint';

export interface ShowSink {
  /** A parameter's new target at audio time `at`. */
  target(slot: number, param: SlotParam, value: number, at: number): void;
  /** A transient on a slot parameter (strobe: flash; size: kick) at `at`. */
  impulse(slot: number, param: SlotParam, amount: number, at: number): void;
  /** Section boundary or drop: stop motion, no trail. */
  snap(at: number): void;
}

/** One decision, with why (the decision log). */
export interface Decision {
  time: number;
  what: string;
  why: string;
}
