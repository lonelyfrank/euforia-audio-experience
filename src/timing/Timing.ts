import type { ClockSync } from './ClockSync';
import { RhythmGate, type RhythmMode } from './RhythmGate';

/** What the timing needs from the analysis each frame (a subset of the analysis frame and its onsets). */
export interface TimingInput {
  /** Capture clock (s) of the newest analysed sample. */
  time: number;
  /** Predicted capture time (s) of the next beat; 0 while not tracking. */
  nextBeatTime: number;
  beatBpm: number;
  beatConfidence: number;
  /** Position in the bar (0..1) at `time`. */
  barPhase: number;
  presence: number;
}

export interface OnsetInput {
  /** Capture clock (s) of the attack. */
  time: number;
  strength: number;
  region: number;
}

export interface LatencySettings {
  /**
   * Seconds between capture and hearing: the output path after the loopback
   * point (device buffer, DAC, Bluetooth). From calibration or the user.
   */
  output: number;
  /** Frames between requestAnimationFrame and the picture on screen (compositor, scan-out). */
  renderFrames: number;
}

/** A beat to show in this frame (it is heard when this frame is seen). */
export interface BeatCue {
  /** Beats shown since the grid engaged. */
  index: number;
  /** 0 = downbeat … 3. */
  barPosition: number;
  downbeat: boolean;
  /** 0..1: the grid's weight: scale grid-locked effects by it. */
  weight: number;
}

/** An attack to show in this frame (fast path: not on the grid). */
export interface ImpactCue {
  strength: number;
  region: number;
  /** Seconds it is shown after it is heard (≥ 0; 0 when the analysis was early enough). */
  late: number;
}

const BEATS_PER_BAR = 4;
const MAX_IMPACTS = 16;

/**
 * Turns the analysis (capture clock) into what to show in the frame being
 * rendered. The picture of a frame appears `renderFrames` frames after
 * requestAnimationFrame and must match what is heard then, which is what was
 * captured `output` seconds earlier. Beats are taken from the predicted grid
 * (so they land on time although the analysis lags), with continuous beat
 * and bar phases at the moment the frame is seen; attacks take a fast path:
 * shown as soon as they are known, or when they will be heard if the output
 * is slow. With a weak grid, beat cues fade out and only atmosphere and
 * attacks remain (RhythmGate). Pure logic: no DOM, no rendering.
 */
export class Timing {
  readonly latency: LatencySettings = { output: 0, renderFrames: 1.5 };
  /** Host time (s) at which this frame will be seen. */
  presentTime = 0;
  /** Capture time (s) heard when this frame is seen. */
  heardTime = 0;
  /** How far the heard moment is ahead of the newest analysis (s): > 0 means beats are predicted, not reported. */
  lead = 0;
  bpm = 0;
  beatPhase = 0;
  barPhase = 0;
  readonly gate = new RhythmGate();
  /** The beat of this frame, if any (reused object). */
  beat: BeatCue | null = null;
  readonly impacts: ImpactCue[] = Array.from({ length: MAX_IMPACTS }, () => ({ strength: 0, region: 0, late: 0 }));
  impactCount = 0;
  /** Smoothed lateness (s) of the attacks shown (fast path). */
  impactLate = 0;

  private readonly beatCue: BeatCue = { index: 0, barPosition: 0, downbeat: false, weight: 0 };
  private lastBeatAt = -Infinity;
  private beatIndex = 0;
  /** Attacks waiting until they are heard: capture time, strength, region. */
  private readonly pending = new Float64Array(MAX_IMPACTS * 3);
  private pendingCount = 0;

  get mode(): RhythmMode {
    return this.gate.mode;
  }

  get gridWeight(): number {
    return this.gate.weight;
  }

  /**
   * `now`: host time (s) of this frame's requestAnimationFrame; `frame`:
   * seconds per frame; `onsets`: attacks reported since the previous frame.
   */
  update(now: number, frame: number, input: TimingInput, onsets: ArrayLike<OnsetInput>, onsetCount: number, clock: ClockSync, dt: number): void {
    this.presentTime = now + this.latency.renderFrames * frame;
    this.beat = null;
    this.impactCount = 0;
    const weight = this.gate.update(input.beatConfidence * Math.min(1, input.presence * 2), dt);
    if (!clock.ready) return;
    const heard = clock.toCapture(this.presentTime - this.latency.output);
    this.heardTime = heard;
    this.lead = heard - input.time;

    this.updateGrid(heard, frame, input, weight);
    this.updateImpacts(heard, frame, onsets, onsetCount);
  }

  reset(): void {
    this.gate.reset();
    this.lastBeatAt = -Infinity;
    this.beatIndex = 0;
    this.pendingCount = 0;
    this.beat = null;
    this.impactCount = 0;
    this.bpm = this.beatPhase = this.barPhase = 0;
  }

  private updateGrid(heard: number, frame: number, input: TimingInput, weight: number): void {
    if (input.nextBeatTime <= 0 || input.beatBpm <= 0) {
      this.bpm = 0;
      return;
    }
    const period = 60 / input.beatBpm;
    this.bpm = input.beatBpm;
    // Beats from the one before the analysis' next beat to the heard moment.
    const previous = input.nextBeatTime - period;
    const steps = Math.floor((heard - previous) / period);
    const beatStart = previous + steps * period;
    this.beatPhase = (heard - beatStart) / period;
    // Bar position: the analysis' current beat, advanced by the beats between it and the heard moment.
    const analysisPosition = Math.floor(input.barPhase * BEATS_PER_BAR) % BEATS_PER_BAR;
    const position = (((analysisPosition + steps) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
    this.barPhase = (position + this.beatPhase) / BEATS_PER_BAR;

    // A beat is shown in the frame seen closest to it: the latest beat at or before heard + half a frame.
    const half = frame / 2;
    const nearest = beatStart + (this.beatPhase * period > period - half ? period : 0);
    const nearestPosition = nearest > beatStart ? (position + 1) % BEATS_PER_BAR : position;
    if (nearest <= heard + half && nearest > this.lastBeatAt + period / 2) {
      this.lastBeatAt = nearest;
      if (weight > 0.02) {
        const cue = this.beatCue;
        cue.index = this.beatIndex++;
        cue.barPosition = nearestPosition;
        cue.downbeat = nearestPosition === 0;
        cue.weight = weight;
        this.beat = cue;
      }
    }
  }

  private updateImpacts(heard: number, frame: number, onsets: ArrayLike<OnsetInput>, count: number): void {
    const p = this.pending;
    for (let i = 0; i < count && this.pendingCount < MAX_IMPACTS; i++) {
      const at = this.pendingCount * 3;
      p[at] = onsets[i].time;
      p[at + 1] = onsets[i].strength;
      p[at + 2] = onsets[i].region;
      this.pendingCount++;
    }
    // Show what is heard by the time this frame is seen; keep the rest for later frames.
    let kept = 0;
    for (let i = 0; i < this.pendingCount; i++) {
      const at = i * 3;
      if (p[at] <= heard + frame / 2) {
        if (this.impactCount < MAX_IMPACTS) {
          const cue = this.impacts[this.impactCount++];
          cue.strength = p[at + 1];
          cue.region = p[at + 2];
          cue.late = Math.max(0, heard - p[at]);
          this.impactLate += (cue.late - this.impactLate) * 0.2;
        }
      } else {
        const to = kept * 3;
        p[to] = p[at];
        p[to + 1] = p[at + 1];
        p[to + 2] = p[at + 2];
        kept++;
      }
    }
    this.pendingCount = kept;
  }
}
