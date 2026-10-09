# Validazione Engine Diagnostics 1.0

## Procedura riproducibile

```
npm run check
cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline
npx vitest run src/diagnostics/tests
npx vitest run src/bench/diagnostics.bench.test.ts
npm run dev
```

Per confronti a rumore ridotto, chiudere altri processi di benchmark e usare
`npx vitest run --maxWorkers=1`; non allentare le soglie temporali della suite.
Aprire `?diagnostics`, avviare REC dopo il warm-up, fissare qualità e risoluzione,
scegliere lo stesso segnale e seed. Prima Basic, poi Detailed; GPU/readback spenti
per la baseline. Salvare i JSON; riportare durata, hardware, variabilità e configurazione.
La soglia ±5% del comparison engine è descrittiva, non statistica.

## Regressioni automatizzate introdotte

- Registry: zero, null, NaN/Infinity, timestamp invalido, overflow, contratto cambiato.
- Store: wrap, ordinamento, metriche aggiunte dopo l'inizio, copie indipendenti, reset.
- Collector: cadenza, clock retrogrado, eccezioni isolate, reset e dispose.
- Statistiche: media e quantili nearest-rank su finestra limitata.
- Export JSON/CSV/Markdown: righe vuote, valori mancanti, escaping, metadati.
- Comparison: delta assoluto/relativo, condizioni incompatibili, valori fisici senza
  etichette arbitrarie di miglioramento, configurazione mista.
- Snapshot: nessuna mutazione degli array o degli intenti osservati.
- Materia: dispersione, velocità, cinetica convenzionale e campioni invalidi.
- GPU query (mock): massimo quattro in volo, disponibilità, disjoint, cleanup.
- Lifecycle (mock): OFF senza store, lease condivise, ripristino autoReset,
  pausa acquisizione, cambio sessione, mount/unmount ripetuti; un frame interrotto
  da un'eccezione non lascia `autoReset` spento né una query GPU aperta.
- Gruppi di metriche: slot risolti una volta per registro, valori ed etichette
  riletti a ogni campione, vettori non più letti (Basic dopo Detailed) indisponibili.
- Replay reale WASM: OFF e ON hanno identici report comportamentali, WorldTrace e
  griglia del mondo. 30/60/144 FPS e batch 256/480/2048 sulla stessa griglia audio
  a 1/6 s: tolleranza assoluta 1e-8 (confronto numerico f64 dello stesso integratore).
- Dieci segnali: silenzio, tono, impulso singolo, impulsi, sweep, rumore, build/drop,
  taglio improvviso, frasi alternate, stereo variabile. Il generatore ha seed 1.

## Verifica browser su GPU reale

Chromium 1243 di Playwright, Linux, ANGLE → Mesa Intel UHD Graphics CML GT2,
viewport 1400×900. Script locale `/tmp/euforia-diagnostics-browser.mjs`
(artefatto temporaneo, non dipendenza del progetto).

Provati: dashboard con sorgente sintetica in worker; REC; freeze mentre gli hop
continuano; isolamento surface da recipe Matter Field (presenza 1, altri slot 0);
readback opt-in; apertura/chiusura overlay; tre cicli dashboard; a fine chiusura
observer null e autoReset true. Nessun errore JS/GLSL/WebGL osservato.
Screenshot `/tmp/euforia-diagnostics-dashboard.png`.

Parità eseguite davvero sulla GPU (1024 elementi, detail=true):

| Harness | Passi | Media | Massimo | RMS | Non finiti | Esito |
|---|---:|---:|---:|---:|---:|---|
| Matter, seed 20261007 | 240 | 2,42599e-5 | 1,14603e-4 | 3,14921e-5 | 0 | pass |
| Tracer, seed 20261008 | 120 | 1,06554e-5 | 1,45947e-4 | 1,44741e-5 | 0 | pass |

Entrambe full-float; tolleranza massimo 1e-3 in unità visuali, coerente con gli
harness precedenti. Nessuna tolleranza full-float viene applicata a half-float:
report `unvalidated-half-float`, soglia null. Il reader completo di laboratorio ora
converte i texel half con DataUtils; questo fallback non è validato su hardware half.

## Limiti

Non provati: cattura microfono/system reale, desktop Tauri, riconnessione fisica,
corpus musicale locale (non fornito), GPU half-float, calibrazione della latenza
fisicamente udita, completezza memoria GPU, topologia visibile nelle scene legacy.
`pkg-config --exists webkit2gtk-4.1 alsa` ora riesce: non si ripete la vecchia
asserzione di dipendenze assenti. Questo non equivale a una prova desktop.

I target OFF <1%, Basic <3%, Detailed <5% non sono dichiarati raggiunti. Il
microbenchmark misura il costo CPU sintetico di raccolta/aggregazione/copia e i byte
dei buffer, non include DOM, cattura reale o GPU. Le misure live richiedono una
macchina scarica, input identico, qualità fissa e round alternati.

