import type { App } from '../../app/App';
import { DebugOverlay, type DebugView } from '../../app/debug/DebugOverlay';
import { CognitionLab } from '../../app/engine/CognitionLab';
import { EmergenceLab } from '../../app/engine/EmergenceLab';
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
import { MusicalCognitionPanel } from './MusicalCognition';
import { button, panel, retitle, writeText, type WorkspaceView } from './components';
import { Experiment, LABS, type Laboratory } from './Experiment';
import { block, type Block } from './sections';

const CHARTS: Record<DebugView, string> = {
  experience: 'Regia, analisi, previsione ed eventi', world: 'Mondo, energia e forze', matter: 'Morfologia, materiale e primitive',
};
const charted = (view: WorkspaceView): view is DebugView => view in CHARTS;
/** The ledger's keys for the overrides set from here (primitive isolation is the controller's: `isolate`). */
const MATTER_FORM = 'matter.form', TUNNEL_BALANCE = 'tunnel.balance', AUDIO_SOURCE = 'audio.source', COGNITION = 'cognition.enabled', COGNITION_DIRECT = 'cognition.direct';

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
  /** Musical Cognition: clock, understanding, predictions (Audio & Analysis, Experience & Direction). */
  private readonly cognition: MusicalCognitionPanel;
  private readonly labHost = h('div');
  private readonly controlsPanel: HTMLElement;
  private debug: DebugOverlay | null = null;
  private lab: EngineCockpit | SolidCockpit | CognitionLab | EmergenceLab | null = null;
  /** Which laboratory runs, and when it starts and ends: the view shown has no part in it. */
  private readonly experiment: Experiment;
  private disposed = false;
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
  /** The musical cognition as it is, with the director back on its reactive path, or off: `cognition.config`, back on leaving. */
  private readonly cognitionMode = h('select', { ariaLabel: 'Musical Cognition' });
  constructor(private readonly app: App, private readonly controller: DiagnosticsController, parent: HTMLElement, deck: HTMLElement) {
    // Every override below goes through the controller's ledger: it remembers what was there, and gives it back once.
    const overrides = controller.overrides;
    this.signal.append(new Option('Sorgente live', ''), ...TEST_SIGNALS.map(s => new Option(s.label, s.id)));
    this.signal.onchange = () => {
      this.holdSource();
      if (this.signal.value) void app.playTestSignal(this.signal.value as TestSignal);
      else void app.audio.setSource(settingsStore.get().source);
    };
    for (const form of ['auto', 'particles', 'wave', 'harmonic'] as const) this.pin.append(new Option(`Matter: ${form}`, form));
    this.pin.value = matterLab.form;
    this.pin.onchange = () => overrides.set(MATTER_FORM, matterLab, 'form', this.pin.value as FormPin, 'experiment controls');
    this.tunnel.append(new Option('Tunnel: preset', ''), new Option('Tunnel: Balanced', '1'), new Option('Tunnel: com\'era (legacy)', '0'));
    this.tunnel.onchange = () => overrides.set(TUNNEL_BALANCE, tunnelLab, 'balance', this.tunnel.value === '' ? null : Number(this.tunnel.value), 'experiment controls');
    this.cognitionMode.append(new Option('Cognition: preset', ''), new Option('Cognition: regia reattiva', 'reactive'), new Option('Cognition: spenta', 'off'));
    this.cognitionMode.onchange = () => {
      const config = app.audio.experience.cognition.config, mode = this.cognitionMode.value;
      overrides.release(COGNITION, 'experiment controls'); overrides.release(COGNITION_DIRECT, 'experiment controls');
      if (mode === 'off') overrides.set(COGNITION, config, 'enabled', false, 'experiment controls');
      else if (mode === 'reactive') overrides.set(COGNITION_DIRECT, config, 'direct', false, 'experiment controls');
    };
    // Ending the experiment has one control, in the workspace's toolbar.
    this.controls.append(this.signal, this.pin, this.tunnel, this.cognitionMode, ...this.labButtons, this.status);
    this.element.className = 'ws-development';
    this.element.append(this.charts);
    this.audio = new AudioAnalysis(app, this.element, deck);
    this.cognition = new MusicalCognitionPanel(app);
    this.element.append(...this.cognition.elements);
    this.controlsPanel = panel({ title: 'Experiment Controls', icon: 'flask', sub: 'modifiche temporanee, non salvate' }, this.controls);
    this.element.append(this.controlsPanel, this.labHost);
    this.blocks = [block(this.charts, 'charts'), block(this.audio.element, 'audio'), ...this.cognition.elements.map(e => block(e, 'cognition')), block(this.controlsPanel, 'experiment'), block(this.labHost, 'laboratory')];
    parent.append(this.element);
    const query = new URLSearchParams(location.search), form = query.get('matter');
    if (form && ['auto', 'particles', 'wave', 'harmonic'].includes(form)) { overrides.set(MATTER_FORM, matterLab, 'form', form as FormPin, '?matter'); this.pin.value = form; }
    const only = query.get('primitives');
    if (only) controller.isolate(only.split(',').filter(Boolean), '?primitives');
    // The laboratory a shortcut, the sidebar or `?engine` opens first: Structural Lab, or the one named by `?engine=solid`.
    this.experiment = new Experiment((lab) => {
      this.lab = lab === 'solid' ? new SolidCockpit(this.app, this.controller, this.labHost) : lab === 'cognition' ? new CognitionLab(this.labHost)
        : lab === 'emergence' ? new EmergenceLab(this.app, this.controller, this.labHost) : new EngineCockpit(this.app, this.controller, this.labHost);
      const cockpit = this.lab;
      return { get overrides() { return cockpit.overrides; }, dispose: () => { cockpit.dispose(); if (this.lab === cockpit) this.lab = null; } };
    }, (['solid', 'cognition', 'emergence'] as const).find((lab) => lab === query.get('engine')) ?? 'structural', overrides);
  }
  get active(): boolean { return this.experiment.running !== null; }
  /** The laboratory in the viewport, by its name. */
  get labName(): string | null { const lab = this.experiment.running; return lab && LABS[lab]; }
  /** Temporary overrides in force: what ending the experiment gives back. */
  get overrides(): number { return this.experiment.overrides; }
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
  /**
   * Before the first test signal: what was being captured is remembered once, to be given back when the experiment
   * stops. The capture is shared and restarting it starts a new audio session, so it is restarted only if what plays
   * then is not what played before.
   */
  private holdSource(): void {
    const audio = this.app.audio;
    if (this.controller.overrides.has(AUDIO_SOURCE)) return;
    const source = audio.state.source ?? settingsStore.get().source, signal = TEST_SIGNALS.find(s => s.label === audio.state.deviceName);
    this.controller.overrides.hold(AUDIO_SOURCE, () => {
      if (source === 'fake' && signal) { if (audio.state.deviceName !== signal.label) void this.app.playTestSignal(signal.id); }
      else if (audio.state.source !== source) void audio.setSource(source);
    }, 'experiment controls');
  }
  /** The controls show what is in force. */
  private mark(): void {
    const running = this.experiment.running;
    for (const item of this.labButtons) item.hidden = item.dataset.lab === running;
    this.pin.value = matterLab.form; this.tunnel.value = tunnelLab.balance === null ? '' : String(tunnelLab.balance);
    const config = this.app.audio.experience.cognition.config;
    this.cognitionMode.value = !config.enabled ? 'off' : !config.direct ? 'reactive' : '';
    if (!this.controller.overrides.has(AUDIO_SOURCE)) this.signal.value = '';
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
    this.cognition.sample();
    if (shown) this.cognition.refresh();
    if (shown && !this.controlsPanel.hidden) {
      const lab = this.labName;
      writeText(this.status, lab ? `${lab} attivo · ${this.overrides} override${this.experiment.running === 'cognition' ? ' · nessun pin' : ' · pin temporaneo'}` : `Matter: ${matterLab.form} · ${worldLab.only ? 'primitive isolate' : 'nessun isolamento'}`);
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
