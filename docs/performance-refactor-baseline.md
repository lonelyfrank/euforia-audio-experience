# Performance refactor — baseline e strategia di migrazione

Punto di partenza del refactor del 9 ottobre 2026: che cosa è stato verificato prima di toccare il
codice, in quali condizioni, quali contratti andavano preservati e come si torna indietro da ogni
fase. Le misure prima/dopo sono in [performance-benchmarks](performance-benchmarks.md).

## Commit

| Voce | Valore |
|---|---|
| Commit dell'audit | `2a8dfde92617f13a8f2a9ae035f4408c780457e7` (`main`) |
| Commit all'inizio del refactor | lo stesso: `HEAD` = `2a8dfde`, albero pulito, solo l'audit e `docs/audit-data/` non tracciati |
| Differenze rispetto alla versione analizzata | nessuna |

L'audit ([EUFORIA_FULL_ENGINE_AUDIT](EUFORIA_FULL_ENGINE_AUDIT.md)) descrive quindi esattamente il
codice da cui si è partiti.

## Suite di test alla baseline (misurato)

| Comando | Esito alla baseline |
|---|---|
| `cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline` | 59 test + 1 doctest passati |
| `npm run check` (typecheck, lint, test, build) | passato: 58 file, 448 test passati, 1 saltato |

Il test `browser analysis path per sample rate` (soglia di carico DSP < 0,5 a 96 kHz), che durante
l'audit falliva a macchina limitata a 7 W, alla baseline di oggi passa.

## Ambiente (misurato)

