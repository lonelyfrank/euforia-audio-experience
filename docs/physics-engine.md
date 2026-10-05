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

## Primitive e Tunnel fisico

`physics/primitives.ts` offre `DampedOscillator` (molla smorzata con la stessa
`springMatrix`), `Momentum` (massa con attrito lineare, posizione integrata in forma
chiusa) ed `Envelope`. Ogni passo è la soluzione esatta per una forza costante nel
passo: lo stesso input dà la stessa traiettoria a 30, 60 o 144 fps; gli impulsi
cambiano la velocità, mai la posizione. Nessuna allocazione nel loop.

`TunnelBody` sostituisce nel Tunnel il mapping diretto a posizioni obiettivo quando la
scena riceve il `SceneClock`: la parete è una molla (0,8 Hz, ζ 0,45) attorno
all'apertura del suono, spinta da `expand − contract` pesati per confidence e calciata
dagli hit; avanzamento e rotazione hanno momento con attrito (2,5 e 1,2 s⁻¹), e
`accelerate − decelerate` aggiunge spinta. Si integra sul tempo udito e gli hit del
`HitLog` sono applicati al loro tempo audio (un hit registrato in ritardo viene
applicato subito, non perso; un salto del clock > 1 s riparte a riposo). Senza clock
resta il mapping storico.

Confronto misurato (`TunnelBody.test.ts`, segnale sintetico): l'apertura che passa da
0,9 a 1,3 fa saltare il mapping diretto di 0,4 in un frame, mentre il corpo non supera
il 10% di quel salto per frame, arriva entro il 2% in 1,2 s con un overshoot tra 1% e
10%; un hit apre la parete di oltre 0,05 e torna entro 0,01 in 1,2 s, dove il mapping
diretto non risponde; nel silenzio la velocità scende sotto l'1% in 2 s; tra 30/60/144
fps le traiettorie differiscono meno di 0,02 (raggio) e 0,03 (avanzamento). Non è una
prova percettiva: il beneficio visivo va confermato a occhio sulle scene reali.

