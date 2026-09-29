import { SHAPE_SIZE } from '../analysis/VoiceTracker';
import type { AudioFrame, MusicContextFrame, VisualResponseFrame, VoiceFrame } from '../../types/audio';
import { Envelope } from './Envelope';
import { hzToPosition, sampleSpectrumRange } from './spectrum';

/** Detected-tempo confidence mapped to lock between these. */
const LOCK_FROM = 0.35;
const LOCK_TO = 0.8;
/** Lock rises over ~1.5 s of a steady groove and lets go over ~3 s. */
const LOCK = [1.5, 3] as const;
/** Time constant (s) of the tempo glide (tempo changes never jump). */
const TEMPO_GLIDE = 2;
/** Time constant (s) of the phase correction that aligns the beat clock to detected beats. */
const PHASE_PULL = 0.5;
/** Free tempo range (no trusted beat): from calm to busy music. */
const FREE_TEMPO_MIN = 80;
const FREE_TEMPO_MAX = 135;
const PACE_MIN = 0.6;
const PACE_MAX = 1.5;

/** Section loudness follower, and how fast the song's loud/quiet references drift (per second, 0..1 units). */
const SECTION = [2, 4] as const;
const REFERENCE_DRIFT = 0.004;
/** Smallest loud–quiet distance (0.2 = 12 dB), so ordinary dynamics don't swing the intensity end to end. */
const MIN_SECTION_RANGE = 0.2;
/** Build: medium vs slow intensity followers. */
const BUILD_FAST = 1.5;
const BUILD_SLOW = 6;
const BUILD_ENVELOPE = [2, 1] as const;
const DROP_DECAY = 1.2;
const DROP_MIN_INTERVAL = 8;
/** Seconds of a new song before builds and drops are detected (its references are still settling). */
const SECTION_WARMUP = 6;
/** Seconds after a drop during which no build is reported. */
const BUILD_AFTER_DROP = 6;
/** Sub-bass (kick and bass fundamentals): builds usually strip it, drops bring it back. */
const SUB_END = hzToPosition(120);
const SUB_RETURN = 0.2;
/** Seconds of sound before a new song's loud/quiet references are set. */
const REFERENCE_DELAY = 2;

/** Percussion: transient edges counted over this window (s); 4 hits/s reads 1. */
const PERCUSSION_WINDOW = 3;
const PERCUSSION_FULL_RATE = 4;
const TRANSIENT_EDGE = 0.5;

const CHARACTER = [2, 2] as const;
/** Silence that separates two songs (s). */
const SONG_GAP = 1.2;
/** Seconds of sound over which a song's character is learned; then its variation is fixed. */
const LEARN_SECONDS = 12;
const VARIATION_GLIDE = 1.5;
export const VARIATIONS = 8;
/** Memory of the learned style (s). */
const STYLE_TAU = 20;
/** A voice this clear (× presence) is drawn as it is; below, the style shows through. */
const VOICE_SHOWN_FROM = 0.45;
const VOICE_SHOWN_TO = 0.85;
/** Glide of the drawn lines and of the pitch (s). */
const LINE_TAU = 0.1;
const PITCH_TAU = 0.08;

/** Fingerprint features: tempo, low share, high share, brightness, tonality, percussion. */
const FEATURES = 6;
/**
 * Fixed pseudo-random weights: each variation is a different smooth mix of the
 * features, so songs differ along several independent directions. Moderate
 * magnitudes keep small measurement differences from changing the look much.
 */
const WEIGHTS = Array.from({ length: VARIATIONS }, (_, i) =>
  Array.from({ length: FEATURES }, (_, j) => Math.sin((i + 1) * 12.9898 + (j + 1) * 78.233) * 1.6),
);
const OFFSETS = Array.from({ length: VARIATIONS }, (_, i) => (Math.sin((i + 1) * 43.758) + 1) / 2);

/**
 * Slow musical context derived from AudioFrame + the fast roles: a tempo
 * clock, section intensity, build-ups and drops, per-region percussion,
 * brightness, tonality and a per-song variation fingerprint. Allocation-free
 * per frame.
 */
export class MusicContext {
  readonly frame: MusicContextFrame = {
    tempo: 110,
    tempoLock: 0,
    beats: 0,
    pace: 1,
    intensity: 0.5,
    build: 0,
    drop: 0,
    lowPercussion: 0,
    midPercussion: 0,
    highPercussion: 0,
    brightness: 0.5,
    tonality: 0.5,
    song: 0,
    songLock: 0,
    variation: new Float32Array(VARIATIONS).fill(0.5),
    bassLine: sineCycle(),
    leadLine: sineCycle(),
    bassPitch: 55,
    leadPitch: 330,
    bassVoice: 0,
    leadVoice: 0,
    bassStyle: sineCycle(),
    leadStyle: sineCycle(),
    styleTonality: 0.5,
    stylePercussion: 0.3,
  };

