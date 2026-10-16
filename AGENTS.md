# Lavorare su Euforia-Audio-Experience

- Iniziare da `README.md` (fonte di verità), poi `docs/technical-overview.md`
  (mappa dei moduli, invarianti, audit e backlog). `docs/experience-engine.md`
  conserva decisioni e misure del motore musicale. `docs/realtime-analysis.md`
  (thread, clock, stati, eventi, confidence, benchmark), `docs/refactor-report.md`,
  `docs/acoustic-model.md`, `docs/experience-planner.md`, `docs/physics-engine.md`,
  `docs/world-engine.md`, `docs/visual-systems.md`, `docs/matter-engine.md`, `docs/visual-engine.md`,
  `docs/visual-grammar.md`, `docs/physical-scenes.md`, `docs/spectral-shell.md`, `docs/structural-dynamics.md`, `docs/solid-dynamics.md`,
  `docs/rigid-resonant-body.md`, `docs/adaptive-calibration.md`, `docs/tunnel-motion.md`, `docs/music-response.md`,
  `docs/generative-terrain.md`, `docs/musical-cognition.md`, `docs/scene-families.md`, `docs/generative-worlds.md` e `docs/resonant-forest.md` descrivono il nuovo
  percorso (`docs/future-worlds.md` è solo progetto). Gli audit precedenti sono storici.
- Il progetto usa audio live: system, microphone, fake. Non c’è supporto file.
- Frontend: TypeScript strict, DOM vanilla, Three.js; desktop: Tauri 2 / Rust.
  La macchina di sviluppo può avviare il browser su porta 1420 anche senza
  dipendenze native. Ricontrollare `pkg-config --exists webkit2gtk-4.1 alsa`
  prima di tentare il desktop; non assumere che una vecchia verifica sia attuale.
- Un solo core di analisi (`spectrum-analysis`): la musica per hop e, ogni pochi hop, ciò che
  le scene disegnano (`scene.rs` → record `scene` → `SceneFeed` → `AudioFrame`). `AudioFrame` e
  `AnalysisFrame` restano due contratti distinti. `scene.rs` è il port dell'`AudioAnalyzer` TS,
  che resta il riferimento: cambiarli insieme e ripetere `SceneAnalysis.test.ts` (stessi numeri
  per le stesse finestre). Nel browser il WASM gira in `analysis.worker.ts`: non riportarlo sul
  frame loop, e non riportare PCM sul main thread. Ogni sorgente consegna i record con
  `readFeatures()` / `readScene()`; il ring PCM del worklet (`PcmRing.ts`) e `tap.worklet.js`
  condividono un layout da tenere allineato. Le scene consumano gli array del produttore senza
  modificarli né fare FFT. Dettagli: `docs/performance-architecture.md`.
- DSP fisico/percettivo in Rust; mai ricomputare le nuove misure in TS o nelle scene.
  Conservare ogni frame hop nel wire: il folding per batch rompe la memoria causale.
- Tenere UI in App/menus; memoria/narrativa in ExperienceEngine, intenti in
  ExperiencePlanner, scene in ShowDirector, traduzione in VisualDirector,
  collegamento/Timing in RigController, risorse GPU in Layer.
- Il frame è temporizzato dal timestamp di `requestAnimationFrame`, propagato da `RenderEngine`
  ad `AudioEngine.update(dt, now)`: mai rileggere `performance.now()` a metà callback. `ClockSync`
  non scatta: scorre verso la stima (reset solo a discontinuità reali). Per frame si decodifica un
  numero limitato di hop (`RecordStage.drain`): niente recupero in un solo frame, niente hop saltati.
- Snapshot Experience e fisica sono presentati al clock percepito, mai a RAF.
  Reset di sessione obbligatorio; buffer e history limitati. `meter=0` è ignoto.
  Grammatica geometrica e impulsi luminosi sono distinti: usare FlashGuard condiviso.
  Eventi discreti: `ExperienceEngine.events` con `EventCursor`, datati sui campioni.
  Intenti per nome (`INTENT.x`), pesati con la loro confidence; niente indici fissi.
- `render-systems/` è il vocabolario grafico condiviso (`docs/visual-systems.md`): campi
  dal mondo, materia GPU, onde, memoria visiva. Nessuno stato musicale lì né nelle scene:
  le onde leggono `SceneClock.events` con un `EventCursor`, la loro luce passa da
  `SceneClock.light`. `fieldLaw`/`formLaw`/`matterStep` sono scritti in GLSL e in TS: cambiarli
  insieme e ripetere la prova di parità GPU ↔ CPU (`runParity()` in
  `render-systems/particles/parity.ts`). Semi da `show/rng.ts`, mai `Math.random`.
