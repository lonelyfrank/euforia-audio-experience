import type { DiagnosticsController } from '../../diagnostics/core/DiagnosticsController';
import { button, panel, tile, writeText, writeTile } from '../../diagnostics/workspace/components';
import { h } from '../../ui/dom';
import { SOLID_DRAW_CALLS, SOLID_STAGES } from '../../visual-engine/primitives/SolidPrimitive';
import { RecipeVisualizer } from '../../visual-engine/RecipeVisualizer';
import { SOLID_PROFILES } from '../../visual-engine/structural/SolidTypes';
import { scenesOf } from '../../visualizers/registry';
import type { App } from '../App';
import { ParticleSolidsExperiment, type SyntheticCue } from './emergence';

/**
 * The Emergence laboratory in the Engine Workspace inspector (DEV): new geometry in the product's own scenes, tried
 * without changing them. It pins the scene it studies and unpins it when it ends; its settings are its own and nothing
 * is saved. No window, listener or frame loop of its own: the workspace's refresh drives it.
 *
 *   Particles · solids   a few bodies of the structural engine among a Particles scene's matter (emergence.ts)
 */

/** The Particles scenes that are recipes: a world the population can be mounted in. */
const HOSTS = ['matter-field', 'vector-field', 'spectral-shell', 'resonant-field'];

export class EmergenceLab {
  readonly element = h('div', { class: 'ws-lab-grid ws-emergence' });
  readonly label = 'Emergence';
  visible = true;
  readonly solids = new ParticleSolidsExperiment();
  private readonly previousPin: string | null;
  private readonly releaseDiagnostics: () => void;
  private host = 'matter-field';
  private readonly hosts = h('div', { class: 'ws-actions' });
  private readonly settings = h('div', { class: 'ws-actions' });
  private readonly tiles = ['Bodies', 'Stages', 'Fracture gate', 'Fractures / reformed', 'Cues taken', 'Solid pass'].map((label) => tile(label));
  private readonly note = h('p', { class: 'ws-note' });
  private readonly cost = h('div', { class: 'ws-table' });

  constructor(private readonly app: App, private readonly diagnostics: DiagnosticsController, parent: HTMLElement) {
    this.previousPin = app.pinnedScene;
    const particles = scenesOf('particles').filter((v) => HOSTS.includes(v.id));
    for (const v of particles) this.hosts.append(this.choice(this.hosts, 'host', v.id, v.name, () => { this.host = v.id; this.app.pinScene(v.id); }));
    const s = this.solids.settings;
    const toggle = (label: string, read: () => string, values: readonly string[], write: (value: string) => void): HTMLButtonElement => {
      const item = button(label, () => { const at = values.indexOf(read()); write(values[(at + 1) % values.length]); });
      (item as HTMLButtonElement & { read?: () => string }).read = () => `${label}: ${read()}`;
      return item;
    };
    this.settings.append(
      toggle('Solids', () => (s.enabled ? 'on' : 'off'), ['on', 'off'], (v) => { s.enabled = v === 'on'; }),
      toggle('Bodies', () => String(s.bodies), ['1', '2', '3'], (v) => { s.bodies = Number(v); }),
      toggle('Start', () => s.start, ['free', 'solid'], (v) => { s.start = v as typeof s.start; }),
      toggle('Fracture', () => s.fracture, ['release', 'accent', 'none'], (v) => { s.fracture = v as typeof s.fracture; }),
      toggle('Material', () => s.profile, SOLID_PROFILES, (v) => { s.profile = v as typeof s.profile; }),
    );
    const synthetic = (label: string, kind: SyntheticCue, title: string): HTMLButtonElement => button(label, () => this.offer(kind), title);
    this.element.append(
      panel({ title: 'Emergence · Particles', icon: 'hex', sub: 'laboratorio · temporaneo, non salvato' },
        h('div', { class: 'ws-caption' }, h('b', {}, 'Scene')), this.hosts,
        h('div', { class: 'ws-caption' }, h('b', {}, 'Solids')), this.settings, this.note),
      panel({ title: 'Cycle', icon: 'pulse', sub: 'free → aggregate → form → solid → fragments · read from the links' },
        h('div', { class: 'ws-metrics ws-metrics-text' }, ...this.tiles.map((t) => t.element))),
      panel({ title: 'Experiment', icon: 'flask', sub: 'eventi sintetici · lo stesso percorso dei cue della sessione' },
        h('div', { class: 'ws-actions' },
          button('Reset', () => this.solids.reset(), 'The population seeded again from the same matter: the cycle starts over'),
          synthetic('Release heard', 'release', 'A confirmed release, offered to the fracture gate as the session\'s own'),
          synthetic('Accent', 'accent', 'An observed accent: breaks bodies only with Fracture: accent'),
          synthetic('Prediction', 'prediction', 'A predicted release: it never breaks anything'))),
      panel({ title: 'Budget & Cost', icon: 'render', sub: 'fixed pools · CPU per frame' }, this.cost),
    );
    parent.append(this.element);
    this.mark(this.hosts, 'host', this.host);
    app.pinScene(this.host);
    this.releaseDiagnostics = diagnostics.acquire();
  }

