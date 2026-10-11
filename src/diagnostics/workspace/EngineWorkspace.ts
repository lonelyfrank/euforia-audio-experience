import type { App } from '../../app/App';
import { h } from '../../ui/dom';
import type { Domain } from '../core/DiagnosticsTypes';
import type { DiagnosticsController } from '../core/DiagnosticsController';
import { DiagnosticsDashboard, download } from '../ui/DiagnosticsDashboard';
import type { DevelopmentTools } from './DevelopmentTools';
import { button, isEditing, metricCard, shortcutView, writeText, type WorkspaceView } from './components';
import './workspace.css';
import { Overview } from './Overview';

type DevelopmentFactory = (parent: HTMLElement) => DevelopmentTools;
const VIEWS: readonly [WorkspaceView, string, string, string][] = [
  ['overview', 'Overview', '◫', 'Stato del motore e presentazione live'],
  ['audio', 'Audio & Analysis', '≋', 'Cattura → analisi acustica → clock'],
  ['experience', 'Experience & Direction', '◇', 'Interpretazione → memoria → planner → regia'],
  ['world', 'World & Physics', '◎', 'Mondo persistente, forze e risposta fisica'],
  ['matter', 'Matter & Geometry', '⬡', 'Morfologia, materiale e primitive'],
  ['render', 'Rendering & Performance', '▥', 'Frame pacing, CPU, risorse e misure GPU'],
  ['laboratories', 'Laboratories', '⚗', 'Esperimenti temporanei sul mondo live · solo DEV'],
  ['diagnostics', 'Diagnostics & Reports', '⌁', 'Acquisizione, replay, confronto e report'],
];
const CARDS = [['FPS', 'fps.mean'], ['Frame · p95', 'frame.p95'], ['CPU source', 'cpu.source'], ['Draw calls', 'render.calls'], ['GPU frame', 'gpu.frame'], ['Clock lead', 'latency.analysisLead']] as const;

