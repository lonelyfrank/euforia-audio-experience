import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import { Audibility } from './Audibility';
import { Envelope } from './Envelope';
import { MusicalStateTracker } from './MusicalState';
import { MusicContext } from './MusicContext';
import { mixDb, Presence } from './Presence';
import { hzToPosition, sampleSpectrumRange } from './spectrum';

/*
 * Time constants (s), attack / release. They sit on top of the analyzer's own
 * smoothing (attack 4–24 ms, release 20–240 ms), so they can only make a role
 * slower: LOW and MID get longer releases for weight and fluidity, HIGH stays
 * close to the analyzer, TRANSIENT attacks instantly.
 */
const WEIGHT = [0.04, 0.35] as const;
const FLOW = [0.12, 0.45] as const;
const DETAIL = [0.015, 0.09] as const;
const SHIMMER = [0, 0.07] as const;
const IMPACT = [0, 0.16] as const;
const DENSITY = [0.3, 0.9] as const;
const SHARE = [0.12, 0.2] as const;
/** Meso and macro memories: movement over ~1 s, openness and tension over seconds, impacts' afterimage. */
const MOTION = [0.12, 1.2] as const;
const OPENNESS = [1.5, 4] as const;
const TENSION = [0.6, 2] as const;
const TRACE = [0, 1.1] as const;
/** A spectrum bin counts as covered above this level (openness). */
const COVERED = 0.15;
/** Slow reference the highs are compared to: shimmer = highs rising above it. */
const HIGH_REFERENCE_TAU = 0.18;

/** Region boundaries on the display spectrum (see AudioFrame band ranges). */
const LOW_END = hzToPosition(250);
const MID_END = hzToPosition(2000);

/**
 * Derives a VisualResponseFrame from each AudioFrame: groups the bands into
 * musical roles, weights them by how present each region is in the mix and
 * gives every role its own attack/release; then updates the slow musical
 * context (tempo clock, sections, per-song variation). Allocation-free per frame.
 */
export class VisualResponse {
  private readonly context = new MusicContext();
  private readonly states = new MusicalStateTracker();
  readonly frame: VisualResponseFrame = {
    presence: 0,
    weight: 0,
    flow: 0,
    detail: 0,
    shimmer: 0,
    impact: 0,
    density: 0,
    motion: 0,
    openness: 0,
    tension: 0,
    trace: 0,
    state: 'silent',
    lowShare: 1 / 3,
    midShare: 1 / 3,
    highShare: 1 / 3,
    lowAudible: 0,
    midAudible: 0,
    highAudible: 0,
    audible: 0,
    music: this.context.frame,
  };

  private readonly weight = new Envelope(...WEIGHT);
  private readonly flow = new Envelope(...FLOW);
  private readonly detail = new Envelope(...DETAIL);
  private readonly shimmer = new Envelope(...SHIMMER);
  private readonly impact = new Envelope(...IMPACT);
  private readonly density = new Envelope(...DENSITY);
  private readonly lowShare = new Envelope(...SHARE);
  private readonly midShare = new Envelope(...SHARE);
  private readonly highShare = new Envelope(...SHARE);
  private readonly highReference = new Envelope(HIGH_REFERENCE_TAU, HIGH_REFERENCE_TAU);
  private readonly lowAudible = new Audibility();
  private readonly midAudible = new Audibility();
  private readonly highAudible = new Audibility();
  private readonly presence = new Presence();
  private readonly motion = new Envelope(...MOTION);
  private readonly openness = new Envelope(...OPENNESS);
  private readonly tension = new Envelope(...TENSION);
  private readonly trace = new Envelope(...TRACE);

  constructor() {
    this.reset();
  }

  /** Learned noise floor of the input (dB), for diagnostics. */
  get noiseFloor(): number {
    return this.presence.floor;
  }

