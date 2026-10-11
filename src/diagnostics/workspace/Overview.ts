import type { DiagnosticsController } from '../core/DiagnosticsController';
import { h } from '../../ui/dom';
import { panel, tile, writeText } from './components';

/** A small presentation of existing observations, with no second history or collector. */
export class Overview {
  private readonly cards = ['Sorgente', 'Frame medio', 'Carico DSP stimato', 'Layer', 'Clock', 'Experience'].map(label => tile(label));
  private readonly alert = h('p', { role: 'status' });
  readonly element = panel({ title: 'Engine Overview', icon: 'home', sub: 'stato del motore' }, h('div', { class: 'ws-metrics ws-metrics-text' }, ...this.cards.map(c => c.element)), this.alert);
  refresh(c: DiagnosticsController): void {
    if (this.element.hidden || !this.element.open) return;
    const audio = c.app.audio, snapshot = audio.experience.presented;
    const metrics = c.store?.registry.metrics;
    const read = (id: string) => metrics?.find(m => m.id === id)?.value;
    const frame = read('frame.mean'), load = read('pipeline.load');
    const values = [audio.state.source ?? 'Nessuna', frame == null ? 'Unavailable' : `${frame.toFixed(1)} ms`,
      load == null ? 'Unavailable' : `≈ ${(load * 100).toFixed(1)}%`, String(c.renderer?.layers ?? 0),
      audio.clock.ready ? `Sync · ${audio.clock.resyncs} resync` : 'In attesa',
      audio.experience.ready ? snapshot.state.narrative : 'In attesa'];
    values.forEach((value, i) => writeText(this.cards[i].value, value));
    const invalid = read('invariants.nonfinite'), outside = read('invariants.fieldDomain');
    writeText(this.alert, invalid == null ? 'Validazione mondo: in attesa di una sessione audio sincronizzata.' :
      invalid || outside ? `Anomalie osservate: ${invalid} valori non finiti, ${outside ?? 0} campi fuori dominio.` :
        'Validazione mondo: nessun valore non finito o campo fuori dominio nell’ultimo campione.');
  }
}
