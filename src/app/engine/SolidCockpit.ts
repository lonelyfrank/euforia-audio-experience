import type { DiagnosticsController } from '../../diagnostics/core/DiagnosticsController';
import { lineChart, Trace } from '../../diagnostics/workspace/charts';
import { button, legend, meter, panel, tile, TONE, writeMeter, writeText, writeTile, type Meter } from '../../diagnostics/workspace/components';
import { h } from '../../ui/dom';
import { resetSolidLab, setSolidProfile, SOLID_DRAW_CALLS, SOLID_VIEWS, solidLab, SolidPrimitive, type SolidCommand, type SolidView } from '../../visual-engine/primitives/SolidPrimitive';
import { RecipeVisualizer } from '../../visual-engine/RecipeVisualizer';
import solidLabScene, { SOLID_LAB } from '../../visual-engine/structural/lab/solid';
import { createReadout } from '../../visual-engine/structural/SolidDynamics';
import {
  createFractureTuning, FRACTURE_LIMITS, FRACTURE_MODES, SOLID_KINDS, SOLID_LIMITS, SOLID_PROFILES, solidProfile, type FractureMode, type FractureTuning, type SolidKind,
  type SolidProfile, type SolidTuning,
} from '../../visual-engine/structural/SolidTypes';
import { createTuning, type StructuralTuning } from '../../visual-engine/structural/StructuralTypes';
import { registerLaboratory } from '../../visualizers/registry';
import type { App } from '../App';

/**
 * The Solid Dynamics laboratory in the Engine Workspace inspector: what the body in the viewport is (geometry), what
 * it is made of (its material and its physics, as temporary values), how it may break (the fracture gate), how the
 * audio is calibrated, how it is holding (structural health), what it takes of the sound (resonance) and the tools
 * to try it without sound. Every number is read from the simulation's state; nothing is kept here but thirty seconds
 * of what was shown. No window, listener or frame loop of its own: the workspace's refresh drives it. Entering
 * registers and pins the laboratory's world; leaving restores overrides, the calibration switch and the pin.
 *
 * Comparisons are made on one body, one after the other, never side by side: the material, the way of breaking and
 * the calibration are switched in place, and Reset structure seeds the same body again from the same seed.
 */

const KIND_LABELS: Record<SolidKind, string> = { tetrahedron: 'Tetrahedron', cube: 'Cube', icosahedron: 'Icosahedron' };
const PROFILE_LABELS: Record<SolidProfile, string> = { rigid: 'Rigid', elastic: 'Elastic', legacy: 'Legacy' };
const MODE_LABELS: Record<FractureMode, string> = { events: 'Events', load: 'Load' };
const VIEW_LABELS: Record<SolidView, string> = {
  vertices: 'Vertices', edges: 'Edges', faces: 'Faces', wireframe: 'Wireframe + Faces', constraints: 'Structural Constraints', fragments: 'Fragments', all: 'All',
};
const HISTORY = [['Integrity', TONE.green], ['Stress', TONE.magenta], ['Volume / rest', TONE.cyan], ['Deformation ×10', TONE.amber]] as const;

/** One factor of the material or of the structural tuning; a level (coherence) is the world's own until ticked. */
interface Control { label: string; min: number; max: number; level?: boolean; read(): number | null; write(value: number | null): void }

