/*
 * The shape of one cycle of a voice, as geometry reads it. A voice arrives as
 * the real cycle the analysis averaged (`music.bassLine` / `leadLine`): what
 * makes a sine, a sawtooth, a square and a noisy cycle look different is
 * measured here as four continuous descriptors, never as a label. A cycle
 * between two textbook shapes is a point between their corners.
 *
 *   edge    how abruptly the cycle jumps somewhere (a sine 0; a ramp that falls back, or a square, 1)
 *   step    how much of it is flat between its jumps (a square 1; a sawtooth, always moving, 0)
 *   skew    which way it leans, signed: + when it falls faster than it rises, − the other way, 0 when balanced
 *   ripple  how much it wiggles beyond one rise and one fall (clean shapes 0; noise 1)
 *
 * Geometry of a curve the graphic analysis already provides: nothing of the
 * signal is measured again. Deterministic and allocation-free.
 */
export interface CycleShape {
  edge: number;
  step: number;
  skew: number;
  ripple: number;
}

export const createCycleShape = (): CycleShape => ({ edge: 0, step: 0, skew: 0, ripple: 0 });

/** A cycle flatter than this (peak to peak) has no shape to speak of. */
const FLAT = 0.05;
/**
 * Steepness is measured against a sine of the same range (1 = as steep as a sine gets). The cycles the voice
 * tracker delivers are band-limited and averaged, so a real sawtooth's fall is a few times a sine's slope, not a
 * jump: a little above a sine is still smooth, and this many times steeper is a full edge.
 */
const SMOOTH = 1.15;
const EDGE_RANGE = 2.5;
/** A sample moving less than this share of a triangle wave's slope is standing still. */
const STILL = 0.25;
/** Share of still samples of a sine (its turning points) and of a clean square. */
const STILL_SINE = 0.2;
const STILL_RANGE = 0.6;
/** One rise and one fall travel twice the range; this much more is a full ripple. */
const RIPPLE_RANGE = 6;

const unit = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);

/** Describes `cycle` (one period, any length ≥ 8, values about −1..1) into `out`. Non-finite samples count as 0. */
export function describeCycle(cycle: ArrayLike<number>, out: CycleShape): CycleShape {
  const n = cycle.length;
  out.edge = out.step = out.skew = out.ripple = 0;
  if (n < 8) return out;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = finite(cycle[i]);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = hi - lo;
  if (!(range > FLAT)) return out;
  const still = STILL * 2 * range / n;
  let rise = 0, fall = 0, travelled = 0, flat = 0;
  for (let i = 0; i < n; i++) {
    const a = finite(cycle[i]), b = finite(cycle[(i + 1) % n]), c = finite(cycle[(i + 2) % n]);
    const d = Math.abs(b - a);
    travelled += d;
    if (d < still) flat++;
    // Over two samples: the averaging of the voice tracker spreads an edge, and a single sample is too noisy.
    const jump = c - a;
    if (jump > rise) rise = jump;
    if (-jump > fall) fall = -jump;
  }
  const edge = unit((Math.max(rise, fall) / (range * Math.sin(2 * Math.PI / n)) - SMOOTH) / EDGE_RANGE);
  out.edge = edge;
  out.step = unit((flat / n - STILL_SINE) / STILL_RANGE) * edge;
  out.skew = rise + fall > 0 ? (fall - rise) / (fall + rise) * edge : 0;
  out.ripple = unit((travelled / range - 2) / RIPPLE_RANGE);
  return out;
}

function finite(x: number): number {
  return Number.isFinite(x) ? x : 0;
}
