import { record, SAMPLE_FIELDS, type Evaluation, type Recording } from '../../experience/cognition/evaluate';
import { SCENARIOS } from '../../experience/cognition/scenarios';
import { CLOCK_STATES, MUSICAL_STATES, PREDICTION_KINDS, type Prediction } from '../../experience/cognition/types';
import { h } from '../../ui/dom';
import { legend, panel, TONE } from '../../diagnostics/workspace/components';

/**
 * The Musical Cognition laboratory (Laboratories, DEV): synthetic feature sequences of known form (scenarios.ts: tempo
 * changes, 4/8/16-bar phrases, irregular patterns, pauses, false builds, late drops, no drop, meter changes, an
 * interrupted source) run through a cognition of their own, beside the live one — no audio, no file, nothing of the
 * application touched: no pin, no override. A timeline puts the truth over what the cognition made of it, and the
 * evaluation (evaluate.ts) beside it. The live cognition is in Audio & Analysis; replays of test signals through the
 * whole pipeline are in Diagnostics & Reports, which records the cognition's measures with the rest.
 */

const W = 1000;
const STATE_TONE: Record<string, string> = {
  unknown: 'transparent', establishingPulse: TONE.amber, stableGroove: TONE.green, developing: TONE.violet, risingTension: TONE.magenta,
  breakdown: TONE.orange, transition: TONE.cyan, release: TONE.red,
};
const CLOCK_TONE: Record<string, string> = { none: 'transparent', acquiring: TONE.amber, locked: TONE.green, coasting: TONE.violet, lost: TONE.red };
const STATUS_TONE: Record<Prediction['status'], string> = { proposed: TONE.ink, updated: TONE.ink, confirmed: TONE.green, expired: TONE.amber, refuted: TONE.red };
const KIND_ROW: Record<Prediction['kind'], number> = { beat: 0, downbeat: 1, phrase: 2, transition: 3, release: 4 };
const SVG = 'http://www.w3.org/2000/svg';

const svg = (name: string, attributes: Record<string, string | number>): SVGElement => {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};
const fixed = (x: number | null | undefined, digits = 2): string => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(digits));

export class CognitionLab {
  readonly element = h('div', { class: 'ws-lab-grid' });
  /** Set by the workspace: the inspector is on screen. */
  visible = true;
  /** This laboratory changes nothing of the application: it holds no override. */
  readonly overrides = 0;
  private readonly select = h('select', { ariaLabel: 'Scenario' });
  private readonly low = h('input', { type: 'checkbox', ariaLabel: 'Budget ridotto' });
  private readonly status = h('span', { class: 'ws-lab-status' });
  private readonly chart = svg('svg', { viewBox: `0 0 ${W} 260`, preserveAspectRatio: 'none', class: 'ws-cog-timeline' }) as SVGSVGElement;
  private readonly metrics = h('div', { class: 'ws-cog-facts' });
  private readonly all = h('div', { class: 'ws-cog-table' });
  private running = false;
  private disposed = false;

  constructor(host: HTMLElement) {
    for (const s of SCENARIOS) this.select.append(new Option(s.label, s.id));
    const run = h('button', { type: 'button', onclick: () => this.run() }, 'Esegui');
    const every = h('button', { type: 'button', onclick: () => void this.runAll() }, 'Esegui tutti');
    const controls = h('div', { class: 'ws-actions' }, this.select, h('label', {}, this.low, ' budget ridotto'), run, every, this.status);
    this.element.append(
      panel({ title: 'Musical Cognition Lab', icon: 'flask', sub: 'sequenze sintetiche di feature · nessun audio · nessuna override' }, controls,
        h('div', { class: 'ws-plot ws-cog-plot' }, this.chart),
        legend([['Verità', TONE.ink], ['Confermata', TONE.green], ['Scaduta', TONE.amber], ['Smentita', TONE.red], ['Tensione', TONE.magenta], ['Sorpresa', TONE.amber], ['Aspettativa', TONE.cyan]])),
      panel({ title: 'Valutazione', icon: 'doc', sub: 'evaluate.ts · contro la verità dello scenario' }, this.metrics),
      panel({ title: 'Tutti gli scenari', icon: 'pulse', sub: 'beat ms · downbeat · frasi P/R · falsi cambi · rilasci veri/uditi/presi/anticipati · cambi/min · µs/hop' }, this.all));
    host.append(this.element);
    this.run();
  }

