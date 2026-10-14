import type { App } from '../../app/App';
import { PREDICTION_KINDS, STYLES, type CognitionFrame, type Prediction } from '../../experience/cognition/types';
import { h } from '../../ui/dom';
import { lineChart, sparkline, Trace } from './charts';
import { legend, meter, panel, tile, TONE, writeMeter, writeText, writeTile, type Meter, type Tile } from './components';

/**
 * Musical Cognition in Audio & Analysis (Shift+D): the clock, what the music is understood to be doing, what is
 * expected of it and what became of it. Presentation only: every value is the presented snapshot's (at the heard
 * moment), nothing is computed or decided here. The traces are the last ten seconds at the workspace's 5 Hz.
 */

const KIND_LABEL: Record<Prediction['kind'], string> = { beat: 'Beat', downbeat: 'Downbeat', phrase: 'Frase', transition: 'Transizione', release: 'Rilascio' };
const STATUS_LABEL: Record<Prediction['status'], string> = { proposed: 'proposta', updated: 'aggiornata', confirmed: 'confermata', expired: 'scaduta', refuted: 'smentita' };
const STATE_LABEL: Record<CognitionFrame['clock']['state'], string> = { none: 'Nessun clock', acquiring: 'In aggancio', locked: 'Agganciato', coasting: 'In inerzia', lost: 'Perso' };
const LINES = [['Tension', TONE.magenta], ['Surprise', TONE.amber], ['Expectation', TONE.cyan]] as const;
const DIMENSIONS = [
  ['Pulse', TONE.green, 'pulse'], ['Groove', TONE.green, 'groove'], ['Tension', TONE.magenta, 'tension'], ['Repetition', TONE.violet, 'repetition'],
  ['Novelty', TONE.electric, 'novelty'], ['Breakdown', TONE.orange, 'breakdown'], ['Transition', TONE.cyan, 'transition'], ['Release', TONE.red, 'release'],
  ['Development', TONE.violet, 'development'], ['Expectation', TONE.cyan, 'expectation'], ['Surprise', TONE.amber, 'surprise'],
] as const;
const ROWS = 8;

const fixed = (x: number, digits = 2): string => (Number.isFinite(x) ? x.toFixed(digits) : '—');
/** A grid of label / value pairs whose nodes are kept and rewritten (never rebuilt). */
function table(rows: number): { element: HTMLElement; cells: HTMLElement[][]; lines: HTMLElement[] } {
  const cells: HTMLElement[][] = [], lines: HTMLElement[] = [];
  const element = h('div', { class: 'ws-cog-table' });
  for (let r = 0; r < rows; r++) {
    const row = [h('span'), h('span'), h('span'), h('span'), h('span')], line = h('div', { class: 'ws-cog-row' }, ...row);
    cells.push(row); lines.push(line); element.append(line);
  }
  return { element, cells, lines };
}

export class MusicalCognitionPanel {
  /** One panel per part, each in the 'cognition' section. */
  readonly elements: HTMLDetailsElement[];
  private readonly clock: Record<string, Tile>;
  private readonly confidence = new Trace();
  private readonly tension = new Trace();
  private readonly surprise = new Trace();
  private readonly expectation = new Trace();
  private readonly lines = lineChart(LINES.map(([, tone]) => tone));
  private readonly meters: Meter[];
  /** State, its confidence and age, the stylistic resemblance: a line of text (names too long for a narrow tile). */
  private readonly state = h('p', { class: 'ws-cog-state' });
  private readonly reason = h('p', { class: 'ws-cog-reason' });
  private readonly open = table(ROWS);
  private readonly recent = table(ROWS);
  private readonly facts = h('div', { class: 'ws-cog-facts' });
  private readonly factValues = new Map<string, HTMLElement>();
  private session = -1;

