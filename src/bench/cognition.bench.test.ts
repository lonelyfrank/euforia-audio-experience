import { expect, it } from 'vitest';
import { newFrame } from '../audio/features/decode';
import { MusicalCognition } from '../experience/cognition/MusicalCognition';
import { runScenario, SCENARIOS, type ScenarioSink } from '../experience/cognition/scenarios';
import { ExperienceEngine } from '../experience/ExperienceEngine';

/**
 * Synthetic CPU cost of the musical cognition: per analysis hop on its own (full and low budget), and the experience
 * engine per hop with the cognition on and off on the same input — the overhead it adds where it runs in the product.
 * Feature sequences, no audio and no GPU: order of magnitude on the machine it runs on, alternated runs, median beside
 * the spread. Typed memory is the cognition's own count; the snapshot history's share is estimated from its objects.
 */

const median = (x: number[]): number => [...x].sort((a, b) => a - b)[Math.floor((x.length - 1) / 2)];
const spread = (x: number[]): string => `${Math.min(...x).toFixed(2)}–${Math.max(...x).toFixed(2)}`;
const SCENARIO = SCENARIOS.find(s => s.id === 'buildDrop')!;

/** µs per hop of whatever `sink` does, minus the generator's own cost (a sink that does nothing). */
function perHop(make: () => ScenarioSink): number {
  const time = (sink: ScenarioSink): [number, number] => {
    let hops = 0;
    const hop = sink.hop;
    sink.hop = (a, c, dt) => { hops++; hop(a, c, dt); };
    const start = performance.now();
    runScenario(SCENARIO, sink);
    return [performance.now() - start, hops];
  };
  const [base] = time({ hop: () => {}, onset: () => {}, beat: () => {}, section: () => {}, gap: () => {} });
  const [work, hops] = time(make());
  return Math.max(0, (work - base) / hops) * 1000;
}
const cognitionSinkOf = (c: MusicalCognition): ScenarioSink => ({ hop: (a, x, dt) => c.hop(a, x, dt), onset: (o) => c.onset(o), beat: (b) => c.beat(b), section: (e) => c.section(e), gap: () => c.interrupt() });
function engineSink(engine: ExperienceEngine): ScenarioSink {
  const a = newFrame();
  return { hop: (frame) => { Object.assign(a, frame); engine.ingest(a); }, onset: (o) => engine.onset(o), beat: (b) => engine.beat(b), section: (e) => engine.section(e), gap: () => {} };
}

it('measures the musical cognition per hop, and the experience engine with it on and off (synthetic CPU, not live overhead)', { timeout: 300000 }, async () => {
  const full: number[] = [], low: number[] = [], on: number[] = [], off: number[] = [];
  // Warm-up, then alternated rounds.
  perHop(() => cognitionSinkOf(new MusicalCognition()));
  for (let round = 0; round < 5; round++) {
    full.push(perHop(() => cognitionSinkOf(new MusicalCognition())));
    low.push(perHop(() => { const c = new MusicalCognition(); c.config.budget = 'low'; c.config.memorySeconds = 30; return cognitionSinkOf(c); }));
    on.push(perHop(() => engineSink(new ExperienceEngine())));
    off.push(perHop(() => { const e = new ExperienceEngine(); e.cognition.config.enabled = false; return engineSink(e); }));
  }
  const c = new MusicalCognition();
  const report = [
    `cognition, full budget: ${median(full).toFixed(2)} µs/hop (${spread(full)})`,
    `cognition, low budget: ${median(low).toFixed(2)} µs/hop (${spread(low)})`,
    `experience engine, cognition on: ${median(on).toFixed(2)} µs/hop (${spread(on)})`,
    `experience engine, cognition off: ${median(off).toFixed(2)} µs/hop (${spread(off)})`,
    `typed memory of one cognition: ${(c.frame.diagnostics.memoryBytes / 1024).toFixed(1)} kB; frame objects per snapshot: ${1 + 2 + c.frame.predictions.length + c.frame.recent.length + 1}`,
    `at 187.5 hops/s (48 kHz, hop 256): ${(median(full) * 187.5 / 1000).toFixed(3)} ms of CPU per second of audio`,
  ];
  console.log('cognition bench:\n  ' + report.join('\n  '));
  const path = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env.EUFORIA_COGNITION_BENCH_REPORT;
  if (path) {
    const fs = await import(/* @vite-ignore */ 'node:fs/promises' as string);
    await fs.writeFile(path, JSON.stringify({ method: 'µs per hop over the buildDrop scenario (69 s of synthetic features), minus the generator; 5 alternated rounds after a warm-up; no audio path, no GPU, machine not isolated', full, low, on, off, report }, null, 2));
  }
  for (const x of [...full, ...low, ...on, ...off]) expect(Number.isFinite(x)).toBe(true);
  // A budget, not a performance claim: an order of magnitude under one hop's 5.3 ms even on a slow machine.
  expect(median(full)).toBeLessThan(200);
});
