import { INTENT, type ExperienceSnapshot, type VisualIntent } from '../experience/types';
import type { MusicState, VisualResponseFrame } from '../types/audio';
import { clamp01, experienceById, moodAmount, moodById, NEUTRAL } from './profiles';
import type { Character, DirectionSettings, Feature, Mapping, ModulationKey, ModulationState, SceneDirection } from './types';
import { Dynamics } from '../dynamics/Dynamics';
import type { DynamicsType } from '../dynamics/presets';

/**
 * Every parameter except `impact` (the rig's timed pulse) lives on the
 * Dynamics layer; the Director sets targets and picks the type, never the
 * coefficients. Slow, symmetric motion is a spring; parameters that track
 * the music's level are followers, whose type follows the mood and
 * experience: [normal, slow (fluid), fast (reactive)].
 */
const DYNAMIC_TYPES: Partial<Record<ModulationKey, readonly [DynamicsType, DynamicsType, DynamicsType]>> = {
  expansion: ['glide', 'glide', 'glide'],
  rotation: ['glide', 'glide', 'glide'],
  cameraMotion: ['drift', 'drift', 'drift'],
  depth: ['drift', 'drift', 'drift'],
  persistence: ['drift', 'drift', 'drift'],
  contrast: ['drift', 'drift', 'drift'],
  scale: ['level', 'swell', 'sparkle'],
  distortion: ['level', 'swell', 'sparkle'],
  turbulence: ['level', 'swell', 'sparkle'],
  particleEmission: ['sparkle', 'level', 'sparkle'],
  brightness: ['level', 'swell', 'level'],
  bloom: ['swell', 'swell', 'level'],
  visibility: ['level', 'swell', 'sparkle'],
};
const NORMAL = 0;
const SLOW = 1;
const FAST = 2;
/** Speed tiers from fluidity × experience attack, with hysteresis (enter, leave). */
const SLOW_ABOVE = [1.7, 1.5] as const;
const FAST_BELOW = [0.55, 0.65] as const;

/** Timed inputs from the host: the heard audio clock and the transient pulse from the Dynamics rig. */
export interface DirectorClock {
  releaseLight?: number;
  /** Audio time (s) heard when this frame is seen. */
  time: number;
  /** Instant-attack pulse on predicted beats and kicks (0..1). */
  impact: number;
  /** Audio time of a section boundary to snap at, or -1. */
  snapAt?: number;
}

/** How long a section snap holds critical damping (s). */
const SNAP_SECONDS = 0.5;

const DEFAULT_ROUTES: readonly Mapping[] = [
  { source: 'low', target: 'scale', amount: 0.65 }, { source: 'pulse', target: 'scale', amount: 0.2 },
  { source: 'openness', target: 'expansion', amount: 0.55 }, { source: 'release', target: 'expansion', amount: 0.45 },
  { source: 'mid', target: 'distortion', amount: 0.65 }, { source: 'tension', target: 'distortion', amount: 0.25 },
  { source: 'flux', target: 'turbulence', amount: 0.6 }, { source: 'high', target: 'turbulence', amount: 0.25 },
  { source: 'mid', target: 'rotation', amount: 0.45 }, { source: 'flux', target: 'rotation', amount: 0.4 },
  { source: 'openness', target: 'cameraMotion', amount: 0.3 }, { source: 'mid', target: 'cameraMotion', amount: 0.4 },
  { source: 'high', target: 'particleEmission', amount: 0.65 }, { source: 'transient', target: 'particleEmission', amount: 0.25 },
  { source: 'brightness', target: 'brightness', amount: 0.3 }, { source: 'intensity', target: 'brightness', amount: 0.6 },
  { source: 'intensity', target: 'bloom', amount: 0.45 }, { source: 'release', target: 'bloom', amount: 0.25 },
  { source: 'transient', target: 'impact', amount: 0.8 }, { source: 'release', target: 'impact', amount: 0.2 },
  { source: 'openness', target: 'depth', amount: 0.5 }, { source: 'warmth', target: 'depth', amount: 0.3 },
];
const KEYS: readonly ModulationKey[] = ['scale', 'expansion', 'distortion', 'turbulence', 'rotation', 'cameraMotion', 'particleEmission', 'brightness', 'bloom', 'impact', 'persistence', 'depth', 'contrast', 'visibility'];
const CHARACTER_KEYS = Object.keys(NEUTRAL) as (keyof Character)[];
const TIMES: Record<ModulationKey, readonly [number, number]> = {
  scale: [0.04, 0.4], expansion: [0.5, 1.5], distortion: [0.07, 0.4], turbulence: [0.04, 0.35],
  rotation: [0.4, 1.5], cameraMotion: [1.8, 3], particleEmission: [0.015, 0.25], brightness: [0.12, 0.6],
  bloom: [0.3, 1], impact: [0.006, 0.18], persistence: [1, 2], depth: [3, 5], contrast: [1, 2], visibility: [0.03, 0.3],
};
const MODIFIER: Partial<Record<ModulationKey, keyof Character>> = {
  expansion: 'expansion', distortion: 'distortion', turbulence: 'turbulence', rotation: 'motion',
  cameraMotion: 'camera', particleEmission: 'particles', brightness: 'brightness', bloom: 'bloom', depth: 'depth',
};
const fresh = (): ModulationState => ({ scale: 0, expansion: 0, distortion: 0, turbulence: 0, rotation: 0, cameraMotion: 0, particleEmission: 0, brightness: 0, bloom: 0, impact: 0, persistence: 0, depth: 0, contrast: 0, visibility: 0 });

