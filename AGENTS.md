# Lavorare su Euforia-Audio-Experience

- Iniziare da `README.md` (fonte di verità), poi `docs/technical-overview.md`
  (mappa dei moduli, invarianti, audit e backlog). `docs/experience-engine.md`
  conserva decisioni e misure del motore musicale. `docs/realtime-analysis.md`
  (thread, clock, stati, eventi, confidence, benchmark), `docs/refactor-report.md`,
  `docs/acoustic-model.md`, `docs/experience-planner.md`, `docs/physics-engine.md`,
  `docs/world-engine.md`, `docs/visual-systems.md`, `docs/matter-engine.md`, `docs/visual-engine.md`,
  `docs/visual-grammar.md`, `docs/physical-scenes.md`, `docs/spectral-shell.md`, `docs/structural-dynamics.md` e `docs/solid-dynamics.md` descrivono il nuovo percorso. Gli audit precedenti sono storici.
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
  un vertice. `solidLab`, il laboratorio (fuori dal registry) e `SolidCockpit` sono solo DEV; nessun solido nelle scene del prodotto.
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