  /** The workspace's 5 Hz tick: nothing runs by itself here. */
  refreshPanel(_now: number): void { /* a run is drawn when it ends */ }

  dispose(): void { this.disposed = true; this.element.remove(); }

  private config() { return this.low.checked ? { budget: 'low' as const, memorySeconds: 30 } : {}; }

  private run(): void {
    if (this.running || this.disposed) return;
    const scenario = SCENARIOS.find(s => s.id === this.select.value) ?? SCENARIOS[0];
    const recording = record(scenario, this.config());
    this.draw(recording);
    this.writeMetrics(recording.evaluation);
    this.status.textContent = `${scenario.label}: ${recording.truth.duration.toFixed(0)} s in ${(recording.evaluation.microsPerHop * recording.truth.duration / (256 / 48000) / 1000).toFixed(0)} ms`;
  }

  /** Every scenario, one per task (the page stays responsive). */
  private async runAll(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    this.all.replaceChildren();
    try {
      for (const scenario of SCENARIOS) {
        await new Promise(resolve => setTimeout(resolve));
        if (this.disposed) return;
        const e = record(scenario, this.config()).evaluation;
        const row = [scenario.id, `${fixed(e.beatErrorMs, 0)} ms`, fixed(e.downbeatAccuracy), `${fixed(e.phrasePrecision)} / ${fixed(e.phraseRecall)}`, String(e.falseTransitions),
          `${e.releasesTrue}/${e.releasesHeard}/${e.releasesMatched}/${e.releasesEarly}`, fixed(e.stateChangesPerMinute, 1), fixed(e.microsPerHop, 1)];
        this.all.append(h('div', { class: 'ws-cog-row ws-cog-row-wide' }, ...row.map(text => h('span', {}, text))));
        this.status.textContent = `${scenario.label}…`;
      }
      this.status.textContent = `${SCENARIOS.length} scenari`;
    } finally { this.running = false; }
  }

  private writeMetrics(e: Evaluation): void {
    const rows: [string, string][] = [
      ['Errore del beat previsto (mediana)', `${fixed(e.beatErrorMs, 1)} ms · copertura ${fixed(e.beatCoverage)}`],
      ['Errore di tempo (mediana)', `${fixed(e.bpmErrorPct, 2)} %`],
      ['Clock: persi · ripresi · in continuità', `${e.losses} · ${e.relocks} · ${e.continuations} · ultimo riaggancio ${fixed(e.relockSeconds, 1)} s`],
      ['Downbeat collocati', fixed(e.downbeatAccuracy)],
      ['Confini di frase: precisione / richiamo', `${fixed(e.phrasePrecision)} / ${fixed(e.phraseRecall)}`],
      ['Transizioni false · cambi di stato al minuto', `${e.falseTransitions} · ${fixed(e.stateChangesPerMinute, 1)}`],
      ['Rilasci: veri / uditi / presi / anticipati', `${e.releasesTrue} / ${e.releasesHeard} / ${e.releasesMatched} / ${e.releasesEarly} · latenza ${fixed(e.releaseLatency)} s`],
      ...PREDICTION_KINDS.map((k): [string, string] => {
        const r = e.predictions[k];
        return [`Previsioni ${k}`, `${r.proposed} proposte · ${r.confirmed}/${r.refuted}/${r.expired} conf./smentite/scadute · precisione ${fixed(r.precision)} · Brier ${fixed(r.brier)} · anticipo ${fixed(r.leadSeconds, 1)} s · errore ${fixed(r.errorMs, 0)} ms`];
      }),
      ['Sorprese', Object.entries(e.surprises).map(([k, n]) => `${k} ${n}`).join(' · ') || 'nessuna'],
      ['Stati', Object.entries(e.states).map(([k, n]) => `${k} ${n}`).join(' · ')],
      ['Costo (sintetico)', `${fixed(e.microsPerHop, 1)} µs per hop`],
    ];
    this.metrics.replaceChildren(...rows.flatMap(([label, value]) => [h('span', {}, label), h('span', {}, value)]));
  }

