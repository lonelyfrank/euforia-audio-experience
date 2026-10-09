# Analisi realtime: thread, clock, stati ed eventi

Data: 5 ottobre 2026. Estende il percorso descritto in [acoustic-model](acoustic-model.md),
[experience-planner](experience-planner.md) e [physics-engine](physics-engine.md); non lo
riscrive. Comandi e verifiche sono in fondo.

```text
LIVE AUDIO → CAPTURE / AUDIO CLOCK → MULTI-RATE REALTIME ANALYSIS (Rust/WASM, fuori dal RAF)
  → ACOUSTIC + PERCEPTUAL + CONTEXT (AnalysisFrame per hop) → RHYTHMIC / MUSICAL (griglia, metro, frasi)
  → TEMPORAL MEMORY → EXPERIENCE STATE + EVENT STREAM → EXPERIENCE PREDICTION
  → EXPERIENCE PLAN / VISUAL INTENTS → PHYSICAL RESPONSE → RENDERER
```

## Audit: cosa è stato mantenuto e cosa no

| Decisione | Sistema | Motivo |
|---|---|---|
| KEEP | Cattura nativa, coda limitata, `src-tauri` worker, session token, `setSource` serializzato | Già fuori dal RAF, con gap espliciti e reset di sessione |
| KEEP | `Analyzer` Rust (hop 256, viste 512/2048/8192, ERB, pitch log, loudness, fase, HPSS, stereo, PLL, metro) | Copre §3–13 dell'obiettivo; misurato e testato |
| KEEP | Wire/layout generato, `AnalysisDecoder`, `ClockSync`, `Timing`, `Dynamics`, `CueScheduler`, `FlashGuard`, `GpuBudget`, `ShowDirector` | Contratti robusti; cambiano solo i consumatori |
| EXTEND | `Analyzer` → `context.rs` | Noise floor per banda, percentili di loudness, derivate dei descrittori lenti, downbeat previsto |
| EXTEND | `ExperienceEngine` | Event stream, derivate, trajectory multiscala, narrativa probabilistica, previsione, silenzio semantico |
| EXTEND | `ExperiencePlanner` / `VisualDirector` | Finestra allineata al confine previsto, confidence per intento, 14 intenti con indice per nome |
| EXTEND | `RecordStage` (estratto da `NativeAudioCapture`) | Lo stesso staging serve nativo e worker |
| REPLACE | WASM sul main thread dentro `AudioEngine.update()` | La cadenza del DSP dipendeva dal RAF; ora `AnalysisHost` gira nel worker |
| REPLACE | Generatore di test chiamato da `readSamples()` | Ora è clockato dal worker come un dispositivo |
| REPLACE | Raggio/avanzamento del Tunnel come posizioni obiettivo | `TunnelBody`: forze, momento e impulsi datati |
| REMOVE | `drain()`/`analysisChannels` dei provider, `AudioEngine.startFeatures`, ring stereo sul main thread | Sostituiti da `readFeatures()` uniforme per ogni sorgente |

Escluso per motivi misurati o di costo: CQT/VQT e gammatone completi (le proiezioni su
FFT esistenti bastano), skewness/kurtosis, separazione neurale, un secondo detector
onset complesso. Nessuna dipendenza nuova.

## Thread model

| Contesto | Desktop (system/mic nativi) | Browser (mic) | Sorgente di test |
|---|---|---|---|
| Cattura | callback cpal → coda limitata | AudioWorklet `tap.worklet.js` | generatore deterministico |
| DSP Rust | thread worker di `src-tauri` | worker `analysis.worker.ts` (WASM) | stesso worker, timer proprio (5 ms) |
| Trasporto PCM→DSP | coda nativa | `SharedArrayBuffer` + indici atomici; senza isolamento `MessagePort` con buffer trasferiti | in memoria nel worker |
| DSP→main | Tauri `Channel` binario | `postMessage` con buffer trasferiti e riciclati | idem |
| Main thread | `RecordStage` → decoder → Experience → Rig → render | idem | idem |

Il main thread non esegue DSP tranne nel fallback `main-thread` (nessun `Worker`, per
esempio i test Node): lì l'host gira nella stessa forma, al passo del frame, come prima.
La scena continua a ricevere PCM mono per la grafica tramite il ring di `readSamples()`.

