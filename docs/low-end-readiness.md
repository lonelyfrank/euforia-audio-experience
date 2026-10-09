# Hardware modesto: a che punto è Euforia

Che cosa rende il motore sostenibile su CPU e GPU limitate, che cosa è stato misurato, e che cosa
resta da provare prima di dichiarare supportata una classe di hardware. Stato al 9 ottobre 2026,
dopo il refactor descritto in [performance-architecture](performance-architecture.md).

Regola di questo documento: **una classe è «supportata» solo se è stata provata.** Oggi ne è stata
provata una, e in condizioni non ideali.

## Che cosa è stato provato

| Classe | Macchina | Stato |
|---|---|---|
| Notebook con grafica integrata | Intel i7-10510U + UHD (CML GT2), Fedora 44, limitato a 17 W, con un'altra istanza dell'applicazione in esecuzione | **misurato** (Chromium sulla GPU reale e desktop Tauri/WebKitGTK), 1280×720 |
| Lo stesso, limitato a 7 W (0,8 GHz) | la macchina dell'audit | **misurato solo prima** del refactor (l'audit); dopo: stimato |
| Handheld x86 (ROG Ally e simili) | — | **non provato** |
| ARM a basse prestazioni | — | **non provato** |
| Raspberry Pi 4 (4 GB) | — | **non provato**: target sperimentale, nessuna dichiarazione di compatibilità |
| Windows / WebView2 | — | **non provato** in questo lavoro |

## Requisiti, uno per uno

