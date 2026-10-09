import type { DiagnosticMetric, MetricDefinition, MetricStatus } from '../core/DiagnosticsTypes';

/** A session's stable vocabulary, bounded even when scenes are switched repeatedly. */
export class MetricRegistry {
  readonly metrics: DiagnosticMetric[] = [];
  private readonly index = new Map<string, number>();
  constructor(readonly capacity = 2048) {}
  register(definition: MetricDefinition): number {
    const previous = this.index.get(definition.id);
    if (previous !== undefined) {
      const old = this.metrics[previous];
      if (old.unit !== definition.unit || old.source !== definition.source || old.clock !== definition.clock) throw new Error(`Metric contract changed: ${definition.id}`);
      return previous;
    }
    if (this.metrics.length >= this.capacity) throw new Error('Metric capacity exceeded');
    const at = this.metrics.length;
    this.index.set(definition.id, at);
    this.metrics.push({ ...definition, value: null, timestamp: 0, status: 'unavailable' });
    return at;
  }
  set(definition: MetricDefinition, value: number | null, timestamp: number, status: MetricStatus = 'valid'): void {
    this.setAt(this.register(definition), value, timestamp, status);
  }
  /** The same write for a metric already registered, by the index `register` returned: no definition and no id to build. */
  setAt(index: number, value: number | null, timestamp: number, status: MetricStatus = 'valid'): void {
    const metric = this.metrics[index];
    const valid = value !== null && Number.isFinite(value) && Number.isFinite(timestamp) && status !== 'unavailable';
    metric.value = valid ? value : null;
    metric.timestamp = Number.isFinite(timestamp) ? timestamp : 0;
    metric.status = valid ? status : 'unavailable';
  }
  invalidate(): void { for (const metric of this.metrics) { metric.value = null; metric.status = 'unavailable'; } }
}
