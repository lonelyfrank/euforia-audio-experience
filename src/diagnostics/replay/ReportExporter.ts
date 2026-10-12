import type { DiagnosticReport } from '../core/DiagnosticsTypes';
const cell = (value: unknown): string => `"${String(value ?? '').replaceAll('"', '""')}"`;
export function exportReport(report: DiagnosticReport, format: 'json' | 'csv' | 'md'): string {
  if (format === 'json') return JSON.stringify(report, null, 2);
  if (format === 'csv') {
    const lines = [['kind', 'sampleTime', 'id', 'value', 'unit', 'status', 'timestamp', 'clock', 'source', 'method'].map(cell).join(',')];
    for (const [key, value] of Object.entries(report.metadata)) lines.push(['metadata', '', key, Array.isArray(value) ? value.join('; ') : value].map(cell).join(','));
    for (const limit of report.limitations) lines.push(['limitation', '', '', limit].map(cell).join(','));
    // One row per configuration the samples were measured under; each sample's `diagnostics.segment` metric names its own.
    for (const s of report.segments ?? []) lines.push(['segment', s.from, s.index, s.changed.join('; '), '', s.origin ?? '', s.audioTime, 'render', s.configuration, ''].map(cell).join(','));
    for (const sample of report.samples) for (const m of sample.metrics) lines.push(['metric', sample.timestamp, m.id, m.value, m.unit, m.status, m.timestamp, m.clock, m.source, m.method].map(cell).join(','));
    for (const e of report.events) lines.push(['event', e.observedAt, e.id, e.strength, '', e.type, e.audioTime, 'audio', e.context, e.confidence].map(cell).join(','));
    return lines.join('\n');
  }
  const escape = (x: unknown): string => String(x ?? 'Unavailable').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const lines = ['# Euforia Engine Diagnostics 1.0', '', ...Object.entries(report.metadata).map(([k, v]) => `- ${k}: ${escape(v)}`), '', `Durata della finestra conservata: ${report.duration.toFixed(3)} s`, '', '| Metrica (ultimo campione) | Valore | Unità | Stato | Clock |', '|---|---:|---|---|---|'];
  for (const m of report.samples.at(-1)?.metrics ?? []) lines.push(`| ${escape(m.id)} | ${escape(m.value)} | ${escape(m.unit)} | ${m.status} | ${m.clock} |`);
  if (report.segments && report.segments.length > 1) {
    lines.push('', '## Segmenti di configurazione', '', 'Le misure sono state prese sotto configurazioni diverse: confrontare i campioni per segmento (metrica `diagnostics.segment`).', '', '| Segmento | Da (s host) | Audio (s) | Cambiato | Origine |', '|---:|---:|---:|---|---|');
    for (const s of report.segments) lines.push(`| ${s.index} | ${s.from.toFixed(3)} | ${s.audioTime?.toFixed(3) ?? '—'} | ${escape(s.changed.join('; ') || '—')} | ${escape(s.origin ?? '—')} |`);
  }
  lines.push('', '## Limiti', '', ...report.limitations.map(x => `- ${x}`), '', '## Timeline (co-osservazioni)', '');
  for (const e of report.events) lines.push(`- ${e.audioTime ?? '—'} s: ${escape(e.type)}; confidence ${e.confidence ?? '—'}; ${escape(e.context)}`);
  return lines.join('\n');
}
