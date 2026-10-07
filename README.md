# Euforia-Audio-Experience

Visualizzatore musicale desktop in tempo reale, ispirato ai visualizer di Windows Media Player, Winamp e MilkDrop, ricostruito con tecnologie moderne (Tauri, Rust, TypeScript, Three.js, GLSL). Il nome dell'applicativo è **Euforia-Audio-Experience**.

L'app **non dipende da nessun player**: cattura l'audio che il computer sta riproducendo (Spotify, YouTube, VLC, giochi…) e lo trasforma in una scena a tutto schermo.

```
LIVE AUDIO → AUDIO CLOCK → ANALISI MULTI-RATE (Rust/WASM fuori dal RAF) → ACOUSTIC / CONTEXT
  → EXPERIENCE / MEMORIA / EVENTI → PREVISIONE → PLANNER → INTENTI → MONDO (FISICA)
  → GEOMETRIA → PRIMITIVE → GPU
```

> Il visualizer è l'interfaccia. Oltre alla scena si vedono solo le informazioni sulla sorgente, a sinistra, e un pulsante circolare in basso al centro. Tutto il resto compare quando serve e si richiude da solo.

La UI implementa il **design system Euforia-Audio-Experience** (token, componenti, le 8 fasi del mockup *Screens → AppPhases*).

---

## Funzionalità

- Cattura dell'audio di sistema su **Windows** (WASAPI loopback) e **Linux** (monitor PipeWire/PulseAudio); microfono su tutte le piattaforme
- Solo audio dal vivo: niente file né tracce precaricate; in sviluppo c'è un segnale di test sintetico
- Rust nativo/WASM: analisi stereo multi-risoluzione 512/2048/8192, ERB, loudness con percentili, noise floor per banda, fase, H/P/R, note e ritmo con ipotesi di metro e downbeat previsto; nel browser gira in un worker, mai sul frame loop; TS conserva spettro/waveform/voci grafiche
- Memoria multiscala, ricorrenza di motivi, narrativa probabilistica con isteresi, trajectory, anticipazione causale, previsione con confidence ed event stream datato sui campioni; grammatica di 14 intenti
- **World Engine**: un mondo fisico persistente (pressione, momento angolare, avanzamento, bias stereo, eccitazione, turbolenza, coerenza, potenziale, luce) che la musica spinge con forze e impulsi; tutte le scene lo interpretano, il cambio di scena non lo azzera, il silenzio lo lascia decadere
- Resonant Field: modi di una membrana e onde propagate/riflesse, con intensità distinta dalla complessità; budget DSP indipendente dalla qualità grafica
- Direction **Auto / Manual**: Auto lascia la regia al sistema; Manual espone 8 mood, 5 modalità Experience, intensità e rig **Preset / Hybrid / Free**. Fino a tre scene simultanee entro il budget grafico, direzione automatica del mood con isteresi
- **Visual Systems** (sperimentale): primitive grafiche condivise — campi spaziali derivati dal mondo, materia particellare simulata su GPU, onde datate sugli eventi, memoria visiva — e la scena-laboratorio **Spectral Matter**, la cui forma emerge dai campi invece di essere disegnata in anticipo
- **Matter Engine** (sperimentale, prima milestone): la morfologia del suono (periodicità, ricchezza di parziali, rumore, transienti…) decide che materia è, e la stessa materia persistente passa da particelle a filamenti, nastri, superfici e poligoni senza essere ricreata: si condensa sulla curva 3D tracciata dalla waveform reale e sulla rete dei parziali, si frattura su un rilascio e si richiude
- **Visual Engine** (sperimentale): un mondo visuale persistente fatto di primitive che condividono campi, fronti e materiale. `SonicGeometryMapper` traduce suono e mondo in una geometria (curvatura, spigoli, gradini, connessioni, onde, massa…), anche dalla forma reale dei cicli delle voci; le strutture si formano, si rompono e si sciolgono con la musica senza che nulla venga ricreato. La scena **Matter Field** ne è la prova: particelle, filamenti che vibrano come corde, una membrana, una gabbia di connessioni e fronti d'urto mossi dalle stesse forze
- **Scene fisiche** (sperimentale): le scene sono interpretazioni fisiche diverse dello stesso mondo, non animazioni indipendenti. **Field** mostra il mondo come campo vettoriale (sorgenti, vortici, gusci, fronti) con traccianti e linee di campo; il **Tunnel** è architettura sotto forze acustiche (torsione geometrica, guida d'onda, tagli in anelli e pannelli, un fronte di rilascio che lascia un'altra struttura); in **Particle Field** le particelle si organizzano in un potenziale stazionario comune (nuvola, gusci, filamenti, eliche, lamine, reticolo). Nel silenzio nulla genera moto nuovo ([docs/physical-scenes.md](docs/physical-scenes.md))
- 10 scene su GPU: **Infinite Tunnel**, **Spectrum**, **Particle Field**, **Galaxy**, **Liquid**, **Oscilloscope**, **Resonant Field**, **Spectral Matter**, **Matter Field**, **Field**
- Composizione finale: cielo con alone e stelle, **pavimento riflettente** con increspature, linea d'orizzonte, **crossfade di 0,9 s** tra le scene
- 4 preset di colore (**Nebula**, **Aurora**, **Ember**, **Mono**) che ricolorano scena e accento della UI
- Qualità Auto / Low / Medium / High, fullscreen, auto-hide di controlli e cursore
- Impostazioni persistenti validate al caricamento, riconnessione automatica se il dispositivo si scollega
- Compensazione audio da −100 a 400 ms, calibrazione guidata, riflesso disattivabile e riduzione dei flash

## Interfaccia

Lo stato della UI comprende quale menu è aperto (`root`, `scene`, `audio`, `presets`, `direction`, `manual`, `mood`, `experience`, `rig` oppure nessuno), se il pannello Settings o la calibrazione è aperto e se l'app è in idle.

