import { h } from '../../ui/dom';
import { flowAt } from '../../render-systems/fields/flowLaw';
import { visualWorld } from '../probes/EngineProbes';
import type { DiagnosticsController } from '../core/DiagnosticsController';
import type { DiagnosticEvent, DiagnosticMetric, DiagnosticReport, Domain, MetricStatus } from '../core/DiagnosticsTypes';
import type { MetricRegistry } from '../metrics/MetricRegistry';
import { exportReport } from '../replay/ReportExporter';
import { compareReports } from '../replay/ReplayComparison';
import { block, type Block } from '../workspace/sections';

const STYLE = `
:host{display:block;contain:content;color:var(--ws-text,#f3f1fa);background:linear-gradient(180deg,rgba(15,18,44,.92),rgba(10,12,32,.94));border:1px solid var(--ws-border,#22254b);border-radius:12px;font:inherit;font-variant-numeric:tabular-nums}
:host([hidden]),[hidden]{display:none!important}
*{box-sizing:border-box}header,nav,section,footer{padding:10px 12px;border-bottom:1px solid var(--ws-hairline,#ffffff14)}footer{border-bottom:0}h1{font-size:13px;line-height:18px;font-weight:600;margin:0}strong{font-weight:600}
button,select,input{font:inherit;background:var(--ws-raised,#11142f);color:inherit;border:1px solid var(--ws-border,#22254b);border-radius:8px;padding:4px 10px;margin:3px;max-width:100%}button,select{cursor:pointer}button:hover,select:hover{border-color:var(--ws-border-strong,#363a72)}
button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--ws-focus,#c9b8ff);outline-offset:2px}button[aria-pressed=true]{border-color:var(--ws-accent,#9b7bff);background:rgba(123,77,255,.22)}input[type=checkbox]{accent-color:var(--ws-accent-strong,#7b4dff);padding:0}
small{color:var(--ws-muted,#a6a4b8)}.hint{display:block;margin:4px 3px 0}summary{cursor:pointer;color:var(--ws-accent,#9b7bff);font-weight:500;line-height:26px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:250px;overflow:auto;font-size:11.5px;color:var(--ws-muted,#a6a4b8)}canvas{width:100%;height:100px}label{display:inline-block} .experimental{color:var(--ws-warning,#f5b73b)} .labels{white-space:pre-wrap;color:var(--ws-muted,#a6a4b8)}
/* A row is its own layout boundary (fixed height, strict containment): a value that changes re-lays out that row alone. */
.row{display:flex;align-items:center;gap:8px;height:28px;padding:0 4px;border-bottom:1px solid var(--ws-hairline,#ffffff14);contain:strict}.row span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.id{flex:1 1 auto;min-width:0;color:var(--ws-muted,#a6a4b8)}.value{flex:0 0 auto;max-width:60%}
`;
/** The plot's stroke: the cockpit's accent (design token violet), as a canvas needs it. */
const PLOT = '#9b7bff';
/** The measure each domain plots. Every one keeps its last thirty seconds whichever is shown. */
const PLOTS = ['audio.rms', 'world.energy', 'frame.mean', 'visualWorld.budget', 'experience.energy'] as const;
const plotOf = (domain: Domain): number => PLOTS.indexOf(domain === 'audio' ? 'audio.rms' : domain === 'world' ? 'world.energy' : domain === 'render' ? 'frame.mean' : domain === 'geometry' ? 'visualWorld.budget' : 'experience.energy');
const HISTORY = 150;
const DOMAINS = ['audio', 'experience', 'world', 'physics', 'matter', 'geometry', 'render', 'diagnostics'] as const;
export function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = h('a', { href: url, download: name }); a.click();
  // Downloads take ownership of the URL during click; no recurring export timer.
  URL.revokeObjectURL(url);
}
/** One retained row: the registry's own metric object (stable for a session), what its cell shows and whether it is in view. */
interface Row { metric: DiagnosticMetric; cell: Text; visible: boolean; value: number | null; status: MetricStatus | null }
const format = (m: DiagnosticMetric): string => m.value === null ? 'Unavailable' : `${m.status === 'estimated' ? '≈ ' : ''}${Number.isInteger(m.value) ? m.value : m.value.toFixed(4)} ${m.unit}`;
/** Writes a text only when it differs: an unchanged panel costs no style, layout or paint. */
const setText = (node: HTMLElement, text: string): void => { if (node.textContent !== text) node.textContent = text; };
interface Rows { rows: Row[]; groups: Map<string, HTMLDetailsElement>; placed: number }
/**
 * The registry, its acquisition controls, replay, reports and the timeline, each a section of one shadow root. Which
 * of them show is the view's decision (`blocks`, applied by the workspace); which domains the rows are of is `setDomains`.
 */
