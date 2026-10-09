# Performance refactor — benchmark prima/dopo

Misure del 9 ottobre 2026, fra le 18:50 e le 20:35. «Prima» è il commit `2a8dfde` (quello
dell'audit); «dopo» è lo stesso con le modifiche descritte in
[performance-architecture](performance-architecture.md). Condizioni, strumenti e limiti sono in
[performance-refactor-baseline](performance-refactor-baseline.md).

Tre avvertenze valgono per ogni tabella:

1. **La macchina non era libera.** L'applicazione dell'utente (build di sviluppo) è rimasta in
   esecuzione, e il suo carico è cambiato durante la sessione. Per questo ogni confronto è fatto
   **uno dopo l'altro** nella stessa serie; valori di serie diverse non vanno confrontati fra loro.
2. **Limite di potenza a 17 W**, non la piena frequenza: i millisecondi sono di questa macchina in
   questo stato. Le proporzioni sono più trasferibili dei valori assoluti.
3. **Una o due ripetizioni per configurazione**, 12–30 s ciascuna: i percentili alti sono ordini di
   grandezza. Nessuna build di release, niente Windows.

## Sintesi

Configurazione dell'utente (Tunnel, High, cattura nativa; sorgente «system» al posto del
microfono, vedi baseline), istanza desktop isolata, 1280×673:

| | Prima | Dopo |
|---|---:|---:|
| Fotogrammi al secondo | 34,6 | **58,7** |
| Frame time p95 / p99 | 48 / 70 ms | **21 / 32 ms** |
| Frame oltre 33 ms (in 30 s) | 247 | **11** |
| CPU del frame sul main thread | 9,0 ms | **2,9 ms** |
| di cui analisi grafica | 3,6 ms | 0 |
| Messaggi IPC al secondo | 178 | **64** |
| Errore del clock udito per frame (RMS / p99) | 1,30 / 4,79 ms | **0,49 / 1,06 ms** |
| Scatti dell'offset dei clock | 26 in 30 s, 1,85 ms in media | nessuno (scorre a passi di 0,04 ms) |
| Hop decodificati in un frame, massimo | 65 | 18 |
| Ritardo cattura → frame che conosce un attacco | 0,151 s | **0,044 s** |
| Cambio sorgente (build di sviluppo, Linux) | minuti (audit, A-06) | **0,10–0,30 s** |

## Serie Y — Chromium sulla GPU reale, tutte le scene

Sorgente sintetica `synthPop` (worker), 1280×720, vsync a 60 Hz, 12 s per riga. Prima alle
19:59–20:05, dopo alle 20:05–20:11. Calibrazione YIN: 1,8–2,3 ns (prima), 1,9–2,4 ns (dopo).
Ogni cella è «prima → dopo».

| Scena / qualità | FPS | p95 ms | p99 ms | frame > 33 ms | GPU ms | CPU frame ms | errore clock RMS ms | alloc kB/frame |
|---|---|---|---|---|---|---|---|---|
| Tunnel / Low | 60,0 → 60,0 | 16,7 → 16,7 | 16,7 → 16,7 | 0 → 0 | 1,3 → 1,3 | 2,4 → 0,7 | 0,7 → 0,6 | 72,4 → 34,0 |
| Tunnel / Medium | 60,0 → 60,0 | 16,7 → 16,7 | 16,7 → 16,7 | 0 → 0 | 6,0 → 4,8 | 3,0 → 1,3 | 0,7 → 0,6 | 66,0 → 27,5 |
| Tunnel / High | 57,5 → 60,0 | 16,7 → 16,7 | 33,3 → 16,7 | 0 → 0 | 10,5 → 8,9 | 5,4 → 1,2 | 3,3 → 0,6 | 64,7 → 26,0 |
| Spectrum / High | 59,3 → 60,0 | 16,7 → 16,7 | 33,3 → 16,7 | 0 → 0 | 11,2 → 9,5 | 4,3 → 1,3 | 3,0 → 0,6 | 63,6 → 25,7 |
| Liquid / High | 50,4 → 60,0 | 33,3 → 16,7 | 33,3 → 16,7 | 0 → 0 | 15,6 → 9,7 | 4,7 → 1,3 | 5,9 → 0,6 | 66,5 → 26,1 |
| Oscilloscope / High | 56,5 → 59,9 | 33,3 → 16,7 | 33,3 → 16,7 | 0 → 0 | 12,6 → 6,3 | 5,5 → 1,2 | 3,8 → 0,6 | 63,8 → 25,1 |
| Galaxy / High | 60,0 → 60,0 | 16,7 → 16,7 | 16,7 → 16,7 | 0 → 0 | 8,0 → 8,4 | 3,4 → 1,0 | 0,7 → 0,6 | 61,8 → 24,1 |
| Particle Field / High | 59,9 → 60,0 | 16,7 → 16,7 | 16,7 → 16,7 | 0 → 0 | 8,4 → 6,1 | 3,8 → 1,0 | 1,1 → 0,6 | 63,3 → 23,8 |
| Resonant Field / High | 59,9 → 60,0 | 16,7 → 16,7 | 16,7 → 16,7 | 0 → 0 | 10,1 → 5,4 | 3,6 → 1,0 | 1,1 → 0,6 | 65,8 → 28,5 |
| Matter Field / High | 42,1 → 54,0 | 33,3 → 33,3 | 33,3 → 33,3 | 0 → 0 | 17,5 → 12,5 | 5,1 → 2,1 | 7,4 → 0,8 | 80,8 → 38,1 |
| Spectral Matter / High | 37,3 → 47,4 | 33,3 → 33,3 | 33,3 → 33,3 | 0 → 1 | 20,9 → 15,1 | 5,1 → 2,1 | 6,9 → 1,5 | 76,0 → 33,5 |
| Spectral Shell / High | 54,1 → 60,0 | 33,3 → 16,7 | 33,3 → 16,7 | 0 → 0 | 13,7 → 6,8 | 5,3 → 1,4 | 4,5 → 0,6 | 68,9 → 29,6 |
| Vector Field / High | 42,3 → 60,0 | 33,3 → 16,7 | 33,3 → 16,7 | 4 → 0 | 18,4 → 9,5 | 8,5 → 1,8 | 6,6 → 0,6 | 72,0 → 29,3 |
| Spectrum / Low | 60,0 → 60,0 | 16,7 → 16,7 | 16,7 → 16,7 | 0 → 0 | 1,8 → 1,2 | 1,9 → 0,9 | 0,6 → 0,6 | 57,0 → 19,7 |