| Voce | Valore durante il refactor |
|---|---|
| Macchina | la stessa dell'audit: i7-10510U, Intel UHD (CML GT2), Fedora 44, display 1920×1080 a 60 Hz |
| Limite di potenza | `intel-rapl-mmio` PL1 = **17 W** per tutta la sessione (durante l'audit: 7 W, poi 12 W) |
| Frequenza sotto carico | 2,0–3,2 GHz (durante l'audit: 0,7–0,8 GHz) |
| Calibrazione (nucleo YIN in V8) | 1,8–3,5 ns per iterazione (audit: 8–14 ns a 7 W, 4–5 ns a 12 W; ≈ 1 ns atteso a piena frequenza) |
| Batteria | 100 %, non in carica |
| Carico concorrente | **l'applicazione dell'utente (`tauri dev`, build di sviluppo) è rimasta in esecuzione** per tutta la sessione: circa un core nel processo UI e mezzo core più GPU nel WebView |

Conseguenze:

- i tempi assoluti di questo refactor **non sono confrontabili con quelli dell'audit**: la macchina
  era da 2,5 a 4 volte più veloce. Ogni confronto prima/dopo usa quindi una baseline rimisurata
  nella stessa sessione, uno dopo l'altro (serie Y e S di
  [performance-benchmarks](performance-benchmarks.md));
- la macchina non era comunque a frequenza nominale (17 W contro i 25–51 W che il processore può
  usare), e la GPU era condivisa con l'altra istanza: i valori assoluti restano pessimistici
  rispetto a una macchina libera, e il carico dell'altra istanza è cambiato durante la sessione
  (la stessa scena di baseline ha dato 19 ms di GPU alle 18:55 e 10 ms alle 20:00). Per questo
  contano solo i confronti consecutivi.

## Come si è misurato

Gli strumenti sono quelli dell'audit (allegati in `docs/audit-data/`), riusati senza modifiche di
sostanza:

1. **Due alberi isolati** fuori dal repository: `base` (un `git archive` di `2a8dfde`) e `work`
   (lo stesso più le modifiche), ciascuno con la sonda dell'audit (`audit-probe.ts`), il proprio
   dev server e la propria cache di Vite. Il repository e l'applicazione dell'utente non sono stati
   toccati durante le misure; le modifiche vi sono state copiate a fasi concluse.
2. **Chromium headless sulla GPU reale** (ANGLE → Mesa, Intel UHD), 1280×720, sorgente sintetica
   `synthPop`: l'unico ambiente con query temporali GPU e heap JavaScript osservabile.
3. **Istanza desktop Tauri isolata** (identificativo, directory dati, `CARGO_TARGET_DIR` e porta
   propri) per il percorso nativo: WebKitGTK, cattura dell'audio di sistema, DSP sul thread di
   cattura, IPC. La cattura è stata alimentata in silenzio con lo stesso segnale (`pw-play` senza
   auto-connessione, collegato solo alle porte di ingresso dell'istanza).
4. **Benchmark del repository** (`src/bench`), l'esempio nuovo `scene_cost` e i test.

Limiti dichiarati della baseline:

- **Nessuna build di release** misurata (né prima né dopo): entrambe le istanze desktop sono build
  di sviluppo. È il punto E-02 dell'audit e resta aperto.
- **Nessuna misura su Windows / WebView2 / WASAPI**, la piattaforma di destinazione.
- **Microfono non misurato in modo valido.** Il microfono predefinito era quello degli auricolari
  Bluetooth dell'utente: aprirlo li porta in modalità cuffia (16 kHz) e disturba l'ascolto. Le due
  prove fatte con il microfono sono state interrotte dall'utente e scartate. La configurazione
  salvata dall'utente (microfono, Tunnel, High) è stata quindi riprodotta con la sorgente
  «system», che usa lo stesso percorso nativo (cpal → thread di cattura → IPC).
- **Una sola istanza non è stata possibile**: vedi sopra.
- **Musica reale non usata**: solo il segnale sintetico e ciò che l'utente stava ascoltando sul
  monitor di sistema.
- Finestra 1280×720; schermo intero e 1080p non misurati sul desktop.

## Contratti da preservare

| Contratto | Dove è definito | Come è stato tenuto |
|---|---|---|
| Audio live soltanto (system, microphone, fake) | `createCaptureProvider` | invariato; nessun file audio nel prodotto (il WAV del segnale di prova esiste solo nello scratchpad di misura) |
| `AudioFrame`: significato di ogni campo | `src/types/audio.ts` | invariato; i valori ora vengono dal port Rust, verificato finestra per finestra |
| **Spectrum** e ciò che legge (`AudioFrame`, `music.*`, `WorldView`, `VoiceTextures`, `SignalTexture`, `audibleGlsl`) | `AGENTS.md` | nessun file della scena toccato; nessun cambiamento di significato dei suoi ingressi |
| `AnalysisFrame`, onset, beat, sezioni: ogni hop sul wire | `wire.rs`, `layout.ts` | invariati; aggiunti il record `scene` e campi al record `clock` |
| Causalità e ordine degli eventi; risultato indipendente dal batching | `ExperienceEngine`, `EventStream`, bench | invariati; la decodifica limitata per frame non salta né riordina |
| Reset di sessione; token delle operazioni asincrone; una sola cattura nativa | `AudioEngine`, `src-tauri/audio.rs` | invariati |
| Snapshot presentati al clock percepito | `ExperienceEngine.present`, `Timing` | invariato; il clock percepito ora parte dal timestamp del frame |
| Leggi GLSL ↔ TS (campi, forme, materia, traccianti, gusci, fili) | `render-systems/`, `visual-engine/` | non toccate |
| UI cinematica e pulsante centrale | `App`, `Dial`, `menus` | non toccati |
| Qualità DSP indipendente dalla GPU, mai su hop/beat | `DspBudget`, `audio.rs` | invariato nel principio; soglie ricalibrate (vedi architettura) |

## Strategia di rollback

Il lavoro è stato fatto in un albero isolato con una cronologia propria, una revisione per gruppo
di fasi, ciascuna verde su `tsc`, ESLint, Vitest e `cargo test` prima di passare alla successiva.
Nel repository le modifiche arrivano non committate; i confini fra le fasi sono questi.

| Fase | File principali | Come si torna indietro | Che cosa si perde |
|---|---|---|---|
| 1 — core unificato | `native/analysis/src/scene.rs`, `wire.rs`, `analysis-wasm`, `SceneFeed.ts`, `AudioEngine.ts`, provider, `spectrum_analysis.wasm` | ripristinare i file da `2a8dfde` insieme a quelli della fase 2 (wire e WASM sono versionati: frontend, WASM e backend vanno riportati insieme) | l'analisi grafica torna sul main thread |
| 2 — trasporto e clock | `src-tauri/src/audio.rs`, `RecordStage.ts`, `NativeAudioCapture.ts`, `ClockSync.ts`, `Timing` (argomento `now`) | `ClockSync.ts` è indipendente e si ripristina da solo; il trasporto va con la fase 1 | messaggi doppi, scatti dell'offset |
| 3 — ingestione limitata | `AudioEngine.update` (budget), `RecordStage.drain`, `decode.ts` | passare `Infinity` come budget in `AudioEngine.update` | recupero in un solo frame dopo uno stallo |
| 4 — rendering | `renderer/ScenePass.ts`, `Layer.ts`, `RenderEngine.ts`, `compositeShader.ts` | ripristinare i quattro file da `2a8dfde` (indipendenti dalle altre fasi, salvo `frameSource(dt, now)`) | pass multicampionati, `OutputPass` |
| 5 — tempo delle scene | `RenderEngine.ts` (`MAX_DELTA`, crossfade) | riportare `MAX_DELTA` a `1 / 20` e `rawDt` a `dt` nel crossfade | — |
| 6 — adattamento | `renderer/quality.ts`, `show/GpuBudget.ts`, `RigController.ts` | ripristinare i tre file | Auto torna a scendere anche se il limite è la CPU |
| 7 — diagnostica | `src/diagnostics/**`, `App.ts` (caricamento) | ripristinare la cartella e il blocco in `App` | metriche per frame, attivazione in release |
| dev Linux | `Cargo.toml` (profili `pulseaudio`, `cpal`, `audio-capture`) | togliere i tre profili | torna il difetto A-06 |

Dopo ogni rollback parziale: `npm run check` e `cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline`.
