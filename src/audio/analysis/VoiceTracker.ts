/*
 * Follows one "voice" of the mix (the bass line, the lead) the way a digital
 * oscilloscope in averaging mode would: the band is isolated, its pitch found
 * (YIN), and the cycles of the signal at that period are stacked and averaged,
 * so what is not in phase with the voice (other instruments) cancels out and
 * the real shape of one cycle remains: a sawtooth looks like a sawtooth, a
 * square like a square, a clipped guitar clipped. The cycle is aligned on its
 * fundamental so the shape stays put from frame to frame.
 */

import type { VoiceFrame } from '../../types/audio';

/** Samples per cycle shape. */
export const SHAPE_SIZE = 128;
/** YIN threshold: the first dip of the normalized difference below this is the period. */
const YIN_THRESHOLD = 0.15;
/** Above this (best dip) the band is considered unpitched (noise, chords that do not fuse). */
const UNVOICED = 0.45;
/** Most cycles averaged into the shape. */
const MAX_CYCLES = 24;
/** Time constant (s) of the displayed shape following the measured one. */
const SHAPE_TAU = 0.06;

export interface VoiceConfig {
  /** Band kept for this voice (Hz). */
  highPass: number;
  lowPass: number;
  /** Pitch search range (Hz). */
  minPitch: number;
  maxPitch: number;
  /** Decimation factor after filtering (keeps the pitch search cheap). */
  decimation: number;
  /** Longest YIN integration window, in decimated samples. */
  maxWindow: number;
}

export class VoiceTracker {
  private readonly buffer: Float32Array;
  private readonly difference: Float32Array;
  private readonly normalized: Float32Array;
  private readonly cycle = new Float32Array(SHAPE_SIZE);
  private readonly aligned = new Float32Array(SHAPE_SIZE);
  private sampleRate = 0;
  private rate = 0;
  private minLag = 1;
  private maxLag = 2;
  private readonly hp = new Biquad();
  private readonly lp = new Biquad();
  private readonly hp2 = new Biquad();
  private readonly lp2 = new Biquad();

  constructor(
    private readonly config: VoiceConfig,
    windowSize: number,
    readonly state: VoiceFrame = { pitch: 0, clarity: 0, shape: new Float32Array(SHAPE_SIZE) },
  ) {
    this.buffer = new Float32Array(Math.floor(windowSize / config.decimation));
    this.difference = new Float32Array(this.buffer.length);
    this.normalized = new Float32Array(this.buffer.length);
    // Until a voice is heard, a sine.
    for (let i = 0; i < SHAPE_SIZE; i++) state.shape[i] = Math.sin((2 * Math.PI * i) / SHAPE_SIZE);
  }

  reset(): void {
    this.state.pitch = 0;
    this.state.clarity = 0;
  }

  /** `samples`: the latest mono samples; shorter than the window given at construction = no update. */
  update(samples: Float32Array, sampleRate: number, dt: number, silent: boolean): void {
    const { state } = this;
    if (samples.length < this.buffer.length * this.config.decimation) return;
    if (silent) {
      state.pitch = 0;
      state.clarity = 0;
      return;
    }
    if (sampleRate !== this.sampleRate) this.configure(sampleRate);
    this.isolate(samples);
    const period = this.findPeriod();
    if (period === 0) {
      state.pitch = 0;
      return;
    }
    state.pitch = this.rate / period;
    this.fold(period);
    const follow = 1 - Math.exp(-dt / SHAPE_TAU);
    for (let i = 0; i < SHAPE_SIZE; i++) state.shape[i] += (this.aligned[i] - state.shape[i]) * follow;
  }

  private configure(sampleRate: number): void {
    const { config } = this;
    this.sampleRate = sampleRate;
    this.rate = sampleRate / config.decimation;
    this.minLag = Math.max(2, Math.floor(this.rate / config.maxPitch));
    this.maxLag = Math.min(Math.ceil(this.rate / config.minPitch), Math.floor(this.buffer.length / 2));
    this.hp.highPass(config.highPass, sampleRate);
    this.hp2.highPass(config.highPass, sampleRate);
    this.lp.lowPass(config.lowPass, sampleRate);
    this.lp2.lowPass(config.lowPass, sampleRate);
  }

  /** Band-pass (4th order each side) and decimate the newest samples into `buffer`. */
  private isolate(samples: Float32Array): void {
    const { buffer, config } = this;
    const count = buffer.length * config.decimation;
    const start = samples.length - count;
    this.hp.clear();
    this.hp2.clear();
    this.lp.clear();
    this.lp2.clear();
    for (let i = 0; i < count; i++) {
      const y = this.lp2.run(this.lp.run(this.hp2.run(this.hp.run(samples[start + i]))));
      if ((i + 1) % config.decimation === 0) buffer[(i + 1) / config.decimation - 1] = y;
    }
  }

