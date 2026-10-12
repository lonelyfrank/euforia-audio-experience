import type { AnalysisFrame } from '../audio/features/decode';

/*
 * Adaptive music calibration: how strongly the audio that is actually being
 * captured should move what answers it. It sits between the measures the DSP
 * already exports and their consumers, and measures nothing itself: no PCM, no
 * spectrum, no file, no network.
 *
 *   capture → DSP (Rust) → hop frame ─→ AdaptiveMusicCalibration ─→ CalibrationFrame ─→ consumers
 *                                      (per hop, on the capture clock)   (in the experience snapshot)
 *
 * What the DSP gives is per moment and per recent window: the learned noise
 * floor, online percentiles of the momentary loudness, each band against its
 * own last seconds and above its own floor. What is added here is what a track
 * is as a whole and how far that is known:
 *
 *   short    the level of the moment, the last attack                      (the DSP's, used as they are)
 *   medium   the DSP's percentiles and band histories                      (seconds to a minute)
 *   long     consolidated references that move the more slowly the more    (the identity of the track)
 *            they have been confirmed, and its character
 *
 * It is not the sync calibration (app/calibration): that one measures when a
 * sound is heard, this one how much of a response it deserves. It changes no
 * time, no beat and no value of the DSP or of the world, and produces nothing
 * in silence. Deterministic: the same hop frames give the same output.
 *
 * Normalization is bounded on purpose. A level is placed in the track's own
 * range, but never in less than MIN_RANGE (a compressed master is not stretched
 * into a dynamic one), under a scale that follows the track's character (a calm
 * track stays calmer than a driving one), and a quiet input is raised only as
 * far as it stands above the noise.
 */

export const CALIBRATION_PHASES = ['off', 'waiting', 'stabilizing', 'learning', 'consolidating', 'adapted'] as const;
export type CalibrationPhase = typeof CALIBRATION_PHASES[number];

/**
 * The calibrated response, as every consumer reads it. While little is known every value is the uncalibrated
 * reading it would otherwise be (`confidence` says how far): the engine never waits for the calibration.
 */
export interface CalibrationFrame {
  /** Capture clock (s). */
  time: number;
  phase: CalibrationPhase;
  /** 0..1: how far the references can be trusted (how much sound they rest on, and how good it was). */
  confidence: number;
  /** Seconds of sound heard since the references last started over. */
  observed: number;
  /** 0..1: the level of the moment within the track's own range (0.5: its typical level), under the track's scale. 0 in silence. */
  energy: number;
  /** 0..1: the activity of the lows (< 250 Hz), the mids (250 Hz – 2 kHz) and the highs against their own recent level, under the track's scale. */
  low: number;
  mid: number;
  high: number;
  /** 0..1: how far the last attack stood out of the track's recent attacks; gone in a fraction of a second. */
  transient: number;
  /** Dynamic range of the track as heard so far (LU): P95 − P10 of the momentary loudness, consolidated. */
  range: number;
  /** Suggested gain for a response driven by absolute levels: raises a quiet input, holds back a hot one. Bounded; 1 until something is known. */
  gain: number;
  /** 0..1: how driving the track is by its nature (attacks, percussion, compression), over tens of seconds. Not its tempo. */
  character: number;
  /** The scale the character puts on `energy`, `low`, `mid` and `high` (SCALE_CALM … 1): a calm track tops out lower. */
  scale: number;
  /** 0..1: how well the references still describe what is heard (1: the same track at the same level). */
  stability: number;
  /** Counts the times the references started over or were demoted (another track, a level that no longer fits). */
  epoch: number;
}

export const createCalibration = (): CalibrationFrame => ({
  time: 0, phase: 'waiting', confidence: 0, observed: 0, energy: 0, low: 0, mid: 0, high: 0, transient: 0, range: 0, gain: 1, character: 0, scale: 1, stability: 1, epoch: 0,
});

export function copyCalibration(to: CalibrationFrame, from: Readonly<CalibrationFrame>): void {
  Object.assign(to, from);
}

