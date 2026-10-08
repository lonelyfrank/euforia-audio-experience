import type { AnalysisFrame } from '../audio/features/decode';
import { springMatrix } from '../dynamics/Dynamics';
import type { ExperienceState } from '../experience/types';

/*
 * Multiscale resonance: what the sound sets ringing, at three scales of one
 * frequency axis. It stands beside ResonantPhysics (the twelve membrane modes
 * the existing scenes read, untouched) and is what physically differentiated
 * matter answers: an element with a natural frequency takes the part of this
 * state that lies near it (visual-engine/structural/ResonanceField.ts).
 *
 *   macro  a few slow, strong modes        bending, breathing, large waves
 *   meso   resonator groups along the axis  the response of structures: nodes,
 *                                           wires, polygons, surface pattern
 *   micro  excitation of the upper spectrum grain, shimmer, micro-vibration
 *
 * Macro and meso are exact damped oscillators (the same closed-form step as
 * ResonantPhysics), driven near their own natural frequency by what the DSP
 * already measures (pitch bins, band levels above their floor) and struck by
 * transients; micro is an envelope, too fast to be drawn as an oscillation.
 * Nothing is measured here. Advanced per analysis hop on the audio clock and
 * carried by the experience snapshots, so what a frame shows depends on the
 * heard time only. With no sound every mode decays: nothing rings by itself.
 * Deterministic and allocation-free after construction.
 */

/** How many resonators each scale has. Counts are a configuration, never a constant of a scene. */
export interface ResonanceConfig {
  macro: number;
  meso: number;
  micro: number;
}

export const DEFAULT_RESONANCE: Readonly<ResonanceConfig> = { macro: 12, meso: 32, micro: 8 };
/** What a configuration is clamped to. */
export const RESONANCE_LIMITS = { macro: [4, 16], meso: [8, 64], micro: [2, 16] } as const;

/** The frequency axis: 0 = 20 Hz … 1 = 20 kHz, logarithmic. */
export const AXIS_LOW_HZ = 20;
export const AXIS_HIGH_HZ = 20000;
const AXIS_SPAN = Math.log(AXIS_HIGH_HZ / AXIS_LOW_HZ);
/** Where the micro bands start on the axis (about 1.3 kHz). */
export const MICRO_FROM = 0.6;

export const axisOf = (hz: number): number => (hz > AXIS_LOW_HZ ? Math.min(1, Math.log(hz / AXIS_LOW_HZ) / AXIS_SPAN) : 0);
export const hzOf = (axis: number): number => AXIS_LOW_HZ * Math.exp(AXIS_SPAN * axis);

/** The pitch bins of the wire: semitones from 55 Hz. */
const PITCH_FROM_HZ = 55;
const PITCH_BINS = 72;
/** Upper edges of the eight energy bands (Hz), as the DSP cuts them. */
const BAND_TOP = [60, 250, 500, 2000, 4000, 6000, 12000, 20000];

/** Visual natural frequencies (Hz): low matter swings slowly, fine matter trembles. All well below any frame rate. */
const MACRO_HZ = [0.22, 1.3];
const MESO_HZ = [0.9, 6.5];
/** Damping ratios: the low end rings for seconds, the high end for a fraction of one. */
const MACRO_ZETA = 0.2;
const MESO_ZETA = [0.07, 0.16];
/**
 * What drives a group with no tonal partial of its own (noise, percussion, the body of a mix): the energy of the
 * moment, shaped by the level of its ERB band against the loudest one (the wire gives each on a dB scale, 0..1 over
 * 80 dB): a band this far below the top (28 dB) drives nothing.
 */
const BROAD = 0.45;
const ERB_REACH = 0.35;
const ERB_BANDS = 24;
const ERB_TOP_HZ = 16000;
/** Amplitude a full transient gives a group per second it lasts, and an event gives the macro modes at once. */
const STRIKE = 4;
const EVENT = 0.6;
/** Micro: taken at once, let go in about a tenth of a second (s). */
const MICRO_ATTACK = 0.006;
const MICRO_RELEASE = 0.11;

export interface ResonanceFrame {
  time: number;
  /** Macro: signed displacement of each mode (about ±1 at full drive). */
  macro: Float32Array;
  /** Meso: signed displacement of each group, low → high along the axis, and its amplitude (the envelope of its swing, ≥ 0). */
  meso: Float32Array;
  mesoLevel: Float32Array;
  /** Micro: 0..1 excitation of each band of the upper spectrum. */
  micro: Float32Array;
  /** Mean amplitude of each scale. */
  macroEnergy: number;
  mesoEnergy: number;
  microEnergy: number;
  /** Where the meso amplitude sits on the axis (0..1), and how far it is gathered in one place (0 spread … 1 one group). */
  centre: number;
  focus: number;
}

const count = (value: number, [lo, hi]: readonly [number, number]): number =>
  Math.min(hi, Math.max(lo, Number.isFinite(value) ? Math.round(value) : lo));