export class SolidCockpit {
  readonly element = h('div', { class: 'ws-lab-grid ws-solid' });
  readonly label = 'Solid Dynamics';
  visible = true;
  private readonly readout = createReadout();
  private readonly previousPin: string | null;
  private readonly withdraw: () => void;
  private readonly releaseDiagnostics: () => void;
  private readonly sync: (() => void)[] = [];
  private readonly traces = HISTORY.map(() => new Trace());
  private readonly history = lineChart(HISTORY.map(([, tone]) => tone));
  private readonly geometry = ['Solid', 'Vertices', 'Edges', 'Faces', 'Volume cells', 'Internal links'].map((label) => tile(label));
  private readonly physics = ['Mass', 'Stiffness', 'Damping', 'Volume compliance', 'Solver'].map((label) => tile(label));
  private readonly health = ['Kinetic energy', 'Elastic energy', 'Volume / reference', 'Broken constraints', 'Fragments', 'State'].map((label) => tile(label));
  private readonly levels: Meter[] = [meter('Integrity', TONE.green), meter('Stress · mean', TONE.magenta), meter('Stress · peak', TONE.red)];
  private readonly sound: Meter[] = [meter('Macro', TONE.orange, true), meter('Meso', TONE.green), meter('Micro', TONE.cyan), meter('Deformation ×10', TONE.amber)];
  private readonly gate = ['Last event', 'Weight / bar', 'Passed', 'Refused'].map((label) => tile(label));
  private readonly calibration = ['Learning state', 'Confidence', 'Relative energy', 'Dynamic range', 'Response gain', 'Track scale'].map((label) => tile(label));
  private readonly heard: Meter[] = [meter('Lows', TONE.orange), meter('Attack', TONE.magenta), meter('Pulse drive', TONE.cyan)];
  private readonly metrics = ['Rest shape deviation', 'Max edge strain', 'Volume error', 'Inverted cells', 'Body pulse', 'Fragments', 'Fracture events', 'Solver', 'Frame budget'].map((label) => tile(label));
  private readonly cost = h('div', { class: 'ws-table' });
  private readonly kinds = h('div', { class: 'ws-actions' });
  private readonly views = h('div', { class: 'ws-actions' });
  private readonly profiles = h('div', { class: 'ws-actions' });
  private readonly modes = h('div', { class: 'ws-actions' });
  private readonly calibrate = h('div', { class: 'ws-actions' });
  /** Whether the calibration was on when the laboratory was entered: what leaving restores. */
  private readonly calibrated: boolean;
  private readonly note = h('p', { class: 'ws-note' });
  private session = -1;
  private lastSample = -1;

