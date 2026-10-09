/** Fixed memory; sorting happens only at the aggregation cadence. */
export class RollingStatistics {
  private readonly values: Float64Array;
  private readonly sorted: Float64Array;
  private head = 0;
  count = 0;
  constructor(readonly capacity = 300) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid statistics capacity');
    this.values = new Float64Array(capacity); this.sorted = new Float64Array(capacity);
  }
  push(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.values[this.head] = value; this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
  }
  summarize(): { mean: number | null; p95: number | null; p99: number | null } {
    if (!this.count) return { mean: null, p95: null, p99: null };
    let sum = 0;
    for (let i = 0; i < this.count; i++) { sum += this.values[i]; this.sorted[i] = this.values[i]; }
    const sorted = this.sorted.subarray(0, this.count).sort();
    return { mean: sum / this.count, p95: sorted[Math.ceil(this.count * 0.95) - 1], p99: sorted[Math.ceil(this.count * 0.99) - 1] };
  }
  reset(): void { this.head = this.count = 0; }
}
