import type { App } from '../../app/App';
import type { AudioSourceId, CaptureStatus } from '../../types/audio';
import { h } from '../../ui/dom';
import type { DiagnosticMetric } from '../core/DiagnosticsTypes';
import type { DiagnosticsController } from '../core/DiagnosticsController';
import { DiagnosticsDashboard, download } from '../ui/DiagnosticsDashboard';
import type { DevelopmentTools } from './DevelopmentTools';
import type { MetricRegistry } from '../metrics/MetricRegistry';
import { sparkline, Trace } from './charts';
import { button, INITIAL_LAYOUT, inspectorShown, isEditing, liveBadge, nextLayout, panel, shortcutView, tile, TONE, writeText, writeTile, type LayoutAction, type Tile, type WorkspaceView } from './components';
import { icon, logo, type IconName } from './icons';
import './workspace.css';
import { Overview } from './Overview';
import { applySections, block, VIEW_DOMAINS, type Block } from './sections';

type DevelopmentFactory = (inspector: HTMLElement, deck: HTMLElement) => DevelopmentTools;
const VIEWS: readonly [WorkspaceView, string, IconName, string][] = [
  ['overview', 'Overview', 'home', 'Stato del motore e presentazione live'],
  ['audio', 'Audio & Analysis', 'wave', 'Cattura → analisi acustica → clock'],
  ['experience', 'Experience & Direction', 'diamond', 'Interpretazione → memoria → planner → regia'],
  ['world', 'World & Physics', 'target', 'Mondo persistente, forze e risposta fisica'],
  ['matter', 'Matter & Geometry', 'hex', 'Morfologia, materiale e primitive'],
  ['render', 'Rendering & Performance', 'render', 'Frame pacing, CPU, risorse e misure GPU'],
  ['laboratories', 'Laboratories', 'flask', 'Esperimenti temporanei sul mondo live · solo DEV'],
  ['diagnostics', 'Diagnostics & Reports', 'pulse', 'Acquisizione, replay, confronto e report'],
];
/** The engine's health (Overview, Rendering & Performance): the registry's own measures, each with the last ten seconds the workspace sampled. */
const CARDS = [['FPS', 'fps.mean', TONE.green], ['Frame · p95', 'frame.p95', TONE.cyan], ['CPU · source', 'cpu.source', TONE.violet],
  ['GPU · frame', 'gpu.frame', TONE.magenta], ['Draw calls', 'render.calls', TONE.electric], ['Clock lead', 'latency.analysisLead', TONE.amber]] as const;
const SOURCES: Record<AudioSourceId, readonly [string, IconName]> = { system: ['System', 'spk'], microphone: ['Microphone', 'mic'], fake: ['Test signal', 'sound'] };
const NO_SOURCE: readonly [string, IconName] = ['Nessuna sorgente', 'sound'];
const STATES: Record<CaptureStatus, readonly [string, string]> = { running: ['Running', 'ok'], starting: ['Starting', 'wait'], idle: ['Idle', 'off'], error: ['Error', 'bad'] };
const INSPECTOR = 'ws-inspector';
const labelled = (target: HTMLButtonElement, name: IconName, label: HTMLElement | string): HTMLButtonElement => { target.replaceChildren(icon(name, 14), label); return target; };

/**
 * Owns navigation and the three columns (navigation, the live viewport, the view's inspector), never the renderer or
 * any audiovisual state: the viewport is the application's own stage, moved here and put back.
 */