  private readonly lock = new Envelope(...LOCK);
  private detectedTempo = 120;
  private readonly section = new Envelope(...SECTION);
  private loud = 0;
  private quiet = 0;
  private hasReference = false;
  private referenceDelay = 0;
  private warmupLoudness = 0;
  private readonly buildFast = new Envelope(BUILD_FAST, BUILD_FAST);
  private readonly buildSlow = new Envelope(BUILD_SLOW, BUILD_SLOW);
  private readonly buildEnvelope = new Envelope(...BUILD_ENVELOPE);
  private readonly brightFast = new Envelope(BUILD_FAST, BUILD_FAST);
  private readonly subFast = new Envelope(0.3, 0.3);
  private readonly subSlow = new Envelope(4, 4);
  private readonly brightSlow = new Envelope(BUILD_SLOW, BUILD_SLOW);
  private recentLow = 1;
  private recentBuild = 0;
  private sinceDrop = DROP_MIN_INTERVAL;
  private lastImpact = 0;
  private readonly flux = new Float32Array(3);
  private readonly hits = new Float32Array(3);
  private readonly brightness = new Envelope(...CHARACTER);
  private readonly tonality = new Envelope(...CHARACTER);
  private silentFor = 0;
  private learned = 0;
  private readonly sums = new Float32Array(FEATURES);
  private readonly features = new Float32Array(FEATURES);
  private readonly targets = new Float32Array(VARIATIONS).fill(0.5);

  /** `silent`: no sound present (digital silence or only the noise floor). */
  update(audio: AudioFrame, roles: VisualResponseFrame, dt: number, silent = audio.silent): MusicContextFrame {
    const out = this.frame;
    this.trackSong(silent, dt);
    if (!silent) {
      const bright = centroid(audio.spectrum);
      this.updateSections(audio.loudness, bright, sampleSpectrumRange(audio.spectrum, 0, SUB_END), roles.impact, dt);
      this.updatePercussion(audio, roles, dt);
      out.brightness = this.brightness.update(bright, dt);
      out.tonality = this.tonality.update(1 - audio.flatness, dt);
    }
    this.updateTempo(audio, silent, dt);
    if (!silent) this.learn(roles, dt);
    out.bassVoice = this.updateVoice(audio.bassVoice, presenceOf(roles.lowShare), out.bassLine, out.bassStyle, dt, true);
    out.leadVoice = this.updateVoice(audio.leadVoice, presenceOf(roles.midShare), out.leadLine, out.leadStyle, dt, false);
    if (!silent) {
      const style = 1 - Math.exp(-dt / STYLE_TAU);
      out.styleTonality += (out.tonality - out.styleTonality) * style;
      const percussion = Math.max(out.lowPercussion, out.midPercussion, out.highPercussion);
      out.stylePercussion += (percussion - out.stylePercussion) * style;
    }
    const glide = 1 - Math.exp(-dt / VARIATION_GLIDE);
    for (let i = 0; i < VARIATIONS; i++) out.variation[i] += (this.targets[i] - out.variation[i]) * glide;
    return out;
  }

  /**
   * A voice's drawn line: its current cycle when it is clear and its region
   * present, else the style; the style itself learns the shapes it hears,
   * weighted by how clear they are. Returns the voice's strength (0..1).
   */
  private updateVoice(voice: VoiceFrame, presence: number, line: Float32Array, style: Float32Array, dt: number, bass: boolean): number {
    const out = this.frame;
    const strength = voice.pitch > 0 ? voice.clarity * presence : 0;
    if (strength > 0) {
      const learn = (1 - Math.exp(-dt / STYLE_TAU)) * strength;
      for (let i = 0; i < SHAPE_SIZE; i++) style[i] += (voice.shape[i] - style[i]) * learn;
      const glide = 1 - Math.exp(-dt / PITCH_TAU);
      // Glide in octaves, so jumps between notes take the same time up or down.
      if (bass) out.bassPitch *= 2 ** (Math.log2(voice.pitch / out.bassPitch) * glide);
      else out.leadPitch *= 2 ** (Math.log2(voice.pitch / out.leadPitch) * glide);
    }
    const shown = smoothstep(VOICE_SHOWN_FROM, VOICE_SHOWN_TO, strength);
    const follow = 1 - Math.exp(-dt / LINE_TAU);
    for (let i = 0; i < SHAPE_SIZE; i++) {
      const target = style[i] + (voice.shape[i] - style[i]) * shown;
      line[i] += (target - line[i]) * follow;
    }
    return strength;
  }