- La scena **Spectrum** va preservata così com'è in ogni intervento: non modificarla, sostituirla
  o rimuoverla, e non cambiare il significato di ciò che legge (`AudioFrame`, voci `music.*`,
  `WorldView`, `VoiceTextures`, `SignalTexture`, `audibleGlsl`). È il riferimento di fedeltà a
  ritmo e melodia; il nuovo si costruisce accanto.
- Matter Engine (`docs/matter-engine.md`): suono → `SoundMorphology` (per hop in ExperienceEngine,
  solo misure già esportate dal DSP) → `VisualMaterial` → forme. La materia è una e persistente:
  una forma la **reclama** con un'àncora e una molla, non crea né sposta elementi; niente tabelle
  suono → forma né classificatori. Gli slot dei parziali sul wire sono ordinati per livello, non
  tracciati. `matterLab` e il blocco Matter dell'overlay sono solo DEV.
- Visual Engine (`docs/visual-engine.md`, `docs/visual-grammar.md`): una scena nuova è una **recipe**
  (`defineRecipe`) di primitive in un `VisualWorld`, non un visualizer monolitico. Le primitive leggono
  solo `frame.geometry`, `frame.fields`, `frame.look` e gli uniform condivisi: mai bande, beat o spettri,
  mai rilevamento di eventi. `GeometryState` / `MaterialState` sono letture per frame: una proprietà
  musicale nuova entra a monte (morfologia, Experience, World). Le primitive restano montate e sfumano con
  la presenza (niente create/dispose per mostrare una struttura); la recipe non contiene sequenze né rami
  su eventi. Leggi delle primitive in GLSL e in TS come la legge dei campi; `fieldHeaderGlsl` è testo
  della legge dei campi. `worldLab`, `?primitives=` e `?legacy=` sono solo DEV.
- Scene fisiche (`docs/physical-scenes.md`): una scena evolve perché cambia il mondo, mai perché passa il tempo.
  Niente fasi o `uTime` decorativi; ciò che trasforma una scena è una funzione pura di `WorldView` e delle età
  degli eventi (`tunnelTopology`, `particleRegimes`, `deriveTopology`): zero a riposo, limitata, uguale a ogni
  frame rate. Uno stato proprio (i traccianti di Vector Field) si ferma quando il campo si annulla. `vectorField`,
  `tracerLaw`, `tracerStep`, `wells` sono scritti in GLSL e in TS: cambiarli insieme e ripetere `runTracerParity()`
  (`render-systems/particles/tracerParity.ts`). La struttura lasciata da un rilascio la sceglie il suo tempo audio
  (`world/Reorganization.ts`).
- Spectral Shell (`docs/spectral-shell.md`): il grafico circolare dentro Matter Field è lo slot `surface`
  (`WaveSurfacePrimitive` con `RESONANT_DISC`); Spectral Shell è la stessa primitiva con la stessa definizione, più
  `shells`. Un guscio è la membrana nel passato: modi da `ModalMemory` (tick del clock audio, mai una riga per frame),
  impulsi rivalutati a `uTime − età`. Il suono dà la forma (modi, impulsi); il mondo solo come i gusci stanno nello
  spazio. `shellPoint` è scritto in GLSL e in TS: cambiarli insieme. Senza `shells` lo shader resta a un solo layer.
- Structural Dynamics (`docs/structural-dynamics.md`): audio → eccitazione → ambiente → materia / struttura → topologia →
  rendering. L'ambiente (lo stesso `fieldAt`, gli stessi fronti) decide **dove** va un elemento; la risonanza
  (`MultiscaleResonance` per hop a monte → `ResonanceField` per (f0, Q)) decide **come** risponde: mai l'audio su una posizione.
  Identità procedurale (`identityOf`, hash intero, distribuzioni continue: niente categorie di particelle né `if` per tipo);
  pool a capacità fissa; vicinato in griglia limitata, mai O(n²); passo fisso sul clock udito con cadenze in passi, mai in frame.
  Rompere un legame libera il legame, mai l'elemento (posizione, velocità, altezza, memoria restano). Ordine, temperatura e
  ruoli sono continui con isteresi: nessun `if (armonia) poligono`. Coesione, vicinato, memoria e potenziale agiscono solo in
  un mondo vivo: il silenzio non crea energia. `ResonantPhysics` resta com'è. `wirePoint` è scritto in GLSL e in TS: cambiarli
  insieme. `structuralLab`, lo Structural Lab (fuori dal registry: `registerLaboratory`) e il cockpit (`?engine`, Shift+E) sono
  solo DEV e non scrivono impostazioni; la UI cinematica non si tocca.