  constructor(private readonly app: App) {
    const spark = sparkline(TONE.green);
    this.clock = {
      bpm: tile('BPM', { spark }), state: tile('Clock'), phase: tile('Beat phase', { tone: TONE.amber, bar: true }), downbeat: tile('Downbeat conf.', { tone: TONE.violet, bar: true }),
      meter: tile('Metro'), bar: tile('Battuta'), phrase: tile('Frase'), stability: tile('Stabilità', { tone: TONE.green, bar: true }),
      sync: tile('Errore sync'), octave: tile('Ambiguità ½ / 2×'),
    };
    this.meters = DIMENSIONS.map(([label, tone]) => meter(label, tone));
    const clockPanel = panel({ title: 'Musical Clock', icon: 'clock', sub: 'cognition · tempo, battuta, frase' },
      h('div', { class: 'ws-metrics' }, ...Object.values(this.clock).map(t => t.element)));
    const understanding = panel({ title: 'Musical Understanding', icon: 'target', sub: 'interpretazione · stato e dimensioni' },
      this.state, this.reason,
      h('div', { class: 'ws-meters' }, ...this.meters.map(m => m.element)),
      h('div', { class: 'ws-chart ws-chart-history' }, h('div', { class: 'ws-plot' }, this.lines.element)), legend(LINES));
    const predictions = panel({ title: 'Predictions', icon: 'pulse', sub: 'aperte · esiti recenti' },
      h('div', { class: 'ws-caption' }, h('b', {}, 'Aperte'), h('span', {}, 'tipo · fra · confidenza · stato · evidenza')), this.open.element,
      h('div', { class: 'ws-caption' }, h('b', {}, 'Esiti'), h('span', {}, 'tipo · esito · errore · confidenza · evidenza')), this.recent.element);
    const diagnostics = panel({ title: 'Cognition Diagnostics', icon: 'doc', sub: 'motivi, esiti per tipo, costo' }, this.facts);
    this.elements = [clockPanel, understanding, predictions, diagnostics];
  }

  /** The presented cognition, or null while the experience has nothing heard to present. */
  private frame(): Readonly<CognitionFrame> | null {
    const e = this.app.audio.experience;
    return e.ready ? e.presented.cognition : null;
  }

  /** The traces advance at the workspace's rate, whether or not the panels are drawn. */
  sample(): void {
    if (this.session !== this.app.audio.session) {
      this.session = this.app.audio.session;
      for (const t of [this.confidence, this.tension, this.surprise, this.expectation]) t.reset();
    }
    const f = this.frame();
    this.confidence.push(f ? f.clock.confidence : NaN);
    this.tension.push(f ? f.understanding.tension : NaN); this.surprise.push(f ? f.understanding.surprise : NaN); this.expectation.push(f ? f.understanding.expectation : NaN);
  }

  refresh(): void {
    if (this.elements.every(e => e.hidden || !e.open)) return;
    const f = this.frame();
    this.writeClock(f);
    this.writeUnderstanding(f);
    this.writePredictions(f);
    this.writeFacts(f);
  }

  private writeClock(f: Readonly<CognitionFrame> | null): void {
    const t = this.clock, c = f?.clock;
    if (!c || !f.enabled) { for (const x of Object.values(t)) writeTile(x, null); return; }
    writeTile(t.bpm, c.bpm > 0 ? c.bpm.toFixed(1) : '—', `conf ${fixed(c.confidence)}`); t.bpm.spark!.update(this.confidence, 0, 1);
    writeTile(t.state, STATE_LABEL[c.state], c.state === 'coasting' ? `${c.coastAge.toFixed(1)} s` : '');
    writeTile(t.phase, fixed(c.beatPhase)); t.phase.fill!.style.transform = `scaleX(${c.beatPhase.toFixed(3)})`;
    writeTile(t.downbeat, fixed(c.downbeatConfidence)); t.downbeat.fill!.style.transform = `scaleX(${c.downbeatConfidence.toFixed(3)})`;
    writeTile(t.meter, c.meter > 0 ? `${c.meter}/4` : 'ignoto', c.meter > 0 ? `conf ${fixed(c.meterConfidence)}` : '');
    writeTile(t.bar, c.barPosition >= 0 ? `${c.barPosition + 1} / ${c.meter}` : '—', c.bar >= 0 ? `#${c.bar}` : '');
    writeTile(t.phrase, c.phraseBar >= 0 ? `${c.phraseBar + 1} / ${c.phraseBars}` : '—', c.phraseBars > 0 ? `conf ${fixed(c.phraseConfidence)}` : '');
    writeTile(t.stability, fixed(c.stability)); t.stability.fill!.style.transform = `scaleX(${c.stability.toFixed(3)})`;
    writeTile(t.sync, c.syncErrorMs.toFixed(1), `ms · jitter ${c.jitterMs.toFixed(1)}`);
    writeTile(t.octave, `${fixed(c.halfTime)} / ${fixed(c.doubleTime)}`);
  }