  /** A new song: forget the song-level references and learn its character again. */
  reset(): void {
    const out = this.frame;
    out.song++;
    out.songLock = 0;
    out.build = 0;
    out.drop = 0;
    this.hasReference = false;
    this.referenceDelay = 0;
    this.warmupLoudness = 0;
    this.learned = 0;
    this.sums.fill(0);
    this.recentLow = 1;
    this.recentBuild = 0;
    this.sinceDrop = DROP_MIN_INTERVAL;
  }

  private trackSong(silent: boolean, dt: number): void {
    if (silent) {
      this.silentFor += dt;
      return;
    }
    if (this.silentFor >= SONG_GAP) this.reset();
    this.silentFor = 0;
  }

  /**
   * The motion follows the detected tempo when it is trusted, else a free
   * tempo from the music's activity; either way it glides. The beat clock
   * advances at that tempo and, when locked, is pulled towards the detected
   * beat phase (gently, so it never runs backwards).
   */
  private updateTempo(audio: AudioFrame, silent: boolean, dt: number): void {
    const out = this.frame;
    if (audio.bpm > 0) this.detectedTempo = audio.bpm;
    out.tempoLock = this.lock.update(silent ? 0 : smoothstep(LOCK_FROM, LOCK_TO, audio.tempoConfidence), dt);
    const activity = Math.min(1, 0.6 * out.intensity + 0.4 * Math.max(out.lowPercussion, out.midPercussion, out.highPercussion));
    const free = FREE_TEMPO_MIN + (FREE_TEMPO_MAX - FREE_TEMPO_MIN) * activity;
    const target = free + (this.detectedTempo - free) * out.tempoLock;
    out.tempo += (target - out.tempo) * (1 - Math.exp(-dt / TEMPO_GLIDE));
    out.pace = clamp(out.tempo / 120, PACE_MIN, PACE_MAX);

    out.beats += (dt * out.tempo) / 60;
    if (audio.bpm > 0 && out.tempoLock > 0) {
      let error = audio.beatPhase - (out.beats - Math.floor(out.beats));
      if (error > 0.5) error -= 1;
      else if (error < -0.5) error += 1;
      out.beats += error * (1 - Math.exp(-dt / PHASE_PULL)) * out.tempoLock;
    }
  }

  /**
   * Intensity: the section's loudness between the song's quiet and loud
   * references, which drift slowly so they describe the song, not the moment.
   * Build: intensity rising for seconds. Drop: the sub-bass coming back with
   * a hit, on a loud section right after a quiet or rising one.
   */
  private updateSections(loudness: number, brightness: number, sub: number, impact: number, dt: number): void {
    const out = this.frame;
    if (!this.hasReference) {
      // A new song reads mid-intensity for its first seconds; then the references are set around its mean level.
      this.referenceDelay += dt;
      this.warmupLoudness += loudness * dt;
      if (this.referenceDelay < REFERENCE_DELAY) {
        out.intensity = 0.5;
        return;
      }
      const mean = this.warmupLoudness / this.referenceDelay;
      this.section.reset(mean);
      this.loud = mean + MIN_SECTION_RANGE / 2;
      this.quiet = mean - MIN_SECTION_RANGE / 2;
      this.buildFast.reset(0.5);
      this.buildSlow.reset(0.5);
      this.brightFast.reset(brightness);
      this.brightSlow.reset(brightness);
      this.subFast.reset(sub);
      this.subSlow.reset(sub);
      this.hasReference = true;
    }
    const level = this.section.update(loudness, dt);
    this.loud = Math.max(level, this.loud - REFERENCE_DRIFT * dt);
    this.quiet = Math.min(level, this.quiet + REFERENCE_DRIFT * dt);
    const range = Math.max(this.loud - this.quiet, MIN_SECTION_RANGE);
    out.intensity = clamp((level - this.quiet) / range, 0, 1);

    // A build rises over seconds (louder, often brighter) and stays below the top: a drop is a
    // step to the top, not a build.
    const louder = this.buildFast.update(out.intensity, dt) - this.buildSlow.update(out.intensity, dt);
    const brighter = this.brightFast.update(brightness, dt) - this.brightSlow.update(brightness, dt);
    // No build right after a drop: the new section's rise is the drop itself.
    const settled = this.learned >= SECTION_WARMUP && this.sinceDrop > BUILD_AFTER_DROP;
    const rising = smoothstep(0.03, 0.12, Math.max(louder, brighter * 0.8)) * (1 - smoothstep(0.85, 1, out.intensity));
    out.build = this.buildEnvelope.update(settled ? rising : 0, dt);

    // Memory of the last seconds: how low the intensity went, how much it was building.
    this.recentLow = Math.min(out.intensity, this.recentLow + dt * 0.15);
    this.recentBuild = Math.max(out.build, this.recentBuild - dt * 0.08);
    this.sinceDrop += dt;
    const hit = impact > 0.6 && this.lastImpact <= 0.6;
    this.lastImpact = impact;
    const bassReturns = this.subFast.update(sub, dt) - this.subSlow.update(sub, dt) > SUB_RETURN;
    if (this.learned >= SECTION_WARMUP && hit && bassReturns && out.intensity > 0.65 && (this.recentLow < 0.4 || this.recentBuild > 0.35) && this.sinceDrop > DROP_MIN_INTERVAL) {
      out.drop = 1;
      this.sinceDrop = 0;
      out.build = 0;
      this.buildEnvelope.reset(0);
      this.recentLow = 1;
      this.recentBuild = 0;
    } else {
      out.drop *= Math.exp(-dt / DROP_DECAY);
    }
  }

