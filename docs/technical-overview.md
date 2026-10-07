# Euforia-Audio-Experience — scheda tecnica e audit

Aggiornata il **7 ottobre 2026** (scene fisiche: Field, Tunnel, Particle Field). Il [README](../README.md) è la fonte di verità per
funzionalità, avvio e architettura; questa scheda contiene i dettagli operativi per
chi modifica il progetto. [experience-engine.md](experience-engine.md) conserva
le decisioni e misure delle fasi precedenti. Il prodotto usa solo sorgenti live;
il vecchio supporto file non esiste più.

## Nuova pipeline operativa

Capture stereo → DSP fisico/percettivo/musicale Rust → tutti gli hop del wire →
ExperienceEngine → memoria/narrativa → ExperiencePlanner → VisualIntent →
**WorldEngine → WorldState persistente** (forze, impulsi, energia; estrapolato al
tempo udito) → ShowDirector (rappresentazione, struttura per fixture) / VisualDirector + WorldView (per layer)
→ scene che interpretano il mondo: forme proprie (legacy) oppure **recipe** di un mondo visuale
(`SonicGeometryMapper` → `GeometryState` → primitive che condividono campi, fronti e materiale:
[Visual Engine](visual-engine.md)) → composizione GPU.

Contratti e algoritmi: [acustica](acoustic-model.md), [planner](experience-planner.md),
[fisica](physics-engine.md), [World Engine](world-engine.md), [integrazione scene](visual-director.md),
[Visual Systems e Spectral Matter](visual-systems.md), [Matter Engine](matter-engine.md),
[Visual Engine](visual-engine.md), [Visual Grammar](visual-grammar.md), [scene fisiche](physical-scenes.md).
`meter=0` significa sconosciuto; non quantizzare allora la regia a una falsa
battuta 4/4. Il budget DSP riduce solo la frequenza delle elaborazioni lente,
indipendentemente dal budget GPU. Il wire non è retrocompatibile: distribuire
frontend, backend e WASM della stessa revisione.

## Mappa delle responsabilità

