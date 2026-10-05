# Lavorare su Halo

- Iniziare da `README.md` (fonte di verità), poi `docs/technical-overview.md`
  (mappa dei moduli, invarianti, audit e backlog). `docs/experience-engine.md`
  conserva decisioni e misure del motore musicale. `docs/realtime-analysis.md`
  (thread, clock, stati, eventi, confidence, benchmark), `docs/refactor-report.md`,
  `docs/acoustic-model.md`, `docs/experience-planner.md` e `docs/physics-engine.md`
  descrivono il nuovo percorso. Gli audit precedenti sono storici.
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
