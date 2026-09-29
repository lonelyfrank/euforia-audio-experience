import type { MusicalState, MusicContextFrame } from '../../types/audio';
import { Envelope } from './Envelope';

/** A new reading must hold this long (s) before the state changes… */
const CONFIRM = 0.8;
/** …and a state lasts at least this long (s), except for entering or leaving silence. */
const MIN_DWELL = 2.5;
/** Silence is confirmed faster: the scene should fall asleep with the sound. */
const SILENCE_CONFIRM = 0.3;
/** Intensity trend: medium vs slow followers (s). */
const TREND_FAST = 1.5;
const TREND_SLOW = 4;

/**
 * Coarse state of the music over seconds (silent, calm, rising, active, peak,
 * falling), from presence and the musical context. Every threshold has a
 * separate way in and way out, a reading must persist before it counts and a
 * state lasts a minimum time, so the state never flickers. Allocation-free.
 */
export class MusicalStateTracker {
  state: MusicalState = 'silent';
  /** Seconds spent in the current state. */
  time = 0;
  private candidate: MusicalState = 'silent';
  private candidateFor = 0;
  private readonly fast = new Envelope(TREND_FAST, TREND_FAST);
  private readonly slow = new Envelope(TREND_SLOW, TREND_SLOW);

  constructor() {
    this.reset();
  }

  update(presence: number, music: MusicContextFrame, dt: number): MusicalState {
    this.time += dt;
    const trend = presence > 0.5 ? this.fast.update(music.intensity, dt) - this.slow.update(music.intensity, dt) : 0;
    const reading = this.read(presence, music, trend);
    if (reading === this.state) {
      this.candidateFor = 0;
      return this.state;
    }
    if (reading !== this.candidate) {
      this.candidate = reading;
      this.candidateFor = 0;
    }
    this.candidateFor += dt;
    const silence = reading === 'silent' || this.state === 'silent';
    if (this.candidateFor >= (silence ? SILENCE_CONFIRM : CONFIRM) && (silence || this.time >= MIN_DWELL)) {
      this.state = reading;
      this.time = 0;
      this.candidateFor = 0;
    }
    return this.state;
  }

  reset(): void {
    this.state = this.candidate = 'silent';
    this.time = this.candidateFor = 0;
    this.fast.reset(0.5);
    this.slow.reset(0.5);
  }

  /** What the music looks like right now; each threshold is easier to stay in than to enter. */
  private read(presence: number, music: MusicContextFrame, trend: number): MusicalState {
    const s = this.state;
    if (presence < (s === 'silent' ? 0.5 : 0.1)) return 'silent';
    // A loud section stays a peak even when it brightens; a quiet one is calm even right after a fall.
    if (music.drop > 0.5 || music.intensity > (s === 'peak' ? 0.65 : 0.82)) return 'peak';
    if (music.build > (s === 'rising' ? 0.2 : 0.35)) return 'rising';
    if (music.intensity < (s === 'calm' ? 0.42 : 0.3)) return 'calm';
    if (trend < (s === 'falling' ? -0.03 : -0.08)) return 'falling';
    return 'active';
  }
}
