# Graphics Refactor Report — 15 ottobre 2026

Baseline `2e7024c` su `main`, working tree pulito; lavoro isolato sul branch
`audit/visual-fidelity`. Il refactor corregge quattro problemi riproducibili senza cambiare
DSP, cattura, contratti Spectrum, UI cinematica, catalogo, regia o solver fisico.
L'accettazione musicale con sorgenti reali resta aperta.

## Correzioni e prove

| Modulo | Causa | Correzione | Verifica |
|---|---|---|---|
| `renderer/Layer.ts` | Il timeout di preparazione sopravviveva a `dispose`; poteva rendere pronto un layer distrutto | Handle posseduto dal layer, cancellazione al rilascio, completamento protetto | Regressione con compilazione pendente: prima un timer residuo, dopo zero e `ready=false` anche al completamento tardivo |
| `primitives/emergenceLaw.ts` | Anello dei solidi ancorati percorso nel verso opposto agli indici; tutte le facce orientate verso l'interno | Verso coerente in TS e GLSL; celle estruse invariate | `SurfaceWinding.test.ts`, tutte le forme in entrambi i modi; readback GPU; facce esterne visibili nelle immagini |
| `primitives/terrainEmergence.ts`, preset Monolith Desert | Il campo iniziale non era popolato; il viaggio lento lasciava i primi landmark all'orizzonte | `initial` opzionale, spento per default; una valutazione della pianura al primo ingresso di una riga con musica viva | Landmark intermedio nel confronto Low/Medium/High; budget, corridoio, fermo e determinismo testati |
| `primitives/forestGrowth.ts` | Il primo frame udibile poteva consumare la semina con target zero; date di fioritura/accento della sessione precedente diventavano future dopo reset | Semina iniziale attesa fino a target positivo; timestamp cancellati nel reset | Due regressioni prima rosse e poi verdi: semina dopo acquisizione e assenza di flash in silenzio dopo reset |

Il campo iniziale del deserto usa lo stesso hash, gli stessi intervalli di distribuzione,
la densità dello stato lento e il budget massimo di strutture in formazione. Non cresce
per tempo decorativo né in assenza di viaggio. Non aumenta numero massimo, bloom,
dimensioni o guadagni globali. La camera resta quella precedente: ha finalmente un soggetto
a profondità utile. Il cambiamento della sua posa di focus è quindi una conseguenza prevista.

La correzione del winding cambia quali facce vengono rasterizzate, senza usare `DoubleSide`
per nascondere il difetto. Non aggiunge pass, shader, texture o triangoli alla singola struttura.
Le leggi TS/GLSL restano allineate. La correzione della foresta non modifica forma degli alberi,
tempi di crescita, selettività della memoria o firme musicali. `buildDrop` non esercita il
caso limite di acquisizione: perciò i suoi frame Forest prima/dopo restano identici.

## Evidenza visiva

240 immagini prima e 240 dopo: 16 scene × tre qualità × cinque istanti, stessi preset,
segnale e clock. [Matrice dei comportamenti](visual-fidelity/matrix.csv),
[differenze pixel](visual-fidelity/pixel-comparison.json),
[stati dopo](visual-fidelity/after.json.gz).

| Confronto | Prima | Dopo |
|---|---|---|
| Deserto, Medium, 23,9 s uditi | [Solo landmark lontani](visual-fidelity/evidence/before-monolith-desert-medium-24.00.png) | [Volume al piano intermedio](visual-fidelity/evidence/after-monolith-desert-medium-24.00.png) |
| Solidi, Medium, 16,9 s | [Corpi chiusi](visual-fidelity/evidence/before-fractured-expanse-medium-17.00.png) | [Preservati](visual-fidelity/evidence/after-fractured-expanse-medium-17.00.png) |
| Solidi, Medium, 18,2 s | [Frammenti](visual-fidelity/evidence/before-fractured-expanse-medium-18.30.png) | [Preservati](visual-fidelity/evidence/after-fractured-expanse-medium-18.30.png) |
| Tutte le scene, Low, 23,9 s | [Baseline](visual-fidelity/evidence/before-low-24.png) | [Dopo](visual-fidelity/evidence/after-low-24.png) |
| Tutte le scene, High, 23,9 s | [Baseline](visual-fidelity/evidence/before-high-24.png) | [Dopo](visual-fidelity/evidence/after-high-24.png) |

