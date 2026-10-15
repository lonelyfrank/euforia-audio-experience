# Euforia-Audio-Experience — scheda tecnica e audit

Aggiornata il **15 ottobre 2026** (audit grafico; Engine Workspace invariato). Il [README](../README.md) è la fonte di verità per
funzionalità, avvio e architettura; questa scheda contiene i dettagli operativi per
chi modifica il progetto. [experience-engine.md](experience-engine.md) conserva
le decisioni e misure delle fasi precedenti. Il prodotto usa solo sorgenti live;
il vecchio supporto file non esiste più.

Verifica grafica corrente: [Visual Fidelity Audit](visual-fidelity-audit.md),
[Graphics Refactor Report](graphics-refactor-report.md), [reattività](music-reactivity-report.md),
[confronto prestazioni](visual-performance-comparison.md). I due script
`scripts/visual-fidelity-browser.mjs` e `scripts/visual-performance-browser.mjs` separano
replay deterministico con immagini e misura live RAF/GPU. Non aggiungono route o pannelli
al prodotto e non sostituiscono i benchmark storici riportati sotto.

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
[Visual Engine](visual-engine.md), [Visual Grammar](visual-grammar.md), [scene fisiche](physical-scenes.md),
[Spectral Shell](spectral-shell.md), [Structural Dynamics](structural-dynamics.md),
[Solid Dynamics](solid-dynamics.md), [Rigid Resonant Body](rigid-resonant-body.md),
[Adaptive Music Calibration](adaptive-calibration.md), [Tunnel Motion Coordinator](tunnel-motion.md),
[Music Response](music-response.md), [Generative Terrain](generative-terrain.md), [Musical Cognition](musical-cognition.md), [Famiglie di scene, solidi ed emersione](scene-families.md),
[Generative Worlds](generative-worlds.md), [mondi futuri (progetto)](future-worlds.md),
[transizioni fra ambienti (studio)](world-transitions.md).
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
| Bridge desktop | `src-tauri/src/audio.rs` | Worker: analisi stereo (musica) e delle scene (mix mono) sul thread di cattura, un Channel binario di soli record (circa un messaggio per frame di scena; nessun PCM), impostazioni delle scene condivise con il thread; i comandi frontend sono serializzati |
| Analisi grafica | `native/analysis/src/scene.rs` (thread di cattura / worker) → record `scene` → `audio/features/SceneFeed.ts` | FFT 2048, finestra voci 4096, cinque bande, waveform, YIN, tracker bassi, ≈ 60 volte al secondo sul clock di cattura. `audio/analysis/AudioAnalyzer.ts` è il riferimento TypeScript del port (test di equivalenza) e tiene l'`AudioFrame` quando nessuna sorgente consegna |
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
| Structural Dynamics | `physics/MultiscaleResonance.ts`, `visual-engine/structural/`, `visual-engine/primitives/WirePolygonPrimitive.ts` | Risonanza multiscala per hop in ExperienceEngine (`snapshot.resonance`; macro / meso / micro a conteggi configurabili; `ResonantPhysics` invariata). Elementi con identità procedurale, pool a capacità fissa, legami (campate, giunti, controventi), carico / danno / frattura, memoria strutturale, ordine / temperatura / ruoli continui, passo fisso sul clock udito, vicinato in griglia limitata. L'ambiente è quello del mondo (`fieldAt`, fronti, molla radiale); la primitiva lo disegna (fili istanziati, punti, facce). Esiste solo nello Structural Lab, fuori dal registry ([structural-dynamics](structural-dynamics.md)) |
| Solid Dynamics | `visual-engine/structural/Solid*.ts`, `WorldEnvironment.ts`, `visual-engine/primitives/SolidPrimitive.ts`, `app/engine/SolidCockpit.ts` | Corpi volumetrici come componente opzionale di `StructuralSystem` (`config.solids`): gli stessi elementi, tenuti da link (spigoli, controventi), cerniere di flessione, triangoli di superficie e celle (insiemi chiusi e orientati di triangoli con un volume). Solver XPBD nello stesso passo fisso, sul moto predetto; frattura con la legge di carico dei fili; componenti connesse e forma di ogni pezzo lette dai link; memoria di lunghezze e volumi, ricomposizione solo a condizioni fisiche e topologiche valide. Pool a budget esplicito. Laboratorio DEV fuori dal registry; nel prodotto lo usa Fractured Expanse, nessuna scena Particles ([solid-dynamics](solid-dynamics.md)) |
| Rigid Resonant Body | `visual-engine/structural/SolidDynamics.ts` (`fit`, `breathe`, `shatter`), `SolidState.ts` (`rest`, `frame`, `settled`), `FractureGate.ts` | Un materiale di `SolidSystem`, non un sistema: riferimento di forma per pezzo, shape matching dopo le proiezioni XPBD (stesso passo, stesse 4 iterazioni), pulsazione come scala unica di ciò a cui link, cerniere, celle e fit tendono (≤ 6 %), frattura automatica solo quando un evento dell'`EventStream` passa il gate (significance, confidenza, isteresi, cooldown, budget), lungo un piano, per la legge di carico dei link. Il materiale di prodotto è `legacy`: senza ritenzione né pulsazione il passo è quello di prima, bit per bit ([rigid-resonant-body](rigid-resonant-body.md)) |
| Adaptive Music Calibration | `experience/AdaptiveCalibration.ts`, `ExperienceEngine.calibration`, `ExperienceSnapshot.calibration`, `AudioEvent.significance` | Per hop, sulle misure già esportate dal DSP: riferimenti consolidati che seguono i percentili del loudness, livello nel range del brano (stiramento limitato), attività relativa di bassi/medi/alti, voto degli attacchi contro gli accenti abituali, gain limitato dal noise floor, carattere. Accanto al World Engine, mai dentro. Distinta dalla calibrazione di sincronia ([adaptive-calibration](adaptive-calibration.md)) |
| Anticipazione (conto) | `experience/Anticipation.ts`, `ExperienceEngine.anticipation`, `ExperienceSnapshot.anticipation` | Per hop: legge la carica del mondo (`forces.charge / CHARGE_RATE`) e i rilasci, tiene fase (none / uncertain / probable / confirmed) e contatori (aperte, confermate, scadute, non annunciate). Non predice e non scrive nel mondo; le scene non ramificano sulla fase. |
| Musical Cognition | `experience/cognition/`, `ExperienceEngine.cognition`, `ExperienceSnapshot.cognition`, `director.ts` | Per hop, dalle misure e dagli eventi del DSP e dall'evidenza di build dell'Experience: clock (stato, inerzia ≤ 2 battute / 4 s, continuità, verifica sugli onset, ottava, battute solo con evidenza), memoria strutturale (ring 256 beat / 64 battute, metro dai cambiamenti, ripetizione, confini, posterior delle frasi), priori e profili stilistici, interprete con isteresi, registro delle previsioni con esiti e Brier, rilascio udito. Non scrive nel mondo, nello stato né negli eventi; la regia (finestra del planner, griglia di frase dello show) la segue solo quando `leads`. `config.enabled = false`: Experience e regia di prima ([musical-cognition](musical-cognition.md)) |
| Moto condiviso | `visualizers/shared/motion.ts` | `RateFollower` (velocità seguita, distanza esatta del frame), `HysteresisGate`, `AccentGate`, `follow`: i pezzi del coordinatore del Tunnel che non riguardano un tunnel. Usati da Tunnel e Terrain. |
| Generative Terrain | `visualizers/terrain/`, `visual-engine/primitives/terrain{Law,Motion}.ts`, `TerrainPrimitive.ts` | Recipe del suolo (più l'emersione): reticolo fisso su cui la mesh scorre, legge dell'altezza in GLSL e TS, lettura del mondo per il suolo su tre scale (`TerrainResponse`). Due draw call, nessun pass. |
| Emersione dal terreno | `visual-engine/primitives/{emergenceLaw,terrainEmergence,EmergencePrimitive,terrainParity}.ts` | Strutture ancorate alla legge del suolo (GLSL e TS), ciclo di vita a pool fisso sui cue musicali, istanze con gli uniform del suolo; parità GPU ↔ CPU. Due draw call (una a Low). |
| Famiglie di scene | `types/visualizer.ts` (`SceneCategory`, `SCENE_CATEGORIES`), `visualizers/registry.ts` (`scenesOf`, `categoryOf`), `app/menus.ts` | Particles / Worlds / Spectrum come metadato del registry; Scene → famiglia → scena nel menu. |
| Locomozione dei mondi | `render-systems/camera/locomotion.ts`, `visual-engine/RigCamera.ts`, `WorldRecipe.camera` | Profili travel / glide / orbit / hover / drift letti da `WorldView` (nessun tempo proprio), sommati e limitati da `CameraRig`; una recipe con `camera` sostituisce l'`Observer`. Tunnel e Terrain non lo usano. |
| Generative Worlds | `visualizers/{monolith-desert,fractured-expanse,pulse-ocean,resonant-forest}/`, `visual-engine/primitives/{lattice,ocean*,forest*,ConstellationPrimitive}.ts` | Quattro recipe Worlds sul riuso di suolo, emersione, solidi, campo e fronti; leggi nuove del mare e della foresta in GLSL e TS con prova di parità; ciclo di vita e memoria della foresta. |
| Cue musicali | `experience/MusicalCues.ts` | Adattatore per hop: anticipazione, previsione, osservazione, conferma (rilascio udito) distinte; snapshot `cues`. Il `drop` dell'Experience non è un cue. |
| Solidi fra le particelle (DEV) | `visual-engine/primitives/solidSlot.ts`, `SolidPrimitive` (`population`), `app/engine/{emergence,EmergenceLab}.ts` | Popolazione di corpi di `SolidSystem` montata a runtime in una recipe Particles dal laboratorio Emergence. |
| Tunnel Motion Coordinator | `visualizers/tunnel/motion.ts`, `topology.ts` (`architecture`) | Decide quanto di ogni target del Tunnel si vede: viaggio continuo (integrale esatto di un follower), forma e torsione seguite e limitate, apertura della parete con isteresi, accenti solo da eventi che spiccano, cessione progressiva di B mentre C occupa il quadro. `balance: 0` non chiama il coordinatore ([tunnel-motion](tunnel-motion.md)) |
| Workspace tecnico | `diagnostics/workspace/`, `app/engine/EngineCockpit.ts` | Una shell a tre colonne (navigazione · viewport live · inspector contestuale) per Shift+D/E/G, canvas originale e controller condiviso; diagnostica lazy in release, laboratori solo DEV. [Contratti e verifiche](engine-workspace.md). Inspector strutturali (`?engine`, Shift+E): moduli, viewport, ispettore, tracce. Fissa il mondo sul rig (`RigController.pinned`, `App.pinScene`), registra il laboratorio (`registerLaboratory`), scrive solo `structuralLab`; alla chiusura ripristina tutto. Nessuna impostazione utente toccata, UI cinematica invariata |
| Scene fisiche | `render-systems/fields/vectorField.ts`, `wells.ts`, `particles/tracer*.ts`, `Tracer*.ts`, `visual-engine/primitives/Field*Primitive.ts` | Campo vettoriale F(P) e sua topologia, pozzi di potenziale, legge / passo / simulazione GPU / probe CPU / parità dei traccianti, primitive dei traccianti e delle linee di campo: leggi in GLSL e in TS come la legge dei campi ([scene fisiche](physical-scenes.md)) |
| Visual Systems | `render-systems/` | Vocabolario condiviso: `VisualMaterial` (mondo + morfologia), campi spaziali, legge dei campi e legge delle forme (GLSL + riferimento CPU), forme della materia (storia della waveform, rete dei parziali), onde datate, materia GPU e probe CPU, disegno a punti / legami / faccette, memoria visiva, osservatore; nessuno stato musicale, solo storia di rendering |
| Scene | `visualizers/` | Sei scene legacy interpretano il mondo (`modulation.world`) in una forma propria: moto, pressione, turbolenza, coerenza, potenziale e rilasci; voci/tracce/spettri restano grafici; senza clock `REST_VIEW` (ferme); dispose GPU espliciti. In Tunnel e Particle Field la trasformazione della struttura è una funzione pura della `WorldView` (`tunnel/topology.ts`, `particle-field/regimes.ts`). Quattro sono recipe: Spectral Matter (la sola materia), Resonant Field (la sola membrana; `?legacy=resonant-field` in DEV monta la precedente), Matter Field (tutte le primitive), Vector Field (traccianti e linee di un campo vettoriale; già `field`), Spectral Shell (la membrana a disco di Matter Field con il proprio passato come gusci, [spectral-shell](spectral-shell.md)) |
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
solo storia di rendering (i traccianti di Vector Field, le tracce, la memoria dei modi di
Spectral Shell, tenuta sul clock audio): quando il campo si annulla
deve fermarsi. `vectorField`, `tracerLaw`, `tracerStep` e `wells` esistono in GLSL e in
TypeScript: si cambiano insieme e la parità va riprovata con `runTracerParity()`
(`render-systems/particles/tracerParity.ts`). Il tempo di un rilascio sceglie la struttura
che lascia (`Reorganization`): non usare contatori di frame né `Math.random`. Dettagli,
misure e limiti in [physical-scenes](physical-scenes.md).

**Structural Dynamics.** La catena è audio → eccitazione → ambiente → materia / struttura →
topologia → rendering: l'ambiente (lo stesso `fieldAt` dei traccianti, gli stessi fronti, la molla
radiale del corpo) decide dove va un elemento, la sua risonanza (`ResonanceField`, per `f0` e `q`)
come risponde; l'audio non scrive mai una posizione. L'identità è una funzione pura di seme, numero
e popolazione (hash intero: uno shader calcola gli stessi bit); le proprietà sono distribuzioni
continue lungo l'asse di frequenza, mai categorie. Rompere un legame libera il legame, non
l'elemento: posizione, velocità, altezza restano, più una memoria che decade. Ordine, temperatura e
ruoli sono quantità seguite con isteresi; il lifecycle è solo un nome per gli strumenti. Coesione,
forza di vicinato, memoria e potenziale agiscono solo in un mondo vivo (`energy` > 0): nel silenzio
nulla di nuovo si assesta né si muove. Il passo è fisso (1/120 s) sul clock che riceve e le cadenze
interne sono contate in passi; pool e griglia hanno capacità fissa, quindi legami e vicinati sono
limitati per costruzione. `wirePoint` esiste in GLSL e in TypeScript. `MultiscaleResonance` usa solo
misure già esportate (`pitchBins`, `bandLevel`, `bandTransient`, `erb`, `sharpness`) e gira per hop
in ogni sessione; `ResonantPhysics` non va toccata per essa. `structuralLab`, lo Structural Lab e il
cockpit esistono solo in DEV; il lab non entra in `visualizers` (menu, show, impostazioni).
Dettagli, misure e limiti in [structural-dynamics](structural-dynamics.md).