- Solid Dynamics (`docs/solid-dynamics.md`): un solido è ciò che link, facce e celle tengono insieme fra elementi del
  sistema strutturale, non un oggetto animato né un secondo motore: `SolidSystem` è un componente di `StructuralSystem`
  (`config.solids`) e un sistema senza corpi fa il passo di prima, bit per bit. Vincoli XPBD (compliance / h², moltiplicatori
  per passo, iterazioni fisse del budget) sul moto predetto dal passo strutturale. Il suono sposta il riposo di link e celle,
  mai un vertice, e sempre per coppie o per celle. Facce, celle e frammenti si leggono dai link (`SolidState.book`): uno
  spigolo rotto non crea un frammento, una cella tiene solo un guscio chiuso e verificato, rompere non crea né rimuove nulla.
  Un link si riforma solo a condizioni fisiche e topologiche valide (mondo vivo, capi assestati, distanza, velocità, verso
  delle celle), alla lunghezza a cui si trova. `SolidState.measure` e `SolidSystem.volumeOf` sommano nello stesso ordine:
  cambiarli insieme (è ciò che tiene fermo un corpo a riposo). Carico, fatica e memoria sono le funzioni di `BondSystem`
  (`loadOf`, `tire`, `fade`): una legge per fili e link. Pool a budget esplicito: ciò che non entra è rifiutato e contato; qualità
  grafica e FPS non toccano topologia né iterazioni. `SolidPrimitive` invia posizioni della simulazione: nessuno shader sposta
  un vertice. `solidLab`, il laboratorio (fuori dal registry) e `SolidCockpit` sono solo DEV; nessun solido nelle scene del prodotto
  tranne **Fractured Expanse** (Worlds, `docs/generative-worlds.md`): nessuna scena Particles ne contiene (test).
- Rigid Resonant Body (`docs/rigid-resonant-body.md`): è un materiale di `SolidSystem` (`SolidTuning`), non un sistema. Il riferimento
  di forma (`SolidState.rest`, `bodyScale`) si scrive alla semina e mai dopo: un frammento usa la propria parte. La pulsazione è una
  sola e fisica (scala i target di link, cerniere, celle e fit, mai il disegno), entro `PULSE_LIMIT`. Il fit di forma usa una quota unica
  per pezzo attorno al suo centro di massa (nessun momento) e non aumenta le iterazioni. `shapeRate` (ritenzione → rigidezza) è tarata
  sulla prova di deformazione di `SolidRigid.test.ts`: cambiarle insieme. Il materiale di prodotto è `legacy`: ogni novità vi passa per
  fattori che valgono 1 o 0, e il corpo resta quello di prima bit per bit. In `events` il carico è misurato e non rompe: l'unico percorso
  è `FractureGate.take` → `shatter` → `sever`, al passo che raggiunge il tempo audio dell'evento; direzione da quel tempo (`seedOf`).
- Adaptive Music Calibration (`docs/adaptive-calibration.md`): `experience/AdaptiveCalibration.ts`, per hop in `ExperienceEngine`, solo
  misure già esportate dal DSP (nessuna FFT, nessun PCM). Sta accanto al World Engine e non vi entra (Spectrum legge `WorldView`): con
  `enabled = false` mondo, stato ed eventi sono identici. Non è la calibrazione di sincronia (`app/calibration`), che non si tocca. La
  `significance` di un evento è relativa agli accenti recenti del brano, mai un livello. Uscite limitate, gain a passo limitato; reset
  completo solo a nuova sessione (`reset`), `interrupt` per una perdita di acquisizione. Le scene non ricalibrano: leggono lo snapshot.
- Tunnel (`docs/tunnel-motion.md`): la scena calcola i target dal mondo come sempre; `TunnelMotionCoordinator` decide quanto se ne vede.
  Nessun tempo proprio: follower esatti per un ingresso tenuto nel frame, età di eventi datati (`EventCursor`), fermo quando il mondo è
  fermo. Bassi, alti, luce e avanzamento non cedono mai. `balance: 0` è il Tunnel com'era e non chiama il coordinatore: `architecture`
  in `topology.ts` è la legge di `tunnelTopology`, cambiarle insieme. `tunnelLab` è solo DEV.