Spectrum, Liquid, Oscilloscope, Tunnel, tutte le sei scene Particles, Fractured Expanse,
Pulse Ocean e Resonant Forest sono identici pixel per pixel nei 15 campioni ciascuno.
Terrain cambia per il winding dei solidi; Monolith Desert cambia per winding e popolazione
iniziale. **Galaxy è esclusa dal confronto di uguaglianza**: la versione esistente usa
`Math.random` per le stelle. Il codice prodotto è preservato. Il controllo opzionale
`FIDELITY_LEGACY_SEED` semina soltanto la costruzione nel harness di test.

Le immagini integrali temporanee sono in `/tmp/euforia-fidelity-before` e
`/tmp/euforia-fidelity-after`; il repository conserva le tavole di tutte le scene e i dettagli
nativi dei quattro nuovi Worlds, con stati e metadati completi compressi. Gli archivi JSON
sono il riferimento anche quando le directory temporanee non sono più disponibili.

## Parità GPU e precisione

[Readback completo](visual-fidelity/parity-and-pilot.json.gz), Intel UHD / Mesa:

| Prova | Esito del criterio esistente | Misura e limite |
|---|---|---|
| Terrain/emersione | pass | Basi delle celle: errore GPU massimo 0; basi solide sotto il minimo locale (margine minimo 0,0376). Terreno CPU↔GPU: mediana 0,000292, p99 0,00873, max 1,83333; strutture max 0,24884 |
| Forest | pass | Radici GPU: max 7,63e-8; rami mediana 0,000201, max 0,01667 |
| Ocean | pass | 11.628 punti, max 0,0002823; nessun non-finito |
| Matter | pass | 1.024 elementi × 240 passi, float completo; RMS 3,15e-5, max 1,15e-4 |
| Tracer | pass | 1.024 traccianti × 120 passi; RMS 1,45e-5, max 1,46e-4 |

Il `pass` del terreno usa il criterio statistico già presente, **non** garantisce errore
massimo sotto 0,002. L'hash f32 e le terrazze producono outlier già noti; l'ancoraggio resta
coerente perché strutture e terreno leggono la stessa legge sulla GPU. Cambiare hash
modificherebbe il paesaggio: non è stato fatto in questo intervento.

## Controlli e checkpoint

- `npm run check`, con `VITEST_MAX_WORKERS=1`: typecheck, lint, **99 file / 821 test
  passati, uno saltato**, benchmark sintetici inclusi, build release riuscita. Il test
  saltato richiede il corpus locale `EUFORIA_AUDIO_EXPERIENCE_CORPUS`, non disponibile.
  [Log del controllo completo](visual-fidelity/frontend-check.txt).
- `cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline`: **67 test
  passati**, compreso il doctest. Nessuna modifica al DSP o al WASM distribuito.
  [Log Rust](visual-fidelity/rust-tests.txt).
- Cinque readback GPU passati secondo i criteri esistenti; precisione e outlier sopra.
- 48 corse prima + 48 dopo; silenzio per tutte le scene; start/stop e 60 fps per i sei
  Worlds; coesistenza Solid Particles a Low/High; Galaxy con seme controllato ripetuta.
- `visual-lifecycle-browser.mjs`: **80 selezioni di scena** (tre giri del catalogo e
  32 sostituzioni rapide), stesso renderer e stessa sessione audio, zero errori.
  Risorse GPU finali entro i massimi delle visite precedenti; heap dopo GC a fine giro
  36,83 / 37,68 / 37,82 MiB. I passaggi comprendono 0,9 s di crossfade: 0,624–1,065 s
  osservati, non tempi puri di compilazione. [Dati](visual-fidelity/lifecycle-final.json).
