# Lavorare su Euforia-Audio-Experience

- Iniziare da `README.md` (fonte di verità), poi `docs/technical-overview.md`
  (mappa dei moduli, invarianti, audit e backlog). `docs/experience-engine.md`
  conserva decisioni e misure del motore musicale. `docs/realtime-analysis.md`
  (thread, clock, stati, eventi, confidence, benchmark), `docs/refactor-report.md`,
  `docs/acoustic-model.md`, `docs/experience-planner.md`, `docs/physics-engine.md`,
  `docs/world-engine.md`, `docs/visual-systems.md`, `docs/matter-engine.md`, `docs/visual-engine.md`,
  `docs/visual-grammar.md`, `docs/physical-scenes.md` e `docs/spectral-shell.md` descrivono il nuovo percorso. Gli audit precedenti sono storici.
- Il progetto usa audio live: system, microphone, fake. Non c’è supporto file.
- Frontend: TypeScript strict, DOM vanilla, Three.js; desktop: Tauri 2 / Rust.
  La macchina di sviluppo può avviare il browser su porta 1420 anche senza
  dipendenze native. Ricontrollare `pkg-config --exists webkit2gtk-4.1 alsa`
  prima di tentare il desktop; non assumere che una vecchia verifica sia attuale.
- Analisi grafica TS e analisi musicale Rust/WASM sono due contratti distinti.
  Nel browser il WASM gira in `analysis.worker.ts`: non riportarlo sul frame loop.
  Ogni sorgente consegna i record con `readFeatures()`; il ring PCM del worklet
  (`PcmRing.ts`) e `tap.worklet.js` condividono un layout da tenere allineato.
  Le scene consumano gli array del produttore senza modificarli né fare FFT.
- DSP fisico/percettivo in Rust; mai ricomputare le nuove misure in TS o nelle scene.
  Conservare ogni frame hop nel wire: il folding per batch rompe la memoria causale.
- Tenere UI in App/menus; memoria/narrativa in ExperienceEngine, intenti in
  ExperiencePlanner, scene in ShowDirector, traduzione in VisualDirector,
  collegamento/Timing in RigController, risorse GPU in Layer.
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
- Qualità DSP indipendente dalla GPU: può cambiare le cadenze lente, non hop/beat.
  Il wire e il WASM versionato devono corrispondere al backend.
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
