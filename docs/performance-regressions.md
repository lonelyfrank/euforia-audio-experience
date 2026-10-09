# Performance refactor — verifiche di regressione

Che cosa è stato verificato dopo il refactor del 9 ottobre 2026, con quale tipo di prova, e che
cosa non è stato possibile verificare. Tre tipi di prova, da non confondere:

- **test** (unità e integrazione, con mock dove serve): `npm run check`, `cargo test`;
- **benchmark sintetici**: `src/bench`, l'esempio `scene_cost`;
- **prove reali**: Chromium headless sulla GPU della macchina, istanza desktop Tauri isolata con
  cattura nativa. Sono descritte in [performance-benchmarks](performance-benchmarks.md).

## Esito complessivo

| Suite | Baseline (`2a8dfde`) | Dopo |
|---|---|---|
| `cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline` | 59 test + 1 doctest | **66 test + 1 doctest**, tutti passati |
| `npm run check` | 58 file, 448 test (1 saltato) | **61 file, 495 test** (1 saltato), typecheck, lint e build passati |

Test esistenti modificati (tutti per un cambio di contratto voluto, nessuna soglia allentata):

| Test | Che cosa è cambiato | Perché |
|---|---|---|
| `AudioEngine.test.ts` (mock del provider) | `readSamples` → `readScene` / `setScene` | i provider non consegnano più PCM |
| `AnalysisHost.test.ts` | via l'uscita `pcm`; epoca, frame persi e sequenza letti dal record clock | lo stesso dato, ora sul wire per entrambi gli host |
| `NativeAudioCapture.test.ts` | record clock a 8 valori, `wireVersion` nella risposta | nuovo layout del record, wire versionato |
| `RenderEngine.test.ts` (mock) | il renderer finto ha `setRenderTarget`/`render`; il layer finto ha `ready` | la composizione non passa più da un `EffectComposer` |
| `ExperienceEngine.test.ts` (budget DSP) | 8 s invece di 5 per arrivare a qualità 2 | i primi 3 s non sono più evidenza di sovraccarico |
| `experience.bench.test.ts` | costruzione di `RecordStage`, via l'uscita `pcm` | come sopra; la soglia di carico (< 0,5) non è stata toccata |
| `lifecycle.test.ts` (mock dell'app) | aggiunto `load` | la diagnostica legge il limite del frame rate |

## Audio

| Che cosa | Prova | Esito |
|---|---|---|
| **Equivalenza dell'analisi grafica** Rust ↔ `AudioAnalyzer` TypeScript | `SceneAnalysis.test.ts`: per 7 segnali (groove, pop sintetico, build/drop, serie armonica, rumore bianco, start/stop, fade e taglio), a 44,1 e 48 kHz, mono e stereo, con sensibilità/smoothing/cadenza diversi, ogni record scene è confrontato con l'analizzatore di riferimento sulla stessa finestra | spettro, forma d'onda, forme delle voci, altezze, chiarezza, `beat`, `silent`, BPM: **identici**. Livelli e dB: differenza massima misurata 2,8 × 10⁻¹⁴ (ultima cifra di `exp`/`log10`/`pow` fra la libreria del motore JS e quella di Rust). Tolleranza del test: 10⁻⁹ |
| Spettri, bande, inviluppi, transienti, voci | lo stesso test, campo per campo | come sopra |
| Feature musicali per hop (invariate) | i test Rust esistenti (acoustic, beats, features, harmony, hpss, rhythm, structure) | passati senza modifiche di sostanza (solo il nuovo ramo `Event::Scene` nei `match`) |
| Beat, onset, downbeat, sezioni | `beats.rs`, `rhythm.rs`, `structure.rs`, `WasmAnalysis.test.ts` | passati |
| Cadenza e clock dell'analisi scene | `tests/scene.rs`: ≈ 60/s a 22–96 kHz, sui confini di hop, ogni record subito dopo il frame del suo hop; indipendenza dal batching (stessi frame con chunk da 480, 77 o tutto insieme) | passati |
| Qualità DSP e scene | `tests/scene.rs`: 3 → 4 → 6 hop, l'analisi musicale resta a ogni hop | passato |
| Riavvio dell'analisi | `tests/scene.rs`: il clock riparte, le gamme adattive dell'immagine no | passato |
| Wire | `tests/wire.rs`: layout generato allineato, record etichettati e dimensionati, un record scene ogni 3 hop | passato |
| Ordine e completezza con decodifica limitata | `RecordStage.test.ts`: 40 hop arretrati con onset intercalati escono in 12 + 12 + 12 + 4, nello stesso ordine | passato |
| Reset di sessione, epoca | `RecordStage.test.ts` (nulla della vecchia epoca raggiunge i consumatori), `AudioEngine.test.ts` (nuova epoca → riavvio di clock, decoder, Experience) | passati |
| Cattura nativa e worker: stesso contratto | `NativeAudioCapture.test.ts`, `AnalysisHost.test.ts`; prova reale: 187,5–187,7 hop al secondo decodificati in entrambi i percorsi, 0 batch mancanti, 0 record scartati | passati |
| Versione del wire | `NativeAudioCapture.test.ts`: backend di un'altra versione rifiutato e cattura rilasciata | passato |
| Ritardo audio, beat mostrato una volta | `SceneFeed.test.ts` | passato |

Non verificato: equivalenza su **registrazioni reali** (non ce ne sono nel repository e non ne sono
state introdotte); equivalenza nel motore JavaScriptCore (il test gira in V8/Node: in WebKit le
differenze dell'ultima cifra possono essere altre, sempre dell'ordine di 10⁻¹⁴).

## Clock

| Che cosa | Prova | Esito |
|---|---|---|
| Nessuno scatto con jitter di consegna (coda esponenziale di 6 ms, fino a decine di ms) | `timing.test.ts` | passo massimo dell'offset < 0,05 ms per messaggio, escursione < 1,5 ms in un minuto |
| Tempo mappato monotono con deriva di 300 ppm | `timing.test.ts` | nessun passo indietro in 2 minuti; errore finale < 6 ms |
| Un messaggio per frame di scena invece che per callback | `timing.test.ts` | stessa stabilità |
| Discontinuità reale (host sospeso 3 s) | `timing.test.ts` | un solo riavvio della stima, poi mappa corretta |
| Timestamp del frame propagato | `AudioEngine.test.ts`, `RenderEngine.test.ts` | passati |
| Prova reale | serie S e Y | vedi benchmark: escursione dell'offset da 13–38 ms a < 0,2 ms nel nativo |

## Experience

| Che cosa | Prova | Esito |
|---|---|---|
| Risultato identico rispetto al batching audio e al frame rate (30/60/144) | `experience.bench.test.ts` (esistente) | passato |
| Planner, Memory, fisica, mondo | test esistenti (`experience/`, `world/`, `physics/`) | passati senza modifiche |
| Recupero da stallo | `RecordStage.test.ts`; `AudioEngine.test.ts` (budget: 13 hop per frame a 60 fps, di più a frame lunghi) | passati |
| Causalità | invariata: la decodifica limitata non riordina (test sopra) | — |

## Rendering

| Che cosa | Prova | Esito |
|---|---|---|
| Tutte le 11 scene montate e disegnate a High | serie Y (Chromium, GPU reale): nessun errore di shader o di console, contatori di draw call invariati (±1 per il pass di uscita tolto) | passato |
| Resa | confronto a occhio di fotogrammi di Tunnel, Spectrum e Matter Field a High, prima e dopo, stesso segnale | stessa struttura, stessi colori e luminosità, bordi antialiasati come prima. **Non** è un confronto pixel per pixel (i due motori non mostrano lo stesso istante) |
| Cambio scena | `RenderEngine.test.ts`: la scena uscente resta finché l'entrante non è pronta; una scena sostituita prima di essere mostrata viene rilasciata senza perdere quella a schermo | passati |
| Crossfade | `RenderEngine.test.ts`: 0,9 s di tempo reale a 144, 60, 20 e 12 fps | passato |
| Rilascio delle risorse | test esistente (tutti i layer rilasciati); serie Y: geometrie, texture e programmi tornano ai valori della scena dopo 8 cambi | passato |
| Qualità Auto | `quality.test.ts`: discesa indipendente dalla densità, recupero dopo headroom e cooldown (esistente); nessuna discesa se il limite è la CPU; nessuna decisione in transizione; recuperi falliti sempre più distanti | passati |
| Passo di tempo | `RenderEngine.test.ts`: uno stallo di 1 s diventa un passo di 80 ms | passato |

Non verificato:

- **golden frame**: non esiste nel progetto un'infrastruttura di fotogrammi di riferimento, e le
  scene non sono deterministiche fra due processi (tempo reale, sorgente con clock proprio). Che i
  pass multicampionati fossero ridondanti è un argomento (documentato in `ScenePass.ts`), più il
  confronto a occhio;
- **resize e schermo intero** sul desktop; **1080p**;
- **Qualità Auto e regia multi-scena in esecuzione reale** dopo le modifiche (solo test);
- la resa **agli occhi dell'utente con musica reale**: è la verifica che manca di più.

## Regressioni note e comportamenti cambiati

Nessuna regressione di correttezza trovata. Comportamenti che sono cambiati di proposito:

1. **Cadenza dell'analisi grafica.** Prima seguiva il frame rate (una per frame, anche a 144 Hz o a
   20 fps); ora è ≈ 60 al secondo sul clock di cattura. Su un display a 120/144 Hz l'`AudioFrame`
   si aggiorna ogni due frame circa. Le sue costanti di tempo sono in secondi, quindi i valori sono
   gli stessi; cambia quante volte al secondo vengono rinfrescati. Il backend accetta una cadenza
   diversa (`every`), che il frontend oggi non imposta.