| Area | Proprietario e contratto | Esito dell’audit |
|---|---|---|
| Bootstrap / UI | `main.ts`, `app/App.ts`, `app/menus.ts`, `ui/` | App coordina UI, impostazioni e lifecycle; menu dichiarativi estratti; dispose di timer, subscriber, audio, renderer e debug |
| Regia applicativa | `app/RigController.ts` | Connette analisi, cue, Dynamics, ShowDirector e slot senza mescolare menu e frame loop |
| Cattura browser | `audio/capture/` | Worklet: blocchi al main thread per il ring grafico mono e flusso stereo continuo verso il worker (SAB o porta, silenzio per quanti saltati); fake generato nel worker |
| Cattura nativa | `native/audio-capture/` | cpal, scelta device per OS, coda limitata callback→worker, buffer riciclati, gap espliciti |
| Bridge desktop | `src-tauri/src/audio.rs` | Worker: analisi stereo, downmix mono per le scene, due Channel binari; i comandi frontend sono serializzati |
| Analisi grafica | `audio/analysis/AudioAnalyzer.ts` | FFT 2048, finestra voci 4096, cinque bande, waveform, YIN, tracker bassi; stato riusato |
| Analisi musicale | `native/analysis/`, `native/analysis-wasm/` | Hop 256; finestre 512/2048/8192, ERB, fase, H/P/R, loudness, note, stereo e ipotesi metriche; stesso DSP nativo/WASM |
| Analisi browser | `audio/features/BrowserAnalysis.ts`, `AnalysisHost.ts`, `analysis.worker.ts`, `PcmRing.ts`, `RecordStage.ts` | WASM nel worker, fuori dal RAF; batch con record clock, pool di buffer, epoch dopo perdite lunghe; fallback sul main thread solo senza `Worker` |
| Trasporto feature | `audio/features/` | ABI Rust ampliata; ogni hop raggiunge ExperienceEngine, senza folding per batch; decoder riusa frame/eventi; record troncati o sconosciuti interrompono il batch senza scritture parziali |
| Morfologia | `morphology/SoundMorphology.ts` | Undici proprietà continue del suono (periodicità, armonicità, rumore, ricchezza, transienti, stabilità…) da misure Rust già esportate; per hop dentro ExperienceEngine, negli snapshot; nessun classificatore |
| Esperienza | `experience/` | Memoria multiscala, ricorrenze, narrativa probabilistica, trajectory, previsione, event stream ordinato e planner sul clock audio; snapshot posseduti presentati al tempo percepito |
| Mondo | `world/WorldEngine.ts`, `WorldState.ts`, `WorldView.ts`, `WorldTrace.ts`, `Reorganization.ts` | Stato fisico persistente per sessione (4 corpi, 7 campi, bilancio energetico); avanzato per hop dentro ExperienceEngine, snapshot ed estrapolazione esatta al tempo udito; un `WorldView` per layer (guadagni del mood sulle velocità); nessuna scena lo possiede né lo azzera. `Reorganization` è una lettura (come `WorldView`): quale struttura ha lasciato l'ultimo rilascio, scelta dal suo tempo audio |
| Fisica | `physics/ResonantPhysics.ts`, `physics/primitives.ts`, `dynamics/` | Dodici modi smorzati e otto impulsi propaganti (campo modale condiviso); primitive esatte (oscillatore, momento, inviluppo); riuso della matrice delle molle, separazione luce/geometria |
| Interpretazione grafica | `audio/interpretation/`, `audio/visual-response/` | Un solo MusicInterpreter, import storico VisualResponse compatibile; ruoli, presenza, memoria e contesto |
| Tempo / dinamica | `timing/`, `dynamics/` | Capture→host→tempo percepito; molle/follower 240 Hz, impulsi analitici, gate e rate limit condivisi |
| Scelte dello show | `show/` | Preset/Hybrid/Free, affinità tra nove scene, ritorni di motivo, tetto del planner e limiti GPU; struttura per fixture (`SlotPlan.structure` → `SceneClock.structure`): un tetto per sezione, mai una scelta di primitive |
| Direzione della scena | `director/` | Intenti e fisica × Mood × Experience × capacità; un VisualDirector per Layer, separato da ShowDirector |
| Rendering | `renderer/RenderEngine.ts`, `renderer/Layer.ts` | Engine: RAF, slot, layout e composizione; Layer: scena, camera, Director, target e pass |
| Visual Engine | `visual-engine/` | Mondo visuale persistente: `SonicGeometryMapper` (morfologia, mondo, planner, forma dei cicli delle voci → `GeometryState`, 36 tratti continui), `MaterialSystem` (luce comune), `VisualWorld` (campi e fronti impacchettati una volta, budget strutturale, presenze, memoria, osservatore), cinque primitive con legge GLSL + riferimento CPU, `WorldRecipe` e `RecipeVisualizer` (adattatore verso `Layer`: recipe e scene legacy convivono) |
| Scene fisiche | `render-systems/fields/vectorField.ts`, `wells.ts`, `particles/tracer*.ts`, `Tracer*.ts`, `visual-engine/primitives/Field*Primitive.ts` | Campo vettoriale F(P) e sua topologia, pozzi di potenziale, legge / passo / simulazione GPU / probe CPU / parità dei traccianti, primitive dei traccianti e delle linee di campo: leggi in GLSL e in TS come la legge dei campi ([scene fisiche](physical-scenes.md)) |
| Visual Systems | `render-systems/` | Vocabolario condiviso: `VisualMaterial` (mondo + morfologia), campi spaziali, legge dei campi e legge delle forme (GLSL + riferimento CPU), forme della materia (storia della waveform, rete dei parziali), onde datate, materia GPU e probe CPU, disegno a punti / legami / faccette, memoria visiva, osservatore; nessuno stato musicale, solo storia di rendering |
| Scene | `visualizers/` | Sei scene legacy interpretano il mondo (`modulation.world`) in una forma propria: moto, pressione, turbolenza, coerenza, potenziale e rilasci; voci/tracce/spettri restano grafici; senza clock `REST_VIEW` (ferme); dispose GPU espliciti. In Tunnel e Particle Field la trasformazione della struttura è una funzione pura della `WorldView` (`tunnel/topology.ts`, `particle-field/regimes.ts`). Quattro sono recipe: Spectral Matter (la sola materia), Resonant Field (la sola membrana; `?legacy=resonant-field` in DEV monta la precedente), Matter Field (tutte le primitive), Field (traccianti e linee di un campo vettoriale) |
| Validazione | `validation/replay.ts`, overlay DEV | Replay di WAV locali sul percorso live (`npm run replay`), metriche comportamentali e tracce; Shift+T esporta la traccia di sessione |
| Persistenza | `stores/` | Validazione dei dati letti, migrazione Auto→Hybrid, `direction` Auto/Manual risolta da `resolveDirection`, notifiche/salvataggi solo se un valore cambia |
| Build | `package.json`, `vite.config.ts`, Cargo workspace, `.github/workflows/ci.yml` | Nessuna nuova dipendenza; CI su check frontend, core Rust, layout e WASM; WASM versionato per sviluppare il browser senza toolchain Rust; COOP/COEP `credentialless` solo nel server browser (SharedArrayBuffer) |

