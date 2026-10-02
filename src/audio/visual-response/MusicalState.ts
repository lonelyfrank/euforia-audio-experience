import type { MusicalState, MusicContextFrame } from '../../types/audio';

/** A new reading must hold this long (s) before the state changes… */
const CONFIRM = 0.8;
/** …and a state lasts at least this long (s), except for entering or leaving silence. */
const MIN_DWELL = 2.5;
/** Silence is confirmed faster: the scene should fall asleep with the sound. */
const SILENCE_CONFIRM = 0.3;

/**
 * Coarse state of the music over seconds (silent, calm, rising, active, peak,
 * falling), from presence and the musical context. Every threshold has a
 * separate way in and way out, a reading must persist before it counts and a
 * state lasts a minimum time, so the state never flickers. Allocation-free.
 */
export class MusicalStateTracker {
  state: MusicalState = 'silent';
  previousState: MusicalState = 'silent';
  confidence = 1;
  /** Seconds spent in the current state. */
  time = 0;
  private candidate: MusicalState = 'silent';
  private candidateFor = 0;

  constructor() {
    this.reset();
  }

  update(presence: number, music: MusicContextFrame, dt: number): MusicalState {
    this.time += dt;
    const trend = presence > 0.5 ? music.energyTrend : 0;
    const reading = this.read(presence, music, trend);
    const support = reading === this.state ? 1 : 0;
    this.confidence += (support - this.confidence) * (1 - Math.exp(-dt / 0.8));
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
      this.previousState = this.state;
      this.state = reading;
      this.confidence = 0.65;
      this.time = 0;
      this.candidateFor = 0;
    }
    return this.state;
  }

  reset(): void {
    this.previousState = this.state = this.candidate = 'silent';
    this.confidence = 1;
    this.time = this.candidateFor = 0;
  }

  /** What the music looks like right now; each threshold is easier to stay in than to enter. */
  private read(presence: number, music: MusicContextFrame, trend: number): MusicalState {
    const s = this.state;
    if (presence < (s === 'silent' ? 0.5 : 0.1)) return 'silent';
    // A loud section stays a peak even when it brightens; a quiet one is calm even right after a fall.
    if (music.drop > 0.5 || music.intensity > (s === 'peak' ? 0.65 : 0.82)) return 'peak';
    if (music.build > (s === 'rising' ? 0.2 : 0.35)) return 'rising';
    if (trend < (s === 'falling' ? -0.06 : -0.16) && music.recentPeak > 0.65) return 'falling';
    // Relative intensity can settle near zero in a long, level groove. Its rhythm is still active.
    const percussion = Math.max(music.lowPercussion, music.midPercussion, music.highPercussion);
    if (music.intensity < (s === 'calm' ? 0.42 : 0.3) && percussion < (s === 'calm' ? 0.3 : 0.25)) return 'calm';
    if (music.tonality > 0.7 && percussion < 0.1) return 'calm';
    return 'active';
  }
}
