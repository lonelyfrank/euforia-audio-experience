# Halo — scheda tecnica e audit

Aggiornata il **5 ottobre 2026**. Il [README](../README.md) è la fonte di verità per
funzionalità, avvio e architettura; questa scheda contiene i dettagli operativi per
chi modifica il progetto. [experience-engine.md](experience-engine.md) conserva
le decisioni e misure delle fasi precedenti. Il prodotto usa solo sorgenti live;
il vecchio supporto file non esiste più.

## Mappa delle responsabilità

| Area | Proprietario e contratto | Esito dell’audit |
|---|---|---|
| Bootstrap / UI | `main.ts`, `app/App.ts`, `app/menus.ts`, `ui/` | App coordina UI, impostazioni e lifecycle; menu dichiarativi estratti; dispose di timer, subscriber, audio, renderer e debug |
| Regia applicativa | `app/RigController.ts` | Connette analisi, cue, Dynamics, ShowDirector e slot senza mescolare menu e frame loop |
| Cattura browser | `audio/capture/` | Microfono via worklet, fake deterministico; PCM mono in ring buffer e drain per WASM |
| Cattura nativa | `native/audio-capture/` | cpal, scelta device per OS, coda limitata callback→worker, buffer riciclati, gap espliciti |
| Bridge desktop | `src-tauri/src/audio.rs` | Worker: analisi stereo, downmix mono per le scene, due Channel binari; i comandi frontend sono serializzati |
| Analisi grafica | `audio/analysis/AudioAnalyzer.ts` | FFT 2048, finestra voci 4096, cinque bande, waveform, YIN, tracker bassi; stato riusato |
| Analisi musicale | `native/analysis/`, `native/analysis-wasm/` | Hop 256, otto bande, loudness, onset, beat, armonia, stereo, struttura; stessa implementazione nativa/WASM |
| Trasporto feature | `audio/features/` | ABI Rust e decoder riusano frame/eventi; record troncati o sconosciuti interrompono il batch senza scritture parziali |
| Interpretazione | `audio/interpretation/`, `audio/visual-response/` | Un solo MusicInterpreter, import storico VisualResponse compatibile; ruoli, presenza, memoria e contesto |
| Tempo / dinamica | `timing/`, `dynamics/` | Capture→host→tempo percepito; molle/follower 240 Hz, impulsi analitici, gate e rate limit condivisi |
| Scelte dello show | `show/` | Preset/Hybrid/Free, look e affinità deterministici, limiti GPU e ritorni di sezione |
| Direzione della scena | `director/` | Mood × Experience × capacità; un VisualDirector per Layer, separato da ShowDirector |
| Rendering | `renderer/RenderEngine.ts`, `renderer/Layer.ts` | Engine: RAF, slot, layout e composizione; Layer: scena, camera, Director, target e pass |
| Scene | `visualizers/` | Sei scene, texture condivise e dispose espliciti; shader Liquid estratti, altri moduli coerenti mantenuti |
| Persistenza | `stores/` | Validazione dei dati letti, migrazione Auto→Hybrid, notifiche/salvataggi solo se un valore cambia |
| Build | `package.json`, `vite.config.ts`, Cargo workspace | Nessuna nuova dipendenza; WASM versionato per sviluppare il browser senza toolchain Rust |

## Contratti da preservare

**Due analisi, due usi.** `AudioFrame` alimenta forma e livelli delle scene;
`AnalysisFrame` alimenta la regia sul clock di cattura. Non cancellare il DSP TS
come duplicato: Rust non fornisce ancora l’intero contratto grafico delle voci.
Le finestre PCM grafiche possono essere ritardate; gli eventi mantengono il loro
timestamp e vengono allineati da `Timing`. In browser il WASM gira oggi sul main
thread, non in un worker.

**Proprietà della memoria.** Frame, array e pool eventi appartengono al produttore.
Non conservarne copie implicite né modificarli nelle scene. `features.begin()`
svuota i conteggi per frame, non la memoria dei pool. `SceneInput` e `RigValues`
sono oggetti stabili. Gli array possono essere sostituiti durante un reset.
Mount, cambi di look, IPC, worklet e debug non hanno il vincolo di zero allocazioni
che si cerca invece nel percorso continuo di analisi e aggiornamento.