export function approach(value: number, target: number, dt: number, attack: number, release: number): number {
  const tau = target > value ? attack : release;
  return value + (target - value) * (1 - Math.exp(-Math.max(0, dt) / Math.max(tau, 0.001)));
}

/** One per mounted scene, including during crossfade. No FFT, allocation or UI state in update. */
export class VisualDirector {
  readonly frame = fresh();
  /** Compatibility adapter: directed roles for existing graphical implementations. */
  response: VisualResponseFrame | null = null;
  private readonly target = fresh();
  private readonly character: Character = { ...NEUTRAL };
  private readonly features: Record<Feature, number> = { low: 0, mid: 0, high: 0, transient: 0, pulse: 0, brightness: 0, flux: 0, intensity: 0, openness: 0, tension: 0, release: 0, warmth: 0 };
  private readonly routes: readonly Mapping[];
  private minimal = 0;
  private attack = 1;
  private release = 1;
  /** Springs of the migrated parameters, on the audio clock. */
  readonly dynamics = new Dynamics();
  private readonly channels: Partial<Record<ModulationKey, number>> = {};
  /** How much this scene and mood take transients (scales the rig's hits; 1 without a clock). */
  impactScale = 1;
  /** Current speed tier of the followers (NORMAL, SLOW, FAST). */
  private tier = NORMAL;

  constructor(private readonly direction: SceneDirection = { capabilities: {} }) {
    const custom = direction.mappings ?? [];
    this.routes = [...DEFAULT_ROUTES.filter((r) => !custom.some((c) => c.target === r.target)), ...custom];
    for (const key of KEYS) {
      const types = DYNAMIC_TYPES[key];
      if (types) this.channels[key] = this.dynamics.channel(key, types[NORMAL]);
    }
  }