**Solid Dynamics.** Un solido non è un oggetto animato: è ciò che link, facce e celle tengono
insieme fra elementi del sistema strutturale. Invarianti: (1) nessun secondo motore: `SolidSystem`
è un componente di `StructuralSystem`, entra nel suo passo in tre punti (`recall`, `begin`, `solve`)
e un sistema senza corpi fa esattamente il passo di prima; (2) il suono non scrive posizioni: sposta
la lunghezza di riposo dei link e il volume di riposo delle celle, sempre per coppie o per celle
(quantità di moto conservata); (3) tutto si legge dai link: un triangolo tiene con i suoi tre link,
una cella con tutto il suo contorno **e** un volume verificato, un frammento è una componente
connessa; uno spigolo rotto non crea un frammento; (4) rompere cambia lo stato di un link
(`INTACT` → `BROKEN` → `LOST`), mai il numero di elementi, link, facce o celle; (5) un link si
riforma solo in un mondo vivo, fra capi assestati, vicini alla lunghezza che aveva, lenti l'uno
rispetto all'altro e con le celle dal verso giusto, alla lunghezza a cui si trova; (6) lunghezze e
volumi di riposo sono misurati con la stessa aritmetica del solver (un corpo a riposo non si muove
di un bit: cambiare `SolidState.measure` e `SolidSystem.volumeOf` insieme); (7) iterazioni e pool
sono costanti del budget: la qualità grafica e gli FPS non toccano la topologia; (8) la primitiva
invia posizioni della simulazione e nessuno shader sposta un vertice. `solidLab` (in
`SolidTypes.ts`), il laboratorio e `SolidCockpit` esistono solo in DEV.
Dettagli, misure e limiti in [solid-dynamics](solid-dynamics.md).