## Contratti da preservare

**Due analisi, due usi.** `AudioFrame` alimenta forma e livelli delle scene;
`AnalysisFrame` alimenta la regia sul clock di cattura. Non cancellare il DSP TS
come duplicato: Rust non fornisce ancora l’intero contratto grafico delle voci.
ExperienceEngine è autorevole per la nuova narrativa; MusicContext resta nel
percorso grafico/fallback, non è un secondo planner.
Le finestre PCM grafiche possono essere ritardate; gli eventi mantengono il loro
timestamp e vengono allineati da `Timing`. In browser il WASM gira nel worker di
analisi; il main thread decodifica i record una volta per frame come per il nativo
([realtime-analysis](realtime-analysis.md)).

**Eventi.** `features.onOnset/onBeat/onSection` sono consumer sincroni come
`onFrame`; ExperienceEngine li inserisce in `events`, ordinati per tempo audio.
I consumatori leggono con un `EventCursor` (`forEachHeard`), mai per indice: gli eventi
in ritardo vengono consegnati una volta, il reset dello stream riallinea i cursori.
Gli intenti si leggono per nome (`INTENT.x`) e si pesano con la loro confidence.

**Proprietà della memoria.** Frame, array e pool eventi appartengono al produttore.
Non conservarne copie implicite né modificarli nelle scene. `features.begin()`
svuota i conteggi per frame, non la memoria dei pool. `SceneInput` e `RigValues`
sono oggetti stabili. Gli array possono essere sostituiti durante un reset. `features.onFrame` è
sincrono: ExperienceEngine copia i dati che conserva nei suoi 256 snapshot.
Le scene non trattengono né mutano le viste del decoder. `present(heardTime)`
non espone audio futuro: batch e frequenza RAF non governano la semantica.
Mount, cambi di look, IPC, worklet e debug non hanno il vincolo di zero allocazioni
che si cerca invece nel percorso continuo di analisi e aggiornamento.

**Una cattura alla volta.** `AudioEngine.setSource()` accoda stop/start, scarta le
richieste superate e controlla la richiesta corrente anche dopo l’inizializzazione
WASM. È necessario perché `NativeAudioCapture.stop()` ferma il backend condiviso.
La serializzazione vale per l’unico AudioEngine dell’app; non creare più engine
nativi concorrenti. Una richiesta getUserMedia pendente deve risolversi prima che
la coda possa liberarla: non esiste qui un annullamento del prompt del browser.
`AudioEngine.stop()` invalida le richieste precedenti e rilascia le risorse.

**Età della cattura.** Il record di clock di ogni batch nativo porta l'età del suo
campione più recente, ricavata dai timestamp di cpal; `ClockSync` se ne fida. Se il
backend dichiara un'età maggiore del reale, il tempo udito supera l'ultimo snapshot
e `ExperienceEngine.present()` non restituisce nulla oltre 0,5 s: le scene perdono
esperienza e mondo (le forme grafiche TS continuano). Su Linux `platform::buffer_size`
chiede quindi ~10 ms per callback: misurato il 6 ottobre 2026 su Fedora 44, PipeWire,
monitor di un'uscita Bluetooth A2DP a 48 kHz, l'età passa da ~1,68 s (frammenti da
16.384 frame) a ~0,10 s. Non provato su ALSA puro, su altre uscite né su Windows, dove
resta il default del backend.

