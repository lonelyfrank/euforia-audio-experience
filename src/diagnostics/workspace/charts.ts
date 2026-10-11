import { svg } from '../../ui/dom';

/*
 * The cockpit's chart vocabulary (design system: Charts), as inline SVG that stretches with its host: no canvas to size,
 * no text to measure, one attribute written per chart and per refresh. Colours are CSS values (`var(--ws-green)`).
 * Geometry is in plain functions; the elements only carry it to the DOM.
 */

export const TRACE_RATE = 5;
/** Ten seconds at the workspace's 5 Hz. */
export const TRACE_LENGTH = 10 * TRACE_RATE;

/** The last seconds of a value the workspace already shows: bounded, presentation only, never a collector. */
export class Trace {
  readonly values = new Float32Array(TRACE_LENGTH).fill(NaN);
  /** Where the next sample goes, which is also the oldest one. */
  head = 0;
  push(value: number): void { this.values[this.head] = value; this.head = (this.head + 1) % this.values.length; }
  reset(): void { this.values.fill(NaN); this.head = 0; }
}

/**
 * A ring, oldest to newest, as polyline points in a `width × height` box. Values outside [min, max] are clamped to it;
 * a sample that is not there yet (NaN) leaves no point, so a trace grows from the right as it fills.
 */
export function tracePoints(values: ArrayLike<number>, head: number, min: number, max: number, width = 100, height = 30): string {
  const n = values.length, span = max - min || 1, last = Math.max(1, n - 1);
  let points = '';
  for (let i = 0; i < n; i++) {
    const v = values[(head + i) % n];
    if (!Number.isFinite(v)) continue;
    const t = Math.max(0, Math.min((v - min) / span, 1));
    points += `${(i / last * width).toFixed(1)},${((1 - t) * height).toFixed(1)} `;
  }
  return points;
}

/** The finite values' own range, widened so that a steady value draws a line in the middle and not on an edge. */
export function traceRange(values: ArrayLike<number>, out: [number, number]): [number, number] {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
  }
  if (min > max) { out[0] = 0; out[1] = 1; return out; }
  const pad = Math.max((max - min) * 0.15, Math.abs(max) * 0.02, 1e-3);
  out[0] = min - pad; out[1] = max + pad;
  return out;
}

/** One outline per bin (0…1 from the baseline) as a single path in a `count × 100` box; an empty bin draws nothing. */
export function barsPath(values: ArrayLike<number>, gap = 0.25): string {
  let d = '';
  for (let i = 0; i < values.length; i++) {
    const v = values[i], height = Number.isFinite(v) ? Math.max(0, Math.min(v, 1)) * 100 : 0;
    if (height >= 0.5) d += `M${(i + gap / 2).toFixed(2)} 100V${(100 - height).toFixed(1)}H${(i + 1 - gap / 2).toFixed(2)}V100Z`;
  }
  return d;
}

/** A signal in −1…1 as polyline points in a `width × height` box, zero on the middle line. */
export function wavePoints(values: ArrayLike<number>, width = 100, height = 100): string {
  const last = Math.max(1, values.length - 1);
  let points = '';
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(-1, Math.min(values[i] || 0, 1));
    points += `${(i / last * width).toFixed(1)},${((1 - v) * height / 2).toFixed(1)} `;
  }
  return points;
}

let ids = 0;
const range: [number, number] = [0, 1];
const stroke = (width = 1.5): string => `fill="none" stroke-width="${width}" stroke-linejoin="round" vector-effect="non-scaling-stroke"`;