  /** YIN on the newest part of the buffer; returns the period in decimated samples (0 = unpitched). */
  private findPeriod(): number {
    const { buffer, difference: d, normalized: cmnd, minLag, maxLag, state } = this;
    const n = buffer.length;
    const window = Math.min(this.config.maxWindow, n - maxLag);
    const from = n - window - maxLag;
    let energy = 0;
    for (let j = from; j < n; j++) energy += buffer[j] * buffer[j];
    if (energy < 1e-9) {
      state.clarity = 0;
      return 0;
    }

    let running = 0;
    for (let tau = 1; tau <= maxLag; tau++) {
      let sum = 0;
      for (let j = from; j < from + window; j++) {
        const diff = buffer[j] - buffer[j + tau];
        sum += diff * diff;
      }
      d[tau] = sum;
      running += sum;
      cmnd[tau] = running > 0 ? (sum * tau) / running : 1;
    }

    let best = 0;
    for (let tau = minLag; tau <= maxLag; tau++) {
      if (cmnd[tau] < YIN_THRESHOLD) {
        while (tau + 1 <= maxLag && cmnd[tau + 1] < cmnd[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best === 0) {
      // No dip under the threshold: the deepest one, if it is deep enough.
      let min = Infinity;
      for (let tau = minLag; tau <= maxLag; tau++) {
        if (cmnd[tau] < min) {
          min = cmnd[tau];
          best = tau;
        }
      }
    }
    state.clarity = Math.max(0, Math.min(1, 1 - cmnd[best]));
    if (cmnd[best] > UNVOICED || best <= minLag || best >= maxLag) return 0;
    // Parabolic interpolation of the dip: sub-sample period.
    const a = cmnd[best - 1];
    const b = cmnd[best];
    const c = cmnd[best + 1];
    const curvature = a - 2 * b + c;
    return curvature > 0 ? best + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curvature)) : best;
  }

  /**
   * Stacks the newest cycles at `period` and averages them into one cycle,
   * then aligns it so its fundamental is a sine starting at phase 0 and
   * normalizes it to -1..1.
   */
  private fold(period: number): void {
    const { buffer, cycle, aligned } = this;
    const n = buffer.length;
    const cycles = Math.min(MAX_CYCLES, Math.floor((n - 2) / period));
    cycle.fill(0);
    for (let c = 0; c < cycles; c++) {
      const origin = n - 1 - (c + 1) * period;
      for (let i = 0; i < SHAPE_SIZE; i++) cycle[i] += sampleAt(buffer, origin + (i * period) / SHAPE_SIZE);
    }
    // Remove DC, find the fundamental's phase.
    let mean = 0;
    for (let i = 0; i < SHAPE_SIZE; i++) mean += cycle[i];
    mean /= SHAPE_SIZE;
    let re = 0;
    let im = 0;
    for (let i = 0; i < SHAPE_SIZE; i++) {
      cycle[i] -= mean;
      const angle = (2 * Math.PI * i) / SHAPE_SIZE;
      re += cycle[i] * Math.cos(angle);
      im += cycle[i] * Math.sin(angle);
    }
    // cycle ≈ A·sin(angle + phase): rotate by -phase.
    const shift = (Math.atan2(re, im) / (2 * Math.PI)) * SHAPE_SIZE;
    let peak = 1e-9;
    for (let i = 0; i < SHAPE_SIZE; i++) {
      let x = i - shift;
      x -= Math.floor(x / SHAPE_SIZE) * SHAPE_SIZE;
      const j = Math.floor(x);
      const t = x - j;
      aligned[i] = cycle[j] * (1 - t) + cycle[(j + 1) % SHAPE_SIZE] * t;
      peak = Math.max(peak, Math.abs(aligned[i]));
    }
    for (let i = 0; i < SHAPE_SIZE; i++) aligned[i] /= peak;
  }
}

function sampleAt(buffer: Float32Array, x: number): number {
  const i = Math.floor(x);
  const t = x - i;
  return buffer[i] * (1 - t) + buffer[i + 1] * t;
}

/** Second-order Butterworth section (RBJ cookbook), direct form I. */
class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  lowPass(hz: number, sampleRate: number): void {
    const w = (2 * Math.PI * hz) / sampleRate;
    const alpha = Math.sin(w) / Math.SQRT2;
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  highPass(hz: number, sampleRate: number): void {
    const w = (2 * Math.PI * hz) / sampleRate;
    const alpha = Math.sin(w) / Math.SQRT2;
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0;
    this.b1 = -(1 + cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  clear(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}