| # | Fase | Cosa si vede |
|---|---|---|
| 01 | Idle | Scena, now playing, core chiuso |
| 02 | Control active | Il core sale e si apre la ruota: Scene, Audio, Palette, Settings, Direction, Fullscreen |
| 03 | Scene | Anello delle 10 scene |
| 04 | Audio | Arco con System Audio e Microphone |
| 05 | Presets | Arco con le 4 palette |
| 06 | Direction | Arco con due scelte: Auto e Manual. Manual apre Mood, Experience e Rig |
| 07 | Settings | Pannello sopra il core |
| 08 | Auto-hide | Solo la scena; now playing attenuato, niente cursore |

- **Core**: apre la ruota. In un sub-ring torna all'anello precedente (Mood → Manual → Direction → ruota), con il pannello aperto lo chiude. Pulsa con l'audio.
- **Nei sub-ring** la scelta si applica subito e l'anello resta aperto, così si possono confrontare le opzioni.
- La ruota si chiude con un secondo click sul core, un click fuori, `Esc` o dopo 6 s di inattività.
- L'auto-hide scatta dopo 3, 5 o 10 s (impostabile); qualsiasi movimento del mouse o tasto riporta la UI.
- **Direction** decide chi fa la regia, con un solo controllo:
  - **Auto**: il sistema dirige. Tiene la scena scelta come protagonista, aggiunge variazioni e supporti ai confini di frase e sceglie mood ed Experience dalla musica (equivale al rig Hybrid con mood automatico e intensità 0,65). Le scelte manuali restano memorizzate ma non vengono usate.
  - **Manual**: apre Mood (Euphoria, Dream, Dark, Pulse, Chaos, Ethereal, Melancholy, Focus), Experience (Ambient, Immersive, Reactive, Cinematic, Minimal) e Rig (Preset, Hybrid, Free); *Mood intensity* compare in Settings → Advanced. Preset mantiene la scena scelta; Hybrid aggiunge variazioni e supporti; Free sceglie anche le scene. Hybrid e Free attivano il mood automatico; una scelta manuale di Mood/Experience lo disattiva mantenendo il rig.
  - Il default di una nuova installazione è Manual con rig Preset (`DEFAULT_DIRECTION_MODE` in `src/stores/settingsStore.ts`). Le impostazioni salvate prima di questo controllo vengono caricate come Manual, con i loro valori.
- **Settings** ha due zone:
  - **Essenziale**: Source (System / Microphone), **Audio delay** con Sync calibration, Quality (Auto / Low / Medium / High), Reduce flashing.
  - **Advanced** (chiusa a ogni avvio): Sensitivity, Smoothing, Mood intensity (0–1, solo con Direction Manual), Beat response, Track info (Always / Dim / Hidden), Hide controls after, Hide cursor when idle, Water reflection. Sensitivity e Smoothing restano come rete di sicurezza finché la taratura su musica reale non è fatta.
- **Audio delay** (−100–400 ms) ritarda l'analisi per compensare la latenza dell'uscita: l'audio di sistema viene catturato prima di arrivare alle cuffie, e con cuffie Bluetooth le immagini anticiperebbero il suono di 150–250 ms. Si regola a orecchio o con Settings → Calibrate. I valori negativi anticipano i cue per compensare un display lento; il PCM può essere solo ritardato.

### Tastiera e accessibilità

| Tasto | Azione |
|---|---|
| `Esc` | Chiude ruota e pannello; se è già tutto chiuso, esce dal fullscreen |
| `F11` / `F` | Fullscreen |
| `←` / `→` | Scena precedente / successiva (con la ruota chiusa) |
| `Spazio` | Pausa dell'animazione |
| Frecce, `Home`, `End` | Dentro la ruota: spostano il focus tra gli item |

Il core ha `aria-expanded` e un'etichetta che cambia in base allo stato; la ruota usa `role="menu"` (scelte esclusive come `menuitemradio`, Auto / Manual inclusi), il pannello `role="dialog"` con focus trap e toggle `role="switch"`. La zona Advanced è un pulsante con `aria-expanded` e `aria-controls`; finché è chiusa i suoi controlli sono nascosti anche a Tab e screen reader. L'anello di focus appare solo con `:focus-visible`. Con `prefers-reduced-motion` le transizioni della UI diventano istantanee.

## Architettura

```text
Live capture (system / microphone / test)
  ├─ PCM mono → AudioAnalyzer TS → AudioFrame + ruoli/voci grafiche
  └─ PCM stereo → Analyzer Rust (thread di cattura) / WASM (worker browser, hop 256)
       ├─ 512: transienti; 2048: timbro, ERB, fase, HPSS, stereo
       └─ 8192: chroma, pitch bins, parziali (frequenza, livello, pan, fase: sul wire)
       ├─ contesto: floor per banda, percentili loudness, derivate, downbeat previsto
            ↓ ogni frame hop datato + record clock per batch, senza folding
       RecordStage → AnalysisDecoder → ExperienceEngine (frame + onset/beat/sezioni)
            ├─ SoundMorphology: che tipo di suono è (proprietà continue, per hop)
            ├─ memoria multiscala / motivi / narrativa / trajectory / previsione
            ├─ EventStream ordinato per tempo audio
            ├─ ExperiencePlanner → VisualIntent / contrasto / entropia
            ├─ WorldEngine → WorldState: corpi (pressione, spin, travel, bias) e campi
            │    (eccitazione, turbolenza, coerenza, potenziale, luce, apertura); forze e impulsi
            └─ ResonantPhysics → modi della membrana, onde
                     ↓ history limitata; il mondo è estrapolato esattamente al clock percepito
       ClockSync / Timing → RigController
            ├─ CueScheduler / FlashGuard / Dynamics (luce del rig)
            └─ ShowDirector / grafo scene / GpuBudget (rappresentazione, composizione)
                     ↓
       Layer: VisualDirector (luce, camera, guadagni del mood) + WorldView (adattatore) → scena + pass
            ├─ scena legacy: interpreta il mondo in una forma propria
            └─ recipe (visual-engine): VisualWorld
                 SonicGeometryMapper: morfologia + mondo + planner + forma delle voci → GeometryState
                 → campi spaziali e fronti datati (una volta, condivisi) · MaterialState (luce)
                 → budget strutturale (entropia del planner × tetto dello show) → presenza di ogni primitiva
                 → primitive: materia GPU (punti, legami, faccette, forme), filamenti, membrana,
                   grafo di connessioni, fronti d'urto · memoria visiva · osservatore
               render-systems (leggi e risorse): legge dei campi e dei flussi, forme, materia, onde, memoria
                     ↓
       RenderEngine: 3 slot / 4 layer composti → composizione → Canvas
```

