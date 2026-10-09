# Architettura delle prestazioni

Come è distribuito il lavoro del motore dopo il refactor del 9 ottobre 2026, e perché. Le misure
sono in [performance-benchmarks](performance-benchmarks.md), il punto di partenza in
[performance-refactor-baseline](performance-refactor-baseline.md), i contratti preservati e le
verifiche in [performance-regressions](performance-regressions.md), l'hardware modesto in
[low-end-readiness](low-end-readiness.md). L'audit che ha motivato il lavoro è
[EUFORIA_FULL_ENGINE_AUDIT](EUFORIA_FULL_ENGINE_AUDIT.md) (identificativi A-01 … A-15).

Principio: non si è tolto nulla all'esperienza. Si è tolto lavoro che non la cambiava.

## Prima e dopo

```text
PRIMA (2a8dfde)                                   DOPO
cattura ── PCM stereo ─► DSP Rust (musica)        cattura ── PCM stereo ─► DSP Rust: musica (per hop)
   │                         │ record f64                                   + scene (≈ 60/s, mix mono)
   └─ PCM mono ───────────┐  │ 2 canali, 1 msg                                 │ record f64, 1 canale,
                          ▼  ▼ per callback                                    ▼ ≈ 1 msg per frame di scena
main thread, ogni frame:                          main thread, ogni frame:
  FFT + bande + 2 × YIN (TypeScript)                copia dell'analisi scene più vicina (SceneFeed)
  decodifica di TUTTI gli hop arrivati              decodifica di al più N hop
  Experience · Planner · fisica · mondo             Experience · Planner · fisica · mondo
  Timing(performance.now() a metà callback)         Timing(timestamp del frame)
  Rig · Show · Dynamics                             Rig · Show · Dynamics
  per layer: scena → MSAA×4 RGBA16F,                per layer: scena → MSAA×4 una volta → risolta,
     ogni pass successivo ancora in MSAA               pass successivi su target semplici
  composizione → RGBA16F → OutputPass → schermo     composizione → schermo (un pass)
```

## I thread

| Lavoro | Dove gira | Cadenza |
|---|---|---|
| Cattura, conversione in `f32` | thread dello stream (cpal) / AudioWorklet | callback del dispositivo |
| Analisi musicale (`Analyzer`) | thread `audio-capture` (nativo) / `analysis.worker` (WASM) | ogni hop (256 campioni) |
| Analisi delle scene (`scene.rs`) | lo stesso thread, stesso clock | ogni 3 hop a 44,1/48 kHz (≈ 60/s); meno se il DSP è sovraccarico |
| Trasporto | `Channel` Tauri / `postMessage` con buffer trasferiti | ≈ 1 messaggio per frame di scena, subito se c'è un evento |
| Copia dell'analisi scene nell'`AudioFrame` | main thread | per frame |
| Decodifica + Experience, Planner, fisica, mondo | main thread | per hop, al più N per frame |
| Interpretazione grafica (`MusicInterpreter`), Timing, Rig, Show, Dynamics | main thread | per frame |
| Scene, pass, composizione | main thread (comandi) + GPU | per frame |

Sul main thread non arriva più PCM e non gira più alcuna FFT.

## Unified Audio Feature Core (A-02, A-11)

`spectrum-analysis` produce due letture dello stesso audio sullo stesso clock di campioni:

- il `FeatureFrame` musicale, a ogni hop, invariato;
- lo `SceneFrame` grafico (`native/analysis/src/scene.rs`): livelli, bande, spettro logaritmico a
  128 bin, forma d'onda allineata, transienti per regione, il tracker di kick delle scene e le due
  voci (basso, lead) con altezza, chiarezza e forma di un ciclo. È ciò che `AudioFrame` contiene.

`scene.rs` è il port dell'`AudioAnalyzer` TypeScript: le stesse operazioni nello stesso ordine, in
`f64` con memorizzazione in `f32` dove l'originale usava un `Float32Array`. Per le stesse finestre
dà gli stessi numeri (vedi [performance-regressions](performance-regressions.md)). Le ottimizzazioni
fatte dopo il port non cambiano alcun risultato:

- la differenza di YIN calcola otto ritardi alla volta: ogni ritardo resta una somma sequenziale;
- i due passa-banda delle voci scorrono affiancati, e le quattro sezioni di ciascuno lavorano
  ognuna sul campione precedente della sezione che la precede, così non si aspettano a vicenda;