## Seconda prova browser — 9 ottobre 2026

Provati anche download e parsing del JSON effettivo: 248 elementi letti dal prefisso
Matter Field, zero non finiti; query GPU disponibili e completate (tre osservazioni
36,49 / 41,00 / 43,42 ms; **non una baseline prestazionale**). Replay `silence` in
worker completato, report con 108 punti comuni; successivo cambio sorgente a
`tone400`, nuova sessione e categoria corretta nel report. Dispose di App riuscito;
nessun errore JavaScript o WebGL. Artefatti locali: `/tmp/euforia-diagnostics-browser-report.log`
e `/tmp/euforia-diagnostics-report-example.json` (nessun PCM).

Verificata inoltre l'assenza dei marker della dashboard, del controller e del replay
worker nei JavaScript di `dist`: il percorso Diagnostics è escluso dalla build
produttiva. Questa verifica riguarda la build, non una prova Tauri in produzione.

## Esito dei controlli dopo l'intervento sul pannello — 9 ottobre 2026

`npm run check` a macchina carica: typecheck ed ESLint riusciti, **443 test passati,
5 falliti, 1 saltato** — quattro timeout (VisualWorld, VectorField, AnalysisHost,
MusicContext) e il limite DSP del benchmark Experience (load 0,65 contro <0,5), lo
stesso gruppo sensibile al carico descritto sotto. Rieseguiti in serie
(`--maxWorkers=1`): **49 test su 49 passati**. Nessuna soglia o timeout modificata.
`npm run build` riuscito; nessun marker della diagnostica in `dist`; `git diff --check`
pulito. Due test aggiunti (slot dei gruppi, frame interrotto): 449 in totale.
Nessuna modifica a Rust, wire o WASM: i test del core Rust non sono stati rieseguiti.

## Esito finale dei controlli (prima dell'intervento sul pannello)

9 ottobre 2026: **`npm run check` riuscito**, typecheck, ESLint, **446 test passati
in 58 file, 1 saltato** (corpus locale non fornito), build produttiva riuscita.
Aggiunti 24 test rispetto alla base: 9 core, 3 lifecycle, 11 replay/scenari, 1 benchmark.
`cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline`: **59 test +
1 doctest passati** durante l'intervento; nessuna modifica successiva a Rust/wire/WASM.
`git diff --check` pulito.

I tentativi precedenti, sotto carico variabile, hanno fallito timeout preesistenti
(MusicContext, VisualWorld, VectorField, Forms, AnalysisHost, SpectralMatter) e il
limite DSP del benchmark Experience (load a 96 kHz 0,73–1,04 contro <0,5).
Anche un tentativo seriale è fallito sotto quel carico. **Nessuna soglia o timeout
è stata aumentata**: l'ultima esecuzione completa è riuscita in 135,83 s.
Questa variabilità è il motivo per cui non si attribuisce una percentuale di overhead
live alle nuove funzionalità senza un esperimento controllato.

### Microbenchmark della raccolta

Fedora 44, Intel i7-10510U, Node 22.23.1. Stesso snapshot sintetico, 100 chiamate
warm-up + 500 misurate, ring da 120 campioni. Misura `collectSnapshot` e copia nel
ring; **esclude probe audio live, renderer, UI, GPU ed export**. Non è un A/B del
motore, né un test della memoria totale del processo.

| Modalità | Metriche | Media ms | p95 ms | p99 ms | Buffer numerici |
|---|---:|---:|---:|---:|---:|
| Basic | 168 | 0,1960 | 0,2665 | 0,4779 | 4.178.880 byte |
| Detailed | 296 | 0,2812 | 0,5937 | 0,7395 | 4.178.880 byte |
| Basic, slot dei gruppi risolti una volta | 168 | 0,1561 | 0,3793 | 0,6880 | 4.178.880 byte |
| Detailed, slot dei gruppi risolti una volta | 296 | 0,1184 | 0,2917 | 0,4439 | 4.178.880 byte |

Le ultime due righe sono una misura successiva (`--maxWorkers=1`, stessa macchina,
carico diverso): l'ordine di grandezza è confrontabile, i percentili no.

Riprodurre e salvare il risultato (locale, nessun PCM):

```
EUFORIA_DIAGNOSTICS_BENCH_REPORT=/tmp/euforia-diagnostics-benchmark.json \
  npx vitest run src/bench/diagnostics.bench.test.ts --maxWorkers=1 --reporter=verbose
```

L'esportazione del risultato è esplicita; normalmente il benchmark scrive solo
le statistiche in console. Le misure precedenti possono variare con governor,
processi concorrenti e warm-up del runtime.

## Costo del pannello sul frame — 9 ottobre 2026