**Una cattura alla volta.** `AudioEngine.setSource()` accoda stop/start, scarta le
richieste superate e controlla la richiesta corrente anche dopo l’inizializzazione
WASM. È necessario perché `NativeAudioCapture.stop()` ferma il backend condiviso.
La serializzazione vale per l’unico AudioEngine dell’app; non creare più engine
nativi concorrenti. Una richiesta getUserMedia pendente deve risolversi prima che
la coda possa liberarla: non esiste qui un annullamento del prompt del browser.
`AudioEngine.stop()` invalida le richieste precedenti e rilascia le risorse.

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

**Palette e timing.** Le palette appartengono all’utente; il rig ne permuta i colori
e applica una tinta moderata. Il sesto argomento opzionale `SceneClock` trasporta
hit datati: usarlo per gli impulsi invece di rilevare fronti da un inviluppo per
frame. Non introdurre un secondo limiter indipendente in ogni scena.

**Lifecycle.** `App.start()` è idempotente; `await app.dispose()` rimuove observer,
listener globali, timer, sottoscrizioni, cattura, WASM e GPU. Un’istanza smaltita non
si riavvia. Il bootstrap attuale resta una sola app per pagina; dispose è disponibile
per un host che la smonta, non è un nuovo sistema di navigazione o HMR.

## Interventi dell’audit

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

Non sono state introdotte nuove dipendenze, cambiati preset estetici, algoritmi DSP
Rust o formato binario. Le riduzioni di lavoro sopra sono verificabili nel codice
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

Esiti finali dell’audit: vedere la sezione di verifica in fondo a questa scheda.
I risultati prestazionali precedenti restano datati nei rispettivi documenti.

## Miglioramenti prioritari successivi

| Priorità | Lavoro | Criterio di completamento |
|---|---|---|
| Alta | Prova desktop Windows/WebView2 e Linux reale dopo questi cambi | Cambio rapido system/mic, scollegamento e riconnessione, delay/calibrazione, sei scene senza errori JS/GLSL e senza catture residue |
| Alta | Benchmark CPU/GPU ripetibile, a qualità e risoluzione fisse | Tempi separati cattura/DSP TS/WASM/Director/pass GPU, p50/p95/p99 e memoria, confronto prima/dopo sullo stesso dispositivo |
| Alta | Recupero dopo tab nascosta o backlog browser | Politica esplicita per campioni persi e avanzamento del clock, test con stalli 0,5–10 s; oggi il drain può elaborare molto lavoro in un singolo RAF |
| Media | Unificazione graduale DSP TS/Rust oppure spostamento WASM su worker | Corpus reale e sintetico, stessa waveform/pitch/presenza e latenza misurata; evitare doppia analisi senza spezzare i contratti |
| Media | Ring nativo proporzionato al sample rate | Verificare delay 400 ms e finestra voci a 44,1/48/96/192 kHz; il buffer nativo è ancora fisso a 48.000 campioni |
| Media | Regressioni DOM e GPU in browser | Focus trap, ARIA, fullscreen, idle, chiusura/rimontaggio, snapshot per tutte le scene; i test grafici correnti non compilano shader su GPU reale |
| Media | Budget di transizione e memoria GPU | Gestire esplicitamente >4 layer durante cambi simultanei e misurare il picco di target/pass con High e supporti |
| Media | Persistenza durante slider continui | Misurare il costo di localStorage prima di aggiungere debounce; garantire flush alla chiusura se introdotto |
| Media | Rate limit luminoso e taratura percettiva | Valutare i contributi continui delle scene oltre ai transienti del rig, insieme a musica reale e tutti i mood |
| Prodotto | Device predefinito Linux, metadati GSMTC/MPRIS, macOS | Routing reale e test su ciascuna piattaforma; le note storiche non equivalgono a una nuova verifica |

Non conviene frammentare subito `structure.rs`, `AudioAnalyzer.ts`, `MusicContext.ts`
o il foglio CSS: sono lunghi ma concentrano algoritmi o componenti coerenti. Prima
estrarre una responsabilità con un contratto autonomo, poi verificare output e
costo; evitare wrapper creati soltanto per spostare righe.

## Esito della verifica — 5 ottobre 2026

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

Artefatti locali della sessione (non versionati): `/tmp/halo-check.log`,
`/tmp/halo-regressions.log`, `/tmp/halo-baseline-context.log`,
`/tmp/halo-decoder-bench.mjs`, `/tmp/halo-decoder-bench.json`. I dati e il metodo
sono riportati qui perché i file temporanei possono scomparire.