export class EngineWorkspace {
  private shell: HTMLElement | null = null;
  private view: WorkspaceView = 'overview';
  /** Kept until the application is disposed, never written to storage. */
  private layout = INITIAL_LAYOUT;
  private timer = 0;
  private release: (() => void) | null = null;
  private dashboard: DiagnosticsDashboard | null = null;
  private development: DevelopmentTools | null = null;
  private stage: HTMLElement | null = null;
  private anchor: Comment | null = null;
  private previousFocus: HTMLElement | null = null;
  private readonly nav = new Map<WorkspaceView, HTMLButtonElement>();
  private cards: Tile[] = [];
  /** What the cards showed in the last ten seconds, and the registry's metric behind each (its objects last a session). */
  private readonly traces = CARDS.map(() => new Trace());
  private readonly metrics: (DiagnosticMetric | undefined)[] = [];
  private registry: MetricRegistry | null = null;
  private session = -1;
  private title = h('h1');
  private subtitle = h('p');
  private live = h('span');
  private source = h('span');
  private sourceId: string | null | undefined;
  private state = h('span');
  private scene = h('strong');
  private buffer = h('small');
  /** The one control that ends an experiment: there while a laboratory runs or a temporary override is in force. */
  private labStatus = button('', () => this.development?.stopExperiment());
  private record = button('', () => this.controller.setRecording(!this.controller.recording), 'Registra · REC');
  private collapse = button('', () => this.arrange('sidebar'), 'Espandi / comprimi navigazione');
  private expandLabel = h('span');
  private expand = labelled(button('', () => this.arrange('viewport'), 'Solo il viewport / le tre colonne'), 'expand', this.expandLabel);
  private inspect = labelled(button('', () => this.arrange('inspector'), 'Mostra / nascondi inspector'), 'doc', 'Inspector');
  private widen = button('', () => this.arrange('wide'), 'Allarga / riduci inspector · tabelle e report');
  /** The inspector's own scroll: the viewport never moves with the analytics. */
  private body = h('div');
  /** Under the viewport, the same height in every view: changing view never resizes the renderer. */
  private deck = h('div');
  private disposed = false;
  private overview: Overview | null = null;
  private health: HTMLDetailsElement | null = null;
  /** Every block of the inspector with its section: what `applySections` shows or hides for the view. */
  private blocks: Block[] = [];
  private readonly onKey = (event: KeyboardEvent): void => {
    const requested = shortcutView(event, !!this.createDevelopment);
    if (requested) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (this.shell && this.view === requested) this.close(); else this.open(requested);
      return;
    }
    if (this.shell) {
      // Preserve native editing while preventing the cinematic handler from seeing a shadow host.
      if (isEditing(event)) { event.stopPropagation(); return; }
      if (event.code === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.close(); }
      else if (event.shiftKey && event.code === 'KeyT' && this.createDevelopment) {
        event.preventDefault(); download('euforia-world-trace.csv', this.controller.trace?.toCsv() ?? 'time\n');
      }
      // Workspace controls keep their keys; cinematic scene/fullscreen/pause bindings are dormant.
      else if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
    }
  };
  constructor(private readonly app: App, private readonly controller: DiagnosticsController, private readonly createDevelopment?: DevelopmentFactory) {
    window.addEventListener('keydown', this.onKey, true);
    this.collapse.className = 'ws-collapse'; this.collapse.append(icon('chevl', 16), icon('chevr', 16));
    this.widen.className = 'ws-widen'; this.widen.setAttribute('aria-label', 'Allarga inspector'); this.widen.append(icon('swap', 14));
    this.record.className = 'ws-rec'; this.record.setAttribute('aria-label', 'REC'); this.record.append(h('i', { class: 'ws-dot' }), 'REC');
    this.labStatus.className = 'ws-lab-stop';
    this.inspect.setAttribute('aria-controls', INSPECTOR);
  }
  open(view: WorkspaceView): void {
    if (this.disposed || view === 'laboratories' && !this.createDevelopment) return;
    this.layout = nextLayout(this.layout, 'reveal');
    if (!this.shell) this.mount(); else this.arrange();
    this.select(view);
    if (view === 'laboratories') this.development?.startLab();
  }
  private mount(): void {
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.stage = this.app.directionDebug.renderer.domElement.closest<HTMLElement>('.app-stage');
    if (!this.stage) throw new Error('Viewport Euforia non disponibile');
    this.anchor = document.createComment('Euforia cinematic stage');
    this.stage.before(this.anchor);
    this.release = this.controller.acquire();
    const shell = this.shell = h('div', { class: 'euforia-workspace', role: 'region', ariaLabel: 'Euforia Engine Workspace' });
    const close = button('Chiudi', () => this.close(), 'Chiudi workspace · Esc');
    const reports = labelled(button('', () => this.select('diagnostics'), 'Diagnostics & Reports'), 'pulse', 'Diagnostics');
    reports.className = 'ws-top-view';
    const sidebar = h('nav', { class: 'ws-sidebar', ariaLabel: 'Moduli del motore' });
    for (const [id, label, name] of VIEWS) {
      if (id === 'laboratories' && !this.createDevelopment) continue;
      const item = button('', () => this.select(id), label);
      item.setAttribute('aria-label', label); item.dataset.view = id;
      item.append(icon(name, 17), h('span', { class: 'ws-nav-label' }, label));
      this.nav.set(id, item); sidebar.append(item);
    }
    sidebar.append(this.collapse);
    this.deck = h('div', { class: 'ws-deck' });
    const preview = h('div', { class: 'ws-preview', ariaLabel: 'Viewport 3D live' }, this.stage, h('span', { class: 'ws-preview-label' }, icon('wave', 15), this.scene, this.buffer));
    const center = h('div', { class: 'ws-center' }, h('div', { class: 'ws-heading' }, h('div', { class: 'ws-title' }, this.title, this.subtitle), this.expand), preview,
      this.createDevelopment && this.deck);
    this.cards = CARDS.map(([label, , tone]) => tile(label, { spark: sparkline(tone) }));
    this.overview = new Overview();
    this.health = panel({ title: 'Engine — Live Analytics', icon: 'pulse', right: liveBadge() }, h('div', { class: 'ws-metrics' }, ...this.cards.map(c => c.element)));
    this.body = h('div', { class: 'ws-inspector-body', tabIndex: 0, role: 'region', ariaLabel: 'Analitiche della sezione' }, this.overview.element, this.health);
    const inspector = h('div', { class: 'ws-inspector', id: INSPECTOR, role: 'complementary', ariaLabel: 'Inspector contestuale' },
      h('div', { class: 'ws-inspector-head' }, h('h2', {}, 'Inspector'), h('small', {}, 'vista 5 Hz'), this.widen), this.body);
    this.live = h('span', { class: 'ws-pill' }); this.source = h('span', { class: 'ws-pill' }); this.state = h('span', { class: 'ws-pill' });
    this.sourceId = undefined;
    shell.append(h('header', { class: 'ws-top' }, h('span', { class: 'ws-brand' }, logo(24), 'Euforia Engine'), h('small', { class: 'ws-chip' }, 'WORKSPACE'),
      h('span', { class: 'ws-pills', role: 'status' }, this.live, this.source, this.state),
      this.labStatus, this.record, this.inspect, reports, close), sidebar, center, inspector);
    this.arrange();
    document.body.append(shell);
    if (this.createDevelopment) this.development = this.createDevelopment(this.body, this.deck);
    this.dashboard = new DiagnosticsDashboard(this.controller, this.body, !!this.createDevelopment);
    this.blocks = [block(this.overview.element, 'overview'), block(this.health, 'health'), ...this.development?.blocks ?? [], ...this.dashboard.blocks];
    this.timer = window.setInterval(() => { this.sample(); this.refresh(); }, 200);
    close.focus();
  }
  /** Applies the columns to the shell. The renderer's own observer sees its container once per change and resizes on its usual path. */
  private arrange(action?: LayoutAction): void {
    if (action) this.layout = nextLayout(this.layout, action);
    if (!this.shell) return;
    const { collapsed, inspector, wide, expanded } = this.layout, shown = inspectorShown(this.layout);
    Object.assign(this.shell.dataset, { collapsed: String(collapsed), inspector: inspector ? wide ? 'wide' : 'open' : 'closed', expanded: String(expanded) });
    this.collapse.setAttribute('aria-expanded', String(!collapsed));
    this.expand.setAttribute('aria-pressed', String(expanded)); writeText(this.expandLabel, expanded ? 'Riduci viewport' : 'Espandi viewport');
    this.inspect.setAttribute('aria-pressed', String(shown)); this.inspect.setAttribute('aria-expanded', String(shown));
    this.widen.setAttribute('aria-pressed', String(wide));
    // What has just come back into view shows the present, not what it showed when it was hidden.
    if (action) this.refresh();
  }
  private select(view: WorkspaceView): void {
    if (view === 'laboratories' && !this.createDevelopment) return;
    this.view = view;
    for (const [id, item] of this.nav) { if (id === view) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); }
    const entry = VIEWS.find(([id]) => id === view)!;
    writeText(this.title, entry[1]); writeText(this.subtitle, entry[3]);
    // The view decides what the inspector holds; the components are then told what they have to show.
    applySections(view, this.blocks);
    this.development?.setView(view);
    this.dashboard?.setDomains(VIEW_DOMAINS[view]);
    this.body.scrollTop = 0;
    this.refresh();
  }
  /** The registry's metric behind each card. Its vocabulary only grows: a metric is looked for until it is there, then kept. */
  private resolve(): void {
    const registry = this.controller.store?.registry ?? null, session = this.app.audio.session;
    if (registry !== this.registry || session !== this.session) {
      this.registry = registry; this.session = session; this.metrics.length = 0;
      for (const trace of this.traces) trace.reset();
    }
    for (let i = 0; i < CARDS.length; i++) this.metrics[i] ??= registry?.metrics.find(m => m.id === CARDS[i][1]);
  }
  /** The cards' traces advance with the workspace's clock, whether or not the inspector is there to draw them. */
  private sample(): void {
    if (!this.shell || document.hidden) return;
    this.resolve();
    for (let i = 0; i < CARDS.length; i++) this.traces[i].push(this.metrics[i]?.value ?? NaN);
    this.dashboard?.sample();
  }
  private refresh(): void {
    if (!this.shell || document.hidden) return;
    const start = performance.now();
    const c = this.controller, canvas = this.app.directionDebug.renderer.domElement;
    // A hidden inspector is not kept up to date: only the histories go on, so that it comes back with its last seconds.
    const shown = inspectorShown(this.layout);
    // The canvases first, while the document is still as the last frame left it: text drawn into a canvas resolves its
    // style, and after the writes below that would be a style pass of its own in the middle of the refresh.
    this.development?.refresh(start, shown, !this.layout.expanded);
    this.resolve();
    this.showStatus();
    this.record.setAttribute('aria-pressed', String(c.recording));
    const lab = this.development?.labName ?? null, overrides = this.development?.overrides ?? 0;
    this.labStatus.hidden = !lab && overrides === 0;
    if (!this.labStatus.hidden) {
      writeText(this.labStatus, lab ? `Termina ${lab}` : 'Ripristina override');
      this.labStatus.title = `${lab ? 'Termina l\'esperimento' : 'Nessun laboratorio attivo'} · ripristina ${overrides} override temporanee · il workspace resta aperto`;
    }
    writeText(this.scene, `${this.app.directionDebug.current?.source.preset.name ?? 'In attesa della scena'}${this.development?.active ? ' · LAB' : ''}`);
    writeText(this.buffer, `${canvas.width}×${canvas.height}`);
    if (shown && this.health && !this.health.hidden && this.health.open) {
      for (let i = 0; i < CARDS.length; i++) {
        const metric = this.metrics[i], value = metric?.value, card = this.cards[i];
        if (value === null || value === undefined) writeTile(card, null);
        else writeTile(card, `${metric?.status === 'estimated' ? '≈ ' : ''}${Number.isInteger(value) ? value : value.toFixed(1)}`, metric?.unit);
        card.spark!.update(this.traces[i]);
        card.element.title = metric ? `${metric.method} · ${metric.clock}` : 'In attesa di una misura disponibile';
      }
    }
    if (shown) {
      this.overview?.refresh(c);
      this.dashboard?.refresh();
    }
    c.uiMs = performance.now() - start;
  }
  /** Live or recording, what is captured, and how the capture is doing: each a word, never a colour alone. */
  private showStatus(): void {
    const { source, status } = this.app.audio.state, recording = this.controller.recording;
    if (this.live.dataset.tone !== (recording ? 'rec' : 'ok')) {
      this.live.dataset.tone = recording ? 'rec' : 'ok';
      this.live.replaceChildren(h('i', { class: 'ws-dot' }), recording ? 'REC' : 'LIVE');
    }
    if (source !== this.sourceId) {
      this.sourceId = source;
      const [label, name] = source ? SOURCES[source] : NO_SOURCE;
      this.source.replaceChildren(icon(name, 14), label);
    }
    if (this.state.dataset.status !== status) {
      const [label, tone] = STATES[status];
      this.state.dataset.status = status; this.state.dataset.tone = tone;
      this.state.replaceChildren(h('i', { class: 'ws-dot' }), label);
    }
  }
  close(): void {
    if (!this.shell) return;
    clearInterval(this.timer); this.timer = 0;
    this.development?.dispose(); this.development = null;
    this.overview = null; this.health = null; this.blocks = [];
    this.dashboard?.dispose(); this.dashboard = null;
    this.release?.(); this.release = null;
    if (this.stage && this.anchor) this.anchor.replaceWith(this.stage);
    this.stage = null; this.anchor = null;
    this.shell.remove();
    for (const node of [this.title, this.subtitle, this.scene, this.buffer, this.labStatus, this.record, this.collapse, this.expand, this.inspect, this.widen]) node.remove();
    this.body.replaceChildren(); this.deck.replaceChildren(); this.shell.replaceChildren();
    this.shell = null; this.nav.clear(); this.cards = [];
    this.registry = null; this.metrics.length = 0;
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
    this.previousFocus = null;
  }
  dispose(): void { this.close(); this.disposed = true; window.removeEventListener('keydown', this.onKey, true); }
}