Letture:

- **CPU del frame**: −55 % … −80 %. In Tunnel / High: analisi grafica 2,96 → 0 ms, decodifica +
  Experience 0,40 → 0,29, rig 0,24 → 0,10, sottomissione del rendering 1,55 → 0,64; p99 del frame
  14,2 → 2,1 ms.
- **GPU**: −15 % … −50 % dove c'era post-processing (Medium/High), invariata a Low e in Galaxy.
  Le query misurano anche le fette prese dall'altra applicazione: il guadagno reale del motore è
  quello delle differenze, non dei valori.
- **Clock udito**: a frame regolari l'errore residuo (0,6 ms RMS) è un solo campione per serie
  (l'avvio della misura); p95 e p99 sono 0. Prima cresceva con il carico (p99 14 ms a High) perché
  il tempo veniva letto a metà callback.
- **Allocazioni** (heap V8): dimezzate o più; in Tunnel / Low da 4,2 a 1,9 MB al secondo.
- **Spectral Matter e Matter Field** restano sotto i 60 fps a High su questa GPU in questo stato:
  il loro costo è la materia (60–96 mila elementi simulati e disegnati), non il post-processing.
- **Worker DSP**: carico 0,107 → 0,177 (Tunnel / High): l'analisi grafica ora è lì. Qualità DSP 0
  in entrambi i casi.

### Cambi di scena (serie Y, High, un cambio ogni 4 s)

| | Prima | Dopo |
|---|---:|---:|
| FPS durante la prova | 46,5 | 53,8 |
| Frame oltre 33 / 50 / 100 ms | 43 / 13 / 0 | 11 / 5 / 1 |
| Frame più lungo nei primi 0,3 s dopo il cambio (8 cambi) | 50–100 ms | 33–67 ms, uno da 117 ms |
| Frame medio nel primo secondo e mezzo | 22–33 ms | 17–26 ms |
| Geometrie, texture, programmi dopo 8 cambi | ±0 | ±0 |

Il cambio da 117 ms è verso Spectral Matter: i programmi dei suoi passi di simulazione non stanno
nel grafo della scena e vengono ancora compilati al primo uso.

## Serie S — desktop, cattura nativa

Istanza Tauri isolata (WebKitGTK 2.54, build di sviluppo), finestra 1280×720, sorgente «system»
(monitor dell'uscita dell'utente più il segnale di prova collegato alla sola istanza). Prima alle
20:25–20:28, dopo alle 20:28–20:31. Calibrazione YIN: 2,0–3,1 ns (prima), 2,0 ns (dopo).

| Scena / qualità | FPS | p50 / p95 / p99 ms | > 33 / 50 / 100 ms | CPU frame ms | IPC al secondo | Errore clock RMS / p99 ms | Escursione offset | Hop/frame max |
|---|---|---|---|---|---|---|---|---|
| Tunnel / High, 30 s — prima | 34,6 | 28 / 48 / 70 | 247 / 47 / 2 | 9,00 | 178 | 1,30 / 4,79 | 13,2 ms, 26 scatti | 65 |
| Tunnel / High, 30 s — dopo | **58,7** | 17 / 21 / 32 | 11 / 4 / 1 | **2,89** | **64** | 0,49 / 1,06 | 5,5 ms, scorrendo | 18 |
| Tunnel / Low — prima | 59,8 | 17 / 19 / 28 | 3 / 1 / 0 | 4,47 | 195 | 1,38 / 6,14 | 38,0 ms, 32 scatti | 8 |
| Tunnel / Low — dopo | 60,0 | 17 / 18 / 20 | 0 / 0 / 0 | 1,61 | 64 | 0,50 / 0,60 | 7,9 ms, scorrendo | 7 |
| Matter Field / High — prima | 40,0 | 25 / 34 / 57 | 51 / 16 / 0 | 9,91 | 176 | 1,42 / 3,51 | 10,9 ms, 15 scatti | 15 |
| Matter Field / High — dopo | **51,1** | 19 / 26 / 32 | 7 / 0 / 0 | 5,15 | 64 | 0,64 / 1,00 | 0,9 ms | 9 |
| Spectrum / High — prima | 51,4 | 18 / 29 / 46 | 27 / 5 / 0 | 7,02 | 181 | 1,29 / 3,22 | 8,1 ms, 22 scatti | 13 |
| Spectrum / High — dopo | **59,6** | 17 / 20 / 30 | 6 / 0 / 0 | 2,66 | 64 | 0,48 / 1,09 | 0,2 ms | 9 |

In entrambe le serie: 187,5–187,7 hop al secondo decodificati (tutti), nessun vuoto di cattura,
nessun record scartato, nessun batch mancante (dopo: contati dal record clock).

Altre grandezze del percorso nativo:

| | Prima | Dopo | Nota |
|---|---:|---:|---|
| Anticipo del momento udito sull'analisi più recente (`Timing.lead`) | 67–105 ms | −18 … 0 ms | il mondo presentato non è più estrapolato |
| Ritardo cattura → frame che conosce un attacco | 126–160 ms | 39–47 ms | |
| Processo UI, CPU totale | 162 % di un core | 61 % | finestra di 21 s all'avvio, un solo campione |
| … thread di cattura | 112 % | 26 % | prima: il reactor PulseAudio non ottimizzato (A-06); dopo: DSP musica + scene |
| … main thread del processo UI (invio IPC) | 41 % | 28 % | |
| Carico DSP dichiarato dal thread di cattura | non disponibile | 0,16 | qualità DSP 0 |
| Cambio sorgente sintetico ↔ system (serie T, 4 cambi) | non provato (nell'audit: 6,5 minuti e oltre) | 0,10 – 0,30 s | build di sviluppo |

L'escursione dell'offset «dopo» nelle prime due righe (5–8 ms) è la stima che migliora nei primi
minuti dopo l'avvio e che l'offset segue scorrendo; a regime (righe successive) è sotto 1 ms.

Non misurato nel desktop: tempo GPU (l'estensione manca in WebKitGTK), heap JavaScript, CPU del
processo WebView (il campionatore ha seguito il processo sbagliato e si è fermato dopo 21 s).

## Serie G — dove va il tempo GPU (dopo il refactor)

Chromium, 1280×720, la nuova catena di rendering; ogni riga 10 s. È l'esperimento E-04 dell'audit.
Serie presa alle 19:53–19:58; i valori assoluti vanno letti dentro la serie.

| Scena / qualità | MSAA ×4 (profilo) | MSAA ×2 | senza MSAA | ×4 senza bloom | ×4, bloom a metà risoluzione |
|---|---:|---:|---:|---:|---:|
| Tunnel / High | 8,0 ms | 6,8 | 6,3 | 5,9 | 6,6 |
| Matter Field / High | 11,2 | 8,3 | 6,1 | 9,7 | 11,5 |
| Spectrum / High | 7,6 | — | 5,0 | 7,3 | — |
| Tunnel / Medium (960×540) | 5,2 | — | 4,2 | — | — |

- Con i pass successivi fuori dall'MSAA, il **bloom** costa 0,3–2 ms (nell'audit, con la vecchia
  catena, 7–9 ms: la sua fusione finale scriveva e risolveva un target multicampionato).
- L'**MSAA ×4 del solo pass di scena** costa 1–2 ms dove c'è poca geometria e 5 ms in Matter Field
  (decine di migliaia di punti additivi sovrapposti).
- Dimezzare la risoluzione del bloom non dà un guadagno misurabile.
- **Target a 8 bit: non provati.** Cambierebbero la resa (i valori oltre 1 alimentano il bloom e la
  composizione), quindi non sono un'alternativa equivalente.
- **Bloom condiviso dopo la composizione: non provato.** Con una sola scena visibile coincide con
  quello per layer; con più scene toglierebbe i parametri di bloom per scena che la regia usa.

Nessuno di questi esperimenti è stato adottato: i profili di qualità sono quelli di prima.

## Serie Z — solo le fasi 1 e 2 (analisi unificata, trasporto, clock)

Chromium, stesse condizioni, 12–15 s per riga. «Prima» alle 18:53–18:56, «dopo» alle 19:36–19:40:
non consecutive, quindi solo indicative. In quel momento la GPU era molto più contesa (Tunnel / High
di baseline a 19,4 ms contro i 10,5 della serie Y).

| Scena / qualità | FPS | CPU frame ms | GPU ms | Errore clock RMS ms |
|---|---|---|---|---|
| Tunnel / Low | 59,9 → 60,0 | 4,75 → 2,30 | 0,8 → 0,8 | 1,34 → 0,56 |
| Tunnel / Medium | 47,5 → 47,8 | 5,32 → 2,28 | 12,1 → 10,1 | 6,37 → 1,38 |
| Tunnel / High | 36,2 → 36,0 | 5,64 → 2,37 | 19,4 → 18,6 | 5,46 → 0,89 |
| Spectrum / High | 36,0 → 38,6 | 5,08 → 2,26 | 19,8 → 18,3 | 6,28 → 0,96 |
| Matter Field / High | 24,2 → 25,5 | 6,91 → 3,92 | 31,1 → 33,3 | 7,27 → 1,21 |
| Spectrum / Low | 60,0 → 60,0 | 4,31 → 1,08 | 0,9 → 0,9 | 0,99 → 0,62 |

Dice una cosa utile: togliere lavoro dal main thread **non** cambia il frame rate quando il limite
è la GPU (36 fps prima e dopo); lo cambia il lavoro sulla catena di rendering (serie Y).

## Thread di analisi

| Misura | Prima | Dopo | Come |
|---|---:|---:|---|
| Nativo, 48 kHz stereo: analisi musicale | 6,4–7,1 % di un core | invariata | `cargo run --release -p spectrum-analysis --example scene_cost --offline` |
| Nativo, 48 kHz: analisi delle scene, 62,5 volte al secondo | sul main thread (TS) | +3,1 % (0,49 ms per frame di scena) | idem |
| … prima delle ottimizzazioni del port | | +5,3 % (0,85 ms) | idem |
| Nativo, 96 kHz: musica / + scene | 12,0 % / — | 12,0 % / +4,6 % | idem |
| WASM in Node, pump per risveglio di 512 frame, p50 / p95 / p99 a 48 kHz | 1,26 / 2,79 / 3,91 ms | 1,96 / 3,59 / 4,92 ms | `npx vitest run src/bench/experience.bench.test.ts --maxWorkers=1` |
| WASM in Node, carico DSP a 44,1 / 48 / 96 kHz | 12,3 / 13,3 / 20,3 % | 17,4 / 18,9 / 27,9 % | idem (soglia del test: < 50 %) |
| Analisi grafica TypeScript sul main thread, per frame | 2,6–3,1 ms (Chromium), 2,5–3,6 ms (WebKitGTK) | 0 | serie Y, Z, S |

Bilancio a 60 fps su questa macchina: il main thread cede circa il 17 % di un core; il thread di
analisi ne prende il 3–6 %.

## Benchmark e test del repository

| | Prima | Dopo |
|---|---|---|
| `cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline` | 59 + 1 doctest | 66 + 1 doctest |
| `npm run check` | 58 file, 448 test, 1 saltato | 61 file, 495 test, 1 saltato |
| Catena PCM → Experience → mondo → show invariante al batching (bench) | passa | passa |
| Rig: kick → fixture entro un frame a 30, 60, 144 fps (bench) | passa | passa |

## Che cosa non è stato misurato

- Una macchina libera, a frequenza nominale, in **release**; **Windows / WebView2 / WASAPI**.
- Il **microfono** nel percorso nativo (vedi baseline).
- **1080p**, schermo intero, resize; display a 120/144 Hz.
- Qualità **Auto** e regia a più scene in esecuzione reale dopo le modifiche.
- Sessioni lunghe: memoria su ore, comportamento a finestra nascosta.
- Tempo GPU e heap nel WebView; quota dell'overdraw.
- Il costo di un layer buio che continua a simulare (A-12).

## Dati grezzi

`docs/performance-data/`: i risultati completi delle serie Y, Z, G (Chromium) e S, T (desktop),
un oggetto JSON per prova, con gli intervalli di ogni frame dove registrati, e i piani che le
hanno prodotte (`plan-*.json`). Li ha scritti la sonda dell'audit
(`docs/audit-data/audit-probe.ts.txt`) negli alberi di misura; nessun audio e nessun nome di
dispositivo. Per rifarli: la procedura di [performance-refactor-baseline](performance-refactor-baseline.md).
