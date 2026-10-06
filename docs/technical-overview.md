# Euforia-Audio-Experience — scheda tecnica e audit

Aggiornata il **6 ottobre 2026**. Il [README](../README.md) è la fonte di verità per
funzionalità, avvio e architettura; questa scheda contiene i dettagli operativi per
chi modifica il progetto. [experience-engine.md](experience-engine.md) conserva
le decisioni e misure delle fasi precedenti. Il prodotto usa solo sorgenti live;
il vecchio supporto file non esiste più.

## Nuova pipeline operativa

Capture stereo → DSP fisico/percettivo/musicale Rust → tutti gli hop del wire →
ExperienceEngine → memoria/narrativa → ExperiencePlanner → VisualIntent →
**WorldEngine → WorldState persistente** (forze, impulsi, energia; estrapolato al
tempo udito) → ShowDirector (rappresentazione) / VisualDirector + WorldView (per layer)
→ scene che interpretano il mondo → composizione GPU.

Contratti e algoritmi: [acustica](acoustic-model.md), [planner](experience-planner.md),
[fisica](physics-engine.md), [World Engine](world-engine.md), [integrazione scene](visual-director.md).
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
| Esperienza | `experience/` | Memoria multiscala, ricorrenze, narrativa probabilistica, trajectory, previsione, event stream ordinato e planner sul clock audio; snapshot posseduti presentati al tempo percepito |
| Mondo | `world/WorldEngine.ts`, `WorldState.ts`, `WorldView.ts`, `WorldTrace.ts` | Stato fisico persistente per sessione (4 corpi, 7 campi, bilancio energetico); avanzato per hop dentro ExperienceEngine, snapshot ed estrapolazione esatta al tempo udito; un `WorldView` per layer (guadagni del mood sulle velocità); nessuna scena lo possiede né lo azzera |
| Fisica | `physics/ResonantPhysics.ts`, `physics/primitives.ts`, `dynamics/` | Dodici modi smorzati e otto impulsi propaganti (campo modale condiviso); primitive esatte (oscillatore, momento, inviluppo); riuso della matrice delle molle, separazione luce/geometria |
| Interpretazione grafica | `audio/interpretation/`, `audio/visual-response/` | Un solo MusicInterpreter, import storico VisualResponse compatibile; ruoli, presenza, memoria e contesto |
| Tempo / dinamica | `timing/`, `dynamics/` | Capture→host→tempo percepito; molle/follower 240 Hz, impulsi analitici, gate e rate limit condivisi |
| Scelte dello show | `show/` | Preset/Hybrid/Free, affinità tra sette scene, ritorni di motivo, tetto del planner e limiti GPU |
| Direzione della scena | `director/` | Intenti e fisica × Mood × Experience × capacità; un VisualDirector per Layer, separato da ShowDirector |
| Rendering | `renderer/RenderEngine.ts`, `renderer/Layer.ts` | Engine: RAF, slot, layout e composizione; Layer: scena, camera, Director, target e pass |
| Scene | `visualizers/` | Sette scene interpretano il mondo (`modulation.world`): moto, pressione, turbolenza, coerenza, potenziale e rilasci; voci/tracce/spettri restano grafici; senza clock `REST_VIEW` (ferme); dispose GPU espliciti |
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