/** Evidence (seconds of sound, each weighted by its quality) at which stabilizing, learning and consolidating end. */
export const EVIDENCE = { stable: 3, learned: 12, consolidated: 30 } as const;
/** The references follow the DSP's percentiles this fast while nothing is known, and this slowly once the track is (s). */
const TAU_FAST = 1.2;
const TAU_SLOW = 24;
/** The smallest range (LU) a level is placed in. */
export const MIN_RANGE = 10;
/** The momentary loudness (LUFS) at which an input needs no gain, and the bounds of the gain. */
const REFERENCE_LUFS = -16;
export const GAIN_MIN = 0.7;
export const GAIN_MAX = 1.8;
/** A quiet input is raised only as far as its typical level stands above the noise floor: from this many dB, wholly at SNR_FROM + SNR_SPAN. */
const SNR_FROM = 14;
const SNR_SPAN = 18;
/** The most the gain moves in a second. */
const GAIN_SLEW = 0.12;
/** The character is followed over this long once the track is known (s), and the scale it puts on the outputs for the calmest track. */
const CHARACTER_TAU = 18;
export const SCALE_CALM = 0.6;
/** A silence this long (s) and the references have to prove themselves again when sound returns; the same length the experience calls long. */
const LONG_SILENCE = 2;
/** After this much silence (s) what was learned is doubted, and the confidence left to references that are doubted. */
const STALE_AFTER = 20;
const DOUBT = 0.35;
/** Seconds over which the guard after a long silence or a lost capture lifts. */
const REENTRY = 2;
/** LU between the DSP's median and the consolidated one beyond which the references no longer describe the track. */
const DRIFT = 8;
/**
 * Attacks are rated against the track's usual accents: the smallest margin between a typical attack and an accent
 * (absolute, and as a share of the typical one), how many attacks shape the typical one, over how many an accent is
 * forgotten (what comes back every few bars is usual, not an event), and how long a rating lasts (s).
 */
const ATTACK_MARGIN = 0.05;
const ATTACK_SHARE = 0.3;
const ATTACK_MEMORY = 16;
const ACCENT_MEMORY = 64;
const TRANSIENT_TAU = 0.15;
/** The slow statistics are updated every so many hops: they describe tens of seconds. */
const SLOW_EVERY = 8;
/** dB above its floor at which a band counts for its region (the wire gives 30 dB as 1). */
const BAND_GATE = 4;
/** The bands of each region, as the DSP cuts them: sub and bass; low-mid and mid; high-mid to air. */
const REGIONS = [[0, 2], [2, 4], [4, 8]] as const;

const unit = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
const finite = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback);
/** The experience's own energy scale: what an uncalibrated consumer reads. */
const absolute = (lufs: number): number => unit((lufs + 60) / 54);

/** Owns the calibration of one audio session. Advanced per analysis hop by ExperienceEngine; allocation-free. */
export class AdaptiveMusicCalibration {
  readonly frame = createCalibration();
  /** Off, every output is the uncalibrated reading (gain 1, no scale, events rated by their strength): the comparison the tools make. */
  enabled = true;
  /** Consolidated P10, P50 and P95 of the momentary loudness (LUFS), and whether they have been set. */
  private low = 0;
  private typical = 0;
  private high = 0;
  private ready = false;
  private evidence = 0;
  private silentFor = 0;
  /** 0 right after a long silence or a lost capture … 1: how far the references may act again. */
  private guard = 1;
  private shifted = false;
  /** The typical strength of the recent attacks, and that of their accents (the strongest of them, forgotten slowly). */
  private attackMean = 0;
  private attackAccent = 0;
  private attacks = 0;
  private hops = 0;
  private slowDt = 0;
  private readonly bands = new Float64Array(3);

