import type { DiagnosticEvent, DiagnosticSample } from './DiagnosticsTypes';
import { MetricRegistry } from '../metrics/MetricRegistry';

/** Fixed-size numeric trace; export owns its copies, never references the engine's arrays. */
export class DiagnosticsStore {
  readonly registry = new MetricRegistry();
  readonly events: DiagnosticEvent[] = [];
  readonly labels: Record<string, string> = {};
  private readonly values: Float64Array;
  private readonly times: Float64Array;
  private readonly statuses: Uint8Array;
  private readonly sampleTimes: Float64Array;
  private head = 0;
  count = 0;
  evicted = 0;
  constructor(readonly capacity = 300) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid trace capacity');
    const n = capacity * this.registry.capacity;
    this.values = new Float64Array(n); this.times = new Float64Array(n);
    this.statuses = new Uint8Array(n); this.sampleTimes = new Float64Array(capacity);
  }
  get bytes(): number { return this.values.byteLength + this.times.byteLength + this.statuses.byteLength + this.sampleTimes.byteLength; }
  capture(timestamp: number): void {
    if (!Number.isFinite(timestamp)) return;
    const offset = this.head * this.registry.capacity;
    this.statuses.fill(0, offset, offset + this.registry.capacity);
    for (let i = 0; i < this.registry.metrics.length; i++) {
      const m = this.registry.metrics[i];
      this.values[offset + i] = m.value ?? 0;
      this.times[offset + i] = m.timestamp;
      this.statuses[offset + i] = m.status === 'valid' ? 1 : m.status === 'estimated' ? 2 : 0;
    }
    this.sampleTimes[this.head] = timestamp;
    this.head = (this.head + 1) % this.capacity;
    if (this.count === this.capacity) this.evicted++;
    this.count = Math.min(this.capacity, this.count + 1);
  }
  event(event: DiagnosticEvent): void {
    if (this.events.length === 256) this.events.shift();
    this.events.push(event);
  }
  exportSamples(): DiagnosticSample[] {
    const samples: DiagnosticSample[] = [];
    for (let j = 0; j < this.count; j++) {
      const row = (this.head - this.count + j + this.capacity) % this.capacity;
      const offset = row * this.registry.capacity;
      samples.push({ timestamp: this.sampleTimes[row], metrics: this.registry.metrics.map((m, i) => ({
        ...m, value: this.statuses[offset + i] ? this.values[offset + i] : null,
        timestamp: this.times[offset + i], status: this.statuses[offset + i] === 1 ? 'valid' : this.statuses[offset + i] === 2 ? 'estimated' : 'unavailable',
      })) });
    }
    return samples;
  }
  reset(): void {
    this.head = this.count = this.evicted = 0; this.events.length = 0;
    this.statuses.fill(0); this.registry.invalidate();
    for (const key of Object.keys(this.labels)) delete this.labels[key];
  }
}
