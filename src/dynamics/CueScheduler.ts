import type { Dynamics } from './Dynamics';

/** What the scheduler reads from the analysis each frame (capture-clock times). */
export interface CueInput {
  nextBeatTime: number;
  beatBpm: number;
}

export interface OnsetCue {
  time: number;
  strength: number;
  region: number;
}

export interface SectionCue {
  time: number;
}

/** An attack this close (s) to a scheduled beat is that beat: no second impulse. */
const SAME_HIT = 0.07;
/** Snap duration at a section boundary (s). */
const SNAP = 0.5;

/**
 * Turns the analysis into timed Dynamics events for one transient channel:
 * predicted beats are scheduled ahead at their exact time (weighted by the
 * grid's weight), attacks take the fast path (now, or when heard), except
 * when they are a beat already scheduled; section changes snap. All times
 * are on the capture clock, which is the Dynamics clock. Pure logic.
 */
export class CueScheduler {
  private lastBeat = -Infinity;
  private readonly recentBeats = new Float64Array(4);
  private recent = 0;

  constructor(
    private readonly dynamics: Dynamics,
    private readonly channel: number,
    /** Only attacks in the low region (kicks) take the fast path; hats would make it flicker. */
    private readonly lowOnly = true,
  ) {}

  update(input: CueInput, gridWeight: number, onsets: ArrayLike<OnsetCue>, onsetCount: number, sections: ArrayLike<SectionCue>, sectionCount: number): void {
    const { dynamics, channel } = this;
    // The next predicted beat, once.
    if (input.nextBeatTime > 0 && input.beatBpm > 0 && gridWeight > 0.02) {
      const period = 60 / input.beatBpm;
      if (input.nextBeatTime > this.lastBeat + period / 2) {
        this.lastBeat = input.nextBeatTime;
        this.recentBeats[this.recent++ % this.recentBeats.length] = input.nextBeatTime;
        dynamics.impulse(channel, gridWeight, input.nextBeatTime);
      }
    }
    // Attacks off the grid (or with a weak grid): the fast path.
    for (let i = 0; i < onsetCount; i++) {
      const onset = onsets[i];
      if (this.lowOnly && onset.region !== 0) continue;
      if (gridWeight > 0.5 && this.nearBeat(onset.time)) continue;
      dynamics.impulse(channel, onset.strength * (1 - 0.5 * gridWeight), onset.time);
    }
    for (let i = 0; i < sectionCount; i++) dynamics.snap(sections[i].time, SNAP);
  }

  reset(): void {
    this.lastBeat = -Infinity;
    this.recentBeats.fill(0);
    this.recent = 0;
  }

  private nearBeat(time: number): boolean {
    for (let i = 0; i < this.recentBeats.length; i++) if (Math.abs(time - this.recentBeats[i]) < SAME_HIT) return true;
    return false;
  }
}
