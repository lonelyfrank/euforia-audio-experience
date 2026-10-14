import type { DiagnosticsController } from '../../diagnostics/core/DiagnosticsController';
import { button, panel, tile, writeText, writeTile } from '../../diagnostics/workspace/components';
import { h } from '../../ui/dom';
import { SOLID_DRAW_CALLS, SOLID_STAGES } from '../../visual-engine/primitives/SolidPrimitive';
import { PHASES } from '../../visual-engine/primitives/terrainEmergence';
import { RecipeVisualizer } from '../../visual-engine/RecipeVisualizer';
import { PULSE_LIMIT, SOLID_PROFILES } from '../../visual-engine/structural/SolidTypes';
import { scenesOf } from '../../visualizers/registry';
import type { App } from '../App';
import { ParticleSolidsExperiment, TerrainEmergenceExperiment, type SyntheticCue } from './emergence';

/**
 * The Emergence laboratory in the Engine Workspace inspector (DEV): new geometry in the product's own scenes, tried
 * without changing them. It pins the scene it studies and unpins it when it ends; its settings are its own, nothing is
 * saved, and the scene's world is given back as it was. No window, listener or frame loop of its own: the workspace's
 * refresh drives it. Synthetic events go through the same path as the session's musical cues.
 *
 *   Terrain     the structures that rise out of Generative Terrain (emergence field: budgets, modes, response, fracture)
 *   Particles   a few bodies of the structural engine among a Particles scene's matter
 */

/** The Particles scenes that are recipes: a world the population can be mounted in. */
const HOSTS = ['matter-field', 'vector-field', 'spectral-shell', 'resonant-field'];
type Subject = 'terrain' | 'particles';

/** A button that steps through values; its label shows the value in force. */
type Cycle = HTMLButtonElement & { read: () => string };

export class EmergenceLab {
  readonly element = h('div', { class: 'ws-lab-grid ws-emergence' });
  readonly label = 'Emergence';
  visible = true;
  readonly solids = new ParticleSolidsExperiment();
  readonly terrain = new TerrainEmergenceExperiment();
  private subject: Subject = 'terrain';
  private host = 'matter-field';
  private readonly previousPin: string | null;
  private readonly releaseDiagnostics: () => void;
  private readonly subjects = h('div', { class: 'ws-actions' });
  private readonly hosts = h('div', { class: 'ws-actions' });
  private readonly terrainControls = h('div', { class: 'ws-actions' });
  private readonly solidControls = h('div', { class: 'ws-actions' });
  private readonly tiles = ['Structures', 'Phases', 'Life', 'Fracture gate', 'Cues', 'Cost'].map((label) => tile(label));
  private readonly note = h('p', { class: 'ws-note' });
  private readonly cost = h('div', { class: 'ws-table' });

