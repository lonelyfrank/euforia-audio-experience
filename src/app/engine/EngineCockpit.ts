import type { DiagnosticsController } from '../../diagnostics/core/DiagnosticsController';
import { FIELD } from '../../render-systems/fields/fieldLaw';
import { TOPOLOGY } from '../../render-systems/fields/vectorField';
import { h } from '../../ui/dom';
import { STRUCTURE_VIEWS, structuralLab, WirePolygonPrimitive, type StructureCommand, type StructureView } from '../../visual-engine/primitives/WirePolygonPrimitive';
import { RecipeVisualizer } from '../../visual-engine/RecipeVisualizer';
import structuralLabScene, { STRUCTURAL_LAB } from '../../visual-engine/structural/lab/index';
import { createTuning, LIFECYCLES, ROLE_COUNT, ROLES, type StructuralTuning } from '../../visual-engine/structural/StructuralTypes';
import type { VisualWorld } from '../../visual-engine/VisualWorld';
import { registerLaboratory, visualizers } from '../../visualizers/registry';
import type { App } from '../App';

/** Structural inspectors embedded in the Engine Workspace inspector. No independent window, listener or RAF.
 * Register/pin on explicit laboratory entry; dispose releases its overrides and restores the previous pin.
 * Its three blocks stack in the inspector's column and sit side by side in a wide one (`.ws-lab-grid`).
 */

const BOTTOM = 176;
/** Thirty seconds of traces at 5 Hz, whatever the frame rate. */
const TRACE_RATE = 5;
const TRACE = 30 * TRACE_RATE;

const MODULES = ['Structures', 'Resonance', 'Environment', 'Diagnostics'] as const;
type Module = typeof MODULES[number];
const VIEW_LABELS: Record<StructureView, string> = {
  all: 'Everything', particles: 'Particle system', nodes: 'Nodes', edges: 'Edges', polygon: 'Polygon', surface: 'Surface', fragments: 'Fragments',
};
const TRACES = [
  ['order', '#6fd08c'], ['temperature', '#f0a050'], ['stress', '#e070d0'], ['excitation', '#6cc8f0'], ['structured', '#d8dcf0'], ['fragments', '#f0e070'],
] as const;
type TraceKey = typeof TRACES[number][0];

const STYLE = /* css */ `
.engine { box-sizing:border-box; color:var(--ws-text); font:13px/1.5 system-ui,sans-serif; min-width:0; }
.engine * { box-sizing:border-box; }
.engine-left,.engine-right,.engine-bottom { padding:12px; min-width:0; background:var(--ws-panel); border:1px solid var(--ws-border); border-radius:10px; }
.engine-bottom { grid-column:1 / -1; overflow:hidden; }
.engine h1 { margin: 0; font: 600 12px var(--font-sans); letter-spacing: 0.14em; text-transform: uppercase; }
.engine h2 { margin: 14px 0 6px; font: 600 10px var(--font-sans); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-faint); }
.engine small { color: var(--ink-faint); }
.engine button, .engine select { font: inherit; color: var(--ink); background: var(--abyss); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; cursor: pointer; }
.engine select { width: 100%; }
.engine button:disabled { color: var(--ink-faint); border-color: var(--hairline); cursor: default; }
.engine button[aria-pressed='true'] { border-color: var(--accent-live); color: var(--accent-live); }
.engine-nav, .engine-list { display: flex; flex-wrap: wrap; gap: 4px; }
.engine-row { display: flex; gap: 4px; flex-wrap: wrap; }
.engine-table { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1px 12px; }
.engine-table span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.engine-table span:nth-child(even) { text-align: right; color: var(--ink); }
.engine-table span:nth-child(odd) { color: var(--ink-muted); }
.engine-dev { margin-top: 14px; padding: 8px; border: 1px dashed var(--magenta); border-radius: 8px; }
.engine-dev h2 { margin-top: 0; color: var(--magenta); }
.engine-slider { display: grid; grid-template-columns: 16px 1fr 44px; align-items: center; gap: 6px; margin: 2px 0; }
.engine-slider label { grid-column: 1 / -1; color: var(--ink-muted); }
.engine-slider input[type='range'] { width: 100%; accent-color: var(--magenta); }
.engine canvas { display: block; max-width: 100%; }
.engine-legend { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
`;