**Reset esplicito.** `AudioEngine.session` cambia quando l’analisi viene azzerata.
RigController resetta cue, flash guard, memoria ShowDirector e budget anche quando
la sessione precedente è durata meno di un secondo. La regressione del clock di
oltre un secondo resta un fallback per gap nativi. Quando il clock non è pronto,
il rig non pubblica un impulso temporizzato della vecchia sorgente.

**Tre slot, quattro layer composti.** Ogni slot può avere corrente e uscente durante
0,9 s di crossfade. Il renderer aggiorna lo stato CPU di tutti i layer vivi, ma
renderizza solo quelli visibili che entrano nei quattro ingressi del compositore.
Ordine: slot 0 corrente/uscente, poi slot 1, poi slot 2. Sei layer possono quindi
esistere temporaneamente in memoria; questo intervento limita il lavoro GPU,
non la memoria di picco né garantisce che tutti e sei siano visibili.
Una riduzione del budget rimuove i supporti al prossimo aggiornamento e li lascia
sfumare; un aumento aspetta una decisione musicale. Il protagonista resta sempre,
anche se il suo costo nominale supera il budget minimo.

**Mondo.** Il moto delle scene viene da `WorldState`, mai da integratori locali
guidati dall'audio né da posizioni obiettivo. Nuove misure entrano come forze in
`WorldEngine.setForces` o impulsi datati (`impact`, `release`); i guadagni del mood
scalano velocità, non posizioni. Il mondo si azzera solo col reset di sessione e non
legge qualità GPU né FlashGuard.

**Matter Engine.** La materia di una scena è una sola e persistente: una forma
(`render-systems/forms/`) la reclama filamento per filamento con un'àncora e una molla, e
la lascia tornare libera; non si creano, spostano o azzerano elementi per mostrare una
figura. `SoundMorphology` non ricalcola misure (usa quelle del wire) e non classifica;
`VisualMaterial` è l'unico punto in cui il suono diventa carattere della materia. Gli
slot dei parziali (`partialHz/Level/Pan/Phase`) sono ordinati per livello: chi vuole
identità nel tempo li riconosce per altezza, come `HarmonicForm`. Le sorgenti delle
forme (storia del segnale, nodi) sono storia di rendering: avanzano col frame, con
follower esatti, e non decidono nulla di musicale. `matterLab` esiste solo in DEV.
Dettagli, misure e limiti in [matter-engine](matter-engine.md).

**Visual Engine.** Una recipe è una configurazione (quali primitive, in che ordine la
complessità le fa comparire), mai una sequenza né un ramo su un evento. Una primitiva
legge solo `frame.geometry`, `frame.fields`, `frame.look` e gli uniform condivisi
(`uField`, `uWaveA`, `uWaveB`, `tVoices`): niente bande, beat, spettri, niente rilevamento.
`GeometryState` e `MaterialState` sono letture per layer e per frame, non stato del
mondo: nuove proprietà musicali entrano a monte (morfologia, Experience, World), mai lì.
Le primitive restano montate e sfumano con la loro presenza: non si creano né si
distruggono risorse GPU per mostrare o nascondere una struttura. Le leggi delle primitive
senza stato (`flowLaw.ts`, `filamentPoint`, `nodePoint`, `surfaceHeight`, `ringPoint`)
esistono in GLSL e in TypeScript come la legge dei campi: si cambiano insieme e il
riferimento CPU è ciò che i test provano. `fieldHeaderGlsl` è un pezzo del testo della
legge dei campi: modificarlo significa modificare la legge (parità da ripetere).
`worldLab` e `?primitives=` / `?legacy=` esistono solo in DEV. Dettagli, misure e limiti
in [visual-engine](visual-engine.md); il significato di ogni tratto in
[visual-grammar](visual-grammar.md).

