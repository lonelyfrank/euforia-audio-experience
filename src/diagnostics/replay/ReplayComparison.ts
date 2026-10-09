import type { DiagnosticReport } from '../core/DiagnosticsTypes';
export function compareReports(a: DiagnosticReport, b: DiagnosticReport) {
  const keys = ['os', 'capabilities', 'backend', 'gpu', 'quality', 'resolution', 'source', 'sampleRate', 'detail', 'sampleHz', 'profiling', 'readback', 'scene', 'seed', 'experimental', 'configuration'] as const;
  const differences = keys.filter(k => JSON.stringify(a.metadata[k]) !== JSON.stringify(b.metadata[k]));
  const summarize = (r: DiagnosticReport) => {
    const map = new Map<string, { sum: number; n: number; metric: DiagnosticReport['samples'][number]['metrics'][number] }>();
    for (const s of r.samples) for (const m of s.metrics) {
      const entry = map.get(m.id) ?? { sum: 0, n: 0, metric: m };
      if (m.value !== null && Number.isFinite(m.value)) { entry.sum += m.value; entry.n++; entry.metric = m; }
      map.set(m.id, entry);
    }
    return map;
  };
  const left = summarize(a), right = summarize(b);
  const compatible = differences.length === 0 && a.schema === b.schema && !a.metadata.experimental.includes('mixed-configuration') && !b.metadata.experimental.includes('mixed-configuration');
  const metrics = [...new Set([...left.keys(), ...right.keys()])].map(id => {
    const x = left.get(id), y = right.get(id);
    const before = x?.n ? x.sum / x.n : null, after = y?.n ? y.sum / y.n : null;
    const contract = x && y && x.metric.unit === y.metric.unit && x.metric.method === y.metric.method && x.metric.status === y.metric.status;
    const absolute = compatible && contract && before !== null && after !== null ? after - before : null;
    const relative = absolute !== null && before !== null && before !== 0 ? absolute / Math.abs(before) : null;
    const result = absolute === null ? 'unavailable' : !x?.metric.lowerIsBetter ? 'change' : relative === null && absolute !== 0 ? 'change-from-zero' : relative !== null && relative > 0.05 ? 'regression-candidate' : relative !== null && relative < -0.05 ? 'improvement-candidate' : 'within-5%';
    return { id, domain: x?.metric.domain ?? y?.metric.domain, before, after, absolute, relative, result };
  });
  return { compatible, differences, reasons: [...differences, ...(a.schema !== b.schema ? ['schema'] : []), ...(a.metadata.experimental.includes('mixed-configuration') || b.metadata.experimental.includes('mixed-configuration') ? ['mixed-configuration'] : [])], versions: [a.metadata.engineVersion, b.metadata.engineVersion], durations: [a.duration, b.duration], metrics,
    limitation: 'Medie sui campioni conservati. ±5% segnala candidati, non significatività statistica; durata, input live e carico macchina possono differire. Tenere identici gli altri strumenti DEV aperti e lo stato di freeze.' };
}