Segnalazione: micro scatti durante la visualizzazione. Misura in Chromium 1243
headless sulla GPU reale (ANGLE → Mesa Intel UHD CML GT2), 1280×720, qualità Low
fissa (a High la GPU di questa macchina è già oltre il frame e nasconde gli scatti
della CPU), segnale `synthPop`, scena Tunnel, 12 s dopo 8 s di warm-up, vsync attivo.
Intervalli RAF, long task (`PerformanceObserver`) e tempi di layout del browser
(`Performance.getMetrics` via CDP). HEAD (`9fac87a`) servito da un worktree separato
per l'A/B. Il carico della macchina è cambiato durante la sessione (applicazione
Tauri dell'utente in esecuzione, load 6–11): ogni riga va letta contro il controllo
«chiusa» **dello stesso giro**, non contro gli altri giri.

| Giro | Configurazione | Media | >25 ms | >33 ms | >50 ms | Long task (max) | Layout in 12 s |
|---|---|---:|---:|---:|---:|---:|---:|
| Prima, carico | HEAD | 17,2 ms | 22 | 0 | 0 | 0 | 0 ms |
| | working tree, diagnostica chiusa | 17,2 ms | 23 | 0 | 0 | 0 | 0 ms |
| | pannello Basic | 20,8 ms | 110 | 25 | 7 | 3 (81 ms) | 754 ms |
| | pannello Detailed | 25,7–28,1 ms | 90–159 | 55–60 | 31–58 | 42–56 (101 ms) | 1676 ms |
| Dopo, carico | diagnostica chiusa | 20,8–20,9 ms | 145 | 0–1 | 0 | 0 | 0 ms |
| | pannello Basic | 22,1 ms | 177–179 | 0–2 | 0 | 0 | 264–282 ms |
| | pannello Detailed | 22,4–22,7 ms | 183–187 | 1–6 | 0–1 | 0–2 (65 ms) | 258–386 ms |
| Dopo, macchina più libera | HEAD | 16,6 ms | 0 | 0 | 0 | 0 | 0 ms |
| | working tree, diagnostica chiusa | 16,6 ms | 0 | 0 | 0 | 0 | 0 ms |
| | pannello Basic | 16,7 ms | 1–3 | 0 | 0 | 0 | 59–62 ms |
| | pannello Detailed | 16,6 ms | 0 | 0 | 0 | 0 | 62–68 ms |

Layout e conteggi «Detailed, prima» vengono da due giri distinti; le colonne non
misurate nello stesso giro non sono state ricostruite. Due giri alternati per le
righe «dopo».

A diagnostica chiusa il working tree non si distingue da HEAD in nessun giro:
l'observer del renderer è `null` e nessun codice diagnostico gira nel frame. Gli
scatti venivano dal pannello aperto: ogni 200 ms ricostruiva l'intera tabella del
dominio (profilo CPU: 1195 ms in `refresh` su 15,8 s, di cui 556 ms in `fillText`
della didascalia) e la tabella ad auto-layout ricalcolava tutte le righe, anche fuori
vista, a ogni cifra cambiata. Dopo: `refresh` 147 ms su 15,8 s in Detailed; su 367
righe audio ne vengono scritte circa 20. Il cockpit (Shift+E) resta a 16,7–16,8 ms.
L'overlay (Shift+D) costa di suo, come su HEAD: disegna un canvas a ogni frame
(21–23 ms di media nel giro in cui la scena sola ne fa 16,6); non è stato toccato.

Non misurato: WebView desktop (WebKitGTK/WebView2), dove layout e compositing
differiscono. Osservato ma fuori dall'intervento: `VoiceTracker.findPeriod` è la voce
JS più pesante del main thread (15–17% del profilo; analisi grafica delle voci che
Spectrum legge, non toccata); nel processo Tauri in esecuzione su Linux un thread
figlio della cattura PulseAudio occupava ~96% di un core senza mai sospendersi
(1 context switch volontario): causa non accertata, percorso solo Linux.

## Conservazione e ciclo successivo

Diff senza modifiche a `src/ui/`, Spectrum, DSP Rust, wire, WASM, ExperienceEngine,
WorldEngine, ResonantPhysics e testi GLSL delle leggi. App cambia solo l'entry point
DEV; renderer aggiunge punti di osservazione; simulazioni aggiungono letture e
conversione half-float per il laboratorio, non nuovi passi fisici. Preset, palette,
regole Auto/Manual, menu e pulsante centrale restano nei moduli originali.
L'invarianza del replay copre report, eventi riassunti, WorldTrace (inclusi intenti)
e stato del mondo; le parità coprono i risultati delle simulazioni nei rispettivi
harness, non ogni possibile ingresso musicale o dispositivo.

Prossimo ciclo: corpus locale vario, misure A/B alternate a qualità/risoluzione
fisse, cattura reale con riconnessioni, WebView desktop, half-float e calibrazione
esterna. Usare la diagnostica per misurare prima di modificare le leggi.