La [scheda tecnica per gli agenti](docs/technical-overview.md) descrive responsabilità,
contratti, verifiche dell'audit e miglioramenti prioritari. Il rapporto di questo refactor e le misure sono in [docs/refactor-report.md](docs/refactor-report.md).
Contratti: [analisi realtime: thread, clock, stati, eventi, benchmark](docs/realtime-analysis.md),
[modello acustico](docs/acoustic-model.md), [planner](docs/experience-planner.md),
[fisica](docs/physics-engine.md), [World Engine](docs/world-engine.md), [Visual Systems e Spectral Matter](docs/visual-systems.md),
[Matter Engine: morfologia, materiale, forme](docs/matter-engine.md), [Visual Engine: mondo visuale, primitive, recipe](docs/visual-engine.md),
[Visual Grammar: che cosa chiede il suono alla geometria](docs/visual-grammar.md),
[scene fisiche: Field, Tunnel, Particle Field](docs/physical-scenes.md). La cronologia resta in [experience-engine](docs/experience-engine.md).

Principi:

- **I visualizer non conoscono la sorgente audio**: ricevono `AudioFrame`, ruoli diretti, `ModulationState` e i colori della palette.
- **La sorgente audio non conosce i visualizer**: un provider espone PCM grafico tramite `readSamples()` e i record dell'analisi musicale tramite `readFeatures()`; l'analisi gira fuori dal frame loop (thread di cattura nativo o worker browser).
- **Analisi centralizzata per percorso**: nessun visualizer fa FFT per conto suo. TS e Rust/WASM oggi calcolano alcune misure sovrapposte: la loro unificazione richiede una migrazione verificata, non la rimozione di uno dei due.
- **Il render engine non conosce l'audio engine** né la UI: riceve una callback `frameSource(dt)`.
- **La musica modifica il mondo, non ogni frame**: il moto delle scene viene dal `WorldState` condiviso (forze, momento, smorzamento); le scene lo interpretano, non lo ricalcolano.
- **Le primitive leggono geometria, non audio**: in un mondo visuale nessuna primitiva guarda bande, beat o spettri; legge `GeometryState`, i campi e il materiale del frame, gli stessi per tutte.
- **Riutilizzo nel percorso continuo**: buffer, eventi e oggetti Three.js persistono fra frame. Mount, cambi di look, IPC/worklet e debug possono allocare; non è una garanzia di zero allocazioni sull’intera pipeline.

### Stack

| Livello | Tecnologia | Motivo |
|---|---|---|
| Desktop shell | **Tauri 2** | Binario leggero, WebView di sistema, backend Rust per il codice nativo |
| Cattura audio | **Rust + cpal 0.18** | WASAPI loopback su Windows senza workaround; stessa API per il microfono su tutte le piattaforme |
| Trasporto | Due Tauri `Channel` binari; nel browser worklet → `SharedArrayBuffer` (o `MessagePort`) → worker | PCM mono `f32` + record feature/eventi/clock `f64`, little-endian; buffer trasferiti e riciclati |
| Feature musicali | Crate Rust `spectrum-analysis`, anche in WASM | Hop 256; finestre 512/2048/8192; misure fisiche/percettive, ritmo e sezioni |
| Temporizzazione | `ClockSync`, `Timing`, `Dynamics` in TypeScript | Cue sul clock audio percepito, molle/follower a 240 Hz e inviluppi analitici |
| Frontend | **TypeScript + Vite**, DOM vanilla | UI piccola: nessun framework necessario |
| Rendering | **Three.js** (WebGL2) + shader GLSL | Particelle, tunnel, galassia e onde calcolati sulla GPU; bloom e composizione in post-processing |
| Font | Geist (via `@fontsource-variable/geist`) | Incluso nel bundle: funziona offline e rispetta la CSP |

### Composizione del frame

1. Ogni `Layer` possiede scena, `VisualDirector`, render target e pass; bloom e densità dipendono dalla qualità.
2. Ciascuno dei tre slot conserva il layer corrente e quello uscente per un crossfade di 0,9 s. Il compositore legge al massimo quattro layer, nell’ordine degli slot (corrente, uscente); i layer oltre il limite o a peso zero aggiornano lo stato CPU ma non vengono renderizzati. Gli slot ricevono peso, scala, offset, specchio, flash e tinta dalla regia.
3. Il pass finale (`renderer/compositeShader.ts`) aggiunge fondo, alone e stelle sopra l'orizzonte (al 47% dell'altezza), riflette il cielo sotto l'orizzonte con increspature sinusoidali, scurisce verso il basso e disegna la linea d'orizzonte.
4. La camera viene decentrata con `setViewOffset`: con riflesso il centro è al 52% × 38%; senza riflesso la scena occupa la finestra e fluttua lentamente. Il cambio di layout è interpolato.

## Avvio

### Requisiti

- Node.js 20.19+ oppure 22.12+ (vincolo della versione Vite installata), npm
- Rust stable (≥ 1.85)
- Dipendenze di sistema di Tauri: <https://v2.tauri.app/start/prerequisites/>
  - **Windows**: Microsoft C++ Build Tools, WebView2 (già presente su Windows 10/11)
  - **Linux (Fedora)**: `sudo dnf install webkit2gtk4.1-devel libsoup3-devel javascriptcoregtk4.1-devel alsa-lib-devel librsvg2-devel`
  - **Linux (Debian/Ubuntu)**: `sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libasound2-dev librsvg2-dev`

