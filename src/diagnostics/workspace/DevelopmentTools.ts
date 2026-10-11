import type { App } from '../../app/App';
import { DebugOverlay, type DebugView } from '../../app/debug/DebugOverlay';
import { structuralLab } from '../../visual-engine/primitives/WirePolygonPrimitive';
import { EngineCockpit } from '../../app/engine/EngineCockpit';
import { TEST_SIGNALS, type TestSignal } from '../../audio/capture/testSignals';
import { matterLab, type FormPin } from '../../render-systems/forms/MatterForms';
import { worldLab } from '../../visual-engine/VisualWorld';
import { settingsStore } from '../../stores/settingsStore';
import { h } from '../../ui/dom';
import type { DiagnosticsController } from '../core/DiagnosticsController';
import { button, section, type WorkspaceView } from './components';

/** Loaded only by the DEV branch of installDiagnostics; all experiments are owned by this workspace. */
export class DevelopmentTools {
  readonly element = h('div');
  private readonly controls = h('div', { class: 'ws-actions' });
  private readonly plots = h('div');
  private readonly labHost = h('div');
  private debug: DebugOverlay | null = null;
  private lab: EngineCockpit | null = null;
  private readonly initialForm = matterLab.form;
  private readonly initialOnly = worldLab.only;
  private readonly initialSource;
  private readonly initialSignal;
  private signalChanged = false;
  private view: WorkspaceView = 'overview';
  private readonly status = h('span', { class: 'ws-lab-status' });
  private readonly labButton = button('Avvia Structural Lab', () => this.startLab());
  private readonly stopButton = button('Termina esperimento', () => this.stopExperiment());
  private readonly pin = h('select', { ariaLabel: 'Forma Matter' });
  private readonly signal = h('select', { ariaLabel: 'Segnale live di test' });
  constructor(private readonly app: App, private readonly controller: DiagnosticsController, parent: HTMLElement) {
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
    this.controls.append(this.signal, this.pin, this.labButton, this.stopButton, this.status);
    this.element.append(section('Experiment · modifiche temporanee, non salvate', this.controls), this.labHost, this.plots);
    parent.append(this.element);
    const query = new URLSearchParams(location.search), form = query.get('matter');
    if (form && ['auto', 'particles', 'wave', 'harmonic'].includes(form)) { matterLab.form = form as FormPin; this.pin.value = form; }
    const only = query.get('primitives');
    if (only) worldLab.only = new Set(only.split(',').filter(Boolean));
  }
  get active(): boolean { return this.lab !== null; }
  startLab(): void {
    if (!this.lab) this.lab = new EngineCockpit(this.app, this.controller, this.labHost);
    this.labButton.hidden = true;
    this.setView(this.view);
  }
  stopExperiment(): void {
    this.lab?.dispose(); this.lab = null;
    matterLab.form = this.initialForm; worldLab.only = this.initialOnly;
    this.pin.value = matterLab.form;
    this.labButton.hidden = false;
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
    if (this.lab) this.lab.visible = view === 'laboratories';
    const plot = ['audio', 'experience', 'world', 'matter'].includes(view);
    this.plots.hidden = !plot;
    this.element.hidden = !plot && view !== 'laboratories';
    if (plot) {
      this.debug ??= new DebugOverlay(this.app, this.controller, this.plots);
      this.debug.setView(view as DebugView);
    }
  }
  refresh(now: number): void {
    this.lab?.refreshPanel(now);
    if (!this.plots.hidden) this.debug?.refresh(now);
    const overrides = Object.entries(structuralLab.tuning).filter(([key, value]) => value !== (key === 'coherence' || key === 'temperature' ? null : 1)).length;
    this.status.textContent = this.lab ? `Structural Lab attivo · ${overrides} override · pin temporaneo` : `Matter: ${matterLab.form} · ${worldLab.only ? 'primitive isolate' : 'nessun isolamento'}`;
  }
  dispose(): void { this.stopExperiment(); this.debug?.dispose(); this.element.remove(); }
}
