# Engine Diagnostics 1.0 — audit iniziale (8 ottobre 2026)

Audit eseguito prima di modificare il codice applicativo, su checkout pulito.
README e technical-overview restano i riferimenti dei contratti.

| Produttore / strumento | Dati esistenti | Decisione |
|---|---|---|
| Rust `native/analysis`, wrapper WASM, layout generato | 343 valori per hop, spettro ERB, H/P/R, loudness, parziali, stereo, tempo, confidence | leggere il decoder, nessuna FFT o modifica DSP |
| AudioEngine / BrowserAnalysis | sessione, clock, hop decodificati, backlog PCM, perdite, staging, DSP load, trasporto | probe di sola lettura; nativo senza RealtimeStats resta indisponibile |
| Timing / ClockSync | tempo udito, presentazione host, offset stimato, compensazione, render latency stimata | domini separati; nessuna promessa sulla latenza fisica |
| ExperienceEngine / EventStream | snapshot udito, narrativa, planner, intenti, morfologia, fisica, eventi datati e ordinati | EventCursor diagnostico separato; correlazione temporale, non causalità inventata |
| WorldState / WorldTrace | corpi, forze, campi, energia fenomenologica; ring CSV | riusare WorldTrace con acquisizione esplicita |
| VisualWorld / recipe / worldLab | geometria, campi, presenze, budget, elementi, vertici | registro delle primitive derivato da mounted; isolamento DEV già esistente |
| MatterPrimitive / FieldTracerPrimitive | conteggi, substep, CPU submit (materia), texture ping-pong | estendere solo osservazione; readback separato e limitato |
| StructuralSystem / cockpit | legami, fratture, ordine, temperatura, costi CPU, risorse limitate | riusare statistiche e mantenere laboratorio strutturale |
| DebugOverlay | audio, spettro, eventi, matter, traccia 20 Hz | conservare vista; spostare acquisizione e contatori nel coordinatore |
| EngineCockpit | strutture, risonanza, ambiente, contatori renderer | stesso coordinatore per contatori; collegamento ai nuovi domini |
| Three renderer.info / QualityController / GpuBudget | draw calls, primitive disegnate, risorse; FPS e budget adattivo | raccogliere a confine del vero frame, senza cambiare decisioni qualità |
| runParity / runTracerParity, probe CPU | semi fissi, errori medi/massimi, non finiti, full/half float | comandi laboratorio espliciti, report estesi; nessuna esecuzione continua |
| validation/replay.ts / replay.test.ts | PCM locale → WASM → Experience → WorldTrace; corpus WAV locale | estendere questo percorso con report e scenari SignalGenerator |
| src/bench e test moduli | benchmark sintetici, invarianti e mock GPU | check frontend completo, Rust core; distinguere prove browser reali |

## Divergenze e limiti iniziali

- Overlay e cockpit impostano entrambi `renderer.info.autoReset` e azzerano i contatori in RAF propri: conflitto quando coesistono e confine di misura ambiguo.
- L'installazione dell'overlay registra WorldTrace continuamente anche a UI chiusa: non soddisfa Diagnostics OFF. La traccia non controlla esplicitamente la sessione.
- Replay ha già una griglia comune a 1/6 s per 30/60/144 FPS, ma manca una comparazione strutturata con metadati e report Markdown.
- La cattura nativa non espone sul frontend tutte le statistiche del backend. Canali fisici e buffer hardware non vanno dedotti dal downmix mono grafico.
- DSP load è una media di lavoro/tempo audio, non il tempo del singolo batch. `dspAge` comprende attesa ed elaborazione; non è CPU DSP.
- Energia del mondo approssimata, in unità visuali, senza bilancio conservativo input/dissipazione misurato.
- Vertici inviati non equivalgono a particelle visibili dopo discard nello shader. Memoria GPU completa non disponibile da renderer.info.
- Timer query GPU assenti. Readback esistente completo e sincrono: ammesso solo in laboratorio; serve campione esplicito limitato.
- Parità originaria non produce RMS, seme nel report né esito con precisione distinta. Validazione half-float richiede hardware appropriato.
- Le associazioni evento → planner → geometria possono documentare lo stato osservato, non dimostrare una causa unica.

## Piano

1. Core tipizzato, buffer limitati, validità/null, sessioni, statistiche e report locali.
2. Hook DEV al confine del renderer; controller condiviso da dashboard, overlay e cockpit.
3. Probe dei produttori reali; campionamento indipendente dalla UI; readback e query GPU opt-in.
4. Dashboard DEV, timeline, freeze/acquisizione/registrazione distinti, isolamento e parità.
5. Estensione replay e confronto compatibilità; regressioni, benchmark, documentazione dei limiti.

## Stato Git osservato

Il checkout fornito è `spectral-matter`, commit `9fac87a` (Structural Dynamics),
un commit avanti a `main` (`d617de9`). Il cockpit richiesto dipende da quel commit;
non va eliminato per retrocedere alla vecchia base. Le modifiche Diagnostics sono
state preparate su questa base preservata. Nessun commit o push è necessario per
la verifica locale.

Al completamento, `main` è stato avanzato a `9fac87a` e selezionato come checkout.
Le modifiche Diagnostics restano non committate; non è stato eseguito alcun push.