export function resolveResonance(config: Partial<ResonanceConfig> = {}): ResonanceConfig {
  return {
    macro: count(config.macro ?? DEFAULT_RESONANCE.macro, RESONANCE_LIMITS.macro),
    meso: count(config.meso ?? DEFAULT_RESONANCE.meso, RESONANCE_LIMITS.meso),
    micro: count(config.micro ?? DEFAULT_RESONANCE.micro, RESONANCE_LIMITS.micro),
  };
}

export const createResonanceFrame = (config: Partial<ResonanceConfig> = {}): ResonanceFrame => {
  const c = resolveResonance(config);
  return {
    time: 0, macro: new Float32Array(c.macro), meso: new Float32Array(c.meso), mesoLevel: new Float32Array(c.meso), micro: new Float32Array(c.micro),
    macroEnergy: 0, mesoEnergy: 0, microEnergy: 0, centre: 0.5, focus: 0,
  };
};

/** Copies a frame into owned storage (arrays keep their identity; a frame of another size is copied as far as it fits). */
export function copyResonance(to: ResonanceFrame, from: Readonly<ResonanceFrame>): void {
  to.time = from.time; to.macroEnergy = from.macroEnergy; to.mesoEnergy = from.mesoEnergy; to.microEnergy = from.microEnergy;
  to.centre = from.centre; to.focus = from.focus;
  put(to.macro, from.macro); put(to.meso, from.meso); put(to.mesoLevel, from.mesoLevel); put(to.micro, from.micro);
}

function put(to: Float32Array, from: Float32Array): void {
  if (to.length === from.length) to.set(from);
  else for (let i = 0; i < to.length; i++) to[i] = i < from.length ? from[i] : 0;
}

/** Axis position of meso group `k` of `n`, and of micro band `j` of `n`. */
export const mesoAxis = (k: number, n: number): number => (k + 0.5) / n;
export const microAxis = (j: number, n: number): number => MICRO_FROM + (1 - MICRO_FROM) * (j + 0.5) / n;

const unit = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
const bandOf = (hz: number): number => {
  let b = 0;
  while (b < BAND_TOP.length - 1 && hz > BAND_TOP[b]) b++;
  return b;
};
const erbRate = (hz: number): number => 21.4 * Math.log10(1 + 0.00437 * hz);
/** The ERB band of the wire a frequency falls in (the DSP's 24 bands up to 16 kHz). */
const erbOf = (hz: number): number => Math.min(ERB_BANDS - 1, Math.max(0, Math.round(erbRate(hz) / erbRate(ERB_TOP_HZ) * (ERB_BANDS - 1))));

/** Owns the resonators of one audio session. */
export class MultiscaleResonance {
  readonly config: ResonanceConfig;
  readonly frame: ResonanceFrame;
  /** Natural frequency (rad/s) and damping ratio of the macro modes, then of the meso groups. */
  private readonly omega: Float64Array;
  private readonly zeta: Float64Array;
  private readonly x: Float64Array;
  private readonly v: Float64Array;
  private readonly matrices: Float64Array;
  /** What drives each resonator: its energy band, and for meso groups the pitch bins it covers (`to` < `from`: none). */
  private readonly band: Uint8Array;
  private readonly erb: Uint8Array;
  private readonly binFrom: Int16Array;
  private readonly binTo: Int16Array;
  private readonly microBand: Uint8Array;
  private step = 0;
  private lastEvent = 0;

  constructor(config: Partial<ResonanceConfig> = {}) {
    const c = this.config = resolveResonance(config), n = c.macro + c.meso;
    this.frame = createResonanceFrame(c);
    this.omega = new Float64Array(n); this.zeta = new Float64Array(n); this.x = new Float64Array(n); this.v = new Float64Array(n);
    this.matrices = new Float64Array(n * 4);
    this.band = new Uint8Array(n); this.erb = new Uint8Array(n); this.binFrom = new Int16Array(n); this.binTo = new Int16Array(n).fill(-1);
    for (let m = 0; m < c.macro; m++) {
      const u = c.macro > 1 ? m / (c.macro - 1) : 0;
      this.omega[m] = 2 * Math.PI * (MACRO_HZ[0] + (MACRO_HZ[1] - MACRO_HZ[0]) * u);
      this.zeta[m] = MACRO_ZETA;
      // The macro modes divide the eight energy bands among themselves, low to high.
      this.band[m] = Math.min(7, Math.floor(u * 7.999));
    }
    for (let k = 0; k < c.meso; k++) {
      const at = c.macro + k, u = mesoAxis(k, c.meso);
      this.omega[at] = 2 * Math.PI * MESO_HZ[0] * Math.pow(MESO_HZ[1] / MESO_HZ[0], u);
      this.zeta[at] = MESO_ZETA[0] + (MESO_ZETA[1] - MESO_ZETA[0]) * u;
      this.band[at] = bandOf(hzOf(u)); this.erb[at] = erbOf(hzOf(u));
      const from = Math.ceil(12 * Math.log2(hzOf(k / c.meso) / PITCH_FROM_HZ) - 1e-9), to = Math.ceil(12 * Math.log2(hzOf((k + 1) / c.meso) / PITCH_FROM_HZ) - 1e-9) - 1;
      this.binFrom[at] = Math.max(0, from); this.binTo[at] = Math.min(PITCH_BINS - 1, to);
    }
    this.microBand = Uint8Array.from({ length: c.micro }, (_, j) => bandOf(hzOf(microAxis(j, c.micro))));
  }