  constructor(private readonly app: App, private readonly diagnostics: DiagnosticsController, parent: HTMLElement) {
    this.previousPin = app.pinnedScene;
    this.withdraw = registerLaboratory(solidLabScene);
    resetSolidLab();
    solidLab.active = true;
    for (const kind of SOLID_KINDS) this.kinds.append(this.choice(this.kinds, 'kind', kind, KIND_LABELS[kind], () => { solidLab.kind = kind; }));
    for (const view of SOLID_VIEWS) this.views.append(this.choice(this.views, 'view', view, VIEW_LABELS[view], () => { solidLab.view = view; }));
    for (const profile of SOLID_PROFILES) this.profiles.append(this.choice(this.profiles, 'profile', profile, PROFILE_LABELS[profile], () => { setSolidProfile(profile); solidLab.command = 'reset'; for (const read of this.sync) read(); }));
    for (const mode of [...FRACTURE_MODES].reverse()) this.modes.append(this.choice(this.modes, 'mode', mode, MODE_LABELS[mode], () => { solidLab.fracture.mode = mode; }));
    this.calibrated = app.audio.experience.calibration.enabled;
    for (const on of [true, false]) this.calibrate.append(this.choice(this.calibrate, 'calibration', String(on), on ? 'Enabled' : 'Disabled', () => { app.audio.experience.calibration.enabled = on; }));
    this.mark(this.kinds, 'kind', solidLab.kind); this.mark(this.views, 'view', solidLab.view);
    const material = (key: keyof SolidTuning, label: string): Control => ({ label, min: SOLID_LIMITS[key][0], max: SOLID_LIMITS[key][1], read: () => solidLab.material[key], write: (value) => { solidLab.material[key] = value ?? solidProfile(solidLab.profile)[key]; } });
    const gate = (key: Exclude<keyof FractureTuning, 'mode'>, label: string): Control => ({ label, min: FRACTURE_LIMITS[key][0], max: FRACTURE_LIMITS[key][1], read: () => solidLab.fracture[key], write: (value) => { solidLab.fracture[key] = value ?? createFractureTuning()[key]; } });
    const tuning = (key: keyof StructuralTuning, label: string, min: number, max: number, level = false): Control => ({
      label, min, max, level, read: () => solidLab.tuning[key], write: (value) => { (solidLab.tuning[key] as number | null) = level ? value : value ?? 1; },
    });
    const command = (label: string, value: SolidCommand, title: string): HTMLButtonElement => button(label, () => { solidLab.command = value; }, title);
    this.element.append(
      panel({ title: 'Solid Dynamics', icon: 'hex', sub: 'laboratorio · temporaneo, non salvato' },
        h('div', { class: 'ws-caption' }, h('b', {}, 'Solid')), this.kinds, h('div', { class: 'ws-caption' }, h('b', {}, 'View')), this.views, this.note),
      panel({ title: 'Geometry', icon: 'layers', sub: 'topology of the simulation' }, h('div', { class: 'ws-metrics ws-metrics-text' }, ...this.geometry.map((t) => t.element))),
      panel({ title: 'Material', icon: 'layers', sub: 'what holds the shape · not saved' },
        h('div', { class: 'ws-caption' }, h('b', {}, 'Material mode')), this.profiles,
        this.controls([material('shapeRetention', 'Shape retention'), material('maxPulse', 'Maximum pulse'), material('damping', 'Damping ×'), tuning('resonanceCoupling', 'Resonance coupling ×', 0, 3),
          material('toughness', 'Structural toughness ×'), material('recovery', 'Recovery rate ×')])),
      panel({ title: 'Fracture', icon: 'pulse', sub: 'when a body may break by itself' },
        h('div', { class: 'ws-caption' }, h('b', {}, 'Mode')), this.modes,
        h('div', { class: 'ws-metrics ws-metrics-text' }, ...this.gate.map((t) => t.element)),
        this.controls([gate('confidence', 'Event confidence'), gate('threshold', 'Fracture threshold'), gate('cooldown', 'Cooldown · s'), material('fragmentIntegrity', 'Fragments integrity'),
          tuning('fractureThreshold', 'Fracture resistance ×', 0.2, 3)])),
      panel({ title: 'Adaptive Calibration', icon: 'wave', sub: 'how strongly this audio moves what answers it' },
        this.calibrate, h('div', { class: 'ws-metrics ws-metrics-text' }, ...this.calibration.map((t) => t.element)), h('div', { class: 'ws-meters' }, ...this.heard.map((m) => m.element))),
      panel({ title: 'Physics', icon: 'sliders', sub: 'factors on the material · not saved' },
        h('div', { class: 'ws-metrics ws-metrics-text' }, ...this.physics.map((t) => t.element)),
        this.controls([material('mass', 'Mass ×'), material('stiffness', 'Stiffness ×'), material('volumeCompliance', 'Volume compliance ×'), tuning('environmentCoupling', 'Environment coupling ×', 0, 3)])),
      panel({ title: 'Structural Health', icon: 'pulse', sub: 'measured each step' },
        h('div', { class: 'ws-meters' }, ...this.levels.map((m) => m.element)), h('div', { class: 'ws-metrics ws-metrics-text' }, ...this.health.map((t) => t.element)),
        h('div', { class: 'ws-chart ws-chart-history' }, h('div', { class: 'ws-plot' }, this.history.element)), legend(HISTORY)),
      panel({ title: 'Resonance', icon: 'wave', sub: 'what the body takes of the sound, and its answer' }, h('div', { class: 'ws-meters' }, ...this.sound.map((m) => m.element))),
      panel({ title: 'Debug & Metrics', icon: 'render', sub: 'measured on the state · five times a second' }, h('div', { class: 'ws-metrics ws-metrics-text' }, ...this.metrics.map((t) => t.element))),
      panel({ title: 'Experiment', icon: 'flask', sub: 'diagnostic tools · impulses, never displacements' },
        h('div', { class: 'ws-actions' },
          command('Reset structure', 'reset', 'The body whole again, at rest'),
          command('Seed & form', 'seed', 'Its matter apart, every link remembered, none holding: it forms when the world lets it'),
          command('Impulse', 'impulse', 'A blow from outside, beside one vertex'),
          command('Torsion', 'twist', 'The two ends turned against each other'),
          command('Fracture test', 'fracture', 'A blow from within, strong enough to break links (on a body that breaks on events: one fracture through the gate)'),
          command('Musical event', 'event', 'An event that stands out, offered to the gate as the session\'s own would be: it passes or not')),
        this.controls([tuning('coherence', 'Environment coherence', 0, 1, true), tuning('temperature', 'Environment temperature', 0, 1, true)]),
        h('div', { class: 'ws-actions' }, button('Restore initial conditions', () => this.restore(), 'Every override back to the product\'s value, the body whole again'))),
      panel({ title: 'Budget & Cost', icon: 'render', sub: 'fixed pools · CPU per frame' }, this.cost),
    );
    parent.append(this.element);
    app.pinScene(SOLID_LAB);
    this.releaseDiagnostics = diagnostics.acquire();
  }