  /**
   * With a `clock`, the migrated parameters move as springs on the audio
   * clock and `impact` is the rig's timed pulse; without one (hosts with no
   * clock, tests) every parameter follows its envelope as before.
   */
  update(music: MusicState, settings: DirectionSettings, dt: number, clock?: DirectorClock, experienceState?: ExperienceSnapshot): ModulationState {
    if (experienceState) this.frame.experienceState = experienceState;
    else delete this.frame.experienceState;
    const mood = moodById(settings.mood).character;
    const experience = experienceById(settings.experience);
    const c = this.character;
    for (const key of CHARACTER_KEYS) {
      c[key] = approach(c[key], moodAmount(mood[key], settings.moodIntensity) * experience.character[key], dt, 2, 2);
    }
    this.minimal = approach(this.minimal, experience.minimal, dt, 1, 1);
    this.attack = approach(this.attack, experience.attack, dt, 2, 2);
    this.release = approach(this.release, experience.release, dt, 2, 2);
    const f = this.features;
    f.low = clamp01(music.weight * c.low);
    f.mid = clamp01(music.flow * c.mid);
    f.high = clamp01(music.detail * c.high);
    f.transient = music.transient;
    // A free-running musical clock cannot manufacture a pulse without reliable rhythm.
    f.pulse = (0.5 + 0.5 * Math.cos(music.beatPhase * Math.PI * 2)) * music.rhythmicConfidence * music.audible;
    f.brightness = music.brightness;
    f.flux = music.motion;
    f.intensity = Math.max(music.intensity, music.shortEnergy * 0.6) * music.presence;
    f.openness = music.openness;
    f.tension = clamp01(music.tension * c.structure);
    f.release = clamp01(music.music.drop * c.structure);
    f.warmth = music.warmth;
    if (experienceState) {
      const s = experienceState.state, p = experienceState.plan;
      f.intensity = s.energy;
      f.openness = s.openness + s.release * 0.3;
      f.tension = s.tension * c.structure;
      f.flux = s.motion * (0.3 + p.desiredEntropy * 0.7);
      f.release = Math.min(s.release, clock?.releaseLight ?? 0);
      f.brightness = experienceState.acoustic.perceivedBrightness;
      f.warmth = experienceState.acoustic.lowWeight;
      f.pulse = weight(experienceState.intents[INTENT.pulse]) * s.confidence;
    }
    const t = this.target;
    for (const key of KEYS) t[key] = 0;
    for (const route of this.routes) t[route.target] += f[route.source] * route.amount;
    t.persistence = clamp01(0.35 * c.persistence + music.trace * 0.2);
    t.contrast = clamp01(c.contrast * 0.45);
    t.visibility = (experienceState ? experienceState.acoustic.presence : music.audible) * (1 - this.minimal + this.minimal * clamp01(music.shortEnergy * 1.8));
    if (clock) {
      this.chooseTypes();
      if (clock.snapAt !== undefined && clock.snapAt >= 0) this.dynamics.snap(clock.snapAt, SNAP_SECONDS);
    }
    if (experienceState) {
      // Intents are weighed by their confidence: a doubtful forecast moves the picture less.
      const intent = experienceState.intents;
      const plan = experienceState.plan;
      const suspend = weight(intent[INTENT.suspend]);
      const pace = 1 + 0.3 * (weight(intent[INTENT.accelerate]) - weight(intent[INTENT.decelerate]));
      t.expansion += weight(intent[INTENT.expand]) * 0.25 - weight(intent[INTENT.contract]) * 0.2;
      t.rotation = (t.rotation + weight(intent[INTENT.rotate]) * 0.2) * pace;
      t.depth += weight(intent[INTENT.reveal]) * 0.15;
      t.distortion *= 0.4 + plan.desiredEntropy * 0.6;
      t.turbulence *= 0.3 + plan.desiredEntropy * 0.7;
      t.particleEmission *= 0.35 + plan.desiredEntropy * 0.65;
      t.brightness *= plan.maxIntensity;
      t.bloom *= plan.maxIntensity * (1 - suspend * 0.65);
      t.cameraMotion *= (1 - suspend) * pace;
    }
    const caps = this.direction.capabilities;
    for (const key of KEYS) {
      const modifier = MODIFIER[key];
      if (modifier) t[key] *= c[modifier];
      if ((key === 'cameraMotion' && !caps.cameraMotion) || (key === 'particleEmission' && !caps.particles) ||
          (key === 'depth' && !caps.depth) || (key === 'rotation' && !caps.rotation) || (key === 'distortion' && !caps.distortion)) t[key] = 0;
      const channel = this.channels[key];
      if (clock && channel !== undefined) {
        this.dynamics.setTarget(channel, clamp01(t[key]), clock.time);
        continue;
      }
      if (clock && key === 'impact') {
        // Timed pulse (instant attack on the beat), scaled by how much this scene and mood take transients.
        this.impactScale = Math.min(1, t.impact / 0.8 + 0.5);
        this.frame.impact = clamp01(clock.impact * this.impactScale);
        continue;
      }
      const [a, r] = TIMES[key];
      // The impact envelope keeps a fast edge even with fluid geometry.
      const fluidity = key === 'impact' ? 1 : c.fluidity;
      this.frame[key] = approach(this.frame[key], clamp01(t[key]), dt, a * this.attack * fluidity, r * this.release * c.persistence);
    }
    if (clock) {
      this.dynamics.advance(clock.time);
      for (const key of KEYS) {
        const channel = this.channels[key];
        if (channel !== undefined) this.frame[key] = clamp01(this.dynamics.value(channel));
      }
    }
    if (experienceState) {
      // Momentum is a geometric displacement; it never bypasses the shared brightness guard.
      this.frame.expansion = clamp01(this.frame.expansion + experienceState.physics.displacement * 0.22);
      this.frame.scale = clamp01(this.frame.scale + Math.abs(experienceState.physics.displacement) * 0.12);
    }
    this.adapt(music, experienceState, clock?.releaseLight ?? 0);
    return this.frame;
  }