/** One override of the Structures panel: a factor (always on) or a level that replaces the world's own (when ticked). */
interface Override {
  key: keyof StructuralTuning;
  label: string;
  min: number;
  max: number;
  /** A level is off (null: the world's own value) until ticked. */
  level: boolean;
}

const OVERRIDES: Override[] = [
  { key: 'coherence', label: 'coherence', min: 0, max: 1, level: true },
  { key: 'temperature', label: 'temperature', min: 0, max: 1, level: true },
  { key: 'fractureThreshold', label: 'fracture threshold ×', min: 0.2, max: 3, level: false },
  { key: 'bondStrength', label: 'bond strength ×', min: 0.2, max: 3, level: false },
  { key: 'resonanceCoupling', label: 'resonance coupling ×', min: 0, max: 3, level: false },
  { key: 'environmentCoupling', label: 'environment coupling ×', min: 0, max: 3, level: false },
];

export class EngineCockpit {
  readonly element = h('div', { class: 'ws-lab-grid' });
  visible = true;
  private readonly style = h('style', {}, STYLE);
  private readonly left = h('aside', { class: 'engine engine-left' });
  private readonly right = h('aside', { class: 'engine engine-right' });
  private readonly bottom = h('footer', { class: 'engine engine-bottom' });
  private readonly inspector = h('div');
  private readonly values = h('div', { class: 'engine-table' });
  private readonly metrics = h('div');
  private readonly traces = h('canvas');
  private readonly bars = h('canvas');
  private readonly history: Record<TraceKey, Float32Array> = Object.fromEntries(TRACES.map(([key]) => [key, new Float32Array(TRACE)])) as Record<TraceKey, Float32Array>;
  private head = 0;
  private session = -1;
  private readonly roles = new Float64Array(ROLE_COUNT);
  private readonly lives = new Uint32Array(LIFECYCLES.length);
  private module: Module = 'Structures';
  private world = STRUCTURAL_LAB;
  private readonly previousPin: string | null;
  private readonly withdraw: () => void;
  private lastSample = -1;
  private frameMs = 16;
  private readonly releaseDiagnostics: () => void;
  private readonly drawn = { calls: 0, triangles: 0, points: 0, lines: 0 };

  constructor(private readonly app: App, private readonly diagnostics: DiagnosticsController, parent: HTMLElement) {
    this.previousPin = app.pinnedScene;
    this.withdraw = registerLaboratory(structuralLabScene);
    structuralLab.active = true;
    document.head.append(this.style);
    this.buildLeft();
    this.right.append(this.inspector);
    this.bottom.append(
      h('div', { class: 'engine-legend' }, ...TRACES.map(([key, color]) => h('span', { style: { color } }, `■ ${key}`)), h('small', {}, '30 s · structural engine')),
      this.traces, this.metrics,
    );
    this.element.append(this.left, this.right, this.bottom);
    parent.append(this.element);
    this.select('Structures');
    app.pinScene(this.world);
    this.releaseDiagnostics = diagnostics.acquire();
  }

  dispose(): void {
    this.releaseDiagnostics();
    this.left.remove(); this.right.remove(); this.bottom.remove(); this.style.remove();
    this.element.remove();
    // Nothing of the cockpit outlives it: the overrides, the view and the pinned world go back to the product's.
    Object.assign(structuralLab, { active: false, tuning: createTuning(), view: 'all', sides: 4, command: null });
    this.app.pinScene(this.previousPin);
    this.withdraw();
  }

  // ---- the world in the viewport ------------------------------------------------

  private get visualWorld(): VisualWorld | null {
    const scene = this.app.directionDebug.current?.visualizer;
    return scene instanceof RecipeVisualizer ? scene.world : null;
  }

  private get structure(): WirePolygonPrimitive | null {
    const primitive = this.visualWorld?.primitive('structure');
    return primitive instanceof WirePolygonPrimitive ? primitive : null;
  }

  // ---- left: navigation -----------------------------------------------------------