- Music response (`docs/music-response.md`): un solo predittore. L'anticipazione è la carica del mondo (`forces.charge`: evidenza di build ×
  confidenza → `potential`); `experience/Anticipation.ts` ne tiene solo il conto (aperta / confermata / scaduta), legge e non scrive nulla
  nel mondo, e le scene **non** ramificano sulla sua fase: leggono il potenziale come forza. I follower di chi viaggia nel mondo sono in
  `visualizers/shared/motion.ts` (`RateFollower`, `HysteresisGate`, `AccentGate`), esatti per un ingresso tenuto nel frame e fermi a riposo:
  Tunnel e Terrain ne sono fatti, ciò che cede a cosa resta di ciascuna scena. Il Tunnel è fissato bit per bit da
  `tunnel/preservation.test.ts` (digest registrati prima dell'estrazione): un cambio lì è un cambio di ciò che il Tunnel mostra, e va
  motivato nello stesso commit (`EUFORIA_TUNNEL_DIGEST=1` per registrarli). `EventStream.forEachHeard` regge un momento udito che arretra:
  non azzerare `cursor.low` a mano. Quando scatta un `drop` (`ExperienceEngine`) non si cambia senza musica reale: vedi §2.4–2.5.
- Generative Terrain (`docs/generative-terrain.md`): scena autonoma (`visualizers/terrain`, recipe di una primitiva), nessun legame con il
  Tunnel in nessuno dei due versi. Il suolo è un reticolo fisso: la mesh vi scorre di celle intere (`row`/`shift`, `col`/`shiftX`), il
  paesaggio è una funzione pura del punto e si ripete ogni `PERIOD` righe (ogni scala e ogni placca lo divide). `terrainHeight` è scritta in
  GLSL e in TS (`terrainLaw.ts`): cambiarle insieme. Ogni termine che il mondo aggiunge vale zero a riposo; nessun vertice è mosso da
  un'ampiezza audio; le placche sono traslazioni rigide; solo un rilascio cambia la configurazione. Il suolo: due draw call, nessun pass,
  nessuna texture. Tre scale (`TerrainResponse`): un colpo arriva al suolo localmente (fronti, placca di un accento, scintille), la massa e
  la superficie seguono il groove; `LEGACY_RESPONSE` è il moto di prima bit per bit (`terrain/response.test.ts`, digest registrati prima del
  cambio). Non è una fixture del rig Free. Portali e transizioni fra ambienti sono solo uno studio (`docs/world-transitions.md`): non
  implementarli senza autorizzazione, e mai con uno scene manager parallelo.
- Emersione dal terreno (`docs/scene-families.md`): uno slot dopo il suolo (`emergence`), assente se `emergence.enabled` è falso (allora la
  scena è il suolo e basta). Una struttura è ancorata a un punto del reticolo e legge il suolo con `terrainHeight` stessa e gli stessi
  uniform (`TerrainPrimitive.shared`): mai una copia delle altezze. `emergentPoint` è scritta in GLSL e in TS (`emergenceLaw.ts`): cambiarle
  insieme e ripetere `runTerrainParity()` (`terrainParity.ts`): base delle celle = vertici del suolo sulla GPU, solidi sotto il minimo dei nove
  punti attorno. Pezzi rigidi, funzione pura dell'età della frattura; pulsazione uniforme ≤ `PULSE_LIMIT`. Il ciclo di vita
  (`terrainEmergence.ts`) vive sul tempo della musica (fermo in silenzio), nasce dalle righe che entrano in vista (niente viaggio, niente
  nuove strutture), densità dallo stato lento della musica (mai il livello, mai un colpo); agisce solo sui cue musicali: frattura e burst solo
  su un `release` confermato, tramite `FractureGate`. Pool a capacità fissa (≤ 64), budget di formazione e di frattura; Low disegna solo i
  bordi con la stessa logica. La modalità "distacco di una regione del suolo" non esiste: non improvvisarla spostando vertici del suolo.
- Solidi fra le particelle (`visual-engine/primitives/solidSlot.ts`, laboratorio Emergence): un esperimento DEV, montato a runtime con
  `VisualWorld.add` e tolto con `remove`; nessuna recipe di prodotto lo contiene. I corpi sono di `SolidSystem` (un solo solver), la
  popolazione (`SolidPrimitive` con `population`) dice quali passi del ciclo usa; si rompono solo sui cue (default: solo `release`).
- Musical Cognition (`docs/musical-cognition.md`): `experience/cognition/`, per hop dentro `ExperienceEngine`, solo misure ed
  eventi già esportati dal DSP più l'evidenza di build dell'Experience (`CognitionContext`): niente FFT, niente PCM, niente secondo
  beat tracker (il clock estende la griglia del DSP, non la corregge). Non scrive nel mondo, nello stato Experience né
  nell'`EventStream` (con `config.enabled = false` tutto è come prima: test). Osservazioni, interpretazioni e previsioni restano
  distinte: le previsioni hanno finestra, confidenza, evidenza ed esito, mai retroattive; il rilascio è **udito**, mai confermato da
  un'aspettativa; il `drop` dell'Experience resta com'è e viene solo confrontato. Battute e frasi solo con evidenza, mai un 4/4
  presunto; inerzia del clock ≤ 2 battute / 4 s. La regia la segue solo quando `leads` (`followCognition`, finestra del planner),
  altrimenti percorso reattivo. Ring e pool a capacità fissa. `scenarios.ts` è un mock del DSP (test e laboratorio, DEV); il
  laboratorio non fissa né sovrascrive nulla; le override della cognizione passano da `controller.overrides`.
- Musical cues (`experience/MusicalCues.ts`, `docs/scene-families.md`): ciò su cui agiscono le azioni strutturali nuove
  (solidi che si formano, emergono, si rompono). Adattatore per hop in `ExperienceEngine`, solo eventi, cognizione e
  anticipazione già esistenti; non scrive nel mondo, nello stato né nell'`EventStream` (Tunnel invariato). Anticipazione
  (livello), previsione (`prepare` / `withdraw`), osservazione (`accent`, `phrase`), conferma (`release` = rilascio
  **udito**) restano distinte; l'esecuzione è il conto del consumatore. Il `drop` dell'Experience non è mai un cue da solo
  (abbinato a un rilascio udito ±0,5 s o contato non confermato). Un'azione che rompe o fa emergere in modo significativo
  legge solo `release` confermati; le previsioni preparano e si ritirano, mai confermano. Le scene leggono i cue dallo
  snapshot con `forEachCue` e un cursore.
- Engine Workspace (`docs/engine-workspace.md`): la vista decide cosa mostra l'inspector (`VIEW_SECTIONS` + `applySections` in
  `diagnostics/workspace/sections.ts`); un componente costruisce i blocchi e ne dichiara la sezione, non si mostra né si nasconde da sé, e
  nascondere non ferma campionamento né storici. Un solo ingresso alle viste (`EngineWorkspace.navigate`): entrare in Laboratories apre
  il laboratorio, nessuna vista lo termina o ne cambia le override. Il ciclo di vita è `Experiment` (open / stop / dispose). Le override
  temporanee che non sono di un laboratorio passano solo da `controller.overrides` (`OverrideLedger`) e `controller.isolate`: mai scrivere
  `worldLab.only`, `matterLab.form` o `tunnelLab.balance` altrove. Un cambio di configurazione apre un segmento (`ConfigurationSegment`,
  `diagnostics.segment`) e non azzera: reset solo per nuova sessione audio, avvio REC, cambio dello strumento (Detailed, profiling,
  readback) e `reset()` esplicito. Un solo timer a 5 Hz, nessun RAF o listener dei pannelli; REC e fine esperimento hanno un solo
  controllo, nella toolbar. Ripetere `scripts/workspace-browser.mjs acceptance` (e `release`) dopo ogni modifica.