  /** One analysis hop: `dt` seconds on the capture clock. */
  update(a: AnalysisFrame, e: ExperienceState, dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const f = this.frame, c = this.config, n = c.macro + c.meso, m = this.matrices;
    if (Math.abs(dt - this.step) > 1e-8) {
      this.step = dt;
      for (let i = 0; i < n; i++) springMatrix(this.omega[i], this.zeta[i], dt, m, i * 4);
    }
    const presence = a.silent || a.presence < 0.06 ? 0 : unit(a.presence);
    // Steady partials drive their groups in proportion to how tonal the sound is; the same weight ResonantPhysics uses.
    const tonal = unit(e.flow) * (0.3 + 0.7 * unit(a.phaseCoherence));
    const event = e.eventId !== this.lastEvent ? unit(e.eventStrength) : 0;
    this.lastEvent = e.eventId;
    const body = BROAD * unit(e.energy);
    let top = 0;
    for (let b = 0; b < ERB_BANDS; b++) if (a.erb[b] > top) top = a.erb[b];
    let macroSum = 0, mesoSum = 0, weighted = 0, squares = 0;
    for (let i = 0; i < n; i++) {
      const omega = this.omega[i], zeta = this.zeta[i], level = unit(a.bandLevel[this.band[i]]) * presence, meso = i >= c.macro;
      let drive = level, strike: number;
      if (meso) {
        let partial = 0;
        for (let b = this.binFrom[i]; b <= this.binTo[i]; b++) if (a.pitchBins[b] > partial) partial = a.pitchBins[b];
        drive = Math.max(unit(partial) * tonal, top > 0 ? body * unit(1 - (top - a.erb[this.erb[i]]) / ERB_REACH) : 0);
        // Percussion changes momentum: a transient strikes the groups of its band.
        strike = unit(a.bandTransient[this.band[i]]) * presence * STRIKE * dt;
      } else strike = event * EVENT * (1 - (i / (c.macro * 1.2)));
      // A force at the resonator's own frequency whose steady swing equals the drive: the carrier is the audio clock.
      const target = drive * 2 * zeta * Math.sin(omega * a.time);
      const x = this.x[i] - target, v = this.v[i] + strike * omega, at = i * 4;
      let nx = m[at] * x + m[at + 1] * v + target, nv = m[at + 2] * x + m[at + 3] * v;
      if (!Number.isFinite(nx) || !Number.isFinite(nv)) nx = nv = 0;
      this.x[i] = nx; this.v[i] = nv;
      const amplitude = Math.sqrt(nx * nx + (nv / omega) * (nv / omega));
      if (meso) {
        const k = i - c.macro;
        f.meso[k] = nx; f.mesoLevel[k] = amplitude;
        mesoSum += amplitude; weighted += amplitude * mesoAxis(k, c.meso); squares += amplitude * amplitude;
      } else {
        f.macro[i] = nx;
        macroSum += amplitude;
      }
    }
    let microSum = 0;
    for (let j = 0; j < c.micro; j++) {
      const b = this.microBand[j];
      const target = unit(0.8 * unit(a.bandLevel[b]) * (0.5 + 0.5 * unit(a.sharpness * 2.2)) + 1.5 * unit(a.bandTransient[b])) * presence;
      const value = Number.isFinite(target) ? target : 0, held = f.micro[j];
      f.micro[j] = value + (held - value) * Math.exp(-dt / (value > held ? MICRO_ATTACK : MICRO_RELEASE));
      microSum += f.micro[j];
    }
    f.time = a.time;
    f.macroEnergy = macroSum / c.macro; f.mesoEnergy = mesoSum / c.meso; f.microEnergy = microSum / c.micro;
    f.centre = mesoSum > 1e-6 ? weighted / mesoSum : 0.5;
    // 1 / (groups that share the amplitude): one group ringing alone is focused, a broad spectrum is not.
    f.focus = mesoSum > 1e-6 && c.meso > 1 ? unit((squares / (mesoSum * mesoSum) * c.meso - 1) / (c.meso - 1)) : 0;
  }

  reset(): void {
    this.x.fill(0); this.v.fill(0);
    const f = this.frame;
    f.macro.fill(0); f.meso.fill(0); f.mesoLevel.fill(0); f.micro.fill(0);
    f.time = f.macroEnergy = f.mesoEnergy = f.microEnergy = f.focus = 0; f.centre = 0.5;
    this.lastEvent = 0;
  }
}