  /** One analysis hop: `dt` seconds on the capture clock. Reads the frame; writes `frame`. */
  update(a: AnalysisFrame, dt: number): void {
    const f = this.frame;
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    f.time = a.time;
    const loudness = a.loudnessMomentary, sounding = !a.silent && a.presence >= 0.06 && Number.isFinite(loudness);
    const presence = sounding ? unit(a.presence) : 0;
    f.transient = f.transient * Math.exp(-dt / TRANSIENT_TAU);
    if (f.transient < 1e-6) f.transient = 0;
    // Each region by its most active band: against its own floor, and against its own last seconds.
    const raw = this.bands;
    for (let r = 0; r < 3; r++) {
      let level = 0, relative = 0;
      for (let b = REGIONS[r][0]; b < REGIONS[r][1]; b++) {
        const above = unit(finite(a.bandLevel[b])), gate = unit(above * 30 / BAND_GATE);
        if (above > level) level = above;
        relative = Math.max(relative, unit(finite(a.bandRel[b])) * gate);
      }
      // The DSP's own history of the band is trusted as far as it has one.
      raw[r] = (level + (relative - level) * (this.enabled ? unit(finite(a.energyConfidence)) : 0)) * presence;
    }
    if (!this.enabled) {
      f.phase = 'off'; f.confidence = 0; f.gain = 1; f.scale = 1; f.stability = 1;
      f.energy = sounding ? absolute(loudness) * presence : 0;
      f.low = raw[0]; f.mid = raw[1]; f.high = raw[2];
      return;
    }
    if (!sounding) {
      // Silence says nothing about the track: the references are held as they are, and nothing is put out.
      this.silentFor += dt;
      f.energy = f.low = f.mid = f.high = 0; f.phase = this.phase();
      return;
    }
    if (this.silentFor >= LONG_SILENCE && this.ready) {
      // Sound after a long silence may be another track at another level: what was learned has to be confirmed
      // before it acts again, and after a very long one it is doubted altogether.
      this.guard = 0;
      if (this.silentFor >= STALE_AFTER) this.doubt();
    }
    this.silentFor = 0;
    this.evidence += dt * presence * (0.4 + 0.6 * unit(finite(a.energyConfidence)));
    f.observed += dt;
    this.guard = Math.min(1, this.guard + dt / REENTRY);
    this.slowDt += dt;
    if (++this.hops % SLOW_EVERY === 0 || !this.ready) this.consolidate(a);

    const confidence = f.confidence = unit(this.evidence / EVIDENCE.consolidated);
    f.phase = this.phase();
    f.scale = 1 + (SCALE_CALM + (1 - SCALE_CALM) * f.character - 1) * confidence;
    // The level of the moment: where the experience's own scale puts it, and, as far as the track is known, where it lies in the track's range.
    const fallback = absolute(loudness), relative = this.ready ? unit(0.5 + (loudness - this.typical) / Math.max(this.high - this.low, MIN_RANGE)) : fallback;
    f.energy = (fallback + (relative - fallback) * confidence) * f.scale * presence;
    f.low = raw[0] * f.scale; f.mid = raw[1] * f.scale; f.high = raw[2] * f.scale;
  }

  /**
   * Rates an attack the experience has just registered (`power`: its strength, 0..1) against the track's own recent
   * ones: 0 for a typical one, 0.5 for one as strong as its usual accents (the kick of every bar), 1 for one as far
   * beyond those as they are beyond the typical. Until a few have been heard, and while the track is still
   * stabilizing, nothing can stand out: an attack is then its own strength, and never more than ordinary. Then learns
   * it, so a second blow like the first is usual.
   */
  rate(power: number): number {
    const strength = unit(finite(power));
    if (!this.enabled) return strength;
    // Rated only once the track itself is being learned: in its first seconds nothing has a measure yet.
    const n = this.attacks, known = unit((n - 2) / 6) * unit((this.evidence - EVIDENCE.stable) / (EVIDENCE.learned - EVIDENCE.stable));
    const margin = Math.max(this.attackAccent - this.attackMean, ATTACK_MARGIN, ATTACK_SHARE * this.attackMean);
    const relative = unit(0.5 * (strength - this.attackMean) / margin), unrated = Math.min(strength, 0.5);
    // After a long silence the old attacks are not the measure of the new ones, and nothing stands out yet.
    const significance = (unrated + (relative - unrated) * known) * this.guard;
    const k = 1 / Math.min(n + 1, ATTACK_MEMORY);
    if (n === 0) this.attackMean = this.attackAccent = strength;
    else {
      this.attackMean += (strength - this.attackMean) * k;
      this.attackAccent = Math.max(strength, this.attackAccent + (this.attackMean - this.attackAccent) / Math.min(n + 1, ACCENT_MEMORY));
    }
    this.attacks = n + 1;
    if (significance > this.frame.transient) this.frame.transient = significance;
    return significance;
  }

