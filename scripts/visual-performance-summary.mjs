/* global process */
/** Summarize both raw live captures without treating replay submission time as FPS. */
import { readFile, writeFile } from 'node:fs/promises';
const [beforePath, afterPath, output = '/tmp/euforia-performance-comparison.json'] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error('Usage: node scripts/visual-performance-summary.mjs before/performance.json after/performance.json [output.json]');
const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
};
const distribution = values => ({ p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99) });
const summarize = r => {
  const s = r.samples, dt = s.map(x => x.dt);
  return { frames: s.length, fps: s.length * 1000 / dt.reduce((a, b) => a + b, 0), frameMs: distribution(dt),
    over33: dt.filter(x => x > 33).length, over50: dt.filter(x => x > 50).length,
    cpuMs: Object.fromEntries(['source', 'layers', 'composite', 'solid'].map(k => [k, distribution(s.map(x => x[k]))])),
    gpuMs: distribution(r.gpu), gpuQueries: r.gpu.length, disjoint: r.disjoint,
    max: Object.fromEntries(['calls', 'triangles', 'points', 'lines', 'geometries', 'textures', 'programs', 'passes'].map(k => [k, Math.max(...s.map(x => x[k]))])),
    heapBytes: r.heap, renderer: r.renderer, resolution: r.resolution, errors: r.errors };
};
const before = JSON.parse(await readFile(beforePath, 'utf8')), after = JSON.parse(await readFile(afterPath, 'utf8'));
if (!!before.solids !== !!after.solids) throw new Error('Incomparable experimental solids setting');
for (const key of ['signal', 'warmup', 'seconds', 'viewport']) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw new Error(`Incomparable ${key}`);
const comparison = after.runs.map(r => {
  const old = before.runs.find(b => b.scene === r.scene && b.quality === r.quality);
  if (!old) throw new Error(`No baseline for ${r.scene}/${r.quality}`);
  return { scene: r.scene, quality: r.quality, before: summarize(old), after: summarize(r) };
});
await writeFile(output, JSON.stringify({ before: { head: before.head, date: before.date }, after: { head: after.head, date: after.date }, comparison }, null, 2));
const f = n => n === null ? '—' : n.toFixed(2);
console.log('| Scena / qualità | FPS prima→dopo | frame p95/p99 dopo ms | GPU p95 prima→dopo ms | >33 / >50 ms dopo | draw max prima→dopo |');
console.log('|---|---:|---:|---:|---:|---:|');
for (const r of comparison) { const b = r.before, a = r.after;
  console.log(`| ${r.scene} / ${r.quality} | ${f(b.fps)}→${f(a.fps)} | ${f(a.frameMs.p95)} / ${f(a.frameMs.p99)} | ${f(b.gpuMs.p95)}→${f(a.gpuMs.p95)} | ${a.over33} / ${a.over50} (${a.frames}) | ${b.max.calls}→${a.max.calls} |`);
}