### Comandi

```bash
npm install

npm run desktop:dev      # app desktop (Tauri) con hot reload
npm run desktop:build    # installer / bundle di produzione

npm run dev              # solo frontend nel browser (segnale di test, microfono)
npm run check            # typecheck + lint + test (bench incluso) + build frontend
cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline
npm run wasm             # ricompila il WASM; serve il target wasm32-unknown-unknown
EUFORIA_AUDIO_EXPERIENCE_CORPUS=~/euforia-audio-experience-corpus npm run replay   # validazione su registrazioni locali (mai versionate)
```

### Integrazione continua

`.github/workflows/ci.yml` gira a ogni push e pull request, in due job:

| Job | Comandi | Cosa protegge |
|---|---|---|
| Frontend | `npm ci`, `npm run check` | typecheck, lint, test (bench inclusi), build |
| Rust core | `cargo test -p spectrum-analysis -p spectrum-analysis-wasm --locked` | DSP e protocollo wire |
| | `UPDATE_LAYOUT=1 cargo test -p spectrum-analysis --test wire` + `git diff --exit-code` | `layout.ts` allineato al wire |
| | `npm run wasm` + `git diff --exit-code` | WASM versionato identico, byte per byte, a una ricompilazione dei sorgenti |

Il confronto del WASM vale solo con lo stesso compilatore: la CI fissa Rust **1.98.1** (`RUST_TOOLCHAIN` nel workflow). Chi ricostruisce il WASM con un'altra versione deve aggiornare quella riga nello stesso commit. La CI non compila la shell Tauri né `audio-capture` (servono librerie di sistema e dispositivi reali) e non esegue `cargo fmt`/`clippy`: oggi il codice non li supera senza modifiche (16 file da riformattare, 5 lint nel DSP).

In modalità browser (`npm run dev`) "System Audio" non è disponibile: la sorgente di default è il segnale di test sintetico. Il microfono passa da `getUserMedia`. È utile per sviluppare le scene senza compilare la parte Rust.

### Diagnostica della cattura nativa

```bash
cargo run -p audio-capture --example probe -- system       # loopback (Windows/macOS) o monitor (Linux)
cargo run -p audio-capture --example probe -- microphone
```

Elenca i dispositivi e stampa per 5 secondi campioni/s e picco del segnale catturato.

## Struttura delle cartelle

```
src/
  app/              App (UI/lifecycle), RigController (collegamento regia), menus, shortcuts
    calibration/    click di prova e regolazione della sincronizzazione
    debug/          diagnostica caricata solo in sviluppo
  audio/
    AudioEngine.ts  provider attivo + analizzatore
    capture/        AudioCaptureProvider e implementazioni
    analysis/       AudioAnalyzer, FFT, BeatDetector, smoothing/AGC, misure spettrali
    features/       decoder, layout generato, WASM, worker di analisi, ring PCM, staging dei record
    interpretation/ MusicInterpreter (entry point), DynamicsMemory
    visual-response/ ruoli, presenza, memoria sezioni e voci; alias VisualResponse compatibile
  director/         mood, Experience, matrice, VisualDirector, AutoDirection
  timing/           clock capture→host, cue percepiti, gate del ritmo, calibrazione
  experience/       memoria, narrativa, trajectory, previsione, event stream, planner, intenti, history
  morphology/       SoundMorphology: proprietà continue del suono dalle misure del DSP (docs/matter-engine.md)
  world/            WorldState, WorldEngine (forze, impulsi, energia), WorldView (adattatore per layer), WorldTrace,
                    Reorganization (quale struttura ha lasciato l'ultimo rilascio)
  physics/          modi risonanti, onde causali, primitive esatte (oscillatore, momento, inviluppo)
  validation/       replay di registrazioni locali sul percorso live, metriche e tracce
  dynamics/         molle/follower/inviluppi, scheduler, cronologia hit, FlashGuard
  show/             scelta fixture/effetti, budget GPU, affinità e seed deterministici
  renderer/         RenderEngine (slot, crossfade, loop), Layer, composizione finale, qualità
  visual-engine/    mondo visuale e primitive (docs/visual-engine.md, docs/visual-grammar.md)
    geometry/       GeometryState, SonicGeometryMapper, forma dei cicli delle voci, texture delle voci
    material/       MaterialState: come emette luce ciò che il mondo contiene
    primitives/     materia, filamenti, membrana, grafo di connessioni, fronti d'urto (legge GLSL + riferimento CPU)
    VisualWorld.ts  interpretazione una volta per frame, budget strutturale, presenze, lifecycle
    WorldRecipe.ts, RecipeVisualizer.ts   recipe e adattatore verso Layer (defineRecipe)
  render-systems/   leggi e risorse grafiche condivise (docs/visual-systems.md, docs/matter-engine.md)
    materials/      VisualMaterial: materiale derivato da mondo e morfologia (continuità, connettività, angolarità, …)
    fields/         WorldView → campi spaziali; legge dei campi e legge dei flussi per ciò che non è materia (GLSL + riferimento CPU)
    forms/          forme della materia: storia della waveform, rete dei parziali, legge delle forme (GLSL + CPU)
    waves/          fronti d'onda datati sugli eventi dell'Experience Engine
    particles/      semi deterministici, simulazione GPU (ping-pong), probe CPU, disegno (punti, legami, faccette), prova di parità;
                    traccianti del campo (legge, simulazione, probe, parità)
    feedback/       memoria visiva: legge per pixel e pass di post-processing
    camera/         osservatore con inerzia propria
  visualizers/
    registry.ts     auto-discovery delle scene
    palettes.ts     i 4 preset di colore
    shared/         BaseVisualizer, dispose, defineVisualizer
    tunnel/ spectrum/ particle-field/ galaxy/ liquid/ oscilloscope/ resonant-field/
                    index.ts + <Nome>Visualizer.ts + preset.json
                    (tunnel/topology.ts e particle-field/regimes.ts: come il mondo trasforma la scena, funzioni pure)
    field/          recipe: il mondo come campo vettoriale (traccianti + linee di campo)
    spectral-matter/ recipe con la sola materia (laboratorio del Matter Engine)
    matter-field/   recipe del Visual Engine: materia + fronti + filamenti + membrana + grafo
    resonant-field/ recipe con la sola membrana (la scena precedente resta per il confronto in DEV)
  ui/               Dial (core + ruota), NowPlaying, SettingsPanel, icone, tokens.css, app.css
  stores/           store osservabile, impostazioni persistenti
  platform/         differenze desktop/browser (fullscreen, disponibilità delle sorgenti)
  types/            AudioFrame, Visualizer, preset, qualità
native/
  analysis/         DSP senza I/O: FFT, loudness, ritmo, armonia, struttura, protocollo wire
  analysis-wasm/    ABI C sulla memoria WASM; stesso DSP del percorso desktop
  audio-capture/    crate Rust: API di cattura platform-agnostic
    src/platform.rs selezione dei dispositivi per piattaforma (loopback su Windows/macOS, monitor su Linux)
    src/capture.rs  callback cpal → coda limitata → worker con batch interleaved
src-tauri/          comandi Tauri, analisi sul worker, downmix e due stream binari
public/
```