  /**
   * The capture lost frames (a stall, a transport gap): the track is the same and so is the device, so the
   * references stay; they only have to prove themselves again before they act.
   */
  interrupt(): void {
    this.guard = 0; this.silentFor = 0;
    this.frame.energy = this.frame.low = this.frame.mid = this.frame.high = this.frame.transient = 0;
  }

  /** A new audio session (another source, another device, the analysis started over): nothing learned holds. */
  reset(): void {
    const epoch = this.frame.epoch + (this.ready ? 1 : 0);
    Object.assign(this.frame, createCalibration());
    this.frame.epoch = epoch;
    if (!this.enabled) this.frame.phase = 'off';
    this.low = this.typical = this.high = 0; this.ready = false; this.evidence = 0; this.silentFor = 0; this.guard = 1; this.shifted = false;
    this.attackMean = this.attackAccent = 0; this.attacks = 0; this.hops = 0; this.slowDt = 0;
  }

  /** Where the learning is, by how much has been heard and how good it was: never by the time that has passed. */
  private phase(): CalibrationPhase {
    const e = this.evidence;
    return !this.ready ? 'waiting' : e < EVIDENCE.stable ? 'stabilizing' : e < EVIDENCE.learned ? 'learning' : e < EVIDENCE.consolidated ? 'consolidating' : 'adapted';
  }

  /** What was learned no longer describes what is heard: it is kept as a first guess and learned again, quickly. */
  private doubt(): void {
    this.evidence = Math.min(this.evidence, DOUBT * EVIDENCE.consolidated);
    this.attacks = Math.min(this.attacks, 4);
    this.frame.epoch++;
  }

  /** The slow statistics: the references towards the DSP's percentiles, the range, the character, the gain. */
  private consolidate(a: AnalysisFrame): void {
    const f = this.frame, dt = this.slowDt, q10 = a.loudnessQuantiles[0], q50 = a.loudnessQuantiles[1], q95 = a.loudnessQuantiles[3];
    this.slowDt = 0;
    if (!Number.isFinite(q10 + q50 + q95) || !(q95 >= q10) || !(dt > 0)) return;
    if (!this.ready) { this.low = q10; this.typical = q50; this.high = q95; this.ready = true; }
    // The DSP's median moves within seconds: far from the consolidated one, the track is no longer the one described.
    const drift = Math.abs(q50 - this.typical) / DRIFT, steady = 1 - unit(drift - 0.25);
    f.stability += (steady - f.stability) * (1 - Math.exp(-dt / 2));
    if (drift > 1 && !this.shifted) { this.shifted = true; this.doubt(); } else if (drift < 0.5) this.shifted = false;
    const confidence = unit(this.evidence / EVIDENCE.consolidated);
    const k = 1 - Math.exp(-dt / (TAU_FAST + (TAU_SLOW - TAU_FAST) * confidence * f.stability));
    this.low += (q10 - this.low) * k; this.typical += (q50 - this.typical) * k; this.high += (q95 - this.high) * k;
    f.range = Math.max(0, this.high - this.low);
    // Character: how many attacks, how percussive, how compressed. Nothing of it depends on the level or on the tempo alone.
    const character = unit(0.5 * unit(finite(a.onsetDensity) / 8) + 0.3 * unit(finite(a.percussiveShare)) + 0.2 * unit(1 - f.range / 20));
    f.character += (character - f.character) * (1 - Math.exp(-dt / (CHARACTER_TAU * (0.1 + 0.9 * confidence))));
    // Gain: what brings the typical level of this input to the reference one, within bounds, and no further up than the noise allows.
    const wanted = absolute(REFERENCE_LUFS) / Math.max(absolute(this.typical), 0.2);
    const ceiling = 1 + (GAIN_MAX - 1) * unit((this.typical - finite(a.noiseFloorDb, -70) - SNR_FROM) / SNR_SPAN);
    const target = 1 + (Math.min(ceiling, Math.max(GAIN_MIN, Math.min(GAIN_MAX, wanted))) - 1) * confidence * this.guard;
    const step = GAIN_SLEW * dt;
    f.gain += Math.max(-step, Math.min(step, target - f.gain));
  }
}