  /** Overrides set now: what the status line counts. */
  get overrides(): number {
    // Against the material chosen: a profile is not an override, a slider moved from it is.
    const tuning = createTuning(), material = solidProfile(solidLab.profile);
    return (Object.keys(tuning) as (keyof StructuralTuning)[]).filter((key) => solidLab.tuning[key] !== tuning[key]).length
      + (Object.keys(material) as (keyof SolidTuning)[]).filter((key) => solidLab.material[key] !== material[key]).length
      + (this.app.audio.experience.calibration.enabled ? 0 : 1);
  }

  dispose(): void {
    this.releaseDiagnostics();
    this.element.remove();
    // Nothing of the laboratory outlives it: the overrides, the view and the pinned world go back to the product's.
    resetSolidLab();
    this.app.audio.experience.calibration.enabled = this.calibrated;
    this.app.pinScene(this.previousPin);
    this.withdraw();
  }

  refreshPanel(now: number): void {
    const solid = this.solid, system = solid?.system, solids = system?.solids ?? null, body = solids && solids.state.bodies > 0 ? 0 : -1;
    const r = solids && body >= 0 ? solids.read(body, solid!.environment, this.readout) : null;
    if (this.session !== this.app.audio.session) {
      this.session = this.app.audio.session; this.lastSample = -1;
      for (const trace of this.traces) trace.reset();
    }
    // Five samples a second, whatever the frame rate and whether or not the panel is in view.
    const sample = Math.floor(now / 200);
    if (sample !== this.lastSample) {
      this.lastSample = sample;
      this.traces[0].push(r ? r.integrity : 0); this.traces[1].push(r ? Math.min(1, r.stress) : 0);
      this.traces[2].push(r && r.volumeRest > 0 ? Math.min(2, r.volume / r.volumeRest) / 2 : 0); this.traces[3].push(r ? Math.min(1, 10 * r.response) : 0);
    }
    if (!this.visible) return;
    this.mark(this.kinds, 'kind', solidLab.kind); this.mark(this.views, 'view', solidLab.view);
    this.mark(this.profiles, 'profile', solidLab.profile); this.mark(this.modes, 'mode', solidLab.fracture.mode);
    const experience = this.app.audio.experience, heard = experience.ready ? experience.presented.calibration : experience.calibration.frame;
    this.mark(this.calibrate, 'calibration', String(experience.calibration.enabled));
    const [phase, confidence, energy, range, gain, scale] = this.calibration;
    writeTile(phase, heard.phase, heard.epoch ? `epoch ${heard.epoch}` : ''); writeTile(confidence, heard.confidence.toFixed(2), `${heard.observed.toFixed(0)} s heard`);
    writeTile(energy, heard.energy.toFixed(2)); writeTile(range, heard.range.toFixed(1), 'LU'); writeTile(gain, `× ${heard.gain.toFixed(2)}`, `stability ${heard.stability.toFixed(2)}`);
    writeTile(scale, `× ${heard.scale.toFixed(2)}`, `character ${heard.character.toFixed(2)}`);
    writeMeter(this.heard[0], heard.low); writeMeter(this.heard[1], heard.transient); writeMeter(this.heard[2], solid?.environment.pulse ?? 0);
    if (!r || !solids || !system || !solid) {
      writeText(this.note, 'Nessun solido in questo mondo: il laboratorio è in attesa della scena.');
      return;
    }
    const f2 = (x: number): string => x.toFixed(2), f3 = (x: number): string => x.toFixed(3), stats = solids.stats, state = solids.state, material = solids.tuning;
    const percent = (x: number, digits = 2): string => `${(100 * x).toFixed(digits)} %`, judged = solids.gate.stats;
    const [verdict, weight, passed, refused] = this.gate;
    writeTile(verdict, judged.verdict, solids.gate.tuning.mode); writeTile(weight, `${f2(judged.weight)} / ${f2(judged.bar)}`);
    writeTile(passed, `${judged.fired} / ${judged.offered}`, judged.manual ? `${judged.manual} by tool` : 'events');
    writeTile(refused, `${judged.threshold} · ${judged.cooldown} · ${judged.confidence} · ${judged.budget}`, 'bar · cooldown · trust · budget');
    const [deviation, strain, volumeError, inverted, pulse, pieces, events, solveTime, budgetTile] = this.metrics;
    writeTile(deviation, percent(r.deviation, 3), 'of its scale'); writeTile(strain, percent(r.edgeStrain), 'incl. pulse'); writeTile(volumeError, percent(r.volumeError), r.cellsHolding ? 'vs target' : 'open');
    writeTile(inverted, String(stats.inverted)); writeTile(pulse, `${r.pulse >= 0 ? '+' : ''}${percent(r.pulse)}`, `scale ${percent(r.scale - 1)}`);
    writeTile(pieces, r.pieces > 1 ? String(r.pieces) : '0', r.form); writeTile(events, String(stats.events), `${stats.fractures} links · ${stats.reforms} reformed`);
    writeTile(solveTime, stats.solveMs.toFixed(3), 'ms / frame'); writeTile(budgetTile, `${solids.budget.frameMs.toFixed(2)} ms`, `over in ${stats.over}`);
    writeText(this.note, this.app.audio.experience.ready
      ? 'Mondo vivo: il suono muove ciò a cui link e celle tendono; i legami ricordati possono riformarsi.'
      : 'Senza suono: impulsi e torsioni dissipano; nulla di nuovo si forma finché il mondo non è vivo.');
    const [kind, vertices, edges, faces, cells, internal] = this.geometry;
    writeTile(kind, KIND_LABELS[r.kind]); writeTile(vertices, String(r.vertices)); writeTile(edges, `${r.edgesIntact} / ${r.edges}`);
    writeTile(faces, `${r.facesHolding} / ${r.faces}`, `${r.triangles} tri`); writeTile(cells, `${r.cellsHolding} / ${r.cells}`); writeTile(internal, `${r.bracesIntact} / ${r.braces}`, 'braces');
    const [mass, stiffness, damping, compliance, solver] = this.physics;
    writeTile(mass, f2(r.mass), `× ${f2(material.mass)}`); writeTile(stiffness, `× ${f2(material.stiffness)}`); writeTile(damping, `× ${f2(material.damping)}`);
    writeTile(compliance, `× ${f2(material.volumeCompliance)}`); writeTile(solver, `XPBD · ${stats.iterations}`, 'iter');
    writeMeter(this.levels[0], r.integrity); writeMeter(this.levels[1], r.stress); writeMeter(this.levels[2], r.peak);
    const [kinetic, elastic, volume, broken, fragments, form] = this.health;
    writeTile(kinetic, f3(r.kinetic)); writeTile(elastic, f3(r.elastic), 'est.');
    writeTile(volume, r.cellsHolding ? `${(100 * r.volume / r.volumeRest).toFixed(1)} %` : '—', r.cellsHolding ? `${f3(r.volume)} / ${f3(r.volumeReference)}` : 'open');
    writeTile(broken, String(r.broken + r.lost), r.lost ? `${r.lost} lost` : 'remembered'); writeTile(fragments, r.pieces > 1 ? String(r.pieces) : '0', r.pieces > 1 ? 'pieces' : 'whole');
    writeTile(form, r.form, r.sealed ? 'sealed' : 'open');
    this.history.update(this.traces);
    writeMeter(this.sound[0], r.macro); writeMeter(this.sound[1], r.meso); writeMeter(this.sound[2], r.micro); writeMeter(this.sound[3], Math.min(1, 10 * r.response));
    for (const read of this.sync) read();
    const drawn = this.diagnostics.renderer?.drawn, budget = solids.budget;
    this.table([
      ['elements', `${system.state.count} / ${system.state.capacity}`], ['bodies', `${state.bodies} / ${state.bodyCapacity}`],
      ['links · intact / broken / lost', `${stats.intact} / ${stats.broken} / ${stats.lost} of ${state.linkCapacity}`],
      ['surface triangles holding', `${stats.faces} of ${state.faceCapacity}`], ['cells holding', `${stats.cells} of ${state.cellCapacity}`],
      ['solver iterations', `${budget.iterations} fixed`], ['steps this frame', `${system.stats.steps} of 8 · ${(1 / system.config.step).toFixed(0)} Hz`],
      ['solid pass / frame', `${stats.solveMs.toFixed(3)} ms · peak ${stats.peakMs.toFixed(2)}`], ['· topology', `${stats.bookMs.toFixed(3)} ms`],
      ['structural step / frame', `${system.stats.stepMs.toFixed(3)} ms`], ['buffers / frame', `${solid.debug['buffer ms'].toFixed(3)} ms`],
      ['budget', `${budget.frameMs.toFixed(2)} ms · over in ${stats.over} frames`],
      ['fractures / reformed', `${stats.fractures} / ${stats.reforms}`], ['refused · repaired · inverted', `${stats.refused} · ${stats.repairs} · ${stats.inverted}`],
      ['solid draw calls', String(SOLID_DRAW_CALLS)], ['points · segments · triangles', `${solid.drawn.points} · ${solid.drawn.lines} · ${solid.drawn.triangles}`],
      ['frame draw calls', drawn ? String(drawn.calls) : '—'], ['GPU time', 'not measured here'],
    ]);
  }