export interface Sparkline { readonly element: SVGElement; update(trace: Trace, min?: number, max?: number): void }
/** One trace with a soft fill under it. Without a range it scales to what the trace holds. */
export function sparkline(color: string, fill = true): Sparkline {
  const id = `ws-spark-${ids++}`;
  const element = svg(`<svg class="ws-spark" viewBox="0 -1 100 32" preserveAspectRatio="none" aria-hidden="true">${fill
    ? `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${color};stop-opacity:.28"/><stop offset="1" style="stop-color:${color};stop-opacity:0"/></linearGradient></defs><polygon fill="url(#${id})"/>`
    : ''}<polyline ${stroke()} style="stroke:${color}"/></svg>`);
  const line = element.querySelector('polyline')!, area = element.querySelector('polygon');
  let shown = '';
  return { element, update(trace, min, max) {
    if (min === undefined || max === undefined) { traceRange(trace.values, range); min = range[0]; max = range[1]; }
    const points = tracePoints(trace.values, trace.head, min, max);
    if (points === shown) return;
    shown = points;
    line.setAttribute('points', points);
    if (!area) return;
    // The fill closes on the baseline under the first and the last point the trace has.
    const end = points.trimEnd(), first = points.slice(0, points.indexOf(',')), final = end.slice(end.lastIndexOf(' ') + 1, end.lastIndexOf(','));
    area.setAttribute('points', points ? `${first},31 ${points}${final},31` : '');
  } };
}

export interface LineChart { readonly element: SVGElement; update(traces: readonly Trace[]): void }
/** Several traces on one 0…1 scale, over hairline gridlines. */
export function lineChart(colors: readonly string[], grid = 3): LineChart {
  let lines = '';
  for (let i = 1; i <= grid; i++) lines += `<line x1="0" x2="100" y1="${i * 100 / (grid + 1)}" y2="${i * 100 / (grid + 1)}" class="ws-gridline" vector-effect="non-scaling-stroke"/>`;
  const element = svg(`<svg class="ws-lines" viewBox="0 -2 100 104" preserveAspectRatio="none" aria-hidden="true">${lines}${colors.map(color => `<polyline ${stroke()} style="stroke:${color}"/>`).join('')}</svg>`);
  const paths = [...element.querySelectorAll('polyline')];
  return { element, update(traces) {
    for (let i = 0; i < paths.length; i++) paths[i].setAttribute('points', tracePoints(traces[i].values, traces[i].head, 0, 1, 100, 100));
  } };
}

/** The audio spectrum ramps violet to blue, low to high (design system: Audio & Analysis). */
export const SPECTRUM_RAMP = ['#a24dff', '#8b6bff', '#4f8dff', '#38c6ff'] as const;

export interface BarChart { readonly element: SVGElement; update(values: ArrayLike<number>): void }
/** Bars across the host's width, coloured by position along `ramp`. */
export function barChart(ramp: readonly string[], gap?: number): BarChart {
  const id = `ws-bars-${ids++}`;
  const stops = ramp.map((color, i) => `<stop offset="${ramp.length > 1 ? i / (ramp.length - 1) : 0}" style="stop-color:${color}"/>`).join('');
  const element = svg(`<svg class="ws-bars" viewBox="0 0 1 100" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient></defs><path fill="url(#${id})"/></svg>`);
  const path = element.querySelector('path')!, gradient = element.querySelector('linearGradient')!;
  let count = 0;
  return { element, update(values) {
    if (values.length !== count) {
      count = values.length;
      element.setAttribute('viewBox', `0 0 ${count} 100`); gradient.setAttribute('x2', String(count));
    }
    path.setAttribute('d', barsPath(values, gap));
  } };
}

export interface WaveChart { readonly element: SVGElement; update(values: ArrayLike<number>): void }
/** The signal itself, around its zero line. */
export function waveChart(color: string): WaveChart {
  const element = svg(`<svg class="ws-wave" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="100" y1="50" y2="50" class="ws-gridline" vector-effect="non-scaling-stroke"/><polyline ${stroke(1)} style="stroke:${color}"/></svg>`);
  const line = element.querySelector('polyline')!;
  return { element, update(values) { line.setAttribute('points', wavePoints(values)); } };
}
