import type { DiagnosticReport } from '../core/DiagnosticsTypes';
/** Local imports are still untrusted; bound work and reject malformed contracts before comparison. */
export function validateReport(value: unknown): DiagnosticReport {
  const r = value as DiagnosticReport;
  if (!r || r.schema !== 1 || !r.metadata || !Array.isArray(r.samples) || r.samples.length > 12000 || !Array.isArray(r.events) || r.events.length > 256 || !Array.isArray(r.limitations) || !Number.isFinite(r.duration)) throw new Error('Invalid diagnostic report');
  for (const k of ['engineVersion', 'startedAt', 'os', 'backend', 'quality', 'resolution', 'source']) if (typeof (r.metadata as unknown as Record<string, unknown>)[k] !== 'string') throw new Error('Invalid metadata');
  if (!Array.isArray(r.metadata.experimental) || !Array.isArray(r.metadata.capabilities)) throw new Error('Invalid capabilities');
  let cells = 0;
  for (const s of r.samples) {
    if (!Number.isFinite(s.timestamp) || !Array.isArray(s.metrics) || s.metrics.length > 2048 || (cells += s.metrics.length) > 300000) throw new Error('Invalid sample');
    for (const m of s.metrics) if (!m || typeof m.id !== 'string' || typeof m.unit !== 'string' || typeof m.source !== 'string' || typeof m.method !== 'string' || !Number.isFinite(m.timestamp) || !['valid', 'unavailable', 'estimated'].includes(m.status) || m.value !== null && !Number.isFinite(m.value) || (m.status === 'unavailable') !== (m.value === null)) throw new Error('Invalid metric');
  }
  return r;
}