2. **Carico del thread di analisi.** L'analisi grafica costa ora a quel thread (nativo: +3–5 % di
   un core a 2–3 GHz; WASM: +5–6 %) invece che al main thread (−17 % di un core a 60 fps). Le
   soglie della qualità DSP sono state alzate di conseguenza (40 % / 20 % invece di 30 % / 12 %).
3. **Latenza degli hop senza eventi nel nativo**: fino a un batch di cattura in più (≈ 10 ms) per
   gli hop che non portano eventi né un record scene. Onset, beat e sezioni partono subito.
4. **Recupero dopo uno stallo**: distribuito su più frame; per qualche decimo di secondo lo snapshot
   dell'Experience è più vecchio di prima (il mondo viene estrapolato più a lungo). Uno stallo
   oltre 0,5 s rende `ready = false` per qualche frame in più.
5. **Passo massimo delle scene**: 80 ms invece di 50. Sotto i 20 fps le scene non rallentano più
   rispetto alla musica; gli integratori vedono passi fino a 80 ms (era già il limite previsto dalle
   simulazioni di materia).
6. **Qualità Auto**: non scende più quando il limite è la CPU, e non decide durante i crossfade.
   Su una macchina il cui frame rate è basso per colpa del main thread resta al profilo scelto.
7. **Soglie del budget DSP**: i primi 3 s non contano.
8. **Diagnostica**: caricabile in produzione su richiesta (Ctrl+Alt+Shift+D). Prima era esclusa
   dal bundle; ora è un chunk separato che non viene scaricato né eseguito finché non lo si chiede.
