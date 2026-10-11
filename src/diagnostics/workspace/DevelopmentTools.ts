import type { App } from '../../app/App';
import { DebugOverlay, type DebugView } from '../../app/debug/DebugOverlay';
import { structuralLab } from '../../visual-engine/primitives/WirePolygonPrimitive';
import { EngineCockpit } from '../../app/engine/EngineCockpit';
import { SolidCockpit } from '../../app/engine/SolidCockpit';
import { TEST_SIGNALS, type TestSignal } from '../../audio/capture/testSignals';
import { matterLab, type FormPin } from '../../render-systems/forms/MatterForms';
import { worldLab } from '../../visual-engine/VisualWorld';
import { settingsStore } from '../../stores/settingsStore';
import { h } from '../../ui/dom';
import type { DiagnosticsController } from '../core/DiagnosticsController';
import { AudioAnalysis } from './AudioAnalysis';
import { button, panel, retitle, writeText, type WorkspaceView } from './components';

const CHARTS: Record<DebugView, string> = {
  experience: 'Regia, analisi, previsione ed eventi', world: 'Mondo, energia e forze', matter: 'Morfologia, materiale e primitive',
};

/** The laboratories: each a development world with its own inspector. One runs at a time (each pins the viewport's world). */
export type Laboratory = 'structural' | 'solid';
const LABS: Record<Laboratory, string> = { structural: 'Structural Lab', solid: 'Solid Dynamics' };

/** Loaded only by the DEV branch of installDiagnostics; all experiments are owned by this workspace. */
export class DevelopmentTools {
  readonly element = h('div');
  private readonly controls = h('div', { class: 'ws-actions' });
  private readonly plots = h('div');
  /** The view's live charts: one retained canvas, whose block is renamed (not rebuilt) from a view to the next. */
  private readonly charts = panel({ title: CHARTS.experience, icon: 'pulse' }, this.plots);
  /** Audio & Analysis as panels, and what stands under the viewport in every view. */
  private readonly audio: AudioAnalysis;
  private readonly labHost = h('div');
  private debug: DebugOverlay | null = null;
  private lab: EngineCockpit | SolidCockpit | null = null;
  private running: Laboratory | null = null;
  /** The laboratory a shortcut or `?engine` opens: Structural Lab, or the one named by `?engine=solid`. */
  private readonly requested: Laboratory;
  private readonly initialForm = matterLab.form;
  private readonly initialOnly = worldLab.only;
  private readonly initialSource;
  private readonly initialSignal;
  private signalChanged = false;
  private view: WorkspaceView = 'overview';
  private readonly status = h('span', { class: 'ws-lab-status' });
  private readonly labButtons = (Object.keys(LABS) as Laboratory[]).map((lab) => {
    const item = button(`Avvia ${LABS[lab]}`, () => this.startLab(lab));
    item.dataset.lab = lab;
    return item;
  });
  private readonly stopButton = button('Termina esperimento', () => this.stopExperiment());
  private readonly pin = h('select', { ariaLabel: 'Forma Matter' });
  private readonly signal = h('select', { ariaLabel: 'Segnale live di test' });
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
    this.controls.append(this.signal, this.pin, ...this.labButtons, this.stopButton, this.status);
    this.element.className = 'ws-development';
    this.element.append(this.charts);
    this.audio = new AudioAnalysis(app, this.element, deck);
    this.element.append(panel({ title: 'Experiment Controls', icon: 'flask', sub: 'modifiche temporanee, non salvate' }, this.controls), this.labHost);
    parent.append(this.element);
    const query = new URLSearchParams(location.search), form = query.get('matter');
    if (form && ['auto', 'particles', 'wave', 'harmonic'].includes(form)) { matterLab.form = form as FormPin; this.pin.value = form; }
    const only = query.get('primitives');
    if (only) worldLab.only = new Set(only.split(',').filter(Boolean));
    this.requested = query.get('engine') === 'solid' ? 'solid' : 'structural';
  }
  get active(): boolean { return this.lab !== null; }
  /** Enters a laboratory. Without a name: the one already running, or the one the entry asked for. Another one running is left first. */
  startLab(lab: Laboratory = this.running ?? this.requested): void {
    if (this.running !== lab) {
      // The pin goes back to what it was before the laboratory that is leaving, so the next one restores the same.
      this.lab?.dispose();
      this.lab = lab === 'solid' ? new SolidCockpit(this.app, this.controller, this.labHost) : new EngineCockpit(this.app, this.controller, this.labHost);
      this.running = lab;
    }
    for (const item of this.labButtons) item.hidden = item.dataset.lab === lab;
    this.setView(this.view);
  }
  stopExperiment(): void {
    this.lab?.dispose(); this.lab = null; this.running = null;
    matterLab.form = this.initialForm; worldLab.only = this.initialOnly;
    this.pin.value = matterLab.form;
    for (const item of this.labButtons) item.hidden = false;
    // The cockpit's source selector also uses the same AudioEngine. Restore only a test source.
    if (this.signalChanged) {
      if (this.initialSource === 'fake' && this.initialSignal) void this.app.playTestSignal(this.initialSignal);
      else void this.app.audio.setSource(this.initialSource);
    }
    this.signalChanged = false; this.signal.value = '';
    this.status.textContent = 'Override ripristinate';
  }
  setView(view: WorkspaceView): void {
    this.view = view;
    this.labHost.hidden = view !== 'laboratories';
    const plot = view === 'experience' || view === 'world' || view === 'matter';
    this.charts.hidden = !plot;
    this.audio.element.hidden = view !== 'audio';
    this.element.hidden = !plot && view !== 'audio' && view !== 'laboratories';
    if (view === 'audio') this.audio.show();
    if (plot) {
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
    if (this.lab) { this.lab.visible = shown && this.view === 'laboratories'; this.lab.refreshPanel(now); }
    if (shown && !this.charts.hidden && this.charts.open) this.debug?.refresh();
    this.audio.sample(now);
    this.audio.refresh(shown, deck);
    const overrides = this.lab instanceof SolidCockpit ? this.lab.overrides
      : Object.entries(structuralLab.tuning).filter(([key, value]) => value !== (key === 'coherence' || key === 'temperature' ? null : 1)).length;
    writeText(this.status, this.running ? `${LABS[this.running]} attivo · ${overrides} override · pin temporaneo` : `Matter: ${matterLab.form} · ${worldLab.only ? 'primitive isolate' : 'nessun isolamento'}`);
  }
  dispose(): void { this.stopExperiment(); this.debug?.dispose(); this.audio.dispose(); this.element.remove(); }
}
