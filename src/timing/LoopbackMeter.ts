/** A detection further than this (s) from every emitted click is not one of ours. */
const MATCH = 0.15;
const KEEP = 32;

/**
 * Measures the capture path with the app's own clicks: each click's emission
 * time (host clock, when it reaches the output) is matched with the attack
 * the analysis found in the loopback (host clock through ClockSync). The
 * median difference is how late the clock mapping places captured sound;
 * the spread says how steady it is. Pure logic.
 */
export class LoopbackMeter {
  private readonly emitted: number[] = [];
  private readonly deltas: number[] = [];

  /** A click scheduled to reach the output at host time `time` (s). */
  emit(time: number): void {
    this.emitted.push(time);
    if (this.emitted.length > KEEP) this.emitted.shift();
  }

  /** An attack the analysis found, at host time `time` (s). */
  detect(time: number): void {
    let best = Infinity;
    for (const e of this.emitted) if (Math.abs(time - e) < Math.abs(best)) best = time - e;
    if (Math.abs(best) > MATCH) return;
    this.deltas.push(best);
    if (this.deltas.length > KEEP) this.deltas.shift();
  }

  get count(): number {
    return this.deltas.length;
  }

  /** Median detection − emission (s); 0 before any match. */
  get median(): number {
    return median(this.deltas);
  }

  /** Median absolute deviation (s). */
  get spread(): number {
    const m = this.median;
    return median(this.deltas.map((d) => Math.abs(d - m)));
  }

  reset(): void {
    this.emitted.length = 0;
    this.deltas.length = 0;
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
