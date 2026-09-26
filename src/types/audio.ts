/**
 * Normalized snapshot of the audio signal, produced once per rendered frame by
 * the AudioAnalyzer and consumed read-only by visualizers.
 *
 * All scalar values are in the 0..1 range (already smoothed and auto-gained),
 * so visualizers can map them directly to visual parameters.
 *
 * The typed arrays are owned by the analyzer and reused between frames:
 * never keep a reference to them across frames and never mutate them.
 */
export interface AudioFrame {
  /** Seconds since the analyzer started. */
  time: number;
  sampleRate: number;
  /** True when the input is (almost) silent. */
  silent: boolean;

  /** Overall loudness (smoothed RMS, auto-gained). */
  volume: number;
  /** Instantaneous peak of the current window, 0..1 (not auto-gained). */
  peak: number;

  /** 20–250 Hz */
  bass: number;
  /** 250–500 Hz */
  lowMid: number;
  /** 500–2000 Hz */
  mid: number;
  /** 2–4 kHz */
  highMid: number;
  /** 4–16 kHz */
  treble: number;
  /** Total spectral energy across the audible range. */
  energy: number;

  /** Log-frequency spectrum (SPECTRUM_BINS values, 0..1, smoothed). */
  spectrum: Float32Array;
  /** Latest time-domain samples, -1..1 (gain applied, not smoothed). */
  waveform: Float32Array;

  /** True only on the frame where a beat was detected. */
  beat: boolean;
  /** Decaying pulse that jumps to 1 on each beat and falls back to 0. */
  beatPulse: number;
  /** Kick onset strength, 0..1: rise of the sub-120 Hz level over its running average (not full-band flux). */
  onset: number;
  /** Rough tempo estimate; 0 while unknown. */
  bpm: number;
}

/**
 * Musical roles derived from an AudioFrame by the VisualResponse layer, so
 * scenes can give each part of the music its own visual job instead of
 * pulsing everything with loudness. All values 0..1, frame-rate independent.
 *
 * - LOW  → `weight`: mass, scale, depth, slow pressure (never jitter).
 * - MID  → `flow`: form, curvature, twist, lateral motion.
 * - HIGH → `detail` (sustained) and `shimmer` (rising edges): fine detail, sparkle.
 * - TRANSIENT → `impact`: short events (shockwaves, brief glow), not continuous control.
 * - ENERGY → `density`: moderate global multiplier.
 *
 * Band levels in AudioFrame are each normalized to their own recent history,
 * so they say "this band is moving", not "this band is present". The `*Share`
 * values come from the (globally normalized) spectrum and say how much of the
 * mix sits in each region; the roles above are already weighted by them.
 */
export interface VisualResponseFrame {
  weight: number;
  flow: number;
  detail: number;
  shimmer: number;
  impact: number;
  density: number;
  /** Share of the spectrum in 30–250 Hz, 250 Hz–2 kHz, 2–16 kHz (sum ≈ 1, balanced mix ≈ 1/3 each). */
  lowShare: number;
  midShare: number;
  highShare: number;
}

export type AudioSourceId = 'system' | 'microphone' | 'file' | 'fake';

export type CaptureStatus = 'idle' | 'starting' | 'running' | 'error';