  private buildLeft(): void {
    const nav = h('nav', { class: 'engine-nav' });
    for (const module of MODULES) nav.append(h('button', { type: 'button', dataset: { module }, onclick: () => this.select(module) }, module));

    const world = h('select', { ariaLabel: 'Mondo del laboratorio', onchange: () => { this.world = world.value; this.app.pinScene(this.world); world.blur(); } },
      new Option('Structural Lab', STRUCTURAL_LAB), ...visualizers.map((v) => new Option(v.name, v.id)));
    const views = h('div', { class: 'engine-list' });
    for (const view of STRUCTURE_VIEWS) {
      views.append(h('button', { type: 'button', dataset: { view }, onclick: () => { structuralLab.view = view; this.mark(views, 'view', view); } }, VIEW_LABELS[view]));
    }
    this.mark(views, 'view', structuralLab.view);
    const sides = h('div', { class: 'engine-row' });
    for (const n of [3, 4, 5, 6]) {
      sides.append(h('button', { type: 'button', dataset: { sides: String(n) }, onclick: () => { structuralLab.sides = n; this.mark(sides, 'sides', String(n)); } }, ['triangle', 'square', 'pentagon', 'hexagon'][n - 3]));
    }
    this.mark(sides, 'sides', String(structuralLab.sides));

    this.left.append(
      h('h1', {}, 'Structural Dynamics'), h('small', {}, 'Experiment · temporaneo, non salvato'),
      h('h2', {}, 'Modules'), nav,
      h('h2', {}, 'Viewport'), world,
      h('h2', {}, 'Geometry'), views,
      h('h2', {}, 'Polygon'), sides,
    );
  }