9. **Build di sviluppo su Linux**: `pulseaudio`, `cpal` e `audio-capture` sono compilati ottimizzati
   (prima compilazione più lunga; cambio sorgente in 0,2 s invece di minuti).

## Interventi rinviati

| Intervento | Perché rinviato |
|---|---|
| Sospendere i layer a peso zero (A-12) | nessuna misura possibile qui (la regia non monta mai un secondo fixture su questa macchina); richiede di definire come riprende una simulazione persistente |
| Togliere le allocazioni residue (`Object.assign` degli snapshot, `read` del decoder: A-11) | dimezzate dal resto del lavoro (≈ 65 → 26 kB per frame); il resto chiede di cambiare forma agli snapshot |
| Limite alla coda dei canali di Tauri, gestione della visibilità (H-03, L-06) | non osservati; la ripresa da finestra nascosta è ora limitata dal budget di decodifica ma non è stata provata |
| Condivisione della FFT fra musica e scene | romperebbe l'equivalenza numerica per ≈ 20 µs a frame |
| Cadenza delle scene scelta dal frame rate del display | serve una prova su display a 120/144 Hz |
| Bloom più economico, MSAA ×2, target a 8 bit | cambiano la resa: servono gli occhi dell'utente (dati in benchmark) |
| Experience in un contesto separato | costerebbe più di quanto toglie (vedi architettura) |
| WebGPU | nessun dato che lo giustifichi dopo questo lavoro; WebGL2 resta il percorso |
