import type { DiagnosticsStore } from './DiagnosticsStore';
export interface Probe { id: string; sample(store: DiagnosticsStore, now: number): void; dispose?(): void }
/** Sampling errors belong to telemetry, never to the render loop. */
export class DiagnosticsCollector {
  private readonly probes: Probe[] = [];
  private next = -Infinity;
  private last = -Infinity;
  constructor(readonly store: DiagnosticsStore, public hz = 5) {}
  register(probe: Probe): void {
    if (this.probes.some(p => p.id === probe.id)) throw new Error(`Duplicate probe: ${probe.id}`);
    this.probes.push(probe);
  }
  sample(now: number, record: boolean): boolean {
    if (!Number.isFinite(now) || !Number.isFinite(this.hz) || this.hz <= 0) return false;
    if (now < this.last) this.next = -Infinity;
    this.last = now;
    if (now < this.next) return false;
    this.next = now + 1 / Math.min(60, this.hz);
    this.store.registry.invalidate();
    for (const key of Object.keys(this.store.labels)) delete this.store.labels[key];
    for (const probe of this.probes) {
      try { probe.sample(this.store, now); }
      catch { this.store.event({ id: `error:${probe.id}:${now}`, type: 'probe-error', audioTime: null, observedAt: now, strength: null, confidence: null, context: probe.id }); }
    }
    if (record) this.store.capture(now);
    return true;
  }
  reset(): void { this.next = this.last = -Infinity; this.store.reset(); }
  dispose(): void { for (const probe of this.probes) probe.dispose?.(); this.probes.length = 0; }
}