**Rigid Resonant Body, calibrazione, Tunnel.** Invarianti: (1) il riferimento di forma
(`SolidState.rest`, `bodyScale`) è scritto alla semina e mai dal suono né da una frattura: un
frammento si riferisce alla propria parte; (2) la pulsazione è una sola, fisica: scala i target di
link, cerniere, celle e fit, mai il disegno; `|p| ≤ maxPulse ≤ PULSE_LIMIT`; (3) il fit usa una quota
unica per pezzo attorno al suo centro di massa: non dà quantità di moto né momento angolare;
(4) la conversione ritenzione → rigidezza è `shapeRate`, tarata sulla prova di deformazione:
cambiarla insieme a quel test; (5) in `events` il carico è misurato ma non rompe: l'unico percorso
di rottura è `FractureGate.take` → `shatter` → `sever`, al passo che raggiunge il tempo audio
dell'evento, con direzione data da quel tempo (`seedOf`); (6) il materiale `legacy` è il corpo di
prima bit per bit: ogni novità passa per fattori che valgono 1 o 0 lì; (7) la calibrazione legge
solo misure già esportate dal DSP, sta in `ExperienceEngine` per hop, non entra nel World Engine
(Spectrum legge `WorldView`) e con `enabled = false` è la lettura non calibrata; (8) la
`significance` di un evento è relativa agli accenti recenti, mai un livello; (9) il coordinatore
del Tunnel non ha tempo proprio: follower esatti per un ingresso tenuto nel frame, età di eventi
datati, e a `balance` 0 non viene chiamato.

