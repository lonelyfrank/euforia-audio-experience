import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import { Envelope } from './Envelope';
import { MusicContext } from './MusicContext';
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
  readonly frame: VisualResponseFrame = {
    weight: 0,
    flow: 0,
    detail: 0,
    shimmer: 0,
    impact: 0,
    density: 0,
    lowShare: 1 / 3,
    midShare: 1 / 3,
    highShare: 1 / 3,
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

  constructor() {
    this.reset();
  }

  update(audio: AudioFrame, dt: number): VisualResponseFrame {
    const out = this.frame;
    const silent = audio.silent;

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

    out.weight = this.weight.update(silent ? 0 : clamp01(lowLevel * presence(out.lowShare)), dt);
    out.flow = this.flow.update(silent ? 0 : clamp01(midLevel * presence(out.midShare)), dt);
    const detail = silent ? 0 : clamp01(highLevel * presence(out.highShare));
    out.detail = this.detail.update(detail, dt);

    // Rising edges of the highs (hats, cymbals, consonants): fast minus slow.
    const reference = this.highReference.update(detail, dt);
    out.shimmer = this.shimmer.update(clamp01((detail - reference - 0.03) * 4), dt);

    // Kick onsets are noisy (bass notes rise too): squared so only clear hits count. Onsets and
    // beats come from the sub-120 Hz level, which hi-hats also nudge: gated by the lows' presence.
    const hit = Math.max(audio.beatPulse, audio.onset * audio.onset) * Math.min(presence(out.lowShare), 1);
    out.impact = this.impact.update(silent ? 0 : hit, dt);
    out.density = this.density.update(silent ? 0 : audio.energy, dt);
    this.context.update(audio, out, dt);
    return out;
  }

  reset(): void {
    for (const e of [this.weight, this.flow, this.detail, this.shimmer, this.impact, this.density, this.highReference]) e.reset(0);
    for (const e of [this.lowShare, this.midShare, this.highShare]) e.reset(1 / 3);
    Object.assign(this.frame, { weight: 0, flow: 0, detail: 0, shimmer: 0, impact: 0, density: 0 });
    this.frame.lowShare = this.frame.midShare = this.frame.highShare = 1 / 3;
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
function presence(share: number): number {
  return smoothstep(0.01, 0.12, share) + 0.2 * smoothstep(0.4, 0.65, share);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