  update(audio: AudioFrame, dt: number): VisualResponseFrame {
    const out = this.frame;
    // Sound is there only above the learned noise floor: hiss or hum alone count as silence.
    const presence = this.presence.update(mixDb(audio.lowDb, audio.midDb, audio.highDb), audio.silent, dt);
    out.presence = presence;
    const silent = !this.presence.open;

    // Spectral balance: how much of the (globally normalized) spectrum sits in each region.
    const low = sampleSpectrumRange(audio.spectrum, 0, LOW_END) * LOW_END;
    const mid = sampleSpectrumRange(audio.spectrum, LOW_END, MID_END) * (MID_END - LOW_END);
    const high = sampleSpectrumRange(audio.spectrum, MID_END, 1) * (1 - MID_END);
    const total = low + mid + high;
    if (total > 1e-4) {
      out.lowShare = this.lowShare.update(low / total, dt);
      out.midShare = this.midShare.update(mid / total, dt);
      out.highShare = this.highShare.update(high / total, dt);
    }

    // Band groups; each role is then scaled by its region's presence.
    const lowLevel = audio.bass * 0.75 + audio.lowMid * 0.25;
    const midLevel = audio.lowMid * 0.25 + audio.mid * 0.6 + audio.highMid * 0.15;
    const highLevel = audio.highMid * 0.35 + audio.treble * 0.65;

    out.weight = this.weight.update(silent ? 0 : clamp01(lowLevel * shareGain(out.lowShare)), dt);
    out.flow = this.flow.update(silent ? 0 : clamp01(midLevel * shareGain(out.midShare)), dt);
    const detail = silent ? 0 : clamp01(highLevel * shareGain(out.highShare));
    out.detail = this.detail.update(detail, dt);

    // Rising edges of the highs (hats, cymbals, consonants): fast minus slow.
    const reference = this.highReference.update(detail, dt);
    out.shimmer = this.shimmer.update(clamp01((detail - reference - 0.03) * 4), dt);

    // Kick onsets are noisy (bass notes rise too): squared so only clear hits count. Onsets and
    // beats come from the sub-120 Hz level, which hi-hats also nudge: gated by the lows' presence.
    const hit = Math.max(audio.beatPulse, audio.onset * audio.onset) * Math.min(shareGain(out.lowShare), 1);
    out.impact = this.impact.update(silent ? 0 : hit, dt);
    out.density = this.density.update(silent ? 0 : audio.energy, dt);
    out.trace = this.trace.update(out.impact, dt);

    // Meso: transients anywhere, averaged — a sustained pad is still, a busy groove moves.
    const flux = Math.max(audio.lowFlux, audio.midFlux, audio.highFlux);
    const meanFlux = (audio.lowFlux + audio.midFlux + audio.highFlux) / 3;
    out.motion = this.motion.update(silent ? 0 : clamp01(flux * 0.6 + meanFlux * 0.8), dt);
    // Percussive regions have natural gaps between hits: hold drops longer there; sustained sound cuts sharply.
    const music = this.context.frame;
    const beat = 60 / Math.max(music.tempo, 60);
    out.lowAudible = this.lowAudible.update(audio.lowDb, dt, holdFor(music.lowPercussion, beat)) * presence;
    out.midAudible = this.midAudible.update(audio.midDb, dt, holdFor(music.midPercussion, beat)) * presence;
    out.highAudible = this.highAudible.update(audio.highDb, dt, holdFor(music.highPercussion, beat)) * presence;
    out.audible = Math.max(out.lowAudible, out.midAudible, out.highAudible);
    this.context.update(audio, out, dt, silent);

    // Macro: how full the sound is (a tone covers ~0.2 of the spectrum, a full mix all of it; energy
    // is normalized to its own history, so it only nuances), and how much it is pushing.
    const open = silent ? 0 : clamp01(coverage(audio.spectrum) * 1.1) * (0.75 + 0.25 * audio.energy);
    out.openness = this.openness.update(open, dt);
    out.tension = this.tension.update(silent ? 0 : clamp01(Math.max(music.build, 0.6 * audio.flatness * music.intensity)), dt);
    out.state = this.states.update(presence, music, dt);
    return out;
  }

  reset(): void {
    for (const e of [this.weight, this.flow, this.detail, this.shimmer, this.impact, this.density, this.highReference, this.motion, this.openness, this.tension, this.trace]) e.reset(0);
    for (const e of [this.lowShare, this.midShare, this.highShare]) e.reset(1 / 3);
    Object.assign(this.frame, { presence: 0, weight: 0, flow: 0, detail: 0, shimmer: 0, impact: 0, density: 0, motion: 0, openness: 0, tension: 0, trace: 0, state: 'silent' });
    this.presence.reset();
    this.states.reset();
    this.frame.lowShare = this.frame.midShare = this.frame.highShare = 1 / 3;
    for (const a of [this.lowAudible, this.midAudible, this.highAudible]) a.reset();
    this.frame.lowAudible = this.frame.midAudible = this.frame.highAudible = this.frame.audible = 0;
    this.context.reset();
  }
}

/**
 * Gain from a region's share of the spectrum. The spectrum shows a 42 dB
 * window below its loudest bin, so a share near 0 means the region is more
 * than ~42 dB down: its band level is only leakage or noise normalized up by
 * the analyzer, and it is muted. Any audible share (even a bass-heavy mix
 * leaves ~0.1 to the mids) responds fully; a dominant region a little more.
 */
function shareGain(share: number): number {
  return smoothstep(0.01, 0.12, share) + 0.2 * smoothstep(0.4, 0.65, share);
}

/**
 * How long a drop is held before it shows (s): 0.12 for sustained sound; a
 * percussive part is silent between its hits, so there it covers a beat of
 * the song (a hard cut then shows after about a beat).
 */
function holdFor(percussion: number, beat: number): number {
  return 0.12 + Math.min(percussion * 3, 1) * beat * 1.1;
}

/** Fraction of the spectrum above COVERED: a single tone covers little, a full mix most of it. */
function coverage(spectrum: Float32Array): number {
  let covered = 0;
  for (let i = 0; i < spectrum.length; i++) if (spectrum[i] > COVERED) covered++;
  return covered / spectrum.length;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
