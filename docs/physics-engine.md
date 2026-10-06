# Risposta fisica e Resonant Field

Le primitive `Dynamics` esistenti restano il proprietario dei follower,
molle, code di impulsi e snap dei parametri. `ResonantPhysics` riusa la stessa
`springMatrix`, soluzione esatta dell'oscillatore smorzato, per dodici modi
indipendenti. Nessuna integrazione Euler dipendente dagli fps.

I modi di una membrana rettangolare sono `sin(m*pi*x)*sin(n*pi*y)`, con
frequenze visive proporzionali a `sqrt(m²+n²)`. Dodici gruppi di sei pitch bin
eccitano modi da grandi a piccoli. La quota armonica mantiene una forza
oscillante; la coherence ne modula l'efficienza. Gli attacchi percussivi
cambiano la velocità. Massa normalizzata a uno, damping ratio 0,22. Energia,
velocità, numero di modi attivi e attività delle onde sono osservabili.

La risposta avanza sui frame audio, non nei visualizer. Dopo l'impulso la
velocità non viene azzerata; nel silenzio viene meno la forza e l'energia
si dissipa. Le ampiezze firmate dei modi si sovrappongono: interferenza e
pattern nodali sono conseguenze dello stato, non animazioni aggiunte al beat.
È un modello fisico visivo: le frequenze proprie sono rallentate rispetto
all'audio e non costituiscono una simulazione meccanica calibrata.

Le otto onde memorizzano origine stereo, timestamp e forza. Propagazione
radiale causale a velocità costante, inviluppo dissipativo e spreading;
il fronte non può apparire prima del tempo di arrivo. Lo shader aggiunge le
prime immagini riflesse dai quattro bordi, con segno invertito e perdita.
È una soluzione analitica approssimata, non una griglia FEM né un integratore
scientifico della PDE; i rimbalzi successivi non sono simulati.

Resonant Field precomputa dodici mode shape per vertice al mount. Un singolo
Points/ShaderMaterial, nessuna texture ping-pong o pass supplementare;
risoluzione della membrana proporzionale alla radice della densità di qualità.
Palette Halo, campo scuro, glow e deformazione; ampiezze condivise, onde datate,
width e coherence acustiche, intenti expand/contract. Il dispose di BaseVisualizer
rilascia geometria e materiale. I buffer delle uniform vengono riusati.

Le sei scene preesistenti ricevono `ModulationState.experienceState` e la
traduzione comune di intenti, energia/complessità e spostamento fisico. Il loro
carattere resta nelle route e nella conversione in geometria. Non è stato
sostituito ogni mapping storico né il loro DSP grafico centralizzato: si tratta
di una migrazione tramite adattatore, con la scena nuova come riferimento.

## Primitive e mondo condiviso

`physics/primitives.ts` offre `DampedOscillator`, `Momentum` ed `Envelope` (soluzioni
esatte per forza costante nel passo). Il corpo del Tunnel (`TunnelBody`, parete-molla e
momento di avanzamento/roll) è stato assorbito dal **World Engine**: la stessa matematica
ora governa un mondo condiviso da tutte le scene, avanzato per hop sul clock audio ed
estrapolato al tempo udito. Contratti, forze, energia e mappe per scena:
[world-engine](world-engine.md). I test di `TunnelBody` (salto del mapping diretto,
overshoot, silenzio, 30/60/144 fps) sono sostituiti dalle invarianti di
`src/world/WorldEngine.test.ts` e `WorldView.test.ts`.
