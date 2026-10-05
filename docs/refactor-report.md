# Experience Engine — report del refactor

> Seconda fase (worker WASM, clock/eventi, contesto, previsione, Tunnel fisico):
> vedi [realtime-analysis](realtime-analysis.md). Questo report descrive la prima fase.

Data: 5 ottobre 2026. Repository di lavoro locale, baseline iniziale pulita.
Nessun commit o deployment eseguito. UI Halo, core/ring, Direction, palette,
fullscreen e sorgenti live rimangono il prodotto; Resonant Field è la settima scena.

## Sintesi e architettura prima/dopo

Prima: cattura → analisi TS grafica e Rust musicale → frame finale del batch +
eventi → MusicContext/ShowDirector → Dynamics/VisualDirector → sei scene.

Dopo: cattura stereo → viste fisiche 512/2048/8192 → misure percettive/musicali →
**ogni hop** del wire → memoria multiscala, ricorrenza e narrativa → planner
2–8 s → dieci intenti → regia e fisica → sette scene → composizione GPU.
Gli snapshot sono presentati sul tempo già udito, anche con delay. La vista TS
resta per waveform, spettro e voci grafiche: non è una seconda implementazione
delle nuove misure ERB/fase/HPSS o della narrativa.

L'[audit iniziale](refactor-audit.md) ha preceduto il codice. Le fasi hanno
prodotto contratti/DSP, memoria/planner, fisica/scena, adattatori e verifiche.
Check intermedi: baseline 140 test; integrazione intermedia 147 e poi 148 test.
Una build intermedia ha rilevato una chiamata errata al generatore di rumore,
corretta prima della verifica finale. Le prove PCM/browser hanno individuato
anche falsi build all'avvio e il problema del downmix di segnali side-only.

## Contratti e algoritmi implementati

- `AnalysisFrame` ampliato e layout generato: 269 f64 per record compreso tag.
  Snapshot propri nel consumer; backend/frontend/WASM vanno aggiornati insieme.
  Circa 404 kB/s di soli frame a 48 kHz, più eventi/clock: costo consapevole per
  eliminare la dipendenza semantica dalla dimensione dei batch.
- FFT stereo breve 512 per transienti; riuso delle viste 2048 e 8192; 24 bande
  ERB, 72 pitch bin logaritmici, dodici parziali, roughness/fit armonico,
  descrittori complessi/fase, entropia, spread, H/P/R e transienti per otto bande.
- RMS/peak/crest separati da loudness momentary/short/relative e range
  approssimato. Stereo L/R/M/S, cross-fase, correlazione, balance e movimento;
  trasporto stereo anche per mic/test browser.
- Ipotesi metriche 3/4/5/7 con astensione, confidence separata dall'accento,
  fallback interno esplicito; rimossi prior e classificazione di genere.
- `ExperienceState`: energia separata dalla complessità; ordine/caos, tensione,
  trend, anticipazione causale, rilascio, silenzio contestuale e narrativa con
  isteresi. Memorie 0,15/2/10/45/180 s, 32 fingerprint e 32 transizioni visive.
- `ExperiencePlan` e `VisualIntent`: orizzonte, finestre stabili, tetto
  d'intensità, entropia desiderata, continuità/contrasto; ogni intento è datato.
  Saturazione persistente produce respiro. Le stime non sono probabilità calibrate.
- `ExperienceSnapshot`: history 256 slot, al massimo 120 Hz, selezione causale
  su heardTime. Clock duplicati ignorati; regressioni/gap azzerano il contesto.
- `ResonantPhysics`: dodici oscillatori smorzati con matrice esatta già usata
  da Dynamics, forze armoniche e impulsi di velocità; otto fronti d'onda causali.
  Resonant Field sovrappone modi precomputati e prime riflessioni analitiche.
- Grafo simmetrico delle scene, ritorno dei look per motivo, intensità/supporti
  vincolati dal planner; migrazione delle sei scene tramite adattatore comune.
  Impulsi luminosi separati da quelli geometrici tramite il FlashGuard esistente.

Formule, frequenze, ownership e limiti: [acustica](acoustic-model.md),
[planner](experience-planner.md), [fisica](physics-engine.md),
[Director](visual-director.md). Nessuna dipendenza aggiunta.

## Scelte escluse o ridotte