/** Owns navigation and the viewport, never the renderer or any audiovisual state. */
export class EngineWorkspace {
  private shell: HTMLElement | null = null;
  private view: WorkspaceView = 'overview';
  private collapsed = false;
  private timer = 0;
  private release: (() => void) | null = null;
  private dashboard: DiagnosticsDashboard | null = null;
  private development: DevelopmentTools | null = null;
  private stage: HTMLElement | null = null;
  private anchor: Comment | null = null;
  private previousFocus: HTMLElement | null = null;
  private readonly nav = new Map<WorkspaceView, HTMLButtonElement>();
  private cards: ReturnType<typeof metricCard>[] = [];
  private title = h('h1');
  private subtitle = h('p');
  private status = h('span', { class: 'ws-status' });
  private scene = h('span', { class: 'ws-preview-label' });
  private labStatus = button('Termina laboratorio', () => this.development?.stopExperiment());
  private record = button('REC', () => this.controller.setRecording(!this.controller.recording));
  private main = h('div', { class: 'ws-main' });
  private disposed = false;
  private overview: Overview | null = null;
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
  }
  open(view: WorkspaceView): void {
    if (this.disposed || view === 'laboratories' && !this.createDevelopment) return;
    if (!this.shell) this.mount();
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
    const shell = this.shell = h('div', { class: 'euforia-workspace', role: 'region', ariaLabel: 'Euforia Engine Workspace', dataset: { collapsed: String(this.collapsed) } });
    const close = button('Chiudi', () => this.close(), 'Chiudi workspace · Esc');
    const sidebar = h('nav', { class: 'ws-sidebar', ariaLabel: 'Moduli del motore' });
    for (const [id, label, icon] of VIEWS) {
      if (id === 'laboratories' && !this.createDevelopment) continue;
      const item = button('', () => this.select(id), label);
      item.setAttribute('aria-label', label); item.dataset.view = id;
      item.append(h('span', { class: 'ws-icon', ariaHidden: 'true' }, icon), h('span', { class: 'ws-nav-label' }, label));
      this.nav.set(id, item); sidebar.append(item);
    }
    const collapse = button('⇤', () => {
      this.collapsed = !this.collapsed; shell.dataset.collapsed = String(this.collapsed);
      collapse.setAttribute('aria-expanded', String(!this.collapsed)); collapse.textContent = this.collapsed ? '⇥' : '⇤';
    }, 'Espandi / comprimi navigazione');
    collapse.className = 'ws-collapse'; collapse.setAttribute('aria-expanded', String(!this.collapsed));
    sidebar.append(collapse);
    const preview = h('div', { class: 'ws-preview', ariaLabel: 'Viewport 3D live' }, this.stage, this.scene);
    const expand = button('Espandi viewport', () => {
      const expanded = preview.dataset.expanded !== 'true'; preview.dataset.expanded = String(expanded);
      expand.setAttribute('aria-pressed', String(expanded)); writeText(expand, expanded ? 'Riduci viewport' : 'Espandi viewport');
    });
    this.cards = CARDS.map(([label]) => metricCard(label));
    this.main = h('div', { class: 'ws-main', tabIndex: -1 },
      h('div', { class: 'ws-heading' }, h('div', {}, this.title, this.subtitle), expand), preview,
      h('div', { class: 'ws-metrics' }, ...this.cards.map(c => c.element)));
    shell.append(h('header', { class: 'ws-top' }, h('span', { class: 'ws-brand' }, 'Euforia Engine'), h('small', {}, 'WORKSPACE'), this.status, this.labStatus, this.record, close), sidebar, this.main);
    document.body.append(shell);
    this.overview = new Overview(); this.main.append(this.overview.element);
    if (this.createDevelopment) this.development = this.createDevelopment(this.main);
    this.dashboard = new DiagnosticsDashboard(this.controller, this.main, !!this.createDevelopment);
    this.timer = window.setInterval(() => this.refresh(), 200);
    close.focus();
  }
  private select(view: WorkspaceView): void {
    if (view === 'laboratories' && !this.createDevelopment) return;
    this.view = view;
    for (const [id, item] of this.nav) { if (id === view) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); }
    const entry = VIEWS.find(([id]) => id === view)!;
    writeText(this.title, entry[1]); writeText(this.subtitle, entry[3]);
    if (this.overview) this.overview.element.hidden = view !== 'overview';
    this.development?.setView(view);
    const domain: Domain = view === 'overview' ? 'render' : view === 'laboratories' ? 'matter' : view;
    this.dashboard?.setView(domain, view === 'diagnostics');
    this.main.scrollTop = 0;
    this.refresh();
  }
  private refresh(): void {
    if (!this.shell || document.hidden) return;
    const start = performance.now();
    const c = this.controller, registry = c.store?.registry;
    writeText(this.status, `${c.recording ? '● REC' : '● LIVE'} · ${this.app.audio.state.source ?? 'nessuna sorgente'} · ${this.app.audio.state.status}`);
    this.record.setAttribute('aria-pressed', String(c.recording));
    this.labStatus.hidden = !this.development?.active;
    writeText(this.scene, `${this.app.directionDebug.current?.source.preset.name ?? 'In attesa della scena'}${this.development?.active ? ' · LAB' : ''}`);
    for (let i = 0; i < CARDS.length; i++) {
      const metric = registry?.metrics.find(m => m.id === CARDS[i][1]);
      const value = metric?.value;
      writeText(this.cards[i].value, value === null || value === undefined ? 'Unavailable' : `${metric?.status === 'estimated' ? '≈ ' : ''}${value.toFixed(1)} ${metric?.unit ?? ''}`);
      this.cards[i].element.title = metric ? `${metric.method} · ${metric.clock}` : 'In attesa di una misura disponibile';
    }
    this.overview?.refresh(c);
    this.development?.refresh(start);
    this.dashboard?.refresh();
    c.uiMs = performance.now() - start;
  }
  close(): void {
    if (!this.shell) return;
    clearInterval(this.timer); this.timer = 0;
    this.development?.dispose(); this.development = null;
    this.overview = null;
    this.dashboard?.dispose(); this.dashboard = null;
    this.release?.(); this.release = null;
    if (this.stage && this.anchor) this.anchor.replaceWith(this.stage);
    this.stage = null; this.anchor = null;
    this.shell.remove();
    for (const node of [this.title, this.subtitle, this.status, this.scene, this.labStatus, this.record]) node.remove();
    this.main.replaceChildren(); this.shell.replaceChildren();
    this.shell = null; this.nav.clear(); this.cards = [];
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
    this.previousFocus = null;
  }
  dispose(): void { this.close(); this.disposed = true; window.removeEventListener('keydown', this.onKey, true); }
}