  /** The Director picks the followers' types from how fluid the mood and experience are. */
  private chooseTypes(): void {
    const speed = this.character.fluidity * this.attack;
    const tier = this.tier;
    let next = tier;
    if (tier === SLOW) next = speed < SLOW_ABOVE[1] ? NORMAL : SLOW;
    else if (tier === FAST) next = speed > FAST_BELOW[1] ? NORMAL : FAST;
    if (next === NORMAL) next = speed > SLOW_ABOVE[0] ? SLOW : speed < FAST_BELOW[0] ? FAST : NORMAL;
    if (next === tier) return;
    this.tier = next;
    for (const key of KEYS) {
      const types = DYNAMIC_TYPES[key];
      const channel = this.channels[key];
      if (types && channel !== undefined) this.dynamics.setType(channel, types[next]);
    }
  }

  private adapt(music: MusicState, experience?: ExperienceSnapshot, releaseLight = 0): void {
    // Only the initial mount allocates; nested musical context is copied to avoid mutating the interpreter.
    if (!this.response) this.response = { ...music, music: { ...music.music } };
    const out = this.response;
    const context = out.music;
    Object.assign(out, music);
    out.music = context;
    Object.assign(context, music.music);
    const m = this.frame, c = this.character;
    out.weight = clamp01(music.weight * c.low);
    out.flow = clamp01(music.flow * c.mid);
    out.detail = clamp01(music.detail * c.high);
    out.motion = clamp01(music.motion * c.motion);
    out.openness = m.expansion;
    out.tension = clamp01(music.tension * c.structure);
    out.impact = m.impact;
    out.density = clamp01(music.density * (0.5 + m.brightness));
    out.trace = clamp01(music.trace * c.persistence);
    const gate = 1 - this.minimal + this.minimal * m.visibility;
    const light = (0.35 + 0.65 * c.brightness) * gate;
    out.lowAudible = clamp01(music.lowAudible * light);
    out.midAudible = clamp01(music.midAudible * light);
    out.highAudible = clamp01(music.highAudible * light);
    out.audible = Math.max(out.lowAudible, out.midAudible, out.highAudible);
    context.drop = clamp01((experience ? Math.min(experience.state.release, releaseLight) : music.music.drop) * c.structure);
    if (experience) {
      const s = experience.state;
      out.motion = clamp01(s.motion * c.motion + Math.abs(experience.physics.velocity) * 0.025);
      out.tension = s.tension;
      out.density = s.density;
      // Opposite-phase stereo can cancel the graphical mono waveform, not auditory presence.
      const a = experience.acoustic;
      const audible = a.silent ? 0 : a.presence;
      out.weight = bandLevel(a.bandDb, 0, 2) * audible * c.low;
      out.flow = bandLevel(a.bandDb, 2, 4) * audible * c.mid;
      out.detail = bandLevel(a.bandDb, 4, 8) * audible * c.high;
      out.lowAudible = audible * clamp01(out.weight * 3) * light;
      out.midAudible = audible * clamp01(out.flow * 3) * light;
      out.highAudible = audible * clamp01(out.detail * 3) * light;
      out.audible = Math.max(out.lowAudible, out.midAudible, out.highAudible);
      context.build = s.anticipation;
      context.intensity = s.energy;
      context.energyTrend = s.energyTrend;
    }

  }
}

function bandLevel(bands: Float64Array, from: number, to: number): number {
  let power = 0;
  for (let b = from; b < to; b++) power += 10 ** (bands[b] / 10);
  return clamp01((10 * Math.log10(Math.max(1e-12, power)) + 65) / 55);
}

/** An intent's effective weight: strength attenuated by its confidence. */
function weight(intent: VisualIntent): number {
  return intent.strength * intent.confidence;
}