| Requisito | Stato | Dove |
|---|---|---|
| Memoria prevedibile | **verificato sul codice e nelle prove**: ogni buffer del percorso audio → scena nasce a dimensione fissa (anello PCM dell'analizzatore, 64 chunk di cattura, `RecordStage` 3 s, `SceneFeed` 64 record, snapshot 256, eventi 256). Heap JS a dente di sega con minimo stabile (audit, 8 minuti); risorse three.js invariate dopo 8 cambi di scena | architettura § Trasporto; audit §10 |
| Nessuna crescita illimitata delle code | **verificato** per quelle del progetto. La coda dei canali di Tauri non ha un limite proprio (H-03): non osservata crescere, non provata a finestra nascosta | architettura § Trasporto |
| Analisi musicale indipendente dalla qualità grafica | **verificato**: i profili Low/Medium/High/Auto non toccano hop, onset, beat, sezioni, né la cadenza dell'analisi scene. La qualità DSP dipende solo dal carico del thread di analisi | `quality.ts`, `DspBudget.ts`, `tests/scene.rs` |
| Nessuna funzionalità musicale persa sui profili economici | **verificato**: a Low cambiano pixel (0,5×), densità (35 %), bloom e MSAA (assenti). Experience, World, Show e tutte le scene restano | `quality.ts` |
| CPU usata in modo efficiente | **misurato**: il main thread non fa più FFT né YIN; CPU del frame da 5,4 a 1,2 ms a High (Chromium), da 9,0 a 2,9 ms nel desktop | benchmark, serie Y e S |
| Scalabilità dei pixel e dei pass | **misurato**: Low 1–2 ms di GPU per frame, Medium ≈ 5, High 5–15 a 1280×720 su questa GPU | benchmark |
| Fallback per estensioni GPU mancanti | **parziale**: senza `KHR_parallel_shader_compile` la compilazione torna sincrona da sé (three.js) e dopo 3 s la scena viene mostrata comunque; senza `EXT_disjoint_timer_query_webgl2` la diagnostica segna il tempo GPU come non disponibile. Serve `EXT_color_buffer_half_float`/`float` (target `RGBA16F`): **nessun fallback a 8 bit**, perché cambierebbe la resa (il bloom vive di valori oltre 1) | `Layer.ts`, `RendererProbe.ts` |
| Nessuna dipendenza obbligatoria da WebGPU | **vero**: WebGL2 soltanto | — |
| Funzionamento su GPU integrata | **misurato** su una (Intel UHD) | benchmark |
| Presentazione stabile sotto i 60 fps | **parziale**: sotto i 60 fps il clock udito e il passo delle scene restano regolari (errore del clock 0,5 ms RMS; scene in tempo reale fino a 12,5 fps), ma **non esiste un limitatore di frame rate**: una macchina che oscilla fra 40 e 60 fps mostra quella oscillazione | vedi «Che cosa manca» |

## Dove va il carico, e che cosa scala

| Carico | Thread | Scala con | Che cosa cede sotto pressione |
|---|---|---|---|
| Analisi musicale | cattura / worker | sample rate (hop al secondo) | cadenze lente (qualità DSP 1–2); mai hop, onset, beat |
| Analisi delle scene | lo stesso | ≈ 60 frame al secondo, costo fisso per frame (finestre in campioni) | cadenza: 3 → 4 → 6 hop (qualità DSP 1–2) |
| Decodifica + Experience + mondo | main | hop al secondo | nulla: è piccola (0,2–0,4 ms per frame); dopo uno stallo si distribuisce |
| Scene: logica | main | scena, densità | densità del profilo |
| Scene: GPU | GPU | pixel × pass × densità | fixture in più → risoluzione → bloom/MSAA → densità |
| Composizione | GPU | pixel | risoluzione |

Misure del thread di analisi su questa macchina (2–3 GHz, non libera):

| | Musica | + scene | Fonte |
|---|---:|---:|---|
| Nativo, 48 kHz | 6–7 % di un core | +3–5 % | `cargo run --release -p spectrum-analysis --example scene_cost` |
| Nativo, 96 kHz | 12 % | +5 % | idem |
| WASM (Node), 48 kHz | 13 % | +5,6 % | `npm run bench` |
| WASM (Node), 96 kHz | 20 % | +7,6 % | idem |
| Desktop reale, 48 kHz, build di sviluppo | 16 % in tutto (`load` del record clock) | | serie S |

## Stime per le classi non provate

Sono **stime**, ottenute scalando le misure sopra con la velocità per core. Nessuna è una promessa.

| Classe | Thread di analisi (stima) | Main thread (stima) | GPU (stima) | Giudizio provvisorio |
|---|---|---|---|---|
| Notebook iGPU a frequenza piena (≥ 3,5 GHz) | 6–8 % di un core | < 1,5 ms per frame | come misurato o meglio | 60 fps a 720p High sulla maggior parte delle scene; 1080p da misurare |
| La macchina dell'audit a 7 W (0,8 GHz) | 30–45 % di un core: vicino alla soglia del 40 % che abbassa la qualità DSP | 4–8 ms per frame (era 17–20) | High oltre budget, Medium al limite | probabilmente 40–60 fps a Low/Medium; da rimisurare |
| Handheld x86 (Zen 4, iGPU capace) | < 10 % | < 2 ms | High a 720p plausibile, 1080p da misurare | da provare; attenzione ai display a 120 Hz (l'analisi scene si aggiorna a ≈ 60/s) |
| Raspberry Pi 4 (Cortex-A72, 1,5–1,8 GHz, VideoCore VI) | 40–70 % di un core, senza SIMD nel WASM: **sopra la soglia**, quindi qualità DSP 1–2 quasi sempre | 5–10 ms | `RGBA16F` e 60–96 mila punti additivi sono con ogni probabilità troppi anche a Low | **non dichiarabile**. I colli di bottiglia attesi sono la GPU (fill rate, target a 16 bit) e il WebView (WebKitGTK su V3D), prima del motore |

Per il Pi la domanda vera non è la CPU: è se il driver espone un WebGL2 con render target in
virgola mobile a prestazioni utili. Va verificato prima di ogni altra cosa.

## Che cosa manca

In ordine di utilità per l'hardware modesto:

1. **Misure su una macchina libera e in release** (E-01, E-02 dell'audit), e su Windows.
2. **Un limitatore di frame rate**: se 60 fps non sono sostenibili, presentare a 30 stabili invece
   di oscillare. Il motore è pronto (il clock udito e il mondo non dipendono dal frame rate, il
   passo delle scene regge fino a 80 ms), ma la scelta del target e il suo effetto sulla resa vanno
   provati a occhio. Non implementato.
3. **Un profilo sotto Low** per GPU che non reggono `RGBA16F` a 0,5×: richiede decisioni sulla
   resa (target a 8 bit, niente accumulo additivo oltre 1), quindi gli occhi dell'utente.
4. **Cadenza dell'analisi scene legata al frame rate reale**: a 30 fps di rendering, analizzare 60
   volte al secondo spreca metà del lavoro di quel thread. Il backend accetta già `every`; manca la
   politica nel frontend e la sua verifica.
5. **Sospensione dei layer bui** (A-12) e **gestione della finestra nascosta**: lavoro che oggi
   continua senza contribuire all'immagine.
6. **SIMD nel WASM** (`+simd128`): il nucleo YIN e i filtri ne trarrebbero 1,5–2×; richiede di
   verificare il supporto dei WebView di destinazione e di versionare il modulo di conseguenza.
7. Una **prova di ore** per la memoria (E-07).

## Come provare una nuova macchina

1. `npm run desktop:build` (o `desktop:dev`), sorgente «system» con musica in riproduzione.
2. Aprire la diagnostica (Shift+G in sviluppo, Ctrl+Alt+Shift+D in produzione) e registrare 60 s
   per ciascuna di: Tunnel, Spectrum, Matter Field, a Low e a High.
3. Leggere: `frame.p50/p95/p99`, `frame.jank`, `cpu.source`, `cpu.layers`, `gpu.frame` (dove
   esiste), `pipeline.load`, `pipeline.quality`, `pipeline.missed`, `pipeline.dropped`,
   `clock.heardError.*`, `quality.limit`.
4. La classe è sostenibile a un profilo se: `frame.jank` < 2 %, `pipeline.quality` = 0 a regime,
   `pipeline.missed` = `pipeline.dropped` = 0, `clock.heardError.p99` < 2 ms.
5. Esportare il report (JSON) e aggiungere la riga alla tabella «Che cosa è stato provato».
