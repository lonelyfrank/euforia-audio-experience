# Euforia Engine Diagnostics 2.0

In sviluppo: `npm run dev`, poi `http://localhost:1420/?diagnostics` o **Shift+G**.
In una build di produzione: **Ctrl+Alt+Shift+D** (o `?diagnostics` nell'URL); da lì in poi
Shift+G apre e chiude la dashboard. Nessun servizio esterno, nessuna registrazione PCM,
nessun nome di dispositivo nei report, nessuna nuova scena.
La pagina mantiene il rendering originale dietro un pannello tecnico con Shadow DOM:
CSS e menu cinematici non vengono modificati. **Shift+D** conserva l'overlay;
**Shift+E** conserva il cockpit strutturale e collega i domini della diagnostica.

## Proprietà e lifecycle

`App` importa un solo entry point: subito in sviluppo, su richiesta in produzione
(`App.loadDiagnostics`). `installDiagnostics` coordina dashboard, overlay e cockpit
attraverso `DiagnosticsController`; in produzione installa la sola dashboard, che osserva
e non scrive impostazioni (overlay e cockpit restano strumenti di sviluppo).
I consumer acquisiscono una lease: il primo crea store, collector e observer,
l'ultimo li rilascia. Da spento non ci sono timer di raccolta, WorldTrace, query GPU,
readback, log per frame o serializzazioni. Restano solo i listener di apertura.
Nella build di produzione il modulo è un chunk separato: finché non viene chiesto non è
scaricato né eseguito, e nel frame resta un solo confronto con `null`.

## Che cosa misura in più la 2.0

| Metriche | Fonte | Perché |
|---|---|---|
| `frame.p50`, `frame.jank`, `frame.over33/50/100`, `frame.count` | `PresentationProbe`, ogni frame | uno scatto dura un frame: a 5 Hz non si vede |
| `clock.heardError.mean/p95/p99/max` | avanzamento di `Timing.heardTime` meno l'intervallo del frame | moto a strappi anche con frame puntuali |
| `clock.offset`, `clock.offsetError`, `clock.resyncs` | `ClockSync` | la mappa cattura → host e le sue discontinuità reali |
| `pipeline.hopsPerFrame`, `…P99`, `…Max` | `AnalysisDecoder`, ogni frame | ingestione a raffica dopo uno stallo |
| `pipeline.batches/missed/lost/load/quality/dspAge/pending/dropped` anche per la cattura nativa | record clock del produttore, `RecordStage` | prima erano `null` per le sorgenti native |
| `latency.onset` | `Timing.onsetDelay` | cattura di un attacco → frame che lo conosce |
| `cpu.layers`, `cpu.composite` | `RendererProbe` | dove va la sottomissione del rendering |
| `quality.autoStep`, `quality.logicShare`, `quality.fps`, etichetta `quality.limit` | `QualityController` | che cosa limita il frame rate: GPU o CPU |
| `memory.jsHeap` | `performance.memory` (solo Chromium / WebView2) | andamento della memoria |
| eventi `quality-change`, `clock-resync` | `DiagnosticsController` | correlare uno scatto alla sua causa |

Restano non misurabili dall'applicazione: il tempo GPU nei WebView senza
`EXT_disjoint_timer_query_webgl2` (WebKitGTK), la CPU per thread e per processo, la
frequenza della CPU e i limiti di potenza.

`RenderEngine` chiama l'observer all'inizio e alla fine del proprio frame;
`RendererProbe` salva/ripristina `info.autoReset`, raccogliendo **tutti i pass** invece
dell'ultimo. Overlay e cockpit leggono questi contatori senza azzerarli nei loro RAF.
Le scene, la regia, il DSP e le leggi fisiche non leggono Diagnostics.

`DiagnosticsCollector` legge a 5 Hz (Basic) o 10 Hz (Detailed), indipendentemente
dalla UI a 5 Hz. Le distribuzioni di frame time usano 300 intervalli RAF reali,
aggregati solo alla cadenza di raccolta. `EngineProbes` legge i contratti originali;
nessuna FFT aggiuntiva. Gli array audio/modalità/risonanza sono esposti in Detailed.
`collectSnapshot` è condiviso con il replay, non duplica Experience o World.
I gruppi di metriche (`group`) risolvono i propri slot nel registro alla prima lettura
(per registro e prefisso): i campioni successivi non costruiscono id né definizioni.

Il pannello non deve costare frame alla scena che osserva. Le righe di un dominio sono
costruite una volta e conservate: un refresh riscrive solo le celle **in vista** il cui
valore è cambiato (`IntersectionObserver` sul pannello; i gruppi chiusi e le righe fuori
dallo scroll non vengono toccati e si aggiornano quando tornano visibili). Ogni riga ha
altezza fissa e `contain: strict`, quindi una cifra che cambia rifà il layout di quella
riga soltanto; la timeline aggiunge le voci nuove invece di riscrivere il testo; la
didascalia del grafico è testo DOM, non `fillText`. Il tooltip (metodo, clock, timestamp)
è scritto quando si punta la riga. Misure in [validazione](diagnostics-validation.md).

Lo store conserva un vocabolario massimo di 2048 metriche e 120 righe numeriche
preallocate (4.178.880 byte di buffer), più 256 eventi. Il suo registro distingue
zero da `null`, valori stimati da osservati, clock e metodo. Le copie JSON nascono
solo all'export o al comando di baseline. I campioni storici non referenziano array del
motore. WorldTrace conserva al massimo 1200 righe solo dopo REC e mantiene il CSV
storico accessibile con Shift+T. Una sessione audio nuova azzera dati e cursori anche
se l'acquisizione è in pausa. Un probe guasto produce un evento diagnostico e non
interrompe gli altri probe.

## Controlli

- **REC** inizia una nuova traccia; premuto di nuovo conserva la registrazione.
- **Pausa acquisizione** ferma il campionamento nello store; il motore continua.
  I contatori del renderer condivisi con gli altri strumenti restano disponibili.
- **Freeze vista** ferma esclusivamente l'aggiornamento del pannello.
- **Reset buffer** elimina campioni ed eventi, mantenendo il motore intatto.
- **Detailed** aggiunge vettori originali (ERB, bande, pitch, parziali, modi).
- **Profiling GPU** abilita query asincrone sull'intero frame, al massimo quattro
  in volo. Assenza dell'estensione, context loss e disjoint danno `Unavailable`.
  Nessun `gl.finish`, nessuna attesa attiva per un risultato.
- **Readback materia** legge al massimo 256 elementi della prima riga delle due
  texture posizione/velocità, al massimo una volta al secondo per simulazione.
  È sincrono e può rallentare il frame; è separato dal profiling. Il prefisso non è
  un campione statistico della popolazione. Half-float: fallback indisponibile.
- **Isolamento** deriva la lista da `VisualWorld.mounted` e usa `worldLab.only`;
  è un intervento sperimentale di visibilità, ripristinato all'ultima chiusura.
- **Parità** invoca gli harness originali in un contesto WebGL separato, con report
  scaricato su richiesta. Blocca temporaneamente il main thread: non è un benchmark live.

Cambiare dettaglio, profiling, readback o isolamento resetta la traccia: non si
mescolano silenziosamente modalità differenti. Cambi scena/risoluzione/qualità
all'interno di REC marcano `mixed-configuration`: il confronto rifiuta i delta.
Il frontend non mette in pausa la sorgente live o il rendering tramite questi controlli.

## Timeline e ispettori

L'EventCursor originale conserva timestamp audio, seq, forza e confidence. Ogni
riga indica il tempo dello snapshot co-osservato, intento e confidence del planner,
energia approssimata del mondo e recipe. Narrativa e scena producono righe di cambio.
Questo è un allineamento temporale, **non una prova che un singolo evento abbia
causato ogni forza o formazione**. Evizioni dello stream sono dichiarate nel report.
Non si deduce una transizione topologica dal cambiamento della presenza: i soli
conteggi di frattura/legami/poligoni osservati sono quelli di StructuralSystem.

Il Force Inspector espone i coefficienti `WorldForces` e `SpatialFields`; nel dominio
Physics disegna il riferimento CPU originale `flowAt` su una sezione z=0. Rappresenta
il flusso condiviso, non la forza totale applicata a ogni elemento vincolato.
Presenze, costi, elementi e vertici sono quelli delle recipe montate sul protagonista;
i contatori globali del renderer comprendono invece gli altri layer e i crossfade.

## Replay, export e confronto

Il pannello genera dieci scenari deterministici nel worker `replay.worker.ts` e chiama
lo stesso `validation/replay.ts`: PCM → WASM → Experience → World → WorldTrace.
Il PCM non torna al main thread. Selezionare 30/60/144 FPS e batch 256/480/2048.
Pausa replay agisce solo su questo worker alle sue finestre di avanzamento; Stop
termina il worker. La sorgente live continua. Nessuna nuova sorgente file di prodotto.

Dopo il replay, gli export usano il report replay; **Usa dati live** ripristina quello
live. JSON contiene metadati, campioni, eventi e limiti; CSV usa righe tipizzate
metadata/metric/event/limitation; Markdown mostra metadati, ultimo campione e timeline.
Nessun nome dispositivo o PCM viene esportato. `VITE_GIT_SHA` consente di fornire lo
SHA in sviluppo; senza valore è `null`. Il renderer GPU è quello esposto normalmente
da WebGL, senza richiedere estensioni di fingerprinting.

Memorizzare una baseline o importare un JSON, acquisire un secondo report e premere
Confronta. La comparazione verifica configurazione, metodo, unità e disponibilità;
calcola delta assoluti/relativi delle medie. Solo i costi con `lowerIsBetter` indicano
candidati miglioramento/regressione oltre ±5%; non è un test di significatività.
Durate e versioni sono esplicite. Per confronti comportamentali usare il medesimo PCM
sulla griglia audio comune, non due momenti di musica live differenti.

Corpus reale: invariato `EUFORIA_AUDIO_EXPERIENCE_CORPUS=… npm run replay`.
Non versionare registrazioni. Gli harness GPU verificano separatamente i loro semi;
il replay CPU non promette determinismo del rendering.

I report includono anche la configurazione rilevante (sensibilità, smoothing, delay,
qualità richiesta, palette, direzione risolta, riflesso, FlashGuard e override DEV).
Un cambiamento durante REC marca la traccia come mista. Non si esportano nomi
personalizzati di dispositivi. I metadati di una cattura appena avviata vengono
completati quando il provider pubblica il sample rate effettivo.