**Musical Cognition.** Invarianti: (1) un solo tracker: la griglia è quella del DSP, il clock la estende e non la
corregge; (2) causale: nessuna decisione usa audio dopo l'hop; (3) osservazioni, interpretazioni e previsioni restano
distinte: una previsione non è un evento, è rifiutata se il suo istante è passato e confermata solo da un'osservazione
dentro la sua finestra e successiva alla proposta; (4) il rilascio è **udito** (quota di basso che rientra con un attacco
basso, o un `drop` del DSP), mai confermato da un'aspettativa; il `drop` dell'Experience non si tocca (§2.4 di
[music-response](music-response.md)) ed è solo confrontato; (5) posizioni di battuta e di frase solo con evidenza (metro
pubblicato o cambiamenti; confidenza), mai un 4/4 presunto; il clock non resta in inerzia oltre 2 battute / 4 s;
(6) la cognizione non scrive nel mondo, nello stato Experience né nell'event stream (mondo, stato ed eventi identici
acceso / spento: test); la regia la legge dallo snapshot e torna al percorso reattivo per frame quando non `leads`;
(7) memoria e pool a capacità fissa, nessuna allocazione per hop; (8) `scenarios.ts` è un mock del DSP per i test e il
laboratorio, non una prova del tracker. Le override di sviluppo della cognizione passano da `controller.overrides`.
Dettagli, misure e limiti in [musical-cognition](musical-cognition.md).

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