- Generative Worlds (`docs/generative-worlds.md`): un mondo è una recipe con un `camera` suo (`WorldRecipe.camera`, `RigCamera`), mai un
  framework o un registry paralleli. I profili di locomozione (`render-systems/camera/locomotion.ts`: travel, glide, orbit, hover, drift)
  leggono solo `WorldView` (seguito esattamente su un frame, o somme dello spostamento del mondo) e il soggetto che la scena offre: nessun
  clock proprio, nessuna lettura di cattura, analisi o cognizione; a riposo fermi, uguali a ogni frame rate, limitati da `RigLimits`. Il
  Tunnel non usa il rig (il suo coordinatore resta) e il Terrain non ha camera: non migrarli senza prove di equivalenza. Monoliti, alberi e
  ogni cosa che sta su un suolo leggono `terrainHeight` stessa sugli uniform del suolo (`TerrainPrimitive.shared`). Le estensioni
  dell'emersione (`placement`, `forms`, `keep`, `focus`) e `TerrainMotion.pace` valgono zero/1 di default: il Terrain resta bit per bit.
  `oceanLaw` e `forestLaw` sono scritte in GLSL e in TS: cambiarle insieme e ripetere `runOceanParity()` / `runForestParity()`. Il tempo
  delle onde è l'integrale di quanto il mondo è vivo (fermo in silenzio); un rilascio cambia quanto conta un'onda, mai la sua direzione. La
  forma di un albero si fissa alla semina (tratti quantizzati) e non cambia; la memoria della foresta è una firma di sei tratti della
  geometria per albero, che risuona solo con `cues.repetition` (mai l'identità di un brano). Le azioni irreversibili (frattura, emersione
  importante, fioritura) leggono solo `release` confermati. I mondi nuovi non sono in `show/fixtures.ts` finché manca la prova con musica
  reale. Il soggetto Worlds del laboratorio Emergence è solo DEV.