Nota: la proposta iniziale prevedeva due crate separati, `native/windows-audio` e `native/linux-audio`. Con cpal la differenza tra piattaforme si riduce alla **scelta del dispositivo**, quindi c'è un solo crate e il codice specifico sta in `platform.rs`. Su Linux cpal usa il suo host PulseAudio, scritto interamente in Rust e compatibile con PipeWire, che non richiede librerie di sistema aggiuntive.

### Design token

`src/ui/tokens.css` contiene i token del design system Euforia-Audio-Experience come custom property (`--void`, `--glass`, `--accent-live`, `--core-size`, `--dur-expand`, …). La UI usa sempre i token, mai valori copiati. `--accent-live` viene riscritto sullo stage con la prima tinta del preset attivo.

## AudioFrame

Contratto grafico TS, prodotto una volta per frame da `AudioAnalyzer` (`src/types/audio.ts`). È distinto da `AnalysisFrame`, il contratto feature Rust decodificato in `audio/features/decode.ts`: quest’ultimo include clock, beat predetti, otto bande, armonia, stereo e sezioni. Non scambiare i due clock o i rispettivi campi BPM.

Campi principali di `AudioFrame`:

| Campo | Range | Descrizione |
|---|---|---|
| `volume` | 0..1 | RMS con auto-gain e smoothing |
| `peak` | 0..1 | Picco istantaneo (senza auto-gain) |
| `bass` | 0..1 | 20–250 Hz |
| `lowMid` | 0..1 | 250–500 Hz |
| `mid` | 0..1 | 500–2000 Hz |
| `highMid` | 0..1 | 2–4 kHz |
| `treble` | 0..1 | 4–16 kHz |
| `energy` | 0..1 | Energia spettrale totale |
| `spectrum` | `Float32Array(128)` | Spettro logaritmico 30 Hz–16 kHz, 0..1 |
| `waveform` | `Float32Array(1024)` | Campioni −1..1, allineati allo zero-crossing |
| `beat` | boolean | `true` solo nel frame in cui viene rilevato un beat (sempre `false` con Beat response spento) |
| `beatPulse` | 0..1 | Impulso che salta a 1 sul beat e decade (0 con Beat response spento) |
| `onset` | 0..1 | Intensità dello spectral flux |
| `bpm` | number | Stima del tempo (0 finché non è nota) |

Come vengono calcolati:

1. **Bassi, cassa e volume** nel dominio del tempo, su finestre brevi per ridurre il ritardo: bassi = passa-basso a 250 Hz su 20 ms, cassa = passa-basso a 120 Hz su 10 ms, volume = RMS su 20 ms.
2. **Medi, acuti ed energia** dalla FFT (finestra di Hann su 2048 campioni), come potenza media della banda in dB.
3. **Normalizzazione adattiva** (`DynamicRange`): ogni livello in dB viene mappato in 0..1 mescolando una vista *assoluta* (tra il picco recente e un fondo lento: le sezioni forti risultano più grandi) e una *relativa* (scarto dalla media recente: ogni colpo si vede anche in un mix compresso). Funziona a qualsiasi volume di riproduzione; *Sensitivity* restringe l'intervallo, così i valori arrivano prima a 1.
4. Curva di contrasto e **smoothing** attack/release indipendente dal frame rate: la salita è quasi istantanea, la discesa segue *Smoothing*.
5. **Beat tracking** in due stadi. Gli *onset* sono salite della cassa sopra la sua media che superano una soglia adattiva: sono immediati ma rumorosi, perché anche le note di basso ne producono. Il *tempo* si ricava dall'autocorrelazione degli onset degli ultimi 6 s, con preferenza intorno a 120 BPM. Un beat viene emesso quando un onset cade vicino al beat previsto, che corregge anche la fase; se un colpo manca (un break) il tracker tiene il tempo fino a 4 battute. Prima di agganciare un tempo, gli onset vengono riportati direttamente come beat.

Misure su segnali di prova (mix realistici a 90, 124 e 174 BPM, anche a −26 dB): 100% dei colpi rilevati, precisione 86–95%, ritardo 11–17 ms, BPM entro ±3. Con un basso più forte della cassa il tracker può agganciarsi al levare: resta a tempo, ma sfasato di mezza battuta.

Gli array appartengono all'analizzatore e vengono riusati: i visualizer non devono conservarli tra un frame e l'altro né modificarli.