CQT/VQT e gammatone completi sostituiti da proiezioni che riusano le FFT;
skewness/kurtosis non aggiunte perché senza ruolo semantico verificato.
Nessuna AI stem separation, trascrizione o classificazione di genere.
Complex-domain change descrive instabilità ma non sostituisce il detector
onset già validato. Le onde sono analitiche: nessuna griglia GPU ping-pong,
FEM o rimbalzi infiniti. Il budget DSP scala le elaborazioni lente invece di
spostare ora il WASM su worker; quest'ultimo rimane utile per isolare stalli.

La grammatica ha dieci intenti effettivi, non tutte le etichette suggerite.
L'entropia visiva è un proxy semantico, non una misura dei pixel. Il mood
riusa i sedici assi continui di Character già presenti. Le sei scene precedenti
mantengono parte dei mapping locali: la migrazione non è una riscrittura
integrale di ciascun sistema geometrico.

## Benchmark prima/dopo

Macchina: Fedora 44, Intel i7-10510U / UHD, stessa macchina e compilatore.
Benchmark sintetici; non includono cattura reale né garantiscono latenza end-to-end.

DSP nativo release: stesso groove stereo di 60 s a 48 kHz, batch 480 frame.
Tre esecuzioni alternate della baseline isolata da HEAD e della nuova versione;
mediane tra le tre prove. Ogni esecuzione produce 11.250 frame e 113 beat.

| Versione | Tempo per 60 s PCM | Quota di un core | Batch p50 / p95 / p99 |
|---|---:|---:|---:|
| Prima | 1,510 s | 2,5% | 0,136 / 0,475 / 2,140 ms |
| Dopo High | 1,920 s | 3,2% | 0,192 / 0,574 / 2,160 ms |
| Dopo Medium, una prova | 1,516 s | 2,5% | 0,163 / 0,555 / 2,142 ms |
| Dopo Low, una prova | 1,327 s | 2,2% | 0,163 / 0,551 / 2,143 ms |

Il DSP più ricco costa circa **+27%** in tempo CPU nella mediana High; il p99
per batch resta simile. Le prime misure in debug/con build concorrenti non
sono usate come confronto. La misura High precede l'ultima separazione della
confidence dell'accento; questa modifica non aggiunge FFT né cambia le cadenze.

Confronto aggiuntivo 512/1024: tre alternanze, mediana 2,361/3,049 s per 60 s
PCM. La prima esecuzione 512 è disturbata da carico concorrente (5,003 s),
quindi non è una stima precisa di speedup. Si mantiene 512: costo compatibile
con il budget e finestra di 10,7 ms invece di 21,3 ms; il detector ritmico
principale mantiene hop e comportamento precedenti. Il confronto va ripetuto
con CPU isolata prima di usare quei rapporti come indicatore prestazionale.

Benchmark PCM → WASM → decoder → esperienza/planner/fisica → Show/Dynamics,
24 s di build/drop stereo, 100 ms di ritardo, stessa semantica a 30/60/144 fps.
Campione dedicato dopo le correzioni di warm-up; tempi dipendenti da runtime/JIT.

| FPS / batch | WASM + decode per batch, p50/p95/p99 | Esperienza/planner/fisica per hop | Show + Dynamics per render |
|---|---|---|---|
| 30 / 128 | 0,096 / 0,628 / 0,868 ms | 0,023 / 0,072 / 0,137 ms | 0,009 / 0,049 / 0,136 ms |
| 60 / 480 | 0,267 / 0,791 / 2,250 ms | 0,016 / 0,027 / 0,043 ms | 0,003 / 0,009 / 0,018 ms |
| 144 / 2048 | 1,676 / 3,586 / 3,791 ms | 0,013 / 0,025 / 0,038 ms | 0,001 / 0,003 / 0,006 ms |

La prima colonna sottrae il tempo del callback di ExperienceEngine; la seconda
lo misura separatamente. Per ricostruire un costo totale occorre pesare i costi
per numero di batch, hop e frame, non sommare direttamente i percentili. Il test confronta valori ogni 1/6 s: identici entro 1e-8 e
151 eventi in tutte le configurazioni. Non confronta l'identità dei pixel.

La ripetizione finale di `npm run bench` con i due file Vitest in parallelo e
lo smoke browser attivo è più lenta: p95 WASM+decode 2,142 / 3,180 / 10,261 ms
per batch 128/480/2048; p95 esperienza 0,372 / 0,150 / 0,120 ms per hop.
Le invarianti restano identiche. Il confronto mostra la sensibilità al carico:
la tabella precedente non è un limite superiore garantito.