- Resonant Forest (`docs/resonant-forest.md`): il refactor verso il mockup procede per fasi (A–E); la tavola è un riferimento, non il
  runtime. Un albero è geometria scritta una volta alla semina nella parte del suo slot (budget in vertici per qualità, **multipli di un
  triangolo e di una linea**); nessun vertice è mosso dal suono, la crescita scala ogni segmento dal suo inizio. Tre livelli di luce mai
  mescolati: base costante (silhouette in silenzio), emissione strutturale `emission` (E per fase, ferma a riposo), eventi. La foresta
  ha la sua palette (`forestLook.ts`), non quella dell'app. Cristalli e punte di radice sono parte della forma (una punta sta sul vertice del
  proprio punto del reticolo, `site`); il campo di cristalli sospesi è una funzione pura del seme sullo slot del suolo (`GROUND_SLOT`). La
  rete si forma quando un albero matura e non si ricollega; `linkGlsl` / `linkPoint` sono scritti in GLSL e in TS (parità). Gli impulsi
  partono solo da eventi uditi letti con un `EventCursor` (beat e downbeat evidenti, impact significativi, `release` confermato), datati sul
  loro tempo audio: funzione pura dell'età, cancellati a nuova sessione.
- Qualità DSP indipendente dalla GPU: può cambiare le cadenze lente e quella dell'analisi delle
  scene, non hop/beat. Le soglie (`DspBudget.ts` e `src-tauri/src/audio.rs`) sono le stesse nei due
  host: cambiarle insieme. Il wire e il WASM versionato devono corrispondere al backend:
  `wire::VERSION` va incrementata a ogni cambio di tag, record o layout (il frontend rifiuta un
  produttore di un'altra versione).
- Rendering: MSAA solo nello `ScenePass` del layer, pass successivi su target semplici; la
  composizione è un pass solo, a schermo. Un layer non pronto (`Layer.ready`) non viene disegnato.
  `QualityController` è l'unico osservatore del carico: `GpuBudget` legge da lì, e Auto non toglie
  pixel quando il limite è la CPU.
- La cattura nativa è condivisa: non sovrapporre stop/start o creare AudioEngine
  concorrenti. Preservare il reset della sessione e le verifiche dei token async.
- Riutilizzare oggetti/array nel frame loop. Non dividere algoritmi coerenti solo
  per ridurre le righe. Quando si aggiungono listener, timer o risorse, prevederne
  il rilascio nel lifecycle del proprietario.
- Verifica frontend: `npm run check`. Core Rust:
  `cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline`.
  `npm run bench` è già incluso nei test. Aggiungere regressioni per bug e
  cambi di comportamento; evitare test che ripetono soltanto la struttura.
- `audio/features/layout.ts` è generato: usare
  `UPDATE_LAYOUT=1 cargo test -p spectrum-analysis --test wire`.
  Se cambia il DSP, ricostruire e versionare anche il WASM con `npm run wasm`.
- Distinguere test unitari/mock, benchmark sintetici e prove GPU/cattura reali.
  Riportare esplicitamente i controlli non eseguibili e aggiornare README/scheda
  quando cambiano pipeline, comandi o contratti. Rispondere all’utente in italiano.