  constructor(private readonly app: App, private readonly diagnostics: DiagnosticsController, parent: HTMLElement) {
    this.previousPin = app.pinnedScene;
    for (const [id, label] of [['terrain', 'Terrain'], ['particles', 'Particles']] as const) this.subjects.append(this.choice(this.subjects, 'subject', id, label, () => this.study(id)));
    for (const v of scenesOf('particles').filter((v) => HOSTS.includes(v.id))) this.hosts.append(this.choice(this.hosts, 'host', v.id, v.name, () => { this.host = v.id; this.pin(); }));
    const t = (): NonNullable<TerrainEmergenceExperiment['settings']> | null => this.terrain.settings;
    const set = <K extends keyof NonNullable<TerrainEmergenceExperiment['settings']>>(key: K, value: NonNullable<TerrainEmergenceExperiment['settings']>[K]): void => { const s = t(); if (s) s[key] = value; };
    const number = (key: 'capacity' | 'emerging' | 'fragments' | 'density' | 'rate' | 'response' | 'pulse', label: string, values: number[], show = (x: number) => String(x)) =>
      this.cycle(label, () => { const s = t(); return s ? show(s[key]) : '—'; }, values.map(String), (v) => set(key, Number(v)), () => String(t()?.[key] ?? ''));
    this.terrainControls.append(
      this.cycle('Emergence', () => (t()?.enabled === false ? 'off' : 'on'), ['on', 'off'], (v) => set('enabled', v === 'on')),
      number('capacity', 'Structures', [8, 16, 28, 48]),
      number('emerging', 'Forming at once', [3, 6, 12]),
      number('fragments', 'Breaking at once', [1, 4, 8]),
      this.cycle('Anchoring', () => t()?.modes ?? '—', ['both', 'extrude', 'anchored'], (v) => set('modes', v as 'both')),
      number('pulse', 'Rigidity · pulse', [0, PULSE_LIMIT / 2, PULSE_LIMIT], (x) => `${(100 * x).toFixed(0)} %`),
      number('density', 'Density', [0.06, 0.12, 0.25, 0.5]),
      number('rate', 'Emergence rate', [0.5, 1, 2]),
      number('response', 'Musical response', [0, 1, 2]),
      this.cycle('Fracture', () => (t()?.fracture === false ? 'off' : 'on'), ['on', 'off'], (v) => set('fracture', v === 'on')),
    );
    const s = this.solids.settings;
    this.solidControls.append(
      this.cycle('Solids', () => (s.enabled ? 'on' : 'off'), ['on', 'off'], (v) => { s.enabled = v === 'on'; }),
      this.cycle('Bodies', () => String(s.bodies), ['1', '2', '3'], (v) => { s.bodies = Number(v); }),
      this.cycle('Start', () => s.start, ['free', 'solid'], (v) => { s.start = v as typeof s.start; }),
      this.cycle('Fracture', () => s.fracture, ['release', 'accent', 'none'], (v) => { s.fracture = v as typeof s.fracture; }),
      this.cycle('Material', () => s.profile, SOLID_PROFILES, (v) => { s.profile = v as typeof s.profile; }),
    );
    const synthetic = (label: string, kind: SyntheticCue | 'withdraw', title: string): HTMLButtonElement => button(label, () => this.offer(kind), title);
    this.element.append(
      panel({ title: 'Emergence', icon: 'hex', sub: 'laboratorio · temporaneo, non salvato' },
        h('div', { class: 'ws-caption' }, h('b', {}, 'Subject')), this.subjects,
        h('div', { class: 'ws-caption' }, h('b', {}, 'Scene')), this.hosts,
        h('div', { class: 'ws-caption' }, h('b', {}, 'Settings')), this.terrainControls, this.solidControls, this.note),
      panel({ title: 'Life', icon: 'pulse', sub: 'measured on the state · five times a second' }, h('div', { class: 'ws-metrics ws-metrics-text' }, ...this.tiles.map((x) => x.element))),
      panel({ title: 'Experiment', icon: 'flask', sub: 'eventi sintetici · lo stesso percorso dei cue della sessione' },
        h('div', { class: 'ws-actions' },
          button('Reset', () => (this.subject === 'terrain' ? this.terrain.reset() : this.solids.reset()), 'Start over: the structures back to the pool, or the bodies seeded again'),
          synthetic('Release heard', 'release', 'A confirmed release: what waits emerges, a burst, the fracture gate may break'),
          synthetic('Prediction', 'prediction', 'A predicted release: structures wait in formation; it never breaks or bursts anything'),
          synthetic('Withdraw', 'withdraw', 'The prediction given up: what waited goes back'),
          synthetic('Accent', 'accent', 'An observed accent: a moment of light (bodies break on it only with Fracture: accent)'))),
      panel({ title: 'Budget & Cost', icon: 'render', sub: 'fixed pools · CPU per frame' }, this.cost),
    );
    parent.append(this.element);
    this.study(this.subject);
    this.releaseDiagnostics = diagnostics.acquire();
  }

  /** Settings moved away from what the scene had (Terrain) or from the experiment's defaults (Particles). Nothing is saved. */
  get overrides(): number {
    const s = this.solids.settings;
    const solids = this.subject === 'particles' ? Number(!s.enabled) + Number(s.bodies !== 3) + Number(s.start !== 'free') + Number(s.fracture !== 'release') + Number(s.profile !== 'rigid') : 0;
    return solids + this.terrain.changes;
  }

  dispose(): void {
    this.releaseDiagnostics();
    this.element.remove();
    // Nothing of the laboratory outlives it: the worlds given back as they were, the pin to what it was.
    this.solids.detach(); this.terrain.detach();
    this.app.pinScene(this.previousPin);
  }

