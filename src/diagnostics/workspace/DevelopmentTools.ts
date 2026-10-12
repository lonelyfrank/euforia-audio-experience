import type { App } from '../../app/App';
import { DebugOverlay, type DebugView } from '../../app/debug/DebugOverlay';
import { EngineCockpit } from '../../app/engine/EngineCockpit';
import { SolidCockpit } from '../../app/engine/SolidCockpit';
import { TEST_SIGNALS, type TestSignal } from '../../audio/capture/testSignals';
import { matterLab, type FormPin } from '../../render-systems/forms/MatterForms';
import { worldLab } from '../../visual-engine/VisualWorld';
import { tunnelLab } from '../../visualizers/tunnel/motion';
import { settingsStore } from '../../stores/settingsStore';
import { h } from '../../ui/dom';
import type { DiagnosticsController } from '../core/DiagnosticsController';
import { AudioAnalysis } from './AudioAnalysis';
import { button, panel, retitle, writeText, type WorkspaceView } from './components';
import { Experiment, LABS, type Laboratory } from './Experiment';
import { block, type Block } from './sections';

const CHARTS: Record<DebugView, string> = {
  experience: 'Regia, analisi, previsione ed eventi', world: 'Mondo, energia e forze', matter: 'Morfologia, materiale e primitive',
};
const charted = (view: WorkspaceView): view is DebugView => view in CHARTS;

/**
 * Loaded only by the DEV branch of installDiagnostics; all experiments are owned by this workspace. It builds the DEV
 * blocks of the inspector and says which section each is (`blocks`): the view decides which are shown.
 */