Structural Dynamics (8 ottobre 2026): nessuna modifica a DSP, wire, WASM, World Engine, UI
cinematica, scene esistenti. Aggiunta a `ExperienceSnapshot` (`resonance`). Esiti, misure e limiti in
[structural-dynamics](structural-dynamics.md) §12–14: **422 test frontend in 54 file** (34 nuovi; 1 saltato come prima), core Rust invariato
(**59 test + 1 doctest**, rieseguiti), shader della struttura compilati e undici scene montate senza errori su Intel UHD,
cockpit aperto e richiuso a runtime; non provati musica reale, movimento nel tempo a occhio, app
desktop, tempo GPU.

Rigid Resonant Body, Adaptive Calibration, Tunnel Balanced (11 ottobre 2026): nessuna modifica a
DSP, wire, WASM, World Engine, ShowDirector, UI cinematica o impostazioni; Experience estesa con la
calibrazione e con `significance` sugli eventi (mondo, stato ed eventi identici con la calibrazione
spenta). `npm run check`: esito in [resonant-body-report](resonant-body-report.md) §5, con i
benchmark prima / dopo (§6), le prove su GPU reale e ciò che non è stato verificato.

Solid Dynamics (11 ottobre 2026): nessuna modifica a DSP, wire, WASM, World Engine, Experience,
UI cinematica, scene esistenti, `ResonantPhysics`. Toccati del sistema strutturale: due campi per
elemento (`body`, `links`), leggi di `BondSystem` estratte a funzioni con la stessa aritmetica,
ambiente del mondo estratto in `WorldEnvironment.ts` (i 27 test strutturali di prima passano
invariati). `VITEST_MAX_WORKERS=2 npm run check`: typecheck, ESLint, **542 test passati, 1 saltato
come prima, 67 file** (31 nuovi in 3 file), build di produzione. Il bundle principale non contiene
codice dei solidi; il chunk lazy della diagnostica, che già portava il sistema strutturale per le
sue sonde, ne porta ora anche il componente solido (non il laboratorio, la primitiva o il cockpit).
Browser DEV con GPU reale (Intel UHD): shader compilati senza warning, tre solidi, sette viste,
strumenti, passaggio fra i due laboratori, uscita con scena, pin e impostazioni ripristinati.
Core Rust non toccato e non rieseguito. Non provati: musica reale, movimento nel tempo a occhio,
app desktop, tempo GPU. Esiti e limiti in [solid-dynamics](solid-dynamics.md) §11–13.