  refreshPanel(_now: number): void {
    const scene = this.app.directionDebug.current?.visualizer, world = scene instanceof RecipeVisualizer ? scene.world : null;
    const terrain = this.terrain.apply(this.subject === 'terrain' && world?.recipe.id === 'terrain' ? world : null);
    const solid = this.solids.apply(this.subject === 'particles' && world?.recipe.id === this.host ? world : null);
    if (!this.visible) return;
    this.mark(this.subjects, 'subject', this.subject); this.mark(this.hosts, 'host', this.host);
    this.hosts.hidden = this.subject !== 'particles'; this.solidControls.hidden = this.subject !== 'particles'; this.terrainControls.hidden = this.subject !== 'terrain';
    for (const item of this.element.querySelectorAll<Cycle>('button[data-cycle]')) writeText(item, item.read());
    const [structures, phases, life, gate, cues, cost] = this.tiles;
    if (this.subject === 'terrain') {
      if (!terrain) {
        writeText(this.note, world?.recipe.id === 'terrain' ? 'Emergenza spenta: la scena è il suolo da solo.' : 'In attesa di Generative Terrain nel viewport…');
        for (const x of this.tiles) writeTile(x, '—');
        return;
      }
      const f = terrain.field, s = f.stats, judged = f.gate.stats;
      writeText(this.note, 'Strutture ancorate alla legge del suolo: nascono dove le righe entrano in vista, quanto dice lo stato lento della musica; si rompono solo sui rilasci uditi.');
      writeTile(structures, `${f.count} / ${f.params.capacity}`, `density ${s.density.toFixed(2)} → ${s.target.toFixed(2)}`);
      writeTile(phases, PHASES.slice(1).map((p, i) => `${p.slice(0, 4)} ${s.phases[i + 1]}`).join(' · '));
      writeTile(life, `${s.spawned} / ${s.recycled}`, `passed ${s.passed} · retreated ${s.retreated} · broken ${s.fractured} · refused ${s.refused}`);
      writeTile(gate, `${judged.fired} / ${judged.offered}`, judged.verdict);
      writeTile(cues, `${s.releases} · ${s.prepares} · ${s.withdraws} · ${s.accents}`, `releases · prepares · withdraws · accents · ${this.terrain.offered} synthetic`);
      writeTile(cost, (terrain.debug['emergence ms'] ?? 0).toFixed(3), 'ms / frame (CPU)');
      const drawn = this.diagnostics.renderer?.drawn;
      this.table([['pool', `${f.count} drawn of ${f.params.capacity} (max 64)`], ['draw calls', `${terrain.drawCalls} (ground 2)`], ['vertices per structure', '36'],
        ['frame draw calls', drawn ? String(drawn.calls) : '—']]);
      return;
    }
    if (!solid) {
      writeText(this.note, world ? 'Solids off: la scena è quella del prodotto.' : 'In attesa della scena nel viewport…');
      for (const x of this.tiles) writeTile(x, '—');
      return;
    }
    const solids = solid.system.solids!, stats = solids.stats, judged = solids.gate.stats;
    writeText(this.note, 'Corpi del motore strutturale fra la materia della scena: si formano quando il mondo lo permette, si rompono solo sui cue confermati.');
    writeTile(structures, `${solids.state.bodies}`, `${solid.system.state.count} elements`);
    writeTile(phases, Array.from(solid.stages.subarray(0, solids.state.bodies), (k) => SOLID_STAGES[k]).join(' · '));
    writeTile(life, `${stats.events} / ${stats.reforms}`, `fractures by events / links reformed · ${stats.fractures} links broken`);
    writeTile(gate, `${judged.fired} / ${judged.offered}`, judged.verdict);
    writeTile(cues, `${solid.cuesTaken.releases} · ${solid.cuesTaken.accents}`, `releases · accents · ${this.solids.offered} synthetic`);
    writeTile(cost, stats.solveMs.toFixed(3), 'ms / frame (solid pass)');
    const drawn = this.diagnostics.renderer?.drawn;
    this.table([
      ['elements', `${solid.system.state.count} / ${solid.system.state.capacity}`], ['bodies', `${solids.state.bodies} / ${solids.state.bodyCapacity}`],
      ['links · intact / broken / lost', `${stats.intact} / ${stats.broken} / ${stats.lost} of ${solids.state.linkCapacity}`],
      ['structural step / frame', `${solid.system.stats.stepMs.toFixed(3)} ms`], ['solid draw calls', String(SOLID_DRAW_CALLS)], ['frame draw calls', drawn ? String(drawn.calls) : '—'],
    ]);
  }

  private study(subject: Subject): void {
    this.subject = subject;
    this.pin();
  }

  private pin(): void {
    this.app.pinScene(this.subject === 'terrain' ? 'terrain' : this.host);
  }

  private offer(kind: SyntheticCue | 'withdraw'): void {
    const experience = this.app.audio.experience, time = experience.ready ? experience.presented.state.time : 0;
    if (this.subject === 'terrain') this.terrain.offer(kind, time);
    else if (kind !== 'withdraw') this.solids.offer(kind, time);
  }

  private cycle(label: string, read: () => string, values: readonly string[], write: (value: string) => void, current = read): Cycle {
    const item = button(label, () => { const at = values.indexOf(current()); write(values[(at + 1) % values.length]); }) as Cycle;
    item.dataset.cycle = '1';
    item.read = () => `${label}: ${read()}`;
    return item;
  }

  private choice(group: HTMLElement, key: string, value: string, label: string, pick: () => void): HTMLButtonElement {
    const item = button(label, () => { pick(); this.mark(group, key, value); });
    item.dataset[key] = value;
    return item;
  }

  private mark(group: HTMLElement, key: string, value: string): void {
    for (const item of group.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item.dataset[key] === value));
  }

  private table(rows: [string, string][]): void {
    if (this.cost.childElementCount !== rows.length * 2) this.cost.replaceChildren(...rows.flatMap(() => [h('span'), h('span')]));
    rows.forEach(([label, value], i) => { writeText(this.cost.children[i * 2] as HTMLElement, label); writeText(this.cost.children[i * 2 + 1] as HTMLElement, value); });
  }
}