**Scene fisiche.** Una scena evolve perché cambia il mondo, mai perché passa il tempo: nessun
`uTime` decorativo, nessuna fase che avanza da sola. Ciò che una scena rivista aggiunge è
una funzione pura della `WorldView` e delle età degli eventi (`tunnelTopology`,
`particleRegimes`, `deriveTopology`): a riposo vale zero (o la struttura canonica), è finita
e limitata per qualunque ingresso, uguale a ogni frame rate. Lo stato proprio di una scena è
solo storia di rendering (i traccianti di Field, le tracce): quando il campo si annulla
deve fermarsi. `vectorField`, `tracerLaw`, `tracerStep` e `wells` esistono in GLSL e in
TypeScript: si cambiano insieme e la parità va riprovata con `runTracerParity()`
(`render-systems/particles/tracerParity.ts`). Il tempo di un rilascio sceglie la struttura
che lascia (`Reorganization`): non usare contatori di frame né `Math.random`. Dettagli,
misure e limiti in [physical-scenes](physical-scenes.md).

**Visual Systems.** `render-systems/` non contiene significato musicale: legge
`WorldView`, snapshot, intenti e lo stream di eventi, e tiene solo storia di rendering
(particelle, fronti, buffer di memoria, inerzia dell'osservatore). Le onde nascono
dagli eventi datati (`SceneClock.events`, un `EventCursor` per consumatore), mai da un
rilevamento locale; la luce dei fronti è scalata da `SceneClock.light` (FlashGuard).
`fieldLaw`, `formLaw` e `matterStep` esistono in GLSL e in TypeScript: si cambiano insieme e la
parità GPU ↔ CPU va riprovata con `runParity()` (`render-systems/particles/parity.ts`; procedura
in [matter-engine](matter-engine.md) §11).
I semi usano `show/rng.ts`: niente `Math.random` nelle scene nuove.

**Direction.** `Settings.direction` (`auto` \| `manual`) decide chi dirige; rig, App e
renderer leggono mood, Experience, intensità, `autoDirection` e `rigMode` solo tramite
`resolveDirection(settings)`: in Manual restituisce le impostazioni stesse (nessuna
copia, comportamento precedente invariato), in Auto la costante `AUTO_DIRECTION`
(rig Hybrid, mood automatico, intensità di default). I valori manuali restano salvati
mentre Auto è attivo. Il default di installazione è `DEFAULT_DIRECTION_MODE`; i dati
salvati senza `direction` sono Manual. La chiave di storage resta `…settings.v1`: il
campo è additivo e `normalizeSettings` lo ricostruisce, mentre una nuova chiave
scarterebbe le preferenze esistenti senza una migrazione dedicata. I menu sono una
macchina a stati pura in `app/menus.ts` (`appMenu`, `menuSelection`, `coreTarget`),
che App si limita a eseguire.

**Palette e timing.** Le palette appartengono all’utente; il rig ne permuta i colori
e applica una tinta moderata. Il sesto argomento opzionale `SceneClock` trasporta
hit datati: usarlo per gli impulsi invece di rilevare fronti da un inviluppo per
frame. Non introdurre un secondo limiter indipendente in ogni scena.

**Lifecycle.** `App.start()` è idempotente; `await app.dispose()` rimuove observer,
listener globali, timer, sottoscrizioni, cattura, WASM e GPU. Un’istanza smaltita non
si riavvia. Il bootstrap attuale resta una sola app per pagina; dispose è disponibile
per un host che la smonta, non è un nuovo sistema di navigazione o HMR.

## Audit di manutenzione precedente alla nuova pipeline

- Separati `App` / `RigController` / `menus` e `RenderEngine` / `Layer`; Liquid
  separa GLSL e orchestrazione CPU. DSP, CSS e debug non sono divisi solo per
  raggiungere un limite arbitrario di righe.
- Eliminata la gara fra sorgenti e la pubblicazione di `running` da una richiesta
  superata durante l’avvio WASM. Il clock viene invalidato anche se il nuovo input
  fallisce. Corretto il sample rate dei clock nativi ricevuti prima della risposta
  del comando di avvio (per esempio 44,1 kHz invece del default 48 kHz).
- Azzerati i beat futuri e i look dello show al cambio sessione. Il budget ridotto
  vale anche per un look memorizzato che torna in una sezione successiva.
- Rimossi i pass GPU dei layer esclusi dalla composizione o a peso zero; evitati
  resize identici dei render target. Le regressioni verificano 6 aggiornamenti CPU
  ma solo 4 rendering durante tre crossfade simultanei.
- Decoder: copie nelle viste esistenti senza creare `subarray` per ciascun campo;
  controllo dei confini prima di mutare uno stato. Store: niente JSON/storage e
  notifiche per patch vuote o valori identici.
- NowPlaying: dimensioni da ResizeObserver, nessuna lettura `clientWidth/Height`
  nel draw dopo scritture CSS; gradiente live riusato e resize anche per la sola
  altezza. Waveform nascosta e core idle non ricevono lavoro grafico inutile.
- Rilascio esplicito di sottoscrizioni UI/debug e observer. Calibrazione: chiudere
  durante `AudioContext.resume()` non riavvia i click; nodi terminati disconnessi,
  valore delay inizializzato, core coerente con il pannello aperto.

Questo audit precedente non cambiava DSP e wire. Il nuovo refactor, descritto
nel [report](refactor-report.md), cambia entrambi e conserva le dipendenze. Le riduzioni di lavoro sopra sono verificabili nel codice
e nei test; **non rappresentano una misura di incremento FPS o di latenza reale**.

## Verifica e ambiente

Macchina della sessione: Fedora 44, Node e Cargo disponibili; `pkg-config` non trova
`webkit2gtk-4.1` né `alsa`, e rustup/clippy/rustfmt non sono nel PATH. Il core Rust
senza dipendenze di sistema è testabile. L’avvio browser usa la porta **1420**;
non offre system audio. Non installare sysroot o toolchain solo per una pulizia TS.

```sh
npm run check
cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline
npm run bench                     # già incluso in npm test
npm run dev                       # browser, microfono e sintetico
```

Se cambia il protocollo feature:

```sh
UPDATE_LAYOUT=1 cargo test -p spectrum-analysis --test wire
npm run wasm                      # richiede wasm32-unknown-unknown
```

`src/audio/features/layout.ts` è generato: non editarlo manualmente.
Versionare layout e WASM aggiornati insieme alle modifiche DSP. `cargo test` sul
wrapper controlla la build host, non ricompila il binario WASM versionato; i test
Vitest esercitano quest’ultimo.

**CI** (`.github/workflows/ci.yml`, push e pull request): `npm ci` + `npm run check`;
test dei due crate con `--locked`; rigenerazione di `layout.ts` e del WASM seguita da
`git diff --exit-code`. La ricompilazione del WASM è riproducibile byte per byte a
parità di compilatore (verificato il 6 ottobre 2026: stesso SHA-256 da due percorsi
diversi con rustc 1.98.1 upstream, uguale al binario versionato; i crate non hanno
dipendenze e i percorsi incorporati sono relativi). La CI fissa quindi Rust 1.98.1:
aggiornare `RUST_TOOLCHAIN` insieme al WASM quando si cambia compilatore. Restano
fuori shell Tauri, `audio-capture`, `cargo fmt --check` (16 file differiscono) e
clippy `-D warnings` (5 lint in `spectrum-analysis`; correggerli tocca il DSP e
richiede di ricostruire il WASM).

Se `cargo test` segnala `layout.ts is stale` senza differenze in git, il binario di
test in `target/` è stato compilato sotto un altro percorso della repo (il percorso è
incorporato a compile time): ricompilare con `touch native/analysis/tests/wire.rs`.

Scene fisiche (7 ottobre 2026, notte): nessuna modifica a DSP, wire, WASM, World Engine, UI.
Esiti, misure e limiti in [physical-scenes](physical-scenes.md) §7–8: **370 test frontend in
49 file** (47 nuovi), parità GPU ↔ CPU delle leggi di Field (media 1,07 · 10⁻⁵ unità) e
della materia ripetuta invariata, shader di Field, Tunnel e Particle Field compilati su
Intel UHD; non provati musica reale, movimento nel tempo, app desktop, replay su corpus.

Visual Engine (7 ottobre 2026, sera): nessuna modifica a DSP, wire o WASM. Esiti, misure e
limiti in [visual-engine](visual-engine.md) §7 e §9: **323 test frontend in 46 file** (51
nuovi), shader delle cinque primitive compilati a High / Medium / Low su Intel UHD,
Resonant Field migrata confrontata con la precedente su otto fotogrammi; non provati
musica reale, movimento nel tempo, parità GPU ↔ CPU delle leggi nuove, app desktop.

Visual Systems / Spectral Matter (6 ottobre 2026): esiti, misure e limiti in
[visual-systems](visual-systems.md) §8–9. Matter Engine (7 ottobre 2026): parziali sul
wire (record frame 295 → 343 valori, WASM ricostruito con rustc 1.98.1 upstream, lo stesso
toolchain che riproduce byte per byte il binario di HEAD), morfologia, materiale, forme;
esiti e limiti in [matter-engine](matter-engine.md) §8 e §11: **271 test frontend in 41 file**,
**59 Rust + 1 doctest**, parità GPU ↔ CPU e compilazione degli shader su Intel UHD; non provata
l'app desktop con il nuovo backend né musica reale.

Esiti della seconda fase (analisi realtime): **171 test frontend in 30 file**, **56 Rust
+ 1 doctest**, 5 test di benchmark, smoke Chromium (worker, SAB, tre scene) riusciti;
[analisi realtime](realtime-analysis.md). Fase precedente: 151 test frontend, 53 Rust + 1 doctest,
quattro benchmark/test e smoke Chromium; [report con confronti e limiti](refactor-report.md).
Revisione successiva: `Structure` riporta nella battuta pubblicata le posizioni
del beat tracker anche quando il suo raggruppamento interno (es. 7) non è ancora
pubblicato come metro; prima un taglio su quei beat andava in underflow (panic nelle
build debug, `desktop:dev`). Regressione in `structure.rs`, WASM ricostruito.
La sezione in fondo conserva la baseline precedente.
I risultati prestazionali precedenti restano datati nei rispettivi documenti.

## Miglioramenti prioritari successivi

| Priorità | Lavoro | Criterio di completamento |
|---|---|---|
| Alta | Prova desktop Windows/WebView2 e Linux reale dopo questi cambi | Cambio rapido system/mic, scollegamento e riconnessione, delay/calibrazione, sette scene senza errori JS/GLSL e senza catture residue |
| Alta | Benchmark CPU/GPU ripetibile, a qualità e risoluzione fisse | Tempi separati cattura/DSP TS/WASM/Director/pass GPU, p50/p95/p99 e memoria, confronto prima/dopo sullo stesso dispositivo |
| Alta | Recupero dopo tab nascosta o backlog browser in WebView reali | La politica esiste (silenzio ≤ 1 s, poi epoch; staging ~3 s): verificarla in WebView2/WebKitGTK con stalli 0,5–10 s e timer dei worker in background |
| Media | Unificazione graduale DSP TS/Rust | Corpus reale e sintetico, stessa waveform/pitch/presenza e latenza misurata; evitare doppia analisi senza spezzare i contratti |
| Alta | Visual Engine: Matter Field su musica reale e a occhio | Affinità, costi, guadagno del budget ed esposizioni tarati su un corpus; ogni struttura leggibile da sola e insieme; costo a 1080p e in WebView2 su macchina scarica |
| Alta | Parità GPU ↔ CPU delle leggi nuove | Un `runLawParity()` che valuta filamenti, nodi, membrana e anelli per texel e li confronta con il riferimento CPU, come `runParity()` per la materia |
| Alta | Scene fisiche su musica reale e a occhio | Field, Tunnel e Particle Field con ambient, percussioni, basso elettronico, mix densi, stereo sbilanciato, silenzio, drop e build: ogni regime leggibile, nessun moto nel silenzio, tagli e pozzi tarati; costo a 1080p e in WebView2 su macchina scarica |
| Media | Migrare le scene legacy a recipe e al modello fisico | Galaxy (orbite, `wells` a spirale), Liquid (superficie fluida, fronti condivisi), Oscilloscope (`SignalTracePrimitive`); parete del Tunnel come primitiva che legge `uField` / `uWave*`; **Spectrum resta com'è** |
| Alta | Matter Engine su musica reale | Tono, accordo, mix denso e percussioni danno corpi diversi e leggibili a occhio; quote delle forme, tempi dei nodi ed esposizione tarati su un corpus; costo a 1080p e in WebView2 su macchina scarica |
| Alta | Spectral Matter su musica reale | Le nove domande percettive di [visual-systems](visual-systems.md) con un corpus vario e occhi; costo GPU a 1080p e in WebView2; poi riuso di `FeedbackPass`/`WaveField` nelle scene esistenti |
| Alta | Taratura del World Engine su musica reale | `npm run replay` su un corpus locale vario (casi difficili inclusi), poi prova visiva per scena; nessun priore di genere |
| Media | Ring nativo proporzionato al sample rate | Verificare delay 400 ms e finestra voci a 44,1/48/96/192 kHz; il buffer nativo è ancora fisso a 48.000 campioni |
| Media | Regressioni DOM e GPU in browser | Focus trap, ARIA, fullscreen, idle, chiusura/rimontaggio, snapshot per tutte le scene; lo smoke Chromium corrente compila gli shader, ma non sostituisce test di cattura e WebView desktop |
| Media | Budget di transizione e memoria GPU | Gestire esplicitamente >4 layer durante cambi simultanei e misurare il picco di target/pass con High e supporti |
| Media | Persistenza durante slider continui | Misurare il costo di localStorage prima di aggiungere debounce; garantire flush alla chiusura se introdotto |
| Media | Rate limit luminoso e taratura percettiva | Valutare i contributi continui delle scene oltre ai transienti del rig, insieme a musica reale e tutti i mood |
| Prodotto | Device predefinito Linux, metadati GSMTC/MPRIS, macOS | Routing reale e test su ciascuna piattaforma; le note storiche non equivalgono a una nuova verifica |

Non conviene frammentare subito `structure.rs`, `AudioAnalyzer.ts`, `MusicContext.ts`
o il foglio CSS: sono lunghi ma concentrano algoritmi o componenti coerenti. Prima
estrarre una responsabilità con un contratto autonomo, poi verificare output e
costo; evitare wrapper creati soltanto per spostare righe.

## Baseline precedente al refactor — 5 ottobre 2026

- `npm run check`: **140 test in 26 file**, typecheck, ESLint e build di produzione
  riusciti. Il bench del rig a 30/60/144 fps fa parte della suite. Le **16 nuove
  regressioni** coprono gare sorgenti/WASM, sample rate del clock nativo, record
  incompleti, impostazioni, store, limiti di composizione, budget/riavvio show e
  chiusura della calibrazione durante resume.
- `cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline`:
  **49 test + 1 doctest** riusciti; incluso il controllo del layout wire generato.
  Nessuna modifica Rust o al binario WASM in questo intervento.
- Baseline frontend: 123/124, un timeout nel test lungo di MusicContext durante
  il primo controllo. Quel file passa isolato (10/10); la suite finale completa
  passa senza aumentare timeout né ridurre gli scenari simulati.
- Build: 125 moduli; bundle principale circa **765 kB / 208 kB gzip**, WASM
  **112 kB / 45 kB gzip**. Questi sono pesi di output, non consumo RAM/GPU.
- Microbenchmark decoder: Node **22.23.1**, stesso processo, 10.000 frame di
  riscaldamento per versione, 7 round alternati di 100.000 record/frame completi.
  Mediana prima **866,8 ms**, dopo **748,1 ms** (circa **−13,7%** per questo solo
  workload; 8,67 → 7,48 µs/record). Baseline dal decoder in HEAD prima dell’audit;
  TypeScript trasposto in ES2022 per entrambe le versioni. Carico della macchina
  non isolato: misura indicativa, non prova di riduzione della latenza audio/video.
- Nessuna nuova prova browser su GPU reale o cattura desktop/Windows/macOS.
  La build desktop non è stata eseguita: dipendenze di sistema mancanti. I mock
  del renderer verificano scheduling/dispose, non compilazione GLSL o resa visiva.
- `git diff --check`: nessun errore di whitespace.

Artefatti locali della sessione (log di check, regressioni, contesto baseline e
microbenchmark del decoder in `/tmp`, non versionati né più presenti). I dati e il metodo
sono riportati qui perché i file temporanei possono scomparire.