Le misure fisiche aggiuntive `rms`, `centroidHz`, `rolloffHz` (85% della potenza) e `spreadHz` sono indipendenti dall’AGC dello spettro grafico. Le tre misure spettrali riusano la FFT esistente su 20 Hz–16 kHz.

## Experience Engine

La nuova regia consuma tutti gli hop Rust tramite `ExperienceEngine`: separa
energia da complessità, conserva cinque scale di memoria e 32 motivi, distingue
trend/narrativa dal mood. Il planner propone intenti causali su 2–8 s e limita
l'entropia sostenuta. ShowDirector sceglie scene/continuità; VisualDirector
interpreta la grammatica nelle capacità di ciascuna scena. La risposta fisica
conserva velocità e onde anche dopo un attacco.

La history di snapshot è presentata al `Timing.heardTime`: il delay Bluetooth
vale anche per narrativa e fisica. Impulsi luminosi e geometria hanno vie
separate; Reduce Flashing conserva la deformazione. Gli stati sono indizi
causali, non riconoscimento di genere o previsione certa della struttura.

Il **World Engine** dà a questo cervello un corpo: intenti, eventi e misure
acustiche diventano forze e impulsi su uno stato persistente che nessuna scena
possiede. Le scene lo interpretano tramite un `WorldView` per layer (momento
angolare → orbita della Galaxy, torsione del Tunnel, vortice delle particelle,
taglio del Liquid…); un cambio di scena non azzera il mondo, la previsione carica
potenziale che solo un rilascio reale libera, il silenzio lo lascia decadere.
Contratti, unità, mappe per scena e validazione: [docs/world-engine.md](docs/world-engine.md).
Nessuna scena esegue DSP. Il benchmark automatico confronta PCM→regia→mondo a
30/60/144 fps con batch 128/480/2048, oltre alle regressioni su silenzio e warm-up.

## Interpretazione grafica e fallback

`MusicInterpreter` (alias compatibile `VisualResponse`) trasforma `AudioFrame` in ruoli condivisi: bassi → peso, medi → forma/flow, alti → dettaglio, impatti → eventi. Presence e audibilità per regione distinguono il segnale dal noise floor appreso e seguono fade/tagli.

Tre scale: impact/shimmer in millisecondi, motion/density attorno al secondo, openness/tension e sezioni su più secondi. `MusicContext` conserva tempo, intensità relativa, build/drop e stile delle voci; espone trend firmati di energia, motion, copertura, tensione e apertura, più memoria recente di picchi e drop. Lo stato musicale ha confidence, durata e stato precedente, con isteresi e conferma temporale.

Forme delle voci, tracce e spettri disegnati restano su questo percorso grafico; il moto, la pressione, la turbolenza e i rilasci delle scene vengono invece dal mondo condiviso. Un rilascio libera le spirali, apre il tunnel, espelle le particelle, allarga il fluido, emette un fronte o carica i fosfori dell'oscilloscopio. In assenza sonora il mondo perde energia per smorzamento e le scene si fermano.

Architettura, mood/modalità, Director, capacità e istruzioni di estensione: [docs/visual-director.md](docs/visual-director.md).

Audit precedente, costanti temporali, matrice delle scene, segnali deterministici e procedura di verifica: [docs/musical-semantics.md](docs/musical-semantics.md). L'overlay è solo di sviluppo (`?debug` o Shift+D), con dieci secondi di history; il blocco Matter mostra morfologia, materiale, stato della materia e lavoro della GPU, e può bloccare la materia in uno stato (`?matter=wave|harmonic|particles`). Il blocco Visual World mostra budget di entropia, geometria, presenza e vertici di ogni primitiva e campi attivi; `?primitives=matter,surface` blocca un mondo su alcune primitive, `?legacy=resonant-field` monta la scena precedente alla migrazione.

## Aggiungere una scena

1. Crea una cartella `src/visualizers/<nome>/`.
2. Aggiungi `preset.json`:

   ```json
   {
     "name": "My Scene",
     "author": "Tu",
     "version": 1,
     "audio": { "sensitivity": 1, "smoothing": 1 },
     "camera": { "fov": 60, "distance": 10, "drift": 0.3 },
     "bloom": { "strength": 0.8, "radius": 0.5, "threshold": 0.2 },
     "visual": { "count": 1000 }
   }
   ```

   `audio.sensitivity` e `audio.smoothing` sono **moltiplicatori** delle impostazioni dell'utente; `visual` contiene i parametri propri della scena. I colori non stanno nel preset: arrivano dalla palette attiva tramite `setPalette`.

3. Implementa la scena. Estendendo `BaseVisualizer` hai già scena, camera prospettica, resize e dispose:

   ```ts
   import type { AudioFrame } from '../../types/audio';
   import type { PaletteColors, VisualizerContext } from '../../types/visualizer';
   import { BaseVisualizer } from '../shared/BaseVisualizer';

   export interface MyParams { count: number }

   export class MyVisualizer extends BaseVisualizer<MyParams> {
     init(context: VisualizerContext): void {
       // crea mesh e materiali; usa context.quality.density per scalare i conteggi
     }
     setPalette(colors: PaletteColors): void {
       // copia le 3 tinte nei materiali (senza allocare)
     }
     update(frame: AudioFrame, dt: number, time: number): void {
       // solo aggiornamenti: niente allocazioni qui
     }
   }
   ```

   Il moto si legge dal mondo condiviso, mai da un integratore locale guidato dall'audio:

   ```ts
   import { REST_VIEW } from '../../world/WorldView';
   // in update(frame, dt, time, response, modulation):
   const world = modulation?.world ?? REST_VIEW;   // fermo senza clock
   this.angle += world.dTurn;                      // momento angolare, già × guadagno del mood
   const radius = base * (1 + 0.3 * world.pressure);
   ```