Chromium reale, ANGLE GL/EGL, 1280×720: 7 scene × Low/Medium/High, 60 RAF
campionati dopo 1,1 s per caso. Mediane circa 16,7 ms, p95/p99 16,7–16,8 ms;
nessun errore JS/GLSL in 21 casi e quattro prove aggiuntive di segnale.
È un smoke breve a refresh 60 Hz, non un timer GPU per pass, una prova di
stress dei crossfade o una garanzia desktop. Il nuovo campo non aggiunge pass
GPU oltre a quelli del Layer. Build e dimensioni finali riportate sotto.

## Verifica finale

- `npm run check`: **151 test / 28 file**, typecheck, ESLint e build superati.
- `npm run bench -- --reporter=verbose`: **4 test / 2 file** superati; anche
  il benchmark storico dei cue resta entro un frame a 30/60/144 fps.
- `cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline`:
  **52 test + 1 doctest** superati; wrapper WASM compilato anche per host.
  Revisione successiva: **53 + 1 doctest** con la regressione sul metro non
  pubblicato in `Structure` (vedi scheda tecnica).
- `UPDATE_LAYOUT=1 cargo test -p spectrum-analysis --test wire --offline`:
  layout rigenerato e verificato; `npm run wasm` riuscito con il compilatore
  locale provvisto del target wasm32, binario versionato aggiornato.
- Test isolato del worker nativo con Batch simulato: compilazione e gestione
  batch/gap/reset superate. Non sostituisce la build Tauri.
- Build: JS principale 789,43 kB / 216,12 gzip (prima 765,22 / 208,15);
  WASM 132,39 kB / 52,54 gzip (prima 112,40 / 45,29). Nessuna dipendenza nuova.
- Coperti PCM tono/rumore/anti-fase, RMS/crest, stereo H/P/R, qualità/reset,
  ipotesi metriche, energia/complessità, build/rilascio, taglio/fade, ricorrenza,
  snapshot ritardati, warm-up PCM, dissipazione fisica e saturazione del planner.
  Le regressioni precedenti di lifecycle, storage, clock, Director e budget
  rimangono nella suite. La matrice browser di 21 scene/qualità non ha errori.
- Smoke UI Chromium finale: core/ring con 7 scene, 8 Mood e 5 Experience,
  selezione Resonant Field, Dream/Ambient, persistenza dopo reload e dispose
  superati. Richieste rapide mic→fake→fake rispettano il token di sessione e
  terminano sull'ultima sorgente; non è una prova di acquisizione microfonica
  fisica. Slider Audio delay a 400 ms: snapshot a 3,803 s con analisi a 4,176 s,
  scarto 373 ms coerente con la previsione del tempo di presentazione. Zero
  errori JS/GLSL. Il test risveglia l'auto-hide e usa click alle coordinate del
  core pulsante; attendere stabilità geometrica del bottone non è appropriato.

Il corpus sintetico a 100/124/174 BPM produce beat F1 **0,854**, errore medio
fase **5,2 ms**, downbeat F1 **0,775**: soglie rispettate. Sezioni **4/12**
(**33%**, un falso positivo): soglia non rispettata, limite esplicito.
Ritardo medio di pubblicazione onset 24,8–25,6 ms nei batch del corpus;
non è latenza fisica di cattura/display. Il reader ora accetta annotazioni
`.onsets` e `.novelty` e riporta F1, ma queste annotazioni non sono disponibili
nelle prove eseguite. I contatori di novelty da soli non ne provano l'accuratezza.

