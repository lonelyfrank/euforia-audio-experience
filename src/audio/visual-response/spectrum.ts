import { MAX_FREQ, MIN_FREQ } from '../analysis/AudioAnalyzer';

/*
 * Helpers to read AudioFrame.spectrum by *position*: 0 = MIN_FREQ, 1 =
 * MAX_FREQ, log-spaced like the analyzer's display bins. Scenes use them to
 * tie parts of their geometry to regions of the spectrum. Allocation-free.
 */

const LOG_RATIO = Math.log(MAX_FREQ / MIN_FREQ);

/** Spectrum position (0..1) of a frequency. */
export function hzToPosition(hz: number): number {
  const p = Math.log(hz / MIN_FREQ) / LOG_RATIO;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** Linearly interpolated value at `position` (bin centres at (b + 0.5) / bins). */
export function sampleSpectrum(spectrum: Float32Array, position: number): number {
  const last = spectrum.length - 1;
  let x = position * spectrum.length - 0.5;
  if (x <= 0) return spectrum[0];
  if (x >= last) return spectrum[last];
  const i = Math.floor(x);
  x -= i;
  return spectrum[i] * (1 - x) + spectrum[i + 1] * x;
}

/** Mean value over the positions [start, end), partial bins weighted by overlap. */
export function sampleSpectrumRange(spectrum: Float32Array, start: number, end: number): number {
  const bins = spectrum.length;
  const from = Math.max(start, 0) * bins;
  const to = Math.min(end, 1) * bins;
  if (to <= from) return sampleSpectrum(spectrum, start);
  let sum = 0;
  for (let i = Math.floor(from); i < to; i++) {
    const overlap = Math.min(i + 1, to) - Math.max(i, from);
    sum += spectrum[i] * overlap;
  }
  return sum / (to - from);
}