export class DiagnosticsDashboard {
  private readonly host = h('aside', { ariaLabel: 'Euforia Engine Diagnostics' });
  private readonly root = this.host.attachShadow({ mode: 'open' });
  private readonly title = h('h1');
  private readonly labels = h('div', { class: 'labels' });
  private readonly empty = h('small', {}, 'Nessun dato per questo dominio nella sessione corrente.');
  private readonly values = h('section', {}, this.labels, this.empty);
  private readonly caption = h('small');
  private readonly timeline = h('pre');
  private readonly status = h('small');
  private readonly result = h('pre');
  private readonly plot = h('canvas', { width: 500, height: 100 });
  private readonly plotSection: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly primitives = h('select', { ariaLabel: 'Isolamento sperimentale primitive' });
  private readonly release: () => void;
  private readonly domainSelect: HTMLSelectElement;
  private readonly acquire: HTMLButtonElement;
  /** What the workspace shows or hides: the host with everything it holds, then each section by itself. */
  readonly blocks: Block[] = [];
  private session = -1;
  private frozen = false;
  /** The domains whose rows are shown, and the one chosen where the domain is the user's choice. */
  private scope: readonly Domain[] = ['audio'];
  private picked: Domain = 'diagnostics';
  private recipe = '';
  private baseline: DiagnosticReport | null = null;
  private report: DiagnosticReport | null = null;
  private worker: Worker | null = null;
  private replayPaused = false;
  private closed = false;
  /** One ring per plotted measure, advanced by `sample` at the workspace's cadence: a plot hidden by a view comes back whole. */
  private readonly histories = PLOTS.map(() => new Float32Array(HISTORY).fill(NaN));
  private readonly plotted: (DiagnosticMetric | undefined)[] = [];
  private sampled: MetricRegistry | null = null;
  private sampledSession = -1;
  private head = 0;
  /** The shown domains' rows, built once per registry and scope: a refresh only rewrites the cells in view whose value changed. */
  private rows: Row[] = [];
  private readonly domains = new Map<string, Rows>();
  private groups = new Map<string, HTMLDetailsElement>();
  private readonly rowOf = new WeakMap<Element, Row>();
  /** Which rows are in the panel's viewport (a collapsed group's are not): hundreds of rows cost nothing while out of sight. */
  private readonly seen = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const row = this.rowOf.get(entry.target);
      if (!row) continue;
      row.visible = entry.isIntersecting;
      if (row.visible && !this.frozen) this.write(row);
    }
  }, { rootMargin: '120px 0px' });
  private registry: MetricRegistry | null = null;
  /** Metrics of the registry already looked at (its vocabulary only grows). */
  private placed = 0;
  private lastEvent: DiagnosticEvent | null = null;
  constructor(private readonly controller: DiagnosticsController, parent: HTMLElement, tools: boolean) {
    this.release = controller.acquire();
    const button = (label: string, action: () => void) => h('button', { type: 'button', onclick: action }, label);
    const toggle = (label: string, action: (on: boolean) => void, checked = false) => {
      const input = h('input', { type: 'checkbox', checked, onchange: () => action(input.checked) });
      return h('label', {}, input, label);
    };
    const select = this.domainSelect = h('select', { ariaLabel: 'Dominio diagnostico', onchange: () => { this.picked = select.value as Domain; this.setDomains(null); } },
      ...DOMAINS.map(x => new Option(x, x)));
    this.primitives.onchange = () => controller.isolate(this.primitives.value || null);
    const gpu = toggle('Profiling GPU', on => controller.setProfiling(on), controller.renderer?.timer.enabled);
    const gpuInput = gpu.querySelector('input')!;
    gpuInput.disabled = !controller.renderer?.timer.supported;
    gpu.title = controller.renderer?.timer.supported ? 'Query asincrone, massimo 4 in volo' : 'Unavailable: EXT_disjoint_timer_query_webgl2';
    const acquire = this.acquire = button('Pausa acquisizione', () => { controller.paused = !controller.paused; acquire.setAttribute('aria-pressed', String(controller.paused)); });
    const freeze = button('Freeze vista', () => { this.frozen = !this.frozen; freeze.setAttribute('aria-pressed', String(this.frozen)); });
    const formats = (['json', 'csv', 'md'] as const).map(format => button(`Export ${format.toUpperCase()}`, () => download(`euforia-diagnostics.${format}`, exportReport(this.report ?? controller.report(), format))));
    const upload = h('input', { type: 'file', accept: '.json', ariaLabel: 'Carica report baseline JSON' });
    upload.onchange = () => { const file = upload.files?.[0]; if (file) void this.importBaseline(file); };
    const replaySignal = h('select', { ariaLabel: 'Scenario replay' }, ...['silence', 'tone400', 'singleImpulse', 'impulses', 'sweep', 'whiteNoise', 'buildDrop', 'drop', 'phrases', 'stereoWidth'].map(s => new Option(s, s)));
    const replayFps = h('select', { ariaLabel: 'Replay FPS' }, ...[30, 60, 144].map(n => new Option(`${n} FPS`, String(n)))); replayFps.value = '60';
    const replayBatch = h('select', { ariaLabel: 'Replay batch' }, ...[256, 480, 2048].map(n => new Option(`${n} campioni/batch`, String(n)))); replayBatch.value = '480';
    const replayPause = button('Pausa replay', () => { this.replayPaused = !this.replayPaused; this.worker?.postMessage({ pause: this.replayPaused }); replayPause.setAttribute('aria-pressed', String(this.replayPaused)); });
    const header = h('header', {}, this.title, this.status);
    // REC has one control, in the workspace's toolbar; here its state and what it holds are shown (the status line).
    const acquisition = h('nav', {}, select, acquire, freeze, button('Reset buffer', () => { controller.reset(); this.report = null; }),
      toggle('Detailed (10 Hz)', on => controller.setDetailed(on), controller.detailed), gpu, toggle('Readback materia 1 Hz', on => controller.setReadback(on), controller.readback),
      h('small', { class: 'hint' }, 'Il freeze ferma solo questa vista. La pausa acquisizione non ferma audio, rendering o replay. REC (barra in alto) conserva gli ultimi 120 campioni.'));
    this.plotSection = h('section', {}, this.plot, this.caption);
    const isolation = tools ? h('section', { class: 'experimental' }, 'Experiment · isolamento temporaneo', this.primitives,
      button('Reset isolamento', () => { controller.isolate(null); this.primitives.value = ''; }),
      button('Parità Matter', () => { void this.parity(false); }), button('Parità Tracer', () => { void this.parity(true); })) : null;
    const replays = h('section', {}, h('strong', {}, 'Replay locale · worker separato · 20 s · seed 1'), replaySignal, replayFps, replayBatch,
      button('Avvia replay', () => this.replay(replaySignal.value, +replayFps.value, +replayBatch.value)), replayPause,
      button('Ferma replay', () => { this.worker?.terminate(); this.worker = null; this.result.textContent = 'Replay interrotto'; }),
      h('small', {}, 'La sorgente live continua. Il PCM sintetico resta nel worker. Corpus WAV tramite npm run replay.'));
    const reports = h('section', {}, h('strong', {}, 'Report e confronto'), ...formats,
      button('Memorizza baseline', () => { this.baseline = this.report ?? controller.report(); this.result.textContent = 'Baseline acquisita'; }), upload,
      button('Confronta', () => { this.result.textContent = this.baseline ? JSON.stringify(compareReports(this.baseline, this.report ?? controller.report()), null, 2) : 'Acquisire o importare prima la baseline'; }),
      button('Usa dati live', () => { this.report = null; this.result.textContent = 'Export dei dati live'; }), this.result);
    this.footer = h('footer', {}, h('strong', {}, 'Timeline · audio → snapshot → planner → mondo → recipe'),
      h('small', {}, ' Co-osservazioni temporali, non prova di causalità. Confidence non calibrate.'), this.timeline);
    this.root.append(h('style', {}, STYLE), header, acquisition, this.plotSection, this.values, ...(isolation ? [isolation] : []), replays, reports, this.footer);
    this.blocks.push(block(header, 'registry'), block(acquisition, 'acquisition'), block(this.plotSection, 'plot'), block(this.values, 'registry'),
      block(replays, 'replay'), block(reports, 'reports'), block(this.footer, 'timeline'));
    if (isolation) this.blocks.push(block(isolation, 'isolation'));
    // The host shows while any of its sections does: an empty shadow host would still draw its frame.
    this.blocks.push(block(this.host, ...this.blocks.flatMap(b => b.sections)));
    // The tooltip carries a timestamp: written when a row is pointed at, not on every refresh.
    this.values.addEventListener('mouseover', event => {
      const row = (event.target as Element).closest<HTMLElement>('.row'), m = row && this.rowOf.get(row)?.metric;
      if (row && m && !this.frozen) row.title = `${m.id} · ${m.method}; ${m.clock} @ ${m.timestamp.toFixed(4)} s`;
    });
    parent.append(this.host);
    this.setDomains(this.scope);
  }
  dispose(): void { this.closed = true; this.seen.disconnect(); this.worker?.terminate(); this.worker = null; this.host.remove(); this.domains.clear(); this.rows.length = 0; this.groups.clear(); this.release(); }
  private clearRows(): void {
    this.seen.disconnect();
    for (const details of this.groups.values()) details.remove();
    this.domains.clear(); this.groups = new Map(); this.rows = []; this.placed = 0;
  }
  private addRow(m: DiagnosticMetric): void {
    let group = this.groups.get(m.source);
    if (!group) { group = h('details', { open: true }, h('summary', {}, m.source)); this.groups.set(m.source, group); this.values.append(group); }
    const cell = document.createTextNode(''), element = h('div', { class: 'row' }, h('span', { class: 'id' }, m.id), h('span', { class: 'value' }, cell));
    const row: Row = { metric: m, cell, visible: false, value: null, status: null };
    this.rows.push(row); this.rowOf.set(element, row); group.append(element); this.seen.observe(element);
  }
  private write(row: Row): void {
    const m = row.metric;
    if (m.value === row.value && m.status === row.status) return;
    row.value = m.value; row.status = m.status; row.cell.data = format(m);
  }
  /** The domains whose rows are shown; `null` where the domain is chosen (Diagnostics & Reports): the one last picked. */
  setDomains(domains: readonly Domain[] | null): void {
    const scope = domains ?? [this.picked], key = scope.join('+'), current = this.scope.join('+');
    this.domainSelect.value = this.picked;
    setText(this.title, domains ? `Observation · ${scope.join(' · ')}` : 'Observation · metric registry');
    if (key !== current) {
      this.seen.disconnect();
      for (const group of this.groups.values()) group.remove();
      this.domains.set(current, { rows: this.rows, groups: this.groups, placed: this.placed });
      this.scope = scope;
      const cached = this.domains.get(key);
      this.rows = cached?.rows ?? []; this.groups = cached?.groups ?? new Map(); this.placed = cached?.placed ?? 0;
      for (const group of this.groups.values()) this.values.append(group);
      for (const row of this.rows) {
        row.visible = false;
        this.seen.observe(row.cell.parentElement!.parentElement!);
      }
    }
    this.refresh();
  }
  /** Advances the plots' histories. Called at the workspace's cadence whether or not anything of this is shown. */
  sample(): void {
    if (this.closed) return;
    const registry = this.controller.store?.registry ?? null, session = this.controller.app.audio.session;
    if (registry !== this.sampled || session !== this.sampledSession) {
      this.sampled = registry; this.sampledSession = session; this.plotted.length = 0; this.head = 0;
      for (const history of this.histories) history.fill(NaN);
    }
    const at = this.head++ % HISTORY;
    for (let i = 0; i < PLOTS.length; i++) {
      this.plotted[i] ??= registry?.metrics.find(m => m.id === PLOTS[i]);
      this.histories[i][at] = this.plotted[i]?.value ?? NaN;
    }
  }
  refresh(): void {
    this.acquire.setAttribute('aria-pressed', String(this.controller.paused));
    if (this.frozen || this.closed || this.host.hidden) return;
    const start = performance.now(), c = this.controller, store = c.store, registry = store?.registry ?? null;
    if (this.session !== c.app.audio.session) { this.session = c.app.audio.session; this.lastEvent = null; this.timeline.replaceChildren(); }
    setText(this.status, `${c.recording ? `REC ● ${store?.count ?? 0}/${store?.capacity ?? 0} campioni` : 'LIVE'} · ${c.paused ? 'acquisizione in pausa' : `${c.detailed ? 10 : 5} Hz`} · sessione ${c.app.audio.session} · ${c.app.audio.state.status} · report ${this.report ? 'REPLAY' : 'LIVE'}`);
    if (registry !== this.registry) { this.registry = registry; this.clearRows(); }
    if (!this.values.hidden) {
      if (registry) for (; this.placed < registry.metrics.length; this.placed++) {
        const m = registry.metrics[this.placed];
        if (this.scope.includes(m.domain)) this.addRow(m);
      }
      for (const row of this.rows) if (row.visible) this.write(row);
      let labels = '';
      for (const key in store?.labels) if (this.scope.some(domain => key.startsWith(domain) || domain === 'experience' && key.startsWith('plan'))) labels += `${key}: ${store.labels[key]}\n`;
      setText(this.labels, labels);
      this.empty.hidden = this.rows.length > 0;
    }
    if (!this.footer.hidden) this.showEvents(store?.events ?? null);
    if (this.primitives.isConnected && !this.primitives.parentElement!.hidden) {
      const world = visualWorld(c.app), ids = world?.mounted.map(m => m.slot.id) ?? [], recipe = `${world?.recipe.id}:${ids.join(',')}`;
      if (recipe !== this.recipe) { this.recipe = recipe; this.primitives.replaceChildren(new Option('Tutte le primitive', ''), ...ids.map(id => new Option(id, id))); }
    }
    if (!this.plotSection.hidden) this.draw();
    c.uiMs += performance.now() - start;
  }
  /** The last 15 events, one entry each: only the new ones are added (and shaped), instead of rewriting the whole text at every event. */
  private showEvents(events: readonly DiagnosticEvent[] | null): void {
    const last = events?.at(-1) ?? null;
    if (last === this.lastEvent) return;
    // The new entries follow the last one shown; when that one is gone (a reset) the list starts again.
    const from = this.lastEvent && events ? events.lastIndexOf(this.lastEvent) + 1 : 0;
    if (from === 0) this.timeline.replaceChildren();
    this.lastEvent = last;
    if (!events) return;
    for (let i = Math.max(from, events.length - 15); i < events.length; i++) {
      const e = events[i];
      this.timeline.append(h('div', {}, `${e.audioTime?.toFixed(3) ?? '—'} s · ${e.type} · c=${e.confidence?.toFixed(2) ?? '—'}\n${e.context}`));
    }
    while (this.timeline.childElementCount > 15) this.timeline.firstElementChild!.remove();
  }
  private draw(): void {
    const ctx = this.plot.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, 500, 100); ctx.strokeStyle = ctx.fillStyle = PLOT;
    const world = visualWorld(this.controller.app), domain = this.scope[0];
    if (domain === 'physics' && world) {
      setText(this.caption, 'Flusso condiviso flowAt(P), sezione z=0; non forza totale');
      ctx.beginPath();
      for (let y = -2; y <= 2; y++) for (let x = -4; x <= 4; x++) {
        const v = flowAt(x / 3, y / 3, 0, world.uField, true), px = 250 + x * 45, py = 56 + y * 16;
        const dx = Math.tanh(v[0]) * 20, dy = -Math.tanh(v[1]) * 12;
        ctx.moveTo(px, py); ctx.lineTo(px + dx, py + dy);
        ctx.rect(px + dx - 1, py + dy - 1, 2, 2);
      }
      ctx.stroke();
      return;
    }
    const index = plotOf(domain), history = this.histories[index];
    let max = 0.001; for (const v of history) if (Number.isFinite(v)) max = Math.max(max, Math.abs(v));
    // The caption is DOM text: drawing it into the canvas at every refresh was the most expensive call of the panel.
    setText(this.caption, `${PLOTS[index]} · scala ${max.toFixed(3)} · ultimi 30 s a 5 Hz`);
    ctx.beginPath(); let gap = true;
    for (let i = 0; i < HISTORY; i++) { const v = history[(this.head + i) % HISTORY]; if (!Number.isFinite(v)) { gap = true; continue; } const x = i / 149 * 500, y = 95 - v / max * 75; if (gap) ctx.moveTo(x, y); else ctx.lineTo(x, y); gap = false; }
    ctx.stroke();
  }
  private async importBaseline(file: File): Promise<void> {
    try {
      if (file.size > 96 * 1024 * 1024) throw new Error('Report oltre 96 MB');
      const value: unknown = JSON.parse(await file.text());
      if (this.closed) return;
      const { validateReport } = await import('../replay/validateReport');
      this.baseline = validateReport(value); this.result.textContent = 'Baseline importata';
    } catch (error) { if (!this.closed) this.result.textContent = String(error); }
  }
  private async parity(tracer: boolean): Promise<void> {
    this.result.textContent = 'Parità GPU in corso · laboratorio isolato, costo non rappresentativo del live';
    try {
      const run = tracer ? (await import('../../render-systems/particles/tracerParity')).runTracerParity : (await import('../../render-systems/particles/parity')).runParity;
      if (this.closed) return;
      const r = run(undefined, undefined, undefined, this.controller.app.directionDebug.renderer);
      if (this.closed) return;
      this.result.textContent = JSON.stringify(r, null, 2);
      download(`euforia-parity-${tracer ? 'tracer' : 'matter'}.json`, JSON.stringify(r, null, 2));
    } catch (error) { if (!this.closed) this.result.textContent = `Parità unavailable: ${String(error)}`; }
  }
  private replay(signal: string, fps: number, batch: number): void {
    this.worker?.terminate(); this.report = null; this.replayPaused = false;
    this.worker = new Worker(new URL('../replay/replay.worker.ts', import.meta.url), { type: 'module' });
    const worker = this.worker;
    this.worker.onmessage = (event: MessageEvent<{ report?: DiagnosticReport; progress?: number; error?: string }>) => {
      if (this.closed || this.worker !== worker) return;
      if (event.data.report) { this.report = event.data.report; this.result.textContent = `Replay completato: ${signal}, ${fps} FPS, batch ${batch}. Export ora usa il report replay.`; this.worker?.terminate(); this.worker = null; }
      else if (event.data.error) { this.result.textContent = event.data.error; this.worker?.terminate(); this.worker = null; }
      else this.result.textContent = `Replay ${event.data.progress?.toFixed(1)} s ${this.replayPaused ? '(pausa richiesta)' : ''}`;
    };
    this.worker.onerror = event => { if (this.closed || this.worker !== worker) return; this.result.textContent = `Replay unavailable: ${event.message}`; this.worker?.terminate(); this.worker = null; };
    this.worker.postMessage({ signal, fps, batch });
  }
}