- `workspace-browser.mjs acceptance`: ripetuto dopo le correzioni, passa senza errori.
  [Dati](visual-fidelity/workspace-after.json). Anche `release` passa sulla build
  servita a porta 1423: [dati release](visual-fidelity/workspace-release.json).
- `workspace-browser.mjs soak`, sei minuti: **40 cicli in 6,12 minuti**, Matter Field
  Low su `beat124`, navigazione, REC, isolamento, laboratorio e ritorno. Zero errori;
  stessa sessione audio, override ripristinate, 2 timer / 2 observer / 18 listener
  globali prima e dopo. GPU al ritorno: 4 geometrie / 11 texture / 9 programmi,
  stabile fra i giri. Heap dopo GC da 21,03 MiB prima di aprire la diagnostica a
  25,97 MiB alla fine; nodi 242→298 e listener DOM 66→81. Il caricamento dei pannelli
  resta in memoria: non è una prova di assenza di ogni leak. [Dati](visual-fidelity/soak.json).

Il primo confronto lifecycle richiedeva uguaglianza esatta delle risorse fra visite:
Spectral Shell ne aveva **meno** al terzo giro (polvere non ancora presente/uploadata).
È stato corretto il criterio del test per confrontare i massimi già osservati, senza
modificare il prodotto per soddisfare un'aspettativa sbagliata. Questo dimostra un limite
osservato su una sessione breve, non assenza universale di leak.

Commit indipendenti: `048b98f` baseline/strumenti/matrice; `2a195c7` lifecycle Layer;
`4a2c71b` winding; `97425e2` avvio/reset Forest; `2b14e66` pianura iniziale Desert.
Nessun push o merge su main.

## Limiti residui e decisioni

- Fedeltà musicale globale, attacco percepito e fluidità continua: non certificati dai
  fotogrammi; [checklist con sorgenti live](music-reactivity-report.md) da eseguire.
- Ocean: tre scale attive ma separazione visiva parziale; nessun aumento indiscriminato
  di ampiezza. Spectral Matter Low resta tenue; alcuni regimi di Matter si sovrappongono.
- Forest: memoria selettiva e filamenti non dimostrati dal tratto iniziale; nessuna falsa
  equivalenza fra test di similarità e riconoscibilità visiva.
- Fractured Expanse: rottura visibile e corpi stabili nel tratto; ricomposizione completa,
  collisioni e memoria strutturale selettiva restano limiti. Nessun secondo solver.
- `Experience.drop` fuori dal release sintetico: riprodotto e documentato, non corretto
  nel compartimento grafico. Le azioni strutturali nuove usano cue confermati.
- Replay 30/60 fps: stessa semantica dei cue, ma non topologia identica in Terrain e
  Fractured Expanse; dettagli nel rapporto musicale. Non presentare i test mock come
  prova della completa indipendenza dal frame rate del percorso reale.
- GPU integrata verificata su Chromium; niente certificazione Windows/WebView2,
  Tauri/WebKitGTK, Raspberry Pi, display 144 Hz, fullscreen o sessioni di ore.
- Campagna comparativa a riflessione spenta e viewport 1280×720: non certifica la
  composizione dei Worlds con la riflessione predefinita né il costo a 1080p/4K.
- Numeri di particelle inviati alla GPU non equivalgono a elementi percettivamente
  distinguibili. Heap JS non misura la VRAM del driver. Costi di compilazione e cache
  dipendono dalla macchina; [misure live e limiti](visual-performance-comparison.md).

I problemi rimasti non sono stati cancellati dalla documentazione né classificati VERIFIED
perché uno shader compila. Non sono stati aggiunti ambienti, portali, cockpit o dipendenze.