  private writeUnderstanding(f: Readonly<CognitionFrame> | null): void {
    const u = f?.understanding;
    if (!u || !f.enabled) { writeText(this.state, '—'); writeText(this.reason, f && !f.enabled ? 'Cognizione disattivata' : 'In attesa di un ascolto'); return; }
    writeText(this.state, `${u.state} · ${fixed(u.confidence)} · da ${Math.max(0, f.time - u.since).toFixed(1)} s — somiglia a ${u.style} (${fixed(u.styleConfidence)}; generico ${fixed(u.styles[0])})`);
    writeText(this.reason, `${u.reason}${u.silence !== 'none' ? ` · silenzio: ${u.silence} ${u.silenceSeconds.toFixed(1)} s` : ''}${u.surprise >= 0.05 ? ` · sorpresa: ${u.surpriseKind}` : ''}`);
    for (let i = 0; i < DIMENSIONS.length; i++) writeMeter(this.meters[i], u[DIMENSIONS[i][2]]);
    this.lines.update([this.tension, this.surprise, this.expectation]);
  }

  private writePredictions(f: Readonly<CognitionFrame> | null): void {
    const write = (t: ReturnType<typeof table>, list: readonly Prediction[], open: boolean): void => {
      let row = 0;
      for (const p of list) {
        if (row >= ROWS) break;
        if (p.id === 0 || (open && p.kind === 'beat')) continue;
        const c = t.cells[row], line = t.lines[row++];
        line.hidden = false;
        writeText(c[0], KIND_LABEL[p.kind]);
        writeText(c[1], open ? `${Math.max(0, p.time - (f?.time ?? 0)).toFixed(1)} s` : STATUS_LABEL[p.status]);
        // A wide window (a release without a phrase grid) has no expected instant to be off from: only whether it held.
        writeText(c[2], open ? fixed(p.confidence) : p.status !== 'confirmed' ? '—' : p.late - p.early > 2 ? 'in finestra' : `${(p.error * 1000).toFixed(0)} ms`);
        writeText(c[3], open ? STATUS_LABEL[p.status] : fixed(p.confidence));
        writeText(c[4], p.evidence);
      }
      for (; row < ROWS; row++) t.lines[row].hidden = true;
    };
    write(this.open, f?.predictions ?? [], true);
    write(this.recent, f?.recent ?? [], false);
  }

  private fact(label: string, value: string): void {
    let node = this.factValues.get(label);
    if (!node) { node = h('span'); this.factValues.set(label, node); this.facts.append(h('span', {}, label), node); }
    writeText(node, value);
  }

  private writeFacts(f: Readonly<CognitionFrame> | null): void {
    if (!f) { this.fact('Stato', 'nessuno snapshot udito'); return; }
    const s = f.stats, c = f.clock, d = f.diagnostics;
    this.fact('Regia', f.leads ? 'segue la cognizione (griglia di frase)' : `reattiva · ${d.fallback}`);
    for (let k = 0; k < PREDICTION_KINDS.length; k++) {
      const kind = PREDICTION_KINDS[k], resolved = s.confirmed[k] + s.refuted[k] + s.expired[k];
      this.fact(`${KIND_LABEL[kind]}: conf. / smentite / scadute`, `${s.confirmed[k]} / ${s.refuted[k]} / ${s.expired[k]}${resolved ? ` · Brier ${fixed(s.brier[k])}` : ''}${s.confirmed[k] ? ` · anticipo ${s.lead[k].toFixed(1)} s` : ''}`);
    }
    this.fact('Rilasci uditi / non annunciati', `${s.releases} / ${s.releasesUnannounced}`);
    this.fact('Drop dell\'Experience: fuori di ±0,5 s / non uditi', `${s.experienceDropsOff} / ${s.experienceDropsUnheard} di ${s.experienceDrops}${s.experienceDrops ? ` · ultimo scarto ${s.dropOffset >= 0 ? '+' : ''}${s.dropOffset.toFixed(2)} s` : ''}`);
    this.fact('Beat mancati · sorprese · cambi di stato', `${s.missedBeats} · ${s.surprises} · ${s.stateChanges}`);
    this.fact('Clock: persi · ripresi · in continuità', `${c.losses} · ${c.relocks} · ${c.continuations}${c.relocks ? ` · ultimo in ${c.relockSeconds.toFixed(1)} s` : ''}`);
    this.fact('Memoria', `${d.bars} battute · ${d.beats} beat · ${(d.memoryBytes / 1024).toFixed(1)} kB`);
    this.fact('Costo per hop', d.updateMicros > 0 ? `${d.updateMicros.toFixed(1)} µs (campionato)` : '—');
    this.fact('Profili', STYLES.map((s, i) => `${s} ${f.understanding.styles[i].toFixed(2)}`).join(' · '));
  }
}
