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
  /** Spectral-flux onset strength, 0..1. */
  onset: number;
  /** Rough tempo estimate; 0 while unknown. */
  bpm: number;
}

export type AudioSourceId = 'system' | 'microphone' | 'file' | 'fake';

export type CaptureStatus = 'idle' | 'starting' | 'running' | 'error';