  /** Truth on top, the cognition under it: bands of clock and state, curves, predictions as spans to their outcome. */
  private draw(r: Recording): void {
    const c = this.chart, duration = Math.max(1, r.truth.duration), x = (t: number) => (t / duration) * W;
    c.replaceChildren();
    const line = (t: number, y0: number, y1: number, stroke: string, width = 1) => c.append(svg('line', { x1: x(t), x2: x(t), y1: y0, y2: y1, stroke, 'stroke-width': width }));
    for (const [from, to] of r.truth.silences) c.append(svg('rect', { x: x(from), width: Math.max(1, x(to) - x(from)), y: 0, height: 260, fill: 'currentColor', opacity: 0.06 }));
    for (const [from, to] of r.truth.gaps) c.append(svg('rect', { x: x(from), width: Math.max(1, x(to) - x(from)), y: 0, height: 260, fill: TONE.red, opacity: 0.1 }));
    for (const t of r.truth.beats) line(t, 4, 10, TONE.ink, 0.6);
    for (const t of r.truth.downbeats) line(t, 2, 14, TONE.ink, 1.2);
    for (const t of r.truth.phrases) line(t, 0, 260, TONE.violet, 1);
    for (const t of r.truth.transitions) line(t, 0, 30, TONE.cyan, 3);
    for (const t of r.truth.releases) line(t, 0, 260, TONE.red, 2);
    // Predicted beats and their outcome, just under the true ones.
    for (const p of r.resolved) if (p.kind === 'beat') line(p.time, 16, 22, STATUS_TONE[p.status], 0.8);
    // Bands: the clock's state, the musical state.
    const s = r.samples, n = s.length / SAMPLE_FIELDS;
    for (let i = 0; i < n - 1; i++) {
      const t0 = s[i * SAMPLE_FIELDS], t1 = s[(i + 1) * SAMPLE_FIELDS];
      c.append(svg('rect', { x: x(t0), width: Math.max(0.5, x(t1) - x(t0)), y: 34, height: 10, fill: CLOCK_TONE[CLOCK_STATES[s[i * SAMPLE_FIELDS + 1]]] ?? 'transparent' }));
      c.append(svg('rect', { x: x(t0), width: Math.max(0.5, x(t1) - x(t0)), y: 48, height: 10, fill: STATE_TONE[MUSICAL_STATES[s[i * SAMPLE_FIELDS + 2]]] ?? 'transparent' }));
    }
    // Curves: tension, surprise, expectation (0..1 over 70 px).
    for (const [field, tone] of [[4, TONE.magenta], [5, TONE.amber], [6, TONE.cyan]] as const) {
      let points = '';
      for (let i = 0; i < n; i++) points += `${x(s[i * SAMPLE_FIELDS]).toFixed(1)},${(140 - 70 * s[i * SAMPLE_FIELDS + field]).toFixed(1)} `;
      c.append(svg('polyline', { points, fill: 'none', stroke: tone, 'stroke-width': 1.2 }));
    }
    // Predictions: a span from when each was proposed to when it was expected, ended by its outcome.
    for (const p of r.resolved) {
      if (p.kind === 'beat') continue;
      const y = 160 + KIND_ROW[p.kind] * 18;
      c.append(svg('line', { x1: x(p.created), x2: x(p.time), y1: y, y2: y, stroke: STATUS_TONE[p.status], 'stroke-width': 1.5, opacity: 0.6 }));
      c.append(svg('rect', { x: x(p.early), width: Math.max(1.5, x(p.late) - x(p.early)), y: y - 5, height: 10, fill: STATUS_TONE[p.status], opacity: 0.8 }));
      if (p.observed > 0) c.append(svg('circle', { cx: x(p.observed), cy: y, r: 2.5, fill: TONE.green }));
    }
    for (const t of r.heard) c.append(svg('circle', { cx: x(t), cy: 250, r: 4, fill: TONE.red }));
  }
}