### Modalità del worker

`BrowserAnalysis.stats.mode` (visibile nel DebugOverlay) vale:

- `worker-shared`: ring condiviso (2 s arrotondati a potenza di due, 2,73 s a 48 kHz).
  Il worklet pubblica `written` con `Atomics.store` dopo i dati e sveglia il worker
  ogni 512 frame (`Atomics.notify` / `Atomics.waitAsync`); senza `waitAsync` il worker
  esegue polling ogni 5 ms. Richiede cross-origin isolation: `vite.config.ts` imposta
  COOP `same-origin` e COEP `credentialless` solo per dev/preview browser, non quando
  Vite parte da Tauri. `credentialless` isola Chromium e Firefox senza bloccare
  risorse; WebKit lo ignora (nessun SAB, modalità `worker-port`).
- `worker-port`: senza isolamento, blocchi di 1024 frame via `MessagePort` dal worklet
  direttamente al worker (il main thread non li tocca).
- `worker-timer`: sorgente di test generata nel worker; il mono per la grafica torna
  al main con buffer riciclati.
- `main-thread`: fallback.

Il worklet inserisce silenzio per i render quantum saltati (`currentFrame` discontinuo),
contandolo nell'header del ring: il clock dei campioni resta quello del contesto audio.
Se il worker resta indietro oltre la capacità del ring, i frame persi fino a 1 s
vengono analizzati come silenzio (clock esatto); oltre, l'analisi riparte con una nuova
**epoch** (`AudioEngine` azzera decoder, Experience, ClockSync e Timing e incrementa la
sessione). I buffer di record e PCM circolano in pool: niente garbage continuo dopo il
warm-up. Se il frame loop è fermo (tab nascosta), `RecordStage` conserva circa 3 s di
record e poi scarta i più vecchi, contandoli (`dropped`).

## Clock

- **Sample clock**: `sample` di ogni record = indice del campione successivo all'ultimo
  analizzato nella sessione/epoch; `time = sample / sampleRate`. Ogni evento (onset,
  beat, downbeat, sezione, impatto, silenzio, drop, picco del build, confine di frase)
  porta il tempo dei campioni che lo hanno generato, mai quello di decodifica.
- **Batch**: ogni batch termina con un record clock `(sample, age)`; `age` è il tempo
  tra l'arrivo del campione più recente al DSP e la chiusura del batch. `ClockSync`
  usa il minimo di `arrival − age − capture` su 3 s.
- **Heard time**: `Timing` converte il clock di cattura nel momento udito quando il
  frame sarà visto (latenza di uscita e di rendering). Snapshot Experience, fisica,
  eventi e corpi delle scene sono letti su questo tempo, mai sul RAF.
- **Sessione ed epoch**: cambio sorgente → sessione nuova; perdita lunga di audio →
  epoch nuova della stessa sorgente; l'event stream incrementa la propria epoch a ogni
  reset e i cursori dei consumatori si riallineano da soli.

## Frequenze di aggiornamento

A 48 kHz un hop è 5,33 ms (187,5 Hz); a 44,1 kHz 5,80 ms; a 96 kHz 2,67 ms.

| Livello | Cadenza (High / Medium / Low) | Contenuto |
|---|---|---|
| Ultra fast | ogni hop | transienti 512, onset, PLL/beat phase, RMS/peak, bande, loudness, stereo, flux |
| Fast | ogni hop | contesto: floor per banda e attività, percentili, derivate (stato filtrato) |
| Medium | 4 / 8 / 16 hop | ERB, fase/complex flux, descrittori spettrali, HPSS |
| Slow | 8 / 16 / 32 hop | pitch bins, chroma, parziali, armonicità, roughness |
| Strutturale | per beat / battuta | metro, downbeat, frasi, sezioni, novelty di battuta |
| Very slow | 2 Hz | fingerprint di ricorrenza (TS, `TemporalMemory`) |
| Experience | ogni hop; snapshot ≤ 120 Hz | stato, eventi, previsione, plan, fisica modale |
| Scene | per frame, sul clock udito | `Dynamics` 240 Hz; mondo (World Engine) per hop, estrapolato esattamente al tempo udito |
| Analisi delle scene (`scene.rs`) | ogni 3 hop a 44,1/48 kHz (≈ 60/s), 6 a 96 kHz | l'`AudioFrame`: livelli, spettro, forma d'onda, voci; record `scene` sul wire |