- la FFT ha i twiddle di ogni stadio contigui, e gli stadi scorrono su slice.

Che cosa **non** è stato unificato, e perché: lo spettro. L'analisi musicale tiene gli spettri
stereo in `f32`; le scene vogliono lo spettro del mix mono in `f64`. Condividere la FFT avrebbe
fatto risparmiare circa 20 µs per frame di scena e avrebbe rotto l'identità numerica con il
riferimento (il fondo di rumore di una FFT `f32` è a −150 dB, quello `f64` sotto il limite di
−200 dB dell'analizzatore). Si condividono invece il clock, i confini di hop, il flusso di eventi,
il trasporto e l'adattamento della qualità.

Il vecchio `AudioAnalyzer` resta nel frontend con due ruoli: è il riferimento dei test di
equivalenza, e possiede l'`AudioFrame` che le scene tengono in mano, che fa scendere al silenzio
con il suo stesso smoothing quando nessuna sorgente sta consegnando.

### Cadenza, ritardo, eventi di un frame

L'analisi delle scene non segue più il frame rate: gira ogni `every` hop sul clock di cattura
(`round(hop al secondo / 60)`, quindi 3 a 44,1 e 48 kHz, 6 a 96 kHz), con `dt` esatto. Le sue
costanti di tempo sono in secondi, quindi la cadenza non cambia ciò che misura.

`SceneFeed` tiene gli ultimi 64 record. A ogni frame mostra quello analizzato più vicino a «il più
recente meno l'audio delay», cioè la stessa finestra ritardata che il frame loop analizzava prima.
Ciò che dura un'analisi sola non si perde e non si ripete: se un frame ne scavalca due, il `beat` e
i transienti più forti delle due valgono per quel frame; se due frame mostrano la stessa analisi
(un display più veloce della cadenza), il `beat` vale solo per il primo.

Sensibilità e smoothing dell'utente (moltiplicati dal preset della scena) arrivano al produttore:
comando `set_scene_settings` nel backend, messaggio `scene` al worker. `beatResponse` si applica
alla lettura.

## Trasporto (A-04)

Un solo canale, solo record `f64` (vedi `native/analysis/src/wire.rs`, `WIRE_VERSION = 2`):

| Record | Quando | Contenuto |
|---|---|---|
| `frame` (343) | ogni hop | il `FeatureFrame` |
| `onset`, `beat`, `section` | all'evento | datati sui campioni |
| `scene` (1441) | ogni `every` hop | lo `SceneFrame` |
| `clock` (8) | ultimo record di ogni batch | campione, età del campione più recente, **sequenza**, **epoca**, frame persi, carico e qualità DSP |

- **Coalescenza** (backend nativo): un batch parte quando contiene un record scene o un evento,
  oppure quando ha accumulato 4 hop. Gli hop intermedi viaggiano con il batch successivo: circa un
  messaggio per frame di scena invece di uno per callback di cattura (e nessun secondo canale per
  il PCM). Un evento non aspetta mai.
- **Sequenza**: ogni batch è numerato; un buco viene contato (`missed`).
- **Epoca**: quando l'analisi riparte dopo aver perso più di un secondo di audio il clock di
  cattura ricomincia. Il record clock lo dice, `RecordStage` scarta ciò che aveva dell'epoca
  precedente e l'`AudioEngine` riavvia la sessione (decoder, Experience, clock, timing). Vale allo
  stesso modo per il backend nativo e per il worker.
- **Code limitate**: 64 chunk fra callback e thread di cattura (oltre, il chunk è perso e contato
  come `gap`); `RecordStage` tiene 3 s di record (oltre, scarta ciò che era in attesa e lo conta);
  `SceneFeed` è un anello fisso. Il canale di Tauri non ha un limite proprio (H-03 dell'audit): è
  alimentato a ≈ 1,2 MB/s e svuotato a ogni messaggio; non è stato modificato.
- **Proprietà dei buffer**: nel worker i batch sono `ArrayBuffer` trasferiti e restituiti al pool;
  nel nativo ogni messaggio è un `Vec<u8>` ceduto a Tauri.
- **Versione**: il backend la dichiara in `start_audio_capture`, il modulo WASM con `sa_version()`.
  Un produttore di un'altra versione viene rifiutato con un errore leggibile.

`SharedArrayBuffer` resta dove era già (worklet → worker, quando la pagina è isolata): nel WebView
di Tauri la pagina non è cross-origin isolated e il percorso continua a usare `MessagePort`.

## I quattro clock (A-05, A-07)

| Clock | Unità | Chi lo possiede |
|---|---|---|
| **Cattura** | campioni dall'inizio della sessione | il dispositivo; ogni record lo porta |
| **Analisi** | lo stesso, all'ultimo hop decodificato | `AnalysisDecoder.frame.time` |
| **Presentazione** (momento udito) | secondi di cattura mostrati in questo frame | `Timing.heardTime` |
| **Render** | timestamp di `requestAnimationFrame` | `RenderEngine` |

- Il clock di render entra una volta per frame: `RenderEngine.tick(now)` → `frameSource(dt, now)` →
  `AudioEngine.update(dt, now)` → `Timing.update(now, …)`. Prima `Timing` leggeva
  `performance.now()` a metà callback e ogni ritardo del callback diventava un passo del moto.
- `ClockSync` stima `host − cattura` come la consegna più veloce degli ultimi 12 s (minimi per
  secchi di 0,25 s). Dopo i primi 2 s l'offset mostrato **scorre** verso la stima a non più di
  2 ms al secondo: venti volte la deriva peggiore fra due clock, e nessun passo visibile. Un salto
  reale (più di 0,25 s: macchina sospesa, host bloccato) riavvia la stima e viene contato
  (`resyncs`). Prima il minimo copriva di fatto 0,3–0,6 s e ogni minimo migliore veniva adottato
  all'istante: da qui gli scatti di 2,5–14 ms misurati dall'audit.
- Il tempo di presentazione è monotono dentro una sessione; riparte solo ai reset espliciti
  (cambio sorgente, nuova epoca).

## Esecuzione dell'Experience (A-08)

La catena Experience → Planner → fisica → mondo resta sul main thread. Costa 0,2–0,3 ms per frame
a 60 fps su questa macchina; spostarla in un worker avrebbe richiesto di serializzare a ogni frame
lo snapshot presentato (stato, piano, intenti, fisica, risonanza, mondo, morfologia, un frame
acustico di 343 valori) e gli eventi, cioè più lavoro di quello tolto. Fase dichiarata non
necessaria; resta possibile se la catena crescesse molto.

Ciò che è cambiato è il **limite per frame**: `RecordStage.drain` decodifica al più
`max(12, 4 × hop che arrivano in un frame)` hop. Dopo uno stallo l'arretrato si smaltisce sui frame
seguenti (a 60 fps, 13 hop per frame contro 3 in arrivo) invece che in uno solo. Nulla viene
saltato: ogni record è decodificato una volta, in ordine. I record scene non aspettano: vanno
subito a `SceneFeed`, così l'immagine non resta indietro durante il recupero. Se lo stallo supera i
3 s di capacità, ciò che era in attesa viene scartato e l'Experience riparte da un vuoto dichiarato
(`gaps`), come già faceva.

## Rendering (A-03, A-09)

- **MSAA una volta** (`renderer/ScenePass.ts`). L'antialiasing riguarda i bordi della geometria:
  serve solo al pass che disegna la scena. Prima l'intero composer del layer era multicampionato:
  ogni pass a tutto schermo (la fusione del bloom, un afterimage) scriveva quattro campioni per
  pixel in `RGBA16F` e li risolveva di nuovo, per un'immagine identica (un quad copre tutti i
  campioni; sommare a quattro campioni uguali e poi mediare è sommare alla media). Ora la scena va
  in un target multicampionato proprio, viene risolta una volta, e i pass successivi lavorano su
  target semplici senza depth.
- **Composizione in un pass**. La composizione finale disegnava in un `RGBA16F` a piena
  risoluzione che un `OutputPass` copiava a schermo convertendo lo spazio colore. Ora lo shader di
  composizione converte da sé (`#include <colorspace_fragment>`) e disegna a schermo: un pass a
  piena risoluzione e due target in meno.
- **Preparazione non bloccante**. `Layer` compila i programmi della scena con `compileAsync`
  (per il target su cui verranno usati: un programma dipende dallo spazio colore di uscita). Finché
  non sono pronti il layer non viene aggiornato né disegnato, e la scena uscente resta da sola sullo
  schermo. Restano sincroni la costruzione delle geometrie e i programmi che non stanno nel grafo
  della scena (passi di simulazione GPU, pass della scena).
- **Crossfade in tempo reale**: 0,9 s di orologio, non di `dt` limitato; uno stallo oltre 0,25 s
  non lo fa avanzare.

Bloom, numero di campioni, formati e densità dei profili non sono cambiati. Gli esperimenti su
MSAA 0/2/4, bloom e risoluzione sono in [performance-benchmarks](performance-benchmarks.md).

## Tempo delle scene (A-10) e layer invisibili (A-12)

| Classe | Sistemi | Come avanza |
|---|---|---|
| Evoluzione analitica | `WorldEngine`/`WorldIntegrator`, `Dynamics`, fronti d'onda, topologie delle scene fisiche | tempo assoluto sul clock udito: indipendente dal frame |
| Simulazione numerica | `MatterSimulation`, `TracerSimulation` | `dt` del frame in sotto-passi di 1/50 s, al più 4 |
| Aggiornamento a evento | cue, `EventCursor`, look dello `ShowDirector` | all'evento, datato sui campioni |
| Aggiornamento visivo | inviluppi di presenza, `VisualDirector`, fasi delle scene storiche | `dt` del frame |
| Elaborazione GPU | pass, bloom, composizione | per frame, solo se visibile |

Il passo massimo dato alle scene è ora **80 ms** (era 50): è ciò che le simulazioni integrano
senza perdere tempo (4 × 1/50 s). Fino a 12,5 fotogrammi al secondo il tempo delle scene scorre
insieme a quello della musica; sotto, resta indietro invece di saltare. Nessun recupero dopo uno
stallo.

I layer a peso zero continuano ad aggiornare lo stato (e i passi di simulazione): sospenderli
richiederebbe di definire come una simulazione persistente riprende, e su questa macchina la
situazione (un secondo fixture montato e buio) non si verifica mai fuori dai crossfade, quindi non
c'è una misura che lo giustifichi. Intervento rinviato; vedi
[performance-regressions](performance-regressions.md).

## Adattamento al carico

Un solo osservatore, `QualityController` (`renderer/quality.ts`), misura il frame rate e dice che
cosa lo limita; `GpuBudget` legge gli stessi numeri (`RenderEngine.load`).

- **Limite**: sotto l'85 % del target, se il main thread spende più di metà del frame nella propria
  logica (record, Experience, rig: ciò che precede ogni disegno) il limite è la **CPU**, altrimenti
  la **GPU**. Auto scende solo nel secondo caso.
- **Che cosa non è evidenza**: stalli oltre 0,25 s, frame durante un crossfade o mentre una scena
  si prepara, i 2 s dopo ogni cambio di profilo.
- **Isteresi**: discesa dopo 3 s; risalita dopo 30 s stabili e 60 s di cooldown; un recupero
  seguito da una nuova discesa entro 2 minuti raddoppia l'attesa del successivo, fino a 8 minuti.
- **Coordinamento**: nessun nuovo fixture mentre Auto è ridotto, mentre il frame rate è limitato o
  durante una transizione. Il budget cede per primo (2 s sotto 50 fps), Auto dopo (3 s).
- **DSP**: indipendente dalla GPU. Sopra il 40 % di un core per 2 s (esclusi i primi 3 s) la
  qualità DSP scende: cadenze lente dell'analisi musicale e cadenza delle scene (3 → 4 → 6 hop);
  sotto il 20 % per 30 s risale. Hop, onset e beat non cambiano mai. Le soglie erano 30 % e 12 %
  quando il thread faceva solo la musica.

Ordine di ciò che cede: lavoro inutile (già tolto per tutti) → fixture in più → risoluzione
interna → bloom → densità. Gli eventi musicali e lo stato semantico non cedono.

## Diagnostica

Vedi [engine-diagnostics](engine-diagnostics.md). In breve: la dashboard misura ora anche ciò che
dura un frame (`PresentationProbe`), il trasporto nativo, la mappa dei clock e il limite del frame
rate, e si può aprire in una build di produzione (Ctrl+Alt+Shift+D) senza che nulla di essa venga
caricato prima.
