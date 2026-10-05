import type { ExperienceSnapshot } from '../experience/types';
import type { MusicState } from '../types/audio';
import type { DirectionSettings, ExperienceId, MoodId } from './types';
import { DEFAULT_DIRECTION } from './profiles';

/** Evidence must persist 6 s; committed directions dwell at least 20 s. Never switches scenes. */
export class AutoDirection {
  readonly settings: DirectionSettings = { ...DEFAULT_DIRECTION };
  confidence = 0;
  private candidate = '';
  private evidence = 0;
  private age = 0;
  private enabled = false;
  private sourceTime = 0;

  update(music: MusicState, manual: DirectionSettings, dt: number, sourceTime: number, experienceState?: ExperienceSnapshot): DirectionSettings {
    if (!manual.autoDirection || !this.enabled || sourceTime < this.sourceTime) {
      Object.assign(this.settings, manual);
      this.candidate = '';
      this.evidence = this.age = this.confidence = 0;
    }
    this.sourceTime = sourceTime;
    this.enabled = manual.autoDirection;
    this.settings.moodIntensity = manual.moodIntensity;
    if (!manual.autoDirection) return this.settings;
    this.age += dt;
    let mood: MoodId = this.settings.mood;
    let experience: ExperienceId = this.settings.experience;
    let support = 0;
    const percussion = experienceState ? experienceState.acoustic.percussiveShare : Math.max(music.music.lowPercussion, music.music.midPercussion, music.music.highPercussion);
    if ((experienceState?.acoustic.presence ?? music.audible) > 0.5) {
      if (music.rhythmicConfidence > 0.65 && percussion > 0.3 && music.weight > 0.12) {
        mood = 'pulse'; experience = 'reactive'; support = music.rhythmicConfidence;
      } else if (music.motion < 0.16 && percussion < 0.15 && music.rhythmicConfidence < 0.35 && music.music.tonality > 0.5) {
        mood = 'dream'; experience = 'ambient'; support = 0.85;
      } else if ((experienceState?.state.anticipation ?? music.music.build) > 0.45) {
        mood = 'dark'; experience = 'cinematic'; support = 0.75;
      }
    }
    this.confidence += (support - this.confidence) * (1 - Math.exp(-dt / 2));
    // Mood ids uniquely identify these small, deliberately conservative tendencies.
    if (mood !== this.candidate || support < 0.65) { this.candidate = mood; this.evidence = 0; }
    else this.evidence += dt;
    if (this.evidence >= 6 && this.age >= 20 && this.confidence > 0.65) {
      this.settings.mood = mood;
      this.settings.experience = experience;
      this.age = this.evidence = 0;
    }
    return this.settings;
  }
}