La qualità DSP (`DspBudget`, sopra 40% di un core per 2 s scende, sotto 20% per 30 s
risale; i primi 3 s dopo l'avvio non contano) cambia solo le cadenze Medium/Slow e quella
dell'analisi delle scene (3 → 4 → 6 hop). Hop, beat, onset, clock e contesto restano
invariati. Il budget è indipendente dalla qualità GPU. Le soglie erano 30% e 12% finché il
thread faceva solo l'analisi musicale: dal 9 ottobre 2026 porta anche quella grafica
([performance-architecture](performance-architecture.md)).

Trasporto e clock dopo il refactor delle prestazioni: un solo flusso di record per sorgente
(nessun PCM verso il main thread), record clock con sequenza ed epoca, al più N hop
decodificati per frame, `ClockSync` che scorre invece di scattare, `Timing` che parte dal
timestamp del frame. I dettagli sono in [performance-architecture](performance-architecture.md).

## AcousticState (AnalysisFrame)

Il frame Rust resta l'unico produttore delle misure fisiche e percettive
([acoustic-model](acoustic-model.md)). Nuovi campi di contesto (`context.rs`):

- `bandFloorDb[8]`, `bandLevel[8]`: noise floor adattivo per banda e attività sopra il
  floor (0 a 3 dB, 1 a 33 dB). Il floor scende subito, sale a 6 dB/s solo su livelli
  stabili quando il gate globale è chiuso, a 0,2 dB/s se stabile entro 6 dB durante la
  musica: un pad sostenuto non viene assorbito. Il floor sopravvive al reset di sorgente.
- `loudnessQuantiles[4]`: P10/P50/P90/P95 online della loudness momentary (tracking
  stocastico a 3 LU/s, P95 scende a 0,15 LU/s). `loudnessPosition`: 0,5 al P50, ±0,5
  verso P10/P95 (span minimo 6 LU). Relativo e robusto ai picchi singoli.
- `brightnessSlope`, `entropySlope`, `complexitySlope`, `harmonicitySlope`: derivate
  prime filtrate (unità/s), anche per descrittori aggiornati a cadenza lenta.
- `nextDownbeatTime`: downbeat previsto sulla griglia; con metro ignoto segue il
  raggruppamento di fallback e va pesato con `downbeatConfidence`/`meterConfidence`.

## ExperienceState

Oltre ai valori esistenti (energia, complessità, ordine/caos, tensione, flow, pressione,
risonanza, novelty/familiarity, anticipazione, rilascio, narrativa):

- **Derivate**: `energyVelocity/Acceleration`, `complexityVelocity`, `tensionVelocity`,
  `opennessVelocity` calcolate in TS su grandezze dell'esperienza; loudness, brightness,
  entropy, harmonicity e width passano dalle derivate Rust (nessun ricalcolo DSP in TS).
- `relativeLoudness` (da `loudnessPosition`): il volume assoluto non è il proxy universale.
- `density` usa l'attività sopra il floor per banda: una stanza rumorosa non sembra un mix denso.
- **Trajectory** (`plateau`, `rising`, `falling`, `building`, `releasing`,
  `stabilizing`, `destabilizing`, `suspended`): punteggi da trend 0,15/2/10/45 s e
  derivate; l'accordo tra scale rafforza una direzione. Cambio con margine 0,1 tenuto
  0,4 s (silenzio e rilascio immediati); `trajectoryConfidence` è il margine sul rivale.
- **Narrativa** (`calm`, `floating`, `building`, `ascending`, `climax`, `release`,
  `descending`, `suspended`, `reset`): quote normalizzate dei punteggi, filtrate (0,35 s),
  cambio con margine 0,08 tenuto 0,7 s e almeno 2 s dall'ultimo; silenzio, rilascio e
  ripresa dopo un silenzio lungo agiscono subito. `narrativeConfidence` è la quota attuale.
- **Build e rilascio**: un build richiede crescita sostenuta (trend 2/10 s *e*
  velocità corrente positiva); il plateau dopo un gradino non è un build. Il rilascio
  scarica anticipazione e potenziale; finché è fresco la sua energia non conta come build.
- **Silenzio**: `silenceKind` `hard-cut` / `soft-fade` / `long-silence` (≥ 2 s); un
  `silenceEnd` sotto 0,6 s è un short gap; durata, abruptness, energia e tensione
  precedenti sono conservate.
- **Previsione** (nessun lookahead): `nextBeat/Downbeat/PhraseTime` con confidence,
  orizzonte `1 + 3 × rhythmConfidence` s, `likelyContinuation/Build/Release/Boundary`
  e `predictionConfidence`. Sono evidenze deterministiche, non probabilità calibrate.

## Event stream

`ExperienceEngine.events` (`EventStream`) separa gli eventi dallo stato continuo:
`onset`, `beat`, `downbeat`, `impact`, `silenceStart`, `silenceEnd`, `drop`, `buildPeak`,
`sectionBoundary`, `phraseBoundary`. Ogni `AudioEvent` ha `audioTime`, `strength`,
`confidence`, `band` (0–7, -1 broadband), `structuralWeight`, `duration`, `seq`.

Ring limitato (256), ordinato per tempo audio con inserimento dalla coda: un onset è
riportato un hop dopo il picco, una sezione un beat dopo il suo downbeat, un picco di
build quando il calo lo conferma. `forEachHeard(cursor, heard)` consegna in ordine gli
eventi già uditi non ancora visti e quelli arrivati in ritardo, una volta sola.
`RigController` usa lo stream per gli impulsi luminosi d'impatto: più impatti tra due
frame ricevono ciascuno il proprio impulso al proprio tempo audio, sempre attraverso il
`FlashGuard`; un arretrato più vecchio di 0,5 s non viene flashato.

## Confidence

| Inferenza | Confidence | Uso |
|---|---|---|
| Beat / tempo | `beatConfidence × presence` | `RhythmGate`, `pulse`, orizzonte di previsione |
| Metro | margine tra ipotesi 3/4/5/7; `meter=0` = ignoto | battuta e frasi solo sopra 0,2 |
| Downbeat previsto | `downbeatConfidence × (0,5 + 0,5 metro)`, 0,4 col fallback | finestra del planner |
| Confine di frase | `structureConfidence × downbeat` | `likelyBoundary`, finestra di transizione |
| Anticipazione | `confidence × (0,4 + 0,6 max(ritmo, struttura))` | intento `contract`, drop |
| Trajectory / narrativa | margine / quota | debug, regia |
| Intenti | ciascuno la propria | `VisualDirector` e Tunnel usano `strength × confidence` |

Nessuna confidence viene trasformata in un booleano a monte: le soglie esistono solo
dove si prende una decisione discreta (cambio di narrativa, finestra allineata).

## Intenti e risposta fisica

Quattordici intenti indicizzati per nome (`INTENT.expand`, …): ai dieci precedenti si
aggiungono `pulse` (picco sul beat previsto, sale prima di esso, confidence del beat),
`accelerate`/`decelerate` (derivate di energia e complessità) e `reveal` (novità con
apertura crescente). La finestra di transizione del plan si allinea al confine di frase
previsto quando la sua confidence supera 0,35 (`transitionConfidence`).

Il Tunnel è la scena migrata (Resonant Field era già fisica): vedi
[physics-engine](physics-engine.md). Primitive riutilizzabili in `physics/primitives.ts`.

## Benchmark

Macchina: Fedora 44, i7-10510U / UHD Graphics, carico desktop normale (VS Code,
server Vite). Sintetici; non includono cattura reale né display.

**Percorso browser per sample rate** (`npm run bench`, Node/V8, `buildDrop` 12 s,
risveglio ogni 512 frame, lettura a 60 fps; p50 / p95 / p99 in ms):

| Rate | Host pump (WASM + framing) per risveglio | DSP | Trasferimento per batch | Stage + decode per frame | Experience per hop | Planner per hop |
|---|---|---:|---|---|---|---|
| 44,1 kHz | 1,292 / 2,932 / 3,983 | 13,1% | 0,105 / 0,321 / 0,396 | 0,077 / 0,207 / 0,297 | 0,066 / 0,171 / 0,254 | 0,005 / 0,023 / 0,046 |
| 48 kHz | 1,198 / 2,788 / 4,051 | 13,5% | 0,099 / 0,314 / 0,402 | 0,076 / 0,205 / 0,307 | 0,059 / 0,155 / 0,231 | 0,003 / 0,013 / 0,021 |
| 96 kHz | 1,106 / 2,662 / 3,626 | 26,1% | 0,087 / 0,285 / 0,392 | 0,124 / 0,283 / 0,382 | 0,036 / 0,120 / 0,197 | 0,003 / 0,010 / 0,022 |

“DSP” è la quota di un core del solo host. A 96 kHz il numero di hop raddoppia: il
costo segue la durata audio, non il frame rate. Il trasferimento è uno `structuredClone`
con transfer sullo stesso thread; la latenza reale tra thread è misurata in Chromium.

**Invarianza al batching** (stesso benchmark del refactor precedente): 30/60/144 fps con
batch 128/480/2048 producono stato, eventi (151) e modi fisici identici entro 1e-8.
WASM+decode per batch 0,201/1,456/2,314 · 0,885/2,666/5,043 · 4,137/7,508/9,418 ms;
experience+planner+physics per hop 0,112/0,386/0,652 · 0,058/0,170/0,259 · 0,039/0,123/0,219 ms.

**Chromium reale** (ANGLE GL/EGL, dev server con COOP/COEP): sorgente test in
`worker-timer`, DSP 11,5% di un core, età del batch 0,6 ms, trasferimento medio 0,9 ms;
microfono finto in `worker-shared` (SharedArrayBuffer attivo), DSP 13,0%, età 1,7 ms,
trasferimento 0,3 ms; 3,89 s → 730 frame = tutti gli hop. Con il main thread bloccato
600 ms il worker ha continuato: 132 batch consegnati allo sblocco, zero scartati. Nessun
errore JS/GLSL in Tunnel, Resonant Field e Galaxy con overlay attivo. Tempi di frame
**non validi** in questa sessione: sulla stessa macchina girava un'app Tauri di debug
di un'altra sessione (load average ≈ 9,5, WebKit al 56–68% di CPU), con frame a ~33 ms
anche nelle scene invariate; sotto quel carico il `DspBudget` è sceso da solo a Medium
(DSP 23,6%). Ritardo attacco→frame misurato dal `Timing` con sorgente di test: 39–44 ms
nello stesso contesto carico.

**DSP nativo** (`examples/realtime`, 60 s stereo, High): A/B alternato con e senza
`context.rs`, tre coppie: con 2,33/2,31/3,07 s, senza 3,45/3,32/2,85 s. Il rumore della
macchina (2,3–4,2 s per la stessa build) supera il costo aggiunto, che non è
distinguibile; questi valori non sono confrontabili con l'1,92 s del report precedente.

**Latenza**: il worklet sveglia il DSP ogni 512 frame (10,7 ms a 48 kHz, prima blocchi
di 1024 = 21,3 ms consegnati solo al frame successivo); età DSP 0,6–1,7 ms; trasferimento
0,3–0,9 ms; poi l'attesa del frame successivo. Il rig bench (stesso DSP, senza worker)
misura kick → fixture accesa con mediana 12,4 ms a 60 fps.

## Verifiche e limiti

```sh
npm run check
npm run bench -- --reporter=verbose
cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline
UPDATE_LAYOUT=1 cargo test -p spectrum-analysis --test wire --offline
npm run wasm        # target wasm32-unknown-unknown richiesto
```

Non eseguibili qui: build/cattura Tauri (`pkg-config webkit2gtk-4.1 alsa` assente),
WebView2/WebKitGTK reali (worker modulo, COEP sotto IPC Tauri), microfono fisico,
Windows/macOS, corpus musicale annotato, timer GPU per pass. Il browser desktop Tauri non
usa il ring condiviso (la cattura è nativa); la sorgente di test usa il worker senza SAB.

Debito: la regia delle altre cinque scene usa ancora l'adattatore del Director; il fit
dei parametri fisici del Tunnel è stato verificato su segnali sintetici, non con prove
percettive; la previsione e la trajectory non sono calibrate su un corpus reale;
`AudioAnalyzer` TS continua a esistere per la grafica.