  // ---- the world in the viewport -------------------------------------------------------------

  private get solid(): SolidPrimitive | null {
    const scene = this.app.directionDebug.current?.visualizer;
    const primitive = scene instanceof RecipeVisualizer ? scene.world.primitive('solid') : null;
    return primitive instanceof SolidPrimitive ? primitive : null;
  }

  private restore(): void {
    const { kind, view } = solidLab;
    resetSolidLab();
    this.app.audio.experience.calibration.enabled = true;
    Object.assign(solidLab, { active: true, kind, view, command: 'reset' });
    for (const read of this.sync) read();
  }

  // ---- controls -------------------------------------------------------------------------------

  private choice(group: HTMLElement, key: string, value: string, label: string, pick: () => void): HTMLButtonElement {
    const item = button(label, () => { pick(); this.mark(group, key, value); });
    item.dataset[key] = value;
    return item;
  }

  private mark(group: HTMLElement, key: string, value: string): void {
    for (const item of group.querySelectorAll('button')) if (item.getAttribute('aria-pressed') !== String(item.dataset[key] === value)) item.setAttribute('aria-pressed', String(item.dataset[key] === value));
  }

  /** Sliders within fixed bounds; a level replaces the world's value only while ticked. Each shows the value in force. */
  private controls(items: Control[]): HTMLElement {
    const list = h('div', { class: 'ws-sliders' });
    for (const control of items) {
      const readout = h('span', {}), range = h('input', { type: 'range', ariaLabel: control.label, min: String(control.min), max: String(control.max), step: '0.01' });
      const tick = h('input', { type: 'checkbox', ariaLabel: `Override ${control.label}`, title: control.level ? 'Replace the world\'s own value' : 'Always applied', disabled: !control.level, checked: !control.level });
      const write = (): void => {
        const off = !!control.level && !tick.checked;
        control.write(off ? null : Number(range.value));
        writeText(readout, off ? 'world' : Number(range.value).toFixed(2));
      };
      // A level that is off rests in the middle of its range until it is ticked.
      range.value = String(control.read() ?? (control.min + control.max) / 2);
      range.oninput = write; tick.onchange = write;
      // The switch is the truth: a control never shows a value the simulation is not using.
      this.sync.push(() => {
        const value = control.read();
        if (document.activeElement === range) return;
        if (control.level) tick.checked = value !== null;
        if (value !== null && Number(range.value) !== value) range.value = String(value);
        writeText(readout, value === null ? 'world' : value.toFixed(2));
      });
      list.append(h('label', { class: 'ws-slider' }, h('span', {}, control.label), tick, range, readout));
    }
    return list;
  }

  private table(rows: [string, string][]): void {
    if (this.cost.childElementCount !== rows.length * 2) this.cost.replaceChildren(...rows.flatMap(() => [h('span'), h('span')]));
    rows.forEach(([label, value], i) => { writeText(this.cost.children[i * 2] as HTMLElement, label); writeText(this.cost.children[i * 2 + 1] as HTMLElement, value); });
  }
}