  /** Settings moved away from the experiment's own defaults: what the status line counts. Nothing of the product is overridden. */
  get overrides(): number {
    const s = this.solids.settings;
    return Number(!s.enabled) + Number(s.bodies !== 3) + Number(s.start !== 'free') + Number(s.fracture !== 'release') + Number(s.profile !== 'rigid');
  }

  dispose(): void {
    this.releaseDiagnostics();
    this.element.remove();
    // Nothing of the laboratory outlives it: the world given back as it was, the pin to what it was.
    this.solids.detach();
    this.app.pinScene(this.previousPin);
  }

  refreshPanel(_now: number): void {
    const scene = this.app.directionDebug.current?.visualizer;
    const world = scene instanceof RecipeVisualizer && scene.world.recipe.id === this.host ? scene.world : null;
    const solid = this.solids.apply(world);
    if (!this.visible) return;
    this.mark(this.hosts, 'host', this.host);
    for (const item of this.settings.querySelectorAll<HTMLButtonElement & { read?: () => string }>('button')) if (item.read) writeText(item, item.read());
    const [bodies, stages, gate, fractures, cues, pass] = this.tiles;
    if (!solid) {
      writeText(this.note, world ? 'Solids off: la scena è quella del prodotto.' : 'In attesa della scena nel viewport…');
      for (const t of this.tiles) writeTile(t, '—');
      return;
    }
    const solids = solid.system.solids!, stats = solids.stats, judged = solids.gate.stats;
    writeText(this.note, 'Corpi del motore strutturale fra la materia della scena: si formano quando il mondo lo permette, si rompono solo sui cue confermati.');
    writeTile(bodies, `${solids.state.bodies}`, `${solid.system.state.count} elements`);
    writeTile(stages, Array.from(solid.stages.subarray(0, solids.state.bodies), (k) => SOLID_STAGES[k]).join(' · '));
    writeTile(gate, `${judged.fired} / ${judged.offered}`, judged.verdict);
    writeTile(fractures, `${stats.events} / ${stats.reforms}`, `${stats.fractures} links`);
    writeTile(cues, `${solid.cuesTaken.releases} · ${solid.cuesTaken.accents}`, `releases · accents · ${this.solids.offered} synthetic`);
    writeTile(pass, stats.solveMs.toFixed(3), 'ms / frame');
    const drawn = this.diagnostics.renderer?.drawn;
    this.table([
      ['elements', `${solid.system.state.count} / ${solid.system.state.capacity}`], ['bodies', `${solids.state.bodies} / ${solids.state.bodyCapacity}`],
      ['links · intact / broken / lost', `${stats.intact} / ${stats.broken} / ${stats.lost} of ${solids.state.linkCapacity}`],
      ['structural step / frame', `${solid.system.stats.stepMs.toFixed(3)} ms`], ['solid pass / frame', `${stats.solveMs.toFixed(3)} ms`],
      ['solid draw calls', String(SOLID_DRAW_CALLS)], ['frame draw calls', drawn ? String(drawn.calls) : '—'],
    ]);
  }

  private offer(kind: SyntheticCue): void {
    const experience = this.app.audio.experience;
    this.solids.offer(kind, experience.ready ? experience.presented.state.time : 0);
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