  /** Rising transient edges per region, counted over a few seconds; regions absent from the mix don't count. */
  private updatePercussion(audio: AudioFrame, roles: VisualResponseFrame, dt: number): void {
    const out = this.frame;
    const decay = Math.exp(-dt / PERCUSSION_WINDOW);
    const scale = 1 / (PERCUSSION_WINDOW * PERCUSSION_FULL_RATE);
    out.lowPercussion = this.countHits(0, audio.lowFlux, roles.lowShare, decay) * scale;
    out.midPercussion = this.countHits(1, audio.midFlux, roles.midShare, decay) * scale;
    out.highPercussion = this.countHits(2, audio.highFlux, roles.highShare, decay) * scale;
  }

  /** Leaky count of rising edges of one region's transients. */
  private countHits(region: number, flux: number, share: number, decay: number): number {
    const edge = flux > TRANSIENT_EDGE && this.flux[region] <= TRANSIENT_EDGE && share > 0.05;
    this.flux[region] = flux;
    this.hits[region] = this.hits[region] * decay + (edge ? 1 : 0);
    return Math.min(this.hits[region], PERCUSSION_WINDOW * PERCUSSION_FULL_RATE);
  }

  /**
   * Learns the song's character over its first seconds of sound; the
   * variation targets follow the running means, then freeze.
   */
  private learn(roles: VisualResponseFrame, dt: number): void {
    const out = this.frame;
    if (this.learned >= LEARN_SECONDS) return;
    this.learned = Math.min(this.learned + dt, LEARN_SECONDS);
    out.songLock = this.learned / LEARN_SECONDS;
    const f = this.features;
    // Tempo counts only when trusted; otherwise it sits mid-range.
    f[0] = out.tempoLock > 0.5 ? clamp((this.detectedTempo - 70) / 110, 0, 1) : 0.5;
    f[1] = roles.lowShare;
    f[2] = roles.highShare;
    f[3] = out.brightness;
    f[4] = out.tonality;
    f[5] = (out.lowPercussion + out.midPercussion + out.highPercussion) / 3;
    for (let j = 0; j < FEATURES; j++) this.sums[j] += f[j] * dt;
    for (let i = 0; i < VARIATIONS; i++) {
      let x = OFFSETS[i];
      for (let j = 0; j < FEATURES; j++) x += WEIGHTS[i][j] * (this.sums[j] / this.learned);
      this.targets[i] = 0.5 + 0.5 * Math.sin(2 * Math.PI * x);
    }
  }

}

/** How much a region is in the mix, from its spectrum share (absent below ~5%). */
function presenceOf(share: number): number {
  return smoothstep(0.03, 0.15, share);
}

function sineCycle(): Float32Array {
  const cycle = new Float32Array(SHAPE_SIZE);
  for (let i = 0; i < SHAPE_SIZE; i++) cycle[i] = Math.sin((2 * Math.PI * i) / SHAPE_SIZE);
  return cycle;
}

/** Spectral centroid as a position on the log spectrum (0..1). */
function centroid(spectrum: Float32Array): number {
  let sum = 0;
  let weighted = 0;
  for (let i = 0; i < spectrum.length; i++) {
    sum += spectrum[i];
    weighted += spectrum[i] * (i + 0.5);
  }
  return sum > 1e-4 ? weighted / sum / spectrum.length : 0.5;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}