4. Esporta la definizione in `index.ts`:

   ```ts
   import { defineVisualizer } from '../shared/defineVisualizer';
   import type { VisualizerPreset } from '../../types/visualizer';
   import preset from './preset.json';
   import { MyVisualizer, type MyParams } from './MyVisualizer';

   export default defineVisualizer<MyParams>({
     id: 'my-scene',
     name: 'My Scene',
     description: 'Una riga di descrizione.',
     icon: 'scene',
     order: 7,
     preset: preset satisfies VisualizerPreset<MyParams>,
     create: (p) => new MyVisualizer(p),
   });
   ```

Per comparire nel menu non serve registrarla altrove: `registry.ts` trova automaticamente ogni `visualizers/*/index.ts` e la scena compare nell'anello Scene. L'anello principale resta a sei elementi; Mood usa otto posizioni. Verificare spaziatura e leggibilità quando si aggiungono altre voci.

Per partecipare alla scelta automatica Hybrid/Free aggiungere anche costo e affinità in `src/show/fixtures.ts`. Lo shader può stare in un modulo separato (esempio: `liquid/shaders.ts`).

Il contratto completo è in `src/types/visualizer.ts`:

```ts
interface Visualizer {
  readonly scene: Scene;
  readonly camera: Camera;
  init(context: VisualizerContext): void;
  setPalette(colors: PaletteColors): void;
  update(frame: AudioFrame, deltaTime: number, time: number, response: VisualResponseFrame, modulation?: ModulationState, clock?: SceneClock): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
```