Comandi riproducibili (i WAV sintetici sono strumenti di test, non una sorgente dell'app):

```sh
cargo run -p spectrum-analysis --release --offline --example realtime -- 0
cargo run -p spectrum-analysis --release --offline --example realtime -- 1
cargo run -p spectrum-analysis --release --offline --example realtime -- 2
cargo run -p spectrum-analysis --release --offline --example corpus -- --synth /tmp/halo-corpus
cargo run -p spectrum-analysis --release --offline --example corpus -- /tmp/halo-corpus
npm run bench -- --reporter=verbose
```

## Test non eseguibili e debito residuo

`pkg-config --exists webkit2gtk-4.1 alsa` fallisce: niente build desktop Tauri
completa né cattura PipeWire/Pulse/WASAPI reale in questa sessione. Il test
isolato del worker non verifica IPC, driver o WebView. Niente Windows/macOS,
corpus musicale reale annotato, Bluetooth fisico, misure luminose strumentali,
consumo GPU per pass o profiling delle allocazioni su lunga sessione.

Priorità successive:

1. Corpus reale annotato e miglioramento struttura/metro, specialmente sincopi,
   ritmi dispari e cambi con bassa confidence. Il modello non identifica forma-canzone.
2. Cattura reale e test WebView2/WebKit, device unplug, delay fisico e cambi rapidi
   system/mic; profilare IPC dopo il passaggio a tutti gli hop.
3. Timer GPU per pass, sessioni lunghe e transizioni a quattro layer, memory profiling.
4. Migrare progressivamente le forme delle voci TS solo con regressioni percettive;
   isolare WASM su worker se il carico interferisce con UI o frame scheduling.
5. Politica browser backlog/tab nascosta e ring nativo proporzionato al sample rate
   (oggi il ring grafico è ancora di 48.000 campioni).
6. Raffinare fase oltre il solo canale sinistro, fit armonico polifonico, basse note,
   ricorrenze e taratura musicale di entropia/anticipazione. Confronto percettivo
   umano prima di dichiarare maggiore naturalezza su qualsiasi genere.

## Inventario dei file

Nessun file rimosso. Rimossi codice/contratti interni: prior di genere, folding
per batch e contatore ABI dei frame scartati. I file seguenti sono nuovi o
modificati; il file WASM è rigenerato, non sorgente scritto a mano.

### Creati

- `docs/acoustic-model.md`
- `docs/experience-planner.md`
- `docs/physics-engine.md`
- `docs/refactor-audit.md`
- `docs/refactor-report.md`
- `native/analysis/src/acoustic.rs`
- `native/analysis/src/meter.rs`
- `native/analysis/tests/acoustic.rs`
- `src/audio/features/DspBudget.ts`
- `src/bench/experience.bench.test.ts`
- `src/experience/ExperienceEngine.test.ts`
- `src/experience/ExperienceEngine.ts`
- `src/experience/ExperiencePlanner.ts`
- `src/experience/TemporalMemory.ts`
- `src/experience/types.ts`
- `src/physics/ResonantPhysics.ts`
- `src/show/relationships.ts`
- `src/visualizers/resonant-field/ResonantFieldVisualizer.ts`
- `src/visualizers/resonant-field/index.ts`
- `src/visualizers/resonant-field/preset.json`

### Riscritti o aggiornati

- `AGENTS.md`
- `README.md`
- `docs/experience-engine.md`
- `docs/musical-semantics.md`
- `docs/technical-overview.md`
- `docs/visual-director.md`
- `native/analysis-wasm/src/lib.rs`
- `native/analysis/examples/corpus.rs`
- `native/analysis/examples/realtime.rs`
- `native/analysis/src/analyzer.rs`
- `native/analysis/src/beat.rs`
- `native/analysis/src/frame.rs`
- `native/analysis/src/harmony.rs`
- `native/analysis/src/hpss.rs`
- `native/analysis/src/lib.rs`
- `native/analysis/src/structure.rs`
- `native/analysis/tests/beats.rs`
- `native/analysis/tests/structure.rs`
- `src-tauri/src/audio.rs`
- `src/app/RigController.ts`
- `src/app/debug/DebugOverlay.ts`
- `src/audio/AudioEngine.ts`
- `src/audio/capture/AudioCaptureProvider.ts`
- `src/audio/capture/FakeAudioProvider.ts`
- `src/audio/capture/WebAudioProvider.ts`
- `src/audio/capture/tap.worklet.js`
- `src/audio/capture/testSignals.ts`
- `src/audio/features/WasmAnalysis.test.ts`
- `src/audio/features/WasmAnalysis.ts`
- `src/audio/features/decode.ts`
- `src/audio/features/layout.ts`
- `src/audio/features/spectrum_analysis.wasm`
- `src/director/AutoDirection.ts`
- `src/director/VisualDirector.ts`
- `src/director/types.ts`
- `src/renderer/Layer.ts`
- `src/renderer/RenderEngine.ts`
- `src/show/ShowDirector.test.ts`
- `src/show/ShowDirector.ts`
- `src/show/fixtures.ts`
- `src/show/types.ts`
- `src/timing/Timing.ts`
- `src/types/visualizer.ts`

