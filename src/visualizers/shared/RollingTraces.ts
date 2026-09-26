import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import { SignalTexture } from './SignalTexture';

/** Samples per trace (index 0 = now, the last = oldest). */
export const TRACE_POINTS = 128;
/** A trace spans this many beats of the song, so its hits line up with the tempo. */
export const TRACE_BEATS = 8;

/**
 * GLSL: a rolling trace at `age` (0 = now … 1 = oldest) of row `row` of
 * `rows`. Needs `tTrace` and `uTraceShift` (the sub-sample scroll).
 */
export const traceGlsl = /* glsl */ `
  uniform sampler2D tTrace;
  uniform float uTraceShift;
  float traceAt(float row, float rows, float age) {
    return texture2D(tTrace, vec2(age - uTraceShift, (row + 0.5) / rows)).r;
  }
`;

/**
 * Rolling histories of what parts of the music did, like a roll-mode scope
 * or a seismograph: each row records the loudest value of its signal since
 * the last sample; a new sample every TRACE_BEATS / TRACE_POINTS beats (so a
 * trace always spans 8 beats); `shift` makes the scroll smooth between samples.
 */
export class RollingTraces {
  private readonly signal: SignalTexture;
  private readonly values: Float32Array;
  private readonly peaks: Float32Array;
  private progress = 0;
  shift = 0;

  constructor(readonly rows: number) {
    this.signal = new SignalTexture(TRACE_POINTS, rows);
    this.values = new Float32Array(TRACE_POINTS * rows);
    this.peaks = new Float32Array(rows);
  }

  get texture() {
    return this.signal.texture;
  }

  record(row: number, value: number): void {
    if (value > this.peaks[row]) this.peaks[row] = value;
  }

  update(tempo: number, dt: number): void {
    const interval = (60 / Math.max(tempo, 1)) * (TRACE_BEATS / TRACE_POINTS);
    this.progress += dt / interval;
    const pushes = Math.min(Math.floor(this.progress), TRACE_POINTS);
    this.progress -= Math.floor(this.progress);
    if (pushes > 0) {
      const { values } = this;
      for (let r = 0; r < this.rows; r++) {
        const row = r * TRACE_POINTS;
        for (let i = 0; i < pushes; i++) {
          values.copyWithin(row + 1, row, row + TRACE_POINTS - 1);
          values[row] = this.peaks[r];
        }
        this.peaks[r] = 0;
        this.signal.write(values, false, r, row, TRACE_POINTS);
      }
    }
    this.shift = (this.progress - 0.5) / TRACE_POINTS;
  }

  dispose(): void {
    this.signal.dispose();
  }
}

/**
 * What a trace of a part of the spectrum records: its level (`zone`, the
 * spectrum's mean there) plus the transients of that part — `position` 0 =
 * top (hi-hats), 0.5 = middle (snares), 1 = bottom (kicks). Transients of a
 * part absent from the mix count only partly (leakage).
 */
export function traceValue(frame: AudioFrame, response: VisualResponseFrame, position: number, zone: number): number {
  const low = Math.max(response.impact, frame.lowFlux * 0.7);
  const t = position;
  const transient = t < 0.5 ? frame.highFlux + (frame.midFlux - frame.highFlux) * t * 2 : frame.midFlux + (low - frame.midFlux) * (t * 2 - 1);
  const gate = Math.min(Math.max((zone - 0.05) / 0.2, 0), 1);
  const value = 0.6 * zone ** 1.5 + 0.9 * transient * (0.35 + 0.65 * gate * gate * (3 - 2 * gate));
  return frame.silent ? 0 : Math.min(value, 1);
}