export class DevelopmentTools {
  readonly element = h('div');
  readonly blocks: Block[];
  private readonly controls = h('div', { class: 'ws-actions' });
  private readonly plots = h('div');
  /** The view's live charts: one retained canvas, whose block is renamed (not rebuilt) from a view to the next. */
  private readonly charts = panel({ title: CHARTS.experience, icon: 'pulse' }, this.plots);
  /** Audio & Analysis as panels, and what stands under the viewport in every view. */
  private readonly audio: AudioAnalysis;
  private readonly labHost = h('div');
  private readonly controlsPanel: HTMLElement;
  private debug: DebugOverlay | null = null;
  private lab: EngineCockpit | SolidCockpit | null = null;
  /** Which laboratory runs, and when it starts and ends: the view shown has no part in it. */
  private readonly experiment: Experiment;
  private disposed = false;
  private readonly initialForm = matterLab.form;
  private readonly initialOnly = worldLab.only;
  private readonly initialSource;
  private readonly initialSignal;
  private signalChanged = false;
  private readonly status = h('span', { class: 'ws-lab-status' });
  private readonly labButtons = (Object.keys(LABS) as Laboratory[]).map((lab) => {
    const item = button(`Avvia ${LABS[lab]}`, () => this.openLab(lab));
    item.dataset.lab = lab;
    return item;
  });
  private readonly pin = h('select', { ariaLabel: 'Forma Matter' });
  private readonly signal = h('select', { ariaLabel: 'Segnale live di test' });
  /** The tunnel as it was or balanced, on the same sound: `tunnelLab`, back to the preset's own on leaving. */
  private readonly tunnel = h('select', { ariaLabel: 'Coordinamento del Tunnel' });
  constructor(private readonly app: App, private readonly controller: DiagnosticsController, parent: HTMLElement, deck: HTMLElement) {
    this.initialSource = app.audio.state.source ?? settingsStore.get().source;
    this.initialSignal = TEST_SIGNALS.find(s => s.label === app.audio.state.deviceName)?.id;
    this.signal.append(new Option('Sorgente live', ''), ...TEST_SIGNALS.map(s => new Option(s.label, s.id)));
    this.signal.onchange = () => {
      this.signalChanged = true;
      if (this.signal.value) void app.playTestSignal(this.signal.value as TestSignal);
      else void app.audio.setSource(settingsStore.get().source);
    };
    for (const form of ['auto', 'particles', 'wave', 'harmonic'] as const) this.pin.append(new Option(`Matter: ${form}`, form));
    this.pin.value = matterLab.form;
    this.pin.onchange = () => { matterLab.form = this.pin.value as FormPin; };
    this.tunnel.append(new Option('Tunnel: preset', ''), new Option('Tunnel: Balanced', '1'), new Option('Tunnel: com\'era (legacy)', '0'));
    this.tunnel.onchange = () => { tunnelLab.balance = this.tunnel.value === '' ? null : Number(this.tunnel.value); };
    // Ending the experiment has one control, in the workspace's toolbar.
    this.controls.append(this.signal, this.pin, this.tunnel, ...this.labButtons, this.status);
    this.element.className = 'ws-development';
    this.element.append(this.charts);
    this.audio = new AudioAnalysis(app, this.element, deck);
    this.controlsPanel = panel({ title: 'Experiment Controls', icon: 'flask', sub: 'modifiche temporanee, non salvate' }, this.controls);
    this.element.append(this.controlsPanel, this.labHost);
    this.blocks = [block(this.charts, 'charts'), block(this.audio.element, 'audio'), block(this.controlsPanel, 'experiment'), block(this.labHost, 'laboratory')];
    parent.append(this.element);
    const query = new URLSearchParams(location.search), form = query.get('matter');
    if (form && ['auto', 'particles', 'wave', 'harmonic'].includes(form)) { matterLab.form = form as FormPin; this.pin.value = form; }
    const only = query.get('primitives');
    if (only) worldLab.only = new Set(only.split(',').filter(Boolean));
    // The laboratory a shortcut, the sidebar or `?engine` opens first: Structural Lab, or the one named by `?engine=solid`.
    this.experiment = new Experiment((lab) => {
      this.lab = lab === 'solid' ? new SolidCockpit(this.app, this.controller, this.labHost) : new EngineCockpit(this.app, this.controller, this.labHost);
      const cockpit = this.lab;
      return { get overrides() { return cockpit.overrides; }, dispose: () => { cockpit.dispose(); if (this.lab === cockpit) this.lab = null; } };
    }, query.get('engine') === 'solid' ? 'solid' : 'structural', () => this.restore());
  }
  get active(): boolean { return this.experiment.running !== null; }
  /** The laboratory in the viewport, by its name. */
  get labName(): string | null { const lab = this.experiment.running; return lab && LABS[lab]; }
  /** Temporary overrides in force: what ending the experiment gives back. */
  get overrides(): number {
    return this.experiment.overrides + Number(matterLab.form !== this.initialForm) + Number(worldLab.only !== this.initialOnly) + Number(tunnelLab.balance !== null) + Number(this.signalChanged);
  }
  /**
   * Open Laboratory: the one named, or without a name the one already running, or else the one last asked for. A
   * laboratory already running is left as it is (its body, its overrides, its measures); another one is ended first.
   * True when a laboratory was started.
   */
  openLab(lab?: Laboratory): boolean {
    const started = this.experiment.open(lab);
    this.mark();
    return started;
  }
  /** Stop Experiment: the laboratory ends and every temporary override goes back; the workspace and its view stay. Safe to repeat. */
  stopExperiment(): void {
    this.experiment.stop();
    this.mark();
    this.status.textContent = 'Override ripristinate';
  }
  /** The overrides that are not a laboratory's own, back to what they were when the tools were built. */
  private restore(): void {
    matterLab.form = this.initialForm; worldLab.only = this.initialOnly; tunnelLab.balance = null;
    // The cockpit's source selector also uses the same AudioEngine. Restore only a test source.
    if (this.signalChanged) {
      if (this.initialSource === 'fake' && this.initialSignal) void this.app.playTestSignal(this.initialSignal);
      else void this.app.audio.setSource(this.initialSource);
    }
    this.signalChanged = false;
  }
  /** The controls show what is in force. */
  private mark(): void {
    const running = this.experiment.running;
    for (const item of this.labButtons) item.hidden = item.dataset.lab === running;
    this.pin.value = matterLab.form; this.tunnel.value = tunnelLab.balance === null ? '' : String(tunnelLab.balance);
    if (!this.signalChanged) this.signal.value = '';
  }
  /**
   * Switch View: the view's sections have just been applied, and what came into the inspector is made ready to show
   * the present. Nothing of the experiment changes: a laboratory keeps running and its overrides stay in force.
   */
  setView(view: WorkspaceView): void {
    if (!this.audio.element.hidden) this.audio.show();
    if (!this.charts.hidden && charted(view)) {
      this.debug ??= new DebugOverlay(this.app, this.controller, this.plots);
      this.debug.setView(view);
      retitle(this.charts, CHARTS[view]);
    }
  }
  /**
   * `shown`: the inspector is on screen; `deck`: so are the panels under the viewport. The traces are sampled either way;
   * nothing is drawn for a panel nobody sees. The canvases come first: text drawn into a canvas resolves its style, and
   * after the panels' writes that would be a style pass of its own.
   */
  refresh(now: number, shown: boolean, deck: boolean): void {
    if (this.lab) { this.lab.visible = shown && !this.labHost.hidden; this.lab.refreshPanel(now); }
    if (shown && !this.charts.hidden && this.charts.open) this.debug?.refresh();
    this.audio.sample(now);
    this.audio.refresh(shown, deck);
    if (shown && !this.controlsPanel.hidden) {
      const lab = this.labName;
      writeText(this.status, lab ? `${lab} attivo · ${this.overrides} override · pin temporaneo` : `Matter: ${matterLab.form} · ${worldLab.only ? 'primitive isolate' : 'nessun isolamento'}`);
    }
  }
  /** Dispose: the experiment is stopped if it still runs, then listeners, observers and nodes are released. Safe to repeat. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.experiment.dispose();
    this.debug?.dispose(); this.audio.dispose(); this.element.remove();
  }
}