`context.addPass(pass, 'pre-bloom' | 'post-bloom')` permette di aggiungere pass di post-processing (l'Oscilloscope lo usa per la persistenza dei fosfori); vengono smaltiti automaticamente quando la scena viene smontata.

Una scena può anche essere una **recipe**: una lista di primitive condivise in un mondo visuale, invece di una forma propria. Si dichiara con `defineRecipe` al posto di `defineVisualizer` (esempio: `src/visualizers/matter-field/`); regole, primitive disponibili e come scriverne una nuova in [docs/visual-engine.md](docs/visual-engine.md). I sistemi di base (campi, materia GPU, onde, memoria visiva) sono descritti in [docs/visual-systems.md](docs/visual-systems.md). Gli eventi discreti arrivano in `clock.events` (lo stream dell'Experience Engine, da leggere con un `EventCursor` fino a `clock.time`); `clock.light` è la luce degli impatti già ammessa dal FlashGuard. Riflesso e orizzonte li aggiunge il render engine: la scena deve solo disegnare ciò che sta sopra l'orizzonte.

## Qualità

| Qualità | Risoluzione | Densità geometrica | Bloom |
|---|---|---|---|
| High | 1× devicePixelRatio (max 2) | 100% | sì |
| Medium | 0,75× (DPR max 1,5) | 65% | sì |
| Low | 0,5× (DPR max 1,5) | 35% | no |
| Auto | parte da 1× (DPR max 1,5) | 100% | sì |

Spectral Matter interpreta la densità come quantità di materia (circa 96.000 / 62.000 / 34.000 elementi) e riduce con essa legami e faccette disegnati (assenti a Low, dove materia e forme restano punti), risoluzione della memoria visiva (assente a Low) e dettaglio della turbolenza. Matter Field scala ogni primitiva (materia 60.000 / 39.000 / 21.000 elementi, filamenti, anelli della membrana, nodi) e tiene la memoria visiva a metà risoluzione. Field scala traccianti (circa 36.000 / 23.500 / 12.500) e linee di campo, con memoria visiva a metà risoluzione (assente a Low).

**Auto** riduce prima la sola risoluzione a 0,85×, poi passa a Medium, riduce bloom/risoluzione e infine a Low. Soglia di discesa: 3 s sotto 51 fps. Recupera un passo dopo almeno 30 s a 58 fps e cooldown di 60 s. Gli stalli non costituiscono evidenza. I cambi di sola risoluzione non ricreano la scena.

## Supporto piattaforme

| | System audio | Microfono | Stato |
|---|---|---|---|
| **Windows 10/11** | ✅ WASAPI loopback | ✅ | Target principale |
| **Linux** | ✅ sorgente monitor dell'uscita predefinita (PipeWire / PulseAudio) | ✅ PipeWire / PulseAudio (ALSA come fallback) | Verificata su Fedora 44 |
| **macOS** | ⚠️ tramite aggregate device di cpal (macOS 14.6+), non testato | ✅ | Non verificato |
| **Browser** (`npm run dev`) | ❌ | ✅ getUserMedia | Solo sviluppo |

## Limitazioni attuali

- **Metadati del brano**: non vengono ancora letti (su Windows servirebbero i Global System Media Transport Controls, su Linux MPRIS). Il now playing mostra la sorgente: "System Audio" e il nome del dispositivo, "Live input" per il microfono.
- **Linux**: "System Audio" registra il monitor dell'uscita predefinita *al momento dell'avvio della cattura*. Se poi si cambia uscita (per esempio dalle cuffie Bluetooth agli altoparlanti), bisogna riselezionare Audio → System Audio. Serve un server PipeWire o PulseAudio: con ALSA puro l'audio di sistema non è disponibile.
- **Linux, latenza di cattura**: la cattura chiede a PipeWire/PulseAudio frammenti da circa 10 ms. Senza questa richiesta il monitor di un'uscita Bluetooth consegnava blocchi da ~340 ms dichiarandoli vecchi di ~1,7 s: il clock udito finiva oltre l'ultimo frame analizzato e regia, mondo e Resonant Field restavano fermi. Se un altro dispositivo dichiarasse ancora ritardi superiori a 0,5 s l'effetto si ripeterebbe (nell'overlay di debug l'esperienza risulta assente).
- **Windows**: la cattura WASAPI compila ed è verificata staticamente (`cargo check`/`clippy` per `x86_64-pc-windows-msvc`), ma non è ancora stata provata su una macchina Windows reale.
- **Dispositivo audio**: la UI Euforia-Audio-Experience non prevede la scelta del dispositivo, quindi si usa sempre quello predefinito di sistema. Quando il predefinito cambia, cpal lo segue; se la cattura cade, l'app ritenta 5 volte.
- **Palette / Mood / Experience** sono indipendenti. I profili iniziali richiedono ulteriore taratura percettiva su registrazioni reali; Auto non classifica generi o struttura completa dei brani.
- **Fullscreen**: usa la finestra corrente; non c'è ancora la scelta del monitor.
- Il tracker TS delle scene resta basato sulla cassa; la regia usa gli onset multi-banda Rust con confidence e fallback. Musica senza ritmo affidabile o molto sincopata resta un limite. La calibrazione suggerisce un ritardo, ma non misura end-to-end il display e ogni uscita: verificare *Audio delay* a orecchio.
- La qualità grafica Auto misura RAF, non il tempo GPU; il budget DSP misura separatamente CPU/durata audio.
- Metro: ipotesi 3/4/5/7 con confidence, non analisi completa delle segnature; frase 4/8 battute euristica. Il corpus sintetico conserva il limite delle sezioni (4/12 entro una battuta).
- **Spectral Matter e i Visual Systems sono sperimentali**: verificati con test automatici, parità GPU ↔ riferimento CPU e segnale sintetico su una Intel UHD; non ancora con musica reale, né su WebView2/WebKitGTK. A High la memoria visiva a piena risoluzione pesa su GPU integrate (Auto può scendere a Medium); senza render target float lo stato usa half float, percorso non provato. Tempi GPU non misurati per pass.
- **Visual Engine e Matter Field sono sperimentali**: leggi delle primitive verificate sul riferimento CPU, shader compilati e fotogrammi guardati su una Intel UHD con segnali sintetici; **nessuna prova con musica reale né del movimento nel tempo**, e la taratura (quando compare ogni struttura, quanto è luminosa) è un punto di partenza che richiede gli occhi. Le leggi di filamenti, grafo, membrana e anelli non hanno ancora una prova di parità GPU ↔ CPU con lettura dei risultati. Tunnel, Galaxy, Particle Field, Liquid, Oscilloscope e Spectrum restano scene con una forma propria; fra scene diverse la transizione è ancora un crossfade ([dettagli](docs/visual-engine.md)).
- **Field, Tunnel e Particle Field** (scene fisiche): leggi e regimi verificati con test automatici (silenzio, 30 / 60 / 144 fps, limiti, determinismo), parità GPU ↔ CPU delle leggi di Field e fotogrammi su una Intel UHD con segnali sintetici; **nessuna prova con musica reale né del movimento nel tempo**. Guadagni dei tagli del Tunnel, profondità dei pozzi di Particle Field, esposizione e scie di Field sono punti di partenza che richiedono gli occhi ([limiti](docs/physical-scenes.md)).
- **Matter Engine**: prima milestone. Morfologia tarata sui segnali di prova attraverso il DSP reale, forme verificate sul riferimento CPU e a schermo con segnali sintetici (fotogrammi, non il movimento); **nessuna prova con musica reale**. Con mix densi e armonia che cambia in fretta la rete dei parziali è poco leggibile; i poligoni sono tratteggiati, non riempiti; geometria spettrale, volume e illuminazione direzionale non esistono ancora. Misure di costo prese su una macchina carica ([dettagli](docs/matter-engine.md)).
- Il World Engine è un modello fisico visivo, non meccanica calibrata; coefficienti tarati su segnali sintetici, non ancora su musica reale né con prova percettiva.
- ERB, roughness, armonicità, H/P/R e range di loudness sono approssimazioni live, non strumenti certificati o separazione di sorgenti. La taratura percettiva su un corpus reale resta da eseguire.
- Test automatici su analisi, presenza, semantica temporale e grammatica delle scene; la cattura reale WASAPI richiede ancora una verifica su Windows.

## Roadmap

- Metadati del brano (GSMTC su Windows, MPRIS su Linux) e stato "nessun brano"
- Su Linux, seguire automaticamente il cambio di uscita predefinita; verifica su macOS
- Preset specifici per scena e caricamento di preset esterni
- Consolidare gradualmente TS e Rust/WASM senza perdere waveform, spettro, voci e fallback; misurare cattura→display su hardware reale
- Estendere i test dalla macchina a stati dei menu (coperta) al DOM della UI e ai dispositivi audio reali
- Visual Engine: taratura di Matter Field su musica reale e a occhio; prova di parità per le leggi nuove; Particle Field e Galaxy come recipe; anelli del Tunnel dai fronti condivisi; traccia del segnale e superficie fluida come primitive; transizioni fra recipe dentro lo stesso mondo ([percorso](docs/visual-engine.md))
- Scene fisiche: taratura di Field, Tunnel e Particle Field su musica reale e a occhio; Galaxy (orbite), Liquid (superficie fluida) e Oscilloscope (traccia) sullo stesso modello; storia per tracciante in Field ([prossimi passi](docs/physical-scenes.md))
- Matter Engine: taratura su musica reale e a occhio; forma "membrana" dai modi di Resonant Field (fatta: `WaveSurfacePrimitive`); geometria spettrale da ERB; Particle Field e Galaxy come stati della materia invece che scene; transizioni fra scene come trasformazioni invece che crossfade ([piano](docs/matter-engine.md))
- Visual Systems: taratura percettiva di Spectral Matter su musica reale; riuso graduale di memoria visiva, onde e materia nelle scene esistenti; reaction-diffusion, geometria implicita, densità volumetrica e backend compute restano da fare ([nota](docs/visual-systems.md))
- Profilare GPU per pass e ripresa dopo tab nascosta in WebView reali; tarare il World Engine su un corpus reale e a occhio; backlog e criteri nella [scheda tecnica](docs/technical-overview.md)

## Licenza

Software proprietario, tutti i diritti riservati: vedi [LICENSE](LICENSE). La pubblicazione dei sorgenti non concede alcun diritto d'uso, copia o ridistribuzione. Le dipendenze conservano le rispettive licenze.