Spectral Shell (7 ottobre 2026, dopo): nessuna modifica a DSP, wire, WASM, World Engine. Esiti,
misure e limiti in [spectral-shell](spectral-shell.md) §5–7: **388 test frontend in 51 file**
(19 nuovi), shader della membrana a 1 / 3 / 4 / 5 layer compilati su Intel UHD, Matter Field
confrontata prima / dopo (stesso shader a meno di tre riscritture senza effetto numerico,
stessi tempi); non provati musica reale, movimento nel tempo, app desktop.

Scene fisiche (7 ottobre 2026, notte): nessuna modifica a DSP, wire, WASM, World Engine, UI.
Esiti, misure e limiti in [physical-scenes](physical-scenes.md) §7–8: **370 test frontend in
49 file** (47 nuovi), parità GPU ↔ CPU delle leggi di Field (oggi Vector Field; media 1,07 · 10⁻⁵ unità) e
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

Musical Cognition (14 ottobre 2026): nessuna modifica a DSP, wire, WASM, World Engine, event stream, scene, UI
cinematica, impostazioni. `npm run check`: **691 test superati, 1 saltato (preesistente), 81 file** (48 nuovi, benchmark incluso), build;
`workspace-browser.mjs acceptance` e `release` superati su Chromium con GPU Intel UHD. Non provati: musica reale,
Tauri / WebKitGTK, Windows, hardware più debole. Esiti, benchmark e limiti in [musical-cognition](musical-cognition.md) §7–9.

## Miglioramenti prioritari successivi

