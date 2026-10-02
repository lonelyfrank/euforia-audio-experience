import type { Character, ExperienceId, ExperienceMode, MoodId, VisualMood } from './types';

export const NEUTRAL: Readonly<Character> = {
  motion: 1, fluidity: 1, persistence: 1, expansion: 1, distortion: 1,
  turbulence: 1, particles: 1, brightness: 1, bloom: 1, depth: 1,
  camera: 1, contrast: 1, low: 1, mid: 1, high: 1, structure: 1,
};

export const MOODS: readonly VisualMood[] = [
  { id: 'euphoria', name: 'Euphoria', character: { ...NEUTRAL, expansion: 1.7, particles: 1.5, brightness: 1.3, bloom: 1.5, motion: 1.2, high: 1.3, depth: 1.3 } },
  { id: 'dream', name: 'Dream', character: { ...NEUTRAL, motion: 0.4, fluidity: 2, persistence: 1.8, expansion: 1.4, distortion: 0.5, turbulence: 0.3, bloom: 1.3, camera: 0.5, high: 0.6 } },
  { id: 'dark', name: 'Dark', character: { ...NEUTRAL, brightness: 0.5, bloom: 0.6, contrast: 1.8, depth: 1.5, low: 1.4, high: 0.6, motion: 0.65, expansion: 0.7, structure: 1.4 } },
  { id: 'pulse', name: 'Pulse', character: { ...NEUTRAL, low: 1.5, motion: 1.3, fluidity: 0.55, persistence: 0.6, distortion: 1.2, contrast: 1.3 } },
  { id: 'chaos', name: 'Chaos', character: { ...NEUTRAL, motion: 2, fluidity: 0.4, turbulence: 2.5, distortion: 2.3, particles: 1.8, camera: 1.4, high: 1.5, mid: 1.4, persistence: 0.5 } },
  { id: 'ethereal', name: 'Ethereal', character: { ...NEUTRAL, motion: 0.55, fluidity: 2.5, persistence: 2, depth: 1.7, bloom: 1.6, expansion: 1.6, distortion: 0.4, low: 0.7, high: 1.3, contrast: 0.6 } },
  { id: 'melancholy', name: 'Melancholy', character: { ...NEUTRAL, motion: 0.45, fluidity: 1.8, persistence: 1.7, brightness: 0.7, expansion: 0.65, mid: 1.4, high: 0.55, camera: 0.4, structure: 1.5 } },
  { id: 'focus', name: 'Focus', character: { ...NEUTRAL, camera: 0, particles: 0.4, distortion: 0.4, turbulence: 0.3, bloom: 0.5, contrast: 1.2, motion: 0.7 } },
];

export const EXPERIENCES: readonly ExperienceMode[] = [
  { id: 'ambient', name: 'Ambient', attack: 2.5, release: 2, minimal: 0, character: { ...NEUTRAL, motion: 0.35, fluidity: 1.8, persistence: 1.6, turbulence: 0.3, camera: 0.3, particles: 0.65, brightness: 0.8 } },
  { id: 'immersive', name: 'Immersive', attack: 1, release: 1.3, minimal: 0, character: { ...NEUTRAL, depth: 1.8, camera: 1.8, expansion: 1.3, particles: 1.4, bloom: 1.2 } },
  { id: 'reactive', name: 'Reactive', attack: 0.35, release: 0.65, minimal: 0, character: { ...NEUTRAL, fluidity: 0.7, low: 1.2, mid: 1.2, high: 1.3, turbulence: 1.3 } },
  { id: 'cinematic', name: 'Cinematic', attack: 3, release: 2.2, minimal: 0, character: { ...NEUTRAL, motion: 0.5, fluidity: 1.8, depth: 1.6, camera: 1.2, structure: 2, turbulence: 0.35, persistence: 1.5, particles: 0.7 } },
  { id: 'minimal', name: 'Minimal', attack: 0.6, release: 0.7, minimal: 1, character: { ...NEUTRAL, camera: 0, depth: 0.2, particles: 0.2, motion: 0.3, bloom: 0.35, distortion: 1.2, persistence: 0.45, expansion: 0.7 } },
];
const MOOD_LOOKUP = Object.fromEntries(MOODS.map((m) => [m.id, m])) as Record<MoodId, VisualMood>;
const EXPERIENCE_LOOKUP = Object.fromEntries(EXPERIENCES.map((m) => [m.id, m])) as Record<ExperienceId, ExperienceMode>;
export const moodById = (id: MoodId): VisualMood => MOOD_LOOKUP[id] ?? MOODS[7];
export const experienceById = (id: ExperienceId): ExperienceMode => EXPERIENCE_LOOKUP[id] ?? EXPERIENCES[2];
export const DEFAULT_DIRECTION = { mood: 'focus', moodIntensity: 0.65, experience: 'reactive', autoDirection: false } as const;

export function clamp01(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
/** Zero intensity is neutral; neither a new object nor a palette mutation is needed. */
export function moodAmount(value: number, intensity: number): number { return 1 + (value - 1) * clamp01(intensity); }