  private mark(group: HTMLElement, key: string, value: string): void {
    for (const button of group.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset[key] === value));
  }

  private select(module: Module): void {
    this.module = module;
    this.mark(this.left, 'module', module);
    this.inspector.replaceChildren(h('h1', {}, module));
    if (module === 'Structures') this.buildStructures();
    else if (module === 'Resonance') this.inspector.append(h('small', {}, 'macro · meso (amplitude, swing) · micro'), this.bars, this.values);
    else this.inspector.append(this.values);
    this.refresh();
  }

  // ---- right: the Structures inspector -------------------------------------------

  private buildStructures(): void {
    const dev = h('div', { class: 'engine-dev' }, h('h2', {}, 'Development overrides · not saved'));
    const sync: (() => void)[] = [];
    for (const override of OVERRIDES) {
      const readout = h('span', {});
      const range = h('input', { type: 'range', ariaLabel: override.label, min: String(override.min), max: String(override.max), step: '0.01' });
      const tick = h('input', { type: 'checkbox', ariaLabel: `Override ${override.label}`, title: override.level ? 'Replace the world\'s own value' : 'Always applied' });
      const write = (): void => {
        const value = Number(range.value);
        (structuralLab.tuning[override.key] as number | null) = override.level && !tick.checked ? null : value;
        readout.textContent = override.level && !tick.checked ? 'world' : value.toFixed(2);
      };
      const read = (): void => {
        const value = structuralLab.tuning[override.key];
        tick.checked = !override.level || value !== null; tick.disabled = !override.level;
        range.value = String(value ?? 0.5);
        write();
      };
      range.oninput = write; tick.onchange = write;
      sync.push(read);
      dev.append(h('div', { class: 'engine-slider' }, h('label', {}, override.label), tick, range, readout));
    }
    for (const read of sync) read();
    dev.append(h('div', { class: 'engine-row', style: { marginTop: '8px' } },
      h('button', { type: 'button', onclick: () => { structuralLab.tuning = createTuning(); for (const read of sync) read(); } }, 'Reset overrides')));
    const command = (label: string, value: StructureCommand, title: string): HTMLButtonElement =>
      h('button', { type: 'button', title, onclick: () => { structuralLab.command = value; } }, label);
    this.inspector.append(
      this.values, dev,
      h('h2', {}, 'Test actions'),
      h('div', { class: 'engine-row' },
        command('Seed', 'seed', 'Loose matter that tends to the polygon: it forms when the sound lets it'),
        command('Form', 'form', 'The polygon whole, at once'),
        command('Strike', 'strike', 'A blow from the side'),
        command('Scatter', 'scatter', 'A blow from the centre')),
    );
  }

  // ---- live values -------------------------------------------------------------------

  private table(rows: [string, string][]): void {
    if (this.values.childElementCount !== rows.length * 2) this.values.replaceChildren(...rows.flatMap(() => [h('span'), h('span')]));
    rows.forEach(([label, value], i) => {
      const a = this.values.children[i * 2], b = this.values.children[i * 2 + 1];
      if (a.textContent !== label) a.textContent = label;
      if (b.textContent !== value) b.textContent = value;
    });
  }

  private refresh(): void {
    const structure = this.structure, world = this.visualWorld, f2 = (x: number): string => x.toFixed(2), pct = (x: number): string => `${(100 * x).toFixed(0)} %`;
    if (this.module === 'Structures') {
      if (!structure) this.table([['structural system', 'none in this world']]);
      else {
        const s = structure.system.stats, state = structure.system.state;
        const roles = this.roles, lives = this.lives; roles.fill(0); lives.fill(0);
        for (let i = 0; i < state.count; i++) {
          lives[state.lifecycle[i]]++;
          for (let r = 0; r < ROLE_COUNT; r++) roles[r] += state.roles[i * ROLE_COUNT + r] / Math.max(1, state.count);
        }
        this.table([
          ['elements', `${s.elements} / ${state.capacity}`], ['free matter', pct(s.free)], ['structured matter', pct(s.structured)],
          ['nodes (leading role)', String(s.nodes)], ['bonds', `${s.bonds} / ${state.bondCapacity}`], ['· wires', String(s.spans)], ['· joints', String(s.joints)],
          ['closed polygons', String(s.loops)], ['fragments', String(s.fragments)],
          ['average order', f2(s.order)], ['temperature', f2(s.temperature)], ['average bond stress', f2(s.stress)],
          ['average excitation', f2(s.excitation)], ['average bond strength', f2(s.bondStrength)], ['kinetic energy', s.kinetic.toFixed(3)],
          ['bonds made / broken', `${s.formed} / ${s.fractures}`],
          ...ROLES.map((role, r): [string, string] => [`role · ${role}`, pct(roles[r])]),
          ...LIFECYCLES.map((life, k): [string, string] => [`life · ${life}`, String(lives[k])]),
        ]);
      }
    } else if (this.module === 'Resonance') {
      const experience = this.app.audio.experience, r = experience.presented.resonance;
      this.table(experience.ready
        ? [['macro modes', String(r.macro.length)], ['meso groups', String(r.meso.length)], ['micro bands', String(r.micro.length)],
          ['macro / meso / micro level', `${f2(r.macroEnergy)} / ${f2(r.mesoEnergy)} / ${f2(r.microEnergy)}`],
          ['centre on the axis', f2(r.centre)], ['focus', f2(r.focus)], ['world keeps a field', world?.resonance ? 'yes' : 'no']]
        : [['resonance', 'no synchronized clock']]);
    } else if (this.module === 'Environment') {
      if (!world) this.table([['visual world', 'the protagonist is a legacy scene']]);
      else {
        const f = world.uField, e = structure?.environment, g = world.mapper.state, t = structure?.topology ?? null;
        this.table([
          ['coherence', f2(g.coherence)], ['harmony (symmetry)', f2(g.symmetry)], ['turbulence', f2(g.disorder)], ['tension', f2(g.tension)],
          ['energy', f2(g.energy)], ['release', f2(g.fracture)], ['impulse', f2(g.impulse)],
          ['field · radius', f2(f[FIELD.radius])], ['field · stiffness', f2(f[FIELD.stiffness])], ['field · gather', f2(f[FIELD.gather])],
          ['field · surge', f2(f[FIELD.surge])], ['field · vortex', f2(f[FIELD.vortex])], ['field · advection', f2(f[FIELD.advection])],
          ['field · turbulence', f2(f[FIELD.turbulence])], ['field · drag', f2(f[FIELD.drag])], ['fronts', String(world.debug.waves)],
          ...(t ? [['eddies awake', f2(t[TOPOLOGY.eddies])], ['shell wells', f2(t[TOPOLOGY.well])]] as [string, string][] : []),
          ...(e ? [['medium drag (sampled)', f2(e.drag)]] as [string, string][] : []),
        ]);
      }
    } else {
      const s = structure?.system.stats, d = this.drawn, render = this.app.directionDebug;
      this.table([
        ['frame', `${this.frameMs.toFixed(1)} ms · ${(1000 / this.frameMs).toFixed(0)} fps`], ['quality', render.qualityTier],
        ['structural CPU / frame', s ? `${s.stepMs.toFixed(2)} ms` : '–'], ['· of which bookkeeping', s ? `${s.bookMs.toFixed(2)} ms` : '–'],
        ['steps this frame', s ? String(s.steps) : '–'], ['states repaired', s ? String(s.repairs) : '–'],
        ['active bonds', s ? String(s.bonds) : '–'], ['active fragments', s ? String(s.fragments) : '–'],
        ['primitives present', world ? `${world.debug.present} / ${world.debug.primitives}` : '–'], ['vertices submitted', world ? String(world.debug.vertices) : '–'],
        ['structure vertices', structure ? String(structure.vertices) : '–'],
        ['draw calls / frame', String(d.calls)], ['lines · points · triangles', `${d.lines} · ${d.points} · ${d.triangles}`],
        ['GPU time', 'not measured'],
      ]);
    }
    const s = structure?.system.stats;
    this.metrics.textContent = s
      ? `structural CPU ${s.stepMs.toFixed(2)} ms (bookkeeping ${s.bookMs.toFixed(2)}) · ${s.elements} elements · ${s.bonds} bonds · ${s.loops} polygons · ${s.fragments} fragments · frame ${this.frameMs.toFixed(1)} ms`
      : 'no structural system in this world';
  }

  // ---- bottom: traces; right: resonance bars -----------------------------------------

  private sample(): void {
    const s = this.structure?.system.stats, at = this.head++ % TRACE, elements = Math.max(1, s?.elements ?? 1);
    this.history.order[at] = s?.order ?? 0; this.history.temperature[at] = s?.temperature ?? 0; this.history.stress[at] = s?.stress ?? 0;
    this.history.excitation[at] = s?.excitation ?? 0; this.history.structured[at] = s?.structured ?? 0; this.history.fragments[at] = (s?.fragments ?? 0) / elements;
  }

  private fit(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext('2d');
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx?.clearRect(0, 0, width, height);
    return ctx;
  }

  refreshPanel(now: number): void {
    if (this.session !== this.app.audio.session) {
      this.session = this.app.audio.session; this.head = 0; this.lastSample = -1;
      for (const [key] of TRACES) this.history[key].fill(0);
    }
    const sample = Math.floor(now * TRACE_RATE / 1000);
    if (sample !== this.lastSample) { this.sample(); this.lastSample = sample; }
    if (!this.visible) return;
    this.frameMs = this.diagnostics.renderer?.frameMs ?? 0;
    // Both widths are read before anything is written: one layout per refresh, not one per canvas.
    const width = Math.max(100, this.bottom.clientWidth - 24), side = Math.max(100, this.right.clientWidth - 24);
    this.refresh();
    Object.assign(this.drawn, this.diagnostics.renderer?.drawn);

    const height = BOTTOM - 62, ctx = this.fit(this.traces, width, height);
    if (ctx) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
      for (const [key, color] of TRACES) {
        const values = this.history[key];
        ctx.strokeStyle = color; ctx.beginPath();
        for (let i = 0; i < TRACE; i++) {
          const v = values[(this.head + i) % TRACE], x = i / (TRACE - 1) * width, y = height - 1 - Math.max(0, Math.min(1, v)) * (height - 2);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    if (this.module === 'Resonance') this.drawResonance(side);
  };

  private drawResonance(width: number): void {
    const row = 54, ctx = this.fit(this.bars, width, row * 3 + 8), r = this.app.audio.experience.presented.resonance;
    if (!ctx || !this.app.audio.experience.ready) return;
    const strip = (values: Float32Array, levels: Float32Array | null, top: number, color: string, signed: boolean): void => {
      const w = width / values.length, mid = top + row / 2;
      ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(0, top, width, row - 6);
      for (let k = 0; k < values.length; k++) {
        const level = Math.min(1, levels ? levels[k] : Math.abs(values[k]));
        ctx.fillStyle = color;
        if (signed) ctx.fillRect(k * w + 1, mid - 3 - level * (row / 2 - 4), Math.max(1, w - 2), 2 * level * (row / 2 - 4));
        else ctx.fillRect(k * w + 1, top + row - 6 - level * (row - 8), Math.max(1, w - 2), level * (row - 8));
        if (signed) { ctx.fillStyle = '#ffffff'; ctx.fillRect(k * w + 1, mid - 3 - Math.max(-1, Math.min(1, values[k])) * (row / 2 - 4) - 1, Math.max(1, w - 2), 2); }
      }
    };
    strip(r.macro, null, 0, '#f0a050', true);
    strip(r.meso, r.mesoLevel, row, '#6fd08c', true);
    strip(r.micro, null, row * 2, '#6cc8f0', false);
  }
}