| Priorità | Lavoro | Criterio di completamento |
|---|---|---|
| Alta | Prova desktop Windows/WebView2 e Linux reale dopo questi cambi | Cambio rapido system/mic, scollegamento e riconnessione, delay/calibrazione, sette scene senza errori JS/GLSL e senza catture residue |
| Alta | Benchmark CPU/GPU ripetibile, a qualità e risoluzione fisse | Tempi separati cattura/DSP TS/WASM/Director/pass GPU, p50/p95/p99 e memoria, confronto prima/dopo sullo stesso dispositivo |
| Alta | Recupero dopo tab nascosta o backlog browser in WebView reali | La politica esiste (silenzio ≤ 1 s, poi epoch; staging ~3 s): verificarla in WebView2/WebKitGTK con stalli 0,5–10 s e timer dei worker in background |
| Media | Unificazione graduale DSP TS/Rust | Corpus reale e sintetico, stessa waveform/pitch/presenza e latenza misurata; evitare doppia analisi senza spezzare i contratti |
| Alta | Visual Engine: Matter Field su musica reale e a occhio | Affinità, costi, guadagno del budget ed esposizioni tarati su un corpus; ogni struttura leggibile da sola e insieme; costo a 1080p e in WebView2 su macchina scarica |
| Alta | Parità GPU ↔ CPU delle leggi nuove | Un `runLawParity()` che valuta filamenti, nodi, membrana e anelli per texel e li confronta con il riferimento CPU, come `runParity()` per la materia |
| Alta | Structural Dynamics su musica reale e a occhio | Nel lab, con gli override del cockpit: carico, coesione, memoria e risonanza tarati su un corpus; il quadrato si forma, vibra, si rompe e si ritrova in modo leggibile con ambient, percussioni, mix densi, drop e silenzio |
| Alta | Solid Dynamics su musica reale e a occhio | Nel laboratorio: rigidezze, ampiezze della spinta risonante, soglia di frattura e forza della memoria decise su un corpus; il corpo si deforma in modo leggibile, si rompe quando deve e si ritrova; costo e leggibilità a 1080p |
| Media | Solid Dynamics: celle emergenti, collisioni, più corpi | Celle che nascono da superfici che si chiudono (la verifica esiste); contatto vertice–faccia dove serve; più corpi e selezione nell'inspector; frattura per celle su solidi suddivisi |
| Media | Popolazione strutturale su GPU | Identità (`identityOf`) e tabella di risonanza in GLSL per decine di migliaia di elementi liberi, con parità GPU ↔ CPU; topologia rada su CPU; poi `WirePolygonPrimitive` come slot di Matter Field |
| Alta | Spectral Shell su musica reale e a occhio | Gusci leggibili con ambient, voce, basso, mix densi e percussioni; età, apertura, chiusura e torsione tarate; polvere che vela senza coprire; costo a 1080p e in WebView2 su macchina scarica |
| Alta | Scene fisiche su musica reale e a occhio | Vector Field, Tunnel e Particle Field con ambient, percussioni, basso elettronico, mix densi, stereo sbilanciato, silenzio, drop e build: ogni regime leggibile, nessun moto nel silenzio, tagli e pozzi tarati; costo a 1080p e in WebView2 su macchina scarica |
| Media | Migrare le scene legacy a recipe e al modello fisico | Galaxy (orbite, `wells` a spirale), Liquid (superficie fluida, fronti condivisi), Oscilloscope (`SignalTracePrimitive`); parete del Tunnel come primitiva che legge `uField` / `uWave*`; **Spectrum resta com'è** |
| Alta | Matter Engine su musica reale | Tono, accordo, mix denso e percussioni danno corpi diversi e leggibili a occhio; quote delle forme, tempi dei nodi ed esposizione tarati su un corpus; costo a 1080p e in WebView2 su macchina scarica |
| Alta | Spectral Matter su musica reale | Le nove domande percettive di [visual-systems](visual-systems.md) con un corpus vario e occhi; costo GPU a 1080p e in WebView2; poi riuso di `FeedbackPass`/`WaveField` nelle scene esistenti |
| Alta | Musical Cognition su musica reale | Checklist di [musical-cognition](musical-cognition.md) §10 su un corpus annotato (beat, downbeat, frasi, drop): soglie, priori di frase e profili rivisti, confidenze calibrate sul Brier; poi la decisione su §2.4 di music-response con lo scarto misurato `dropOffset`; ripresa dopo una pausa che sposta la battuta |
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

## Engine Diagnostics 1.0 — osservabilità DEV

`App` importa `diagnostics/installDiagnostics` solo in DEV. Un controller condiviso
coordina dashboard (`?diagnostics`, Shift+G), overlay e cockpit; l'osservazione del
renderer avviene ai confini del frame reale. Sostituiti gli azzeramenti concorrenti
di renderer.info e la registrazione WorldTrace permanente dell'overlay: ora REC è
esplicito e le risorse si liberano all'ultima chiusura. Nessuna modifica alle leggi,
a Spectrum o alla UI cinematica. Aggiunti replay/report sul percorso esistente,
query GPU opt-in, campione materia limitato e isolamento da recipe.
Contratti, disponibilità e verifiche: [engine-diagnostics](engine-diagnostics.md),
[diagnostics-metrics](diagnostics-metrics.md), [diagnostics-validation](diagnostics-validation.md).

## Engine Workspace — 10 ottobre 2026

Le finestre autonome DebugOverlay, EngineCockpit e DiagnosticsDashboard sono sostituite
da adattatori incorporati nell'unica shell `diagnostics/workspace/EngineWorkspace.ts`.
Un solo listener di routing e un timer UI a 5 Hz; nessun RAF aggiuntivo dei pannelli.
La stage originale si monta nel viewport e torna al suo segnaposto alla chiusura;
ResizeObserver, camera e pass rimangono quelli del RenderEngine. Il lease della shell
conserva REC e registry durante la navigazione; replay e baseline restano posseduti
dal pannello report fino alla chiusura. Laboratori caricati soltanto in DEV, nessuna
modifica a impostazioni, DSP, shader o Spectrum. Parità GPU: parametro opzionale per
riusare il renderer live solo durante la prova esplicita, con ripristino del target.
Dall'11 ottobre la shell è a tre colonne: navigazione, viewport (la stage, per tutta
l'altezza disponibile) e inspector contestuale con scroll proprio, dove stanno card,
grafici, laboratorio, registry e report. Le colonne cambiano a scatti (`nextLayout`),
un resize del renderer per passo; i grafici DEV sono larghi quanto il loro host e
vanno a capo (`app/debug/chartLayout.ts`); a ogni tick prima i canvas, poi il DOM.
Dalla sera dell'11 ottobre la shell segue il design system «Euforia Engine» (token `--ws-*`,
Geist, `panel`/`tile`/`meter` in `components.ts`, grafici SVG in `charts.ts`, icone in
`icons.ts`). Audio & Analysis è `workspace/AudioAnalysis.ts` (pannelli DOM + SVG; legge solo
`AudioFrame`, `MusicState` e il frame Rust già pubblicati) e `DebugOverlay` disegna solo
Experience, World e Matter. Sotto il viewport, in DEV, un deck di altezza fissa (`Audio Input`,
`Live Input`) uguale in ogni vista: cambiare sezione non ridimensiona il renderer.
Dal 12 ottobre la vista decide cosa mostra l'inspector (`workspace/sections.ts`:
`VIEW_SECTIONS` + `applySections`; i componenti dichiarano la sezione dei propri blocchi),
ogni ingresso a una vista passa da `EngineWorkspace.navigate` (entrare in Laboratories apre
il laboratorio, nessuna vista lo termina), il ciclo di vita dell'esperimento è
`workspace/Experiment.ts` (open / stop / dispose), le override temporanee che non sono di un
laboratorio hanno un solo proprietario (`core/Overrides.ts`, `controller.overrides`,
`controller.isolate`) e un cambio di configurazione apre un segmento nelle misure invece di
azzerarle (`ConfigurationSegment`, `diagnostics.segment`).
Mapping completo, istruzioni e limiti delle misure: [engine-workspace](engine-workspace.md).
