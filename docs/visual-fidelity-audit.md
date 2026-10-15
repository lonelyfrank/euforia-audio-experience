# Visual Fidelity Audit — 15 ottobre 2026

Baseline: `main`, `2e7024c`, working tree inizialmente pulito. Lavoro sul branch
`audit/visual-fidelity`. Ambito: le 16 scene esistenti, renderer e strumenti di verifica.
Nessuna nuova scena, dipendenza, importazione audio nell'app, modifica alla UI cinematica,
al DSP, al wire, alla cognizione o al World Engine.

Questo audit distingue **immagini osservate**, **test numerici**, **misure sul browser live**
e **accettazione percettiva con musica reale**. Quest'ultima resta da eseguire.

## Metodo ed evidenze

`scripts/visual-fidelity-browser.mjs` usa una pagina di test intercettata da Playwright,
non una route dell'app. Il generatore sintetico esistente produce `buildDrop` a 48 kHz
stereo in un worker; lo stesso WASM analizza blocchi di 480 campioni. Il main thread riceve
solo i record wire, tutti e nell'ordine originale, compresi i record `scene`.

Per ciascuna scena: decoder → ExperienceEngine → SceneFeed e MusicInterpreter →
RigController in Preset/manuale → RenderEngine → Layer → pass della scena, MSAA/bloom,
composizione finale. Seed e preset sono quelli della scena, palette Nebula, viewport
1280×720, DPR 1, riflessione spenta, ritardo di presentazione 100 ms. Timestamp RAF
simulati a 30 fps; il rendering GPU avviene a ogni passo, compresi simulazione e feedback.
Si attende `Layer.ready` prima del primo frame. Acquisizioni a 8, 17, 18,3, 20 e 24 s
di cattura; gli istanti uditi sono 100 ms precedenti. Il framebuffer viene letto nello
stesso task che lo ha disegnato, prima che il browser lo cancelli.

Non è una prova del trasporto live, del jitter di cattura o dell'ascolto. Le misure
`costs` sono tempo CPU di aggiornamento/sottomissione nel replay, **non FPS né tempo GPU**.
Gli array `resources` contano tutti i pass, con `renderer.info.autoReset = false`.
`elements` è capacità/numero inviato, **non conteggio delle particelle distinguibili**.

Baseline completa: 48 corse, 240 immagini, zero errori JS/GLSL, Chromium headless,
ANGLE / Mesa Intel UHD CML GT2, OpenGL ES 3.2. Metadati, pose, stati, cue, eventi,
risorse e tempi grezzi: [before.json.gz](visual-fidelity/before.json.gz).
Le tavole ridotte permettono il confronto fra scene; non sono una prova della visibilità
di un dettaglio di un pixel. I dettagli dei Worlds sono conservati a risoluzione nativa.

| Qualità | Build (tempo udito 16,9 s) | Dopo il rilascio (23,9 s) |
|---|---|---|
| Low, 640×360 | [16 scene](visual-fidelity/evidence/before-low-17.png) | [16 scene](visual-fidelity/evidence/before-low-24.png) |
| Medium, 960×540 | [16 scene](visual-fidelity/evidence/before-medium-17.png) | [16 scene](visual-fidelity/evidence/before-medium-24.png) |
| High, 1280×720 | [16 scene](visual-fidelity/evidence/before-high-17.png) | [16 scene](visual-fidelity/evidence/before-high-24.png) |

Per riprodurre, usare il modulo Playwright e Chromium **già installati** sulla macchina:

```sh
npm run dev
PLAYWRIGHT_MODULE=/percorso/playwright-core/index.mjs \
CHROMIUM_PATH=/percorso/chrome \
FIDELITY_OUTPUT=/tmp/euforia-before node scripts/visual-fidelity-browser.mjs
```

Filtri: `FIDELITY_SCENES` e `FIDELITY_QUALITIES` (liste separate da virgole),
`FIDELITY_TIMES`, `FIDELITY_FPS`, `FIDELITY_SIGNAL` (dal corpus `testSignals.ts`),
`FIDELITY_REFLECTION=1`, `WORKSPACE_URL`. Non eseguire benchmark CPU contemporaneamente
alle misure GPU live. Conservare entrambi i report e confrontare gli stessi frame.

Ulteriori controlli: `FIDELITY_SOLIDS=1` monta lo slot sperimentale esistente solo nella
pagina di test; `FIDELITY_PARITY=1` esegue i cinque readback GPU esistenti;
`FIDELITY_LEGACY_SEED=20261015` controlla la costruzione casuale di Galaxy nel harness.
La baseline iniziale di Galaxy non aveva questo controllo: i suoi pixel non sono
confrontabili per uguaglianza. Due replay supplementari seminati sono identici nei
15 campioni; il codice della scena resta invariato.

La campagna dopo le correzioni ha altre 48 corse e 240 immagini senza errori.
[Dati dopo](visual-fidelity/after.json.gz), [differenze RGB](visual-fidelity/pixel-comparison.json),
[tavola Low](visual-fidelity/evidence/after-low-24.png),
[tavola Medium](visual-fidelity/evidence/after-medium-24.png),
[tavola High](visual-fidelity/evidence/after-high-24.png).
Il report prima riporta `2e7024c`; quello dopo riporta `048b98f` ed è stato
acquisito col working tree delle quattro correzioni, poi registrate nei checkpoint
elencati nel [rapporto](graphics-refactor-report.md). Non è una seconda esecuzione del codice baseline.

## Matrice di conformità

La [matrice completa](visual-fidelity/matrix.csv) separa comportamento atteso, modulo,
segnale, attivazione, risultato visivo, osservazione, evidenza, problema, intervento
e nuova validazione. **VERIFIED vale solo per il comportamento e le condizioni nominate**,
mai per l'intera scena o la sua fedeltà musicale in generale.
`baseline_status` conserva la classificazione iniziale; `status` e `revalidation` sono
il risultato dopo gli interventi. Un bug corretto solo con test numerico resta PARTIAL
quando manca ancora la dimostrazione visiva del caso specifico.
Esito sui 78 comportamenti: 13 VERIFIED, 57 PARTIAL, 3 NOT OBSERVABLE,
3 NOT TESTED e 2 NOT IMPLEMENTED (studi futuri e collisioni). Non è una percentuale
di completamento del prodotto: le righe raggruppano proprietà di ampiezza diversa.

| Stato | Significato |
|---|---|
| VERIFIED | Osservato nel rendering e verificato nelle condizioni riportate |
| PARTIAL | Una parte osservabile; restano aspetti insufficienti o non dimostrati |
| INCORRECT | Evidenza riproducibile contraria al contratto |
| NOT OBSERVABLE | Il dato esiste ma l'effetto non è distinguibile nelle immagini raccolte |
| NOT IMPLEMENTED | Intenzione documentata senza implementazione; non equivale a regressione |
| NOT TESTED | Verifica non eseguita; non inferire un esito dai test numerici |

## Risultati per scena nella baseline

| Scena | Osservazione diretta | Valutazione e seguito |
|---|---|---|
| Infinite Tunnel | Sezioni poligonali, prospettiva profonda, configurazioni diverse fra build e rilascio; fotogrammi senza collassi | PARTIAL: continuità a occhio e rilascio musicale corretto non si deducono da cinque immagini. Digest e segnali storici restano riferimenti; nessun ritocco |
| Generative Terrain | Griglia continua, versanti e placche leggibili; emergenze lontane | PARTIAL: ancoraggio da verificare anche col readback; facce dei solidi ancorati con winding inverso, condiviso col deserto |
| Monolith Desert | A Low, 17 s: una struttura attiva di pochi pixel; 24 s: tre corpi solo all'orizzonte. A Medium/High stesso problema compositivo | NOT OBSERVABLE per scala/emersione vicina; non basta aumentare emissione. Correggere l'avvio della popolazione e il winding, preservando densità e capacità |
| Fractured Expanse | A 17 s sette solidi distinguibili; a 18,3 s e 24 s pezzi separati, vertici persistenti. Polvere non copre i corpi | VERIFIED per formazione/frattura visibile su questo segnale; PARTIAL per ricomposizione, memoria, collisioni e risonanza individuale. Il solver resta invariato |
| Pulse Ocean | Profilo dell'orizzonte e altezze cambiano; nessun foro evidente; foreground dominato dalla griglia | PARTIAL: tre scale numericamente attive, increspature e fronti poco separabili nelle immagini. Non aumentare tutte le ampiezze senza prova musicale |
| Resonant Forest | A High alberi individuali con ramificazioni; a Low pochi rami lontani. Nessun albero maturo nei cinque frame Low | PARTIAL: durata di crescita e attraversamento limitano leggibilità; memoria e filamenti non osservati nel tratto. Due regressioni riproducibili di avvio/reset |
| Particle Field | Distribuzione volumetrica ampia, punti distinti; Low più rado | VERIFIED per presenza e profondità nel campione; PARTIAL per fedeltà per registro |
| Resonant Field | Membrana a punti riconoscibile, deformata fra istanti | VERIFIED per superficie e deformazione; PARTIAL per attribuzione percettiva dei modi |
| Spectral Matter | High: corpo luminoso con filamenti/faccette; Low: polvere molto tenue, quasi persa nel fondale | PARTIAL: organizzazione leggibile a High, NOT OBSERVABLE nel campione Low per dettagli della forma; nessun aumento globale di luce |
| Matter Field | Membrana, materia e filamenti coesistono; High più leggibile e complesso | PARTIAL: alcuni contributi si sovrappongono, non si può attribuire ogni moto a una sorgente dal solo frame |
| Vector Field | Traccianti e flusso riempiono un volume; High molto denso | VERIFIED per flusso rappresentato; PARTIAL per leggibilità dei singoli regimi e transizioni |
| Spectral Shell | Membrana e gusci separabili, polvere tenue | VERIFIED per stratificazione visibile; PARTIAL per corrispondenza temporale della memoria modale |
| Spectrum | Traccia radiale e spettro visibili, diversa apertura nei frame | Controllo di conservazione; nessuna modifica alla scena o ai contratti letti |
| Galaxy | Struttura orbitale luminosa riconoscibile, Low più tenue | Controllo di conservazione |
| Liquid | Tracce sovrapposte leggibili, bloom a High | Controllo di conservazione |
| Oscilloscope | Tre tracce distinguibili su griglia | Controllo di conservazione |

## Pipeline, rendering e costi

Il wire mantiene ogni hop: nessun folding nel replay. Experience e cue sono presentati al
tempo udito; i fronti leggono l'EventStream con cursori. Le nuove azioni strutturali ricevono
`release` confermati; Tunnel, Terrain e Ocean leggono ancora anche il rilascio storico del
mondo. Questa differenza è nel [rapporto musicale](music-reactivity-report.md).

Il renderer conserva la composizione unica e il multisampling dello ScenePass. Le recipe
mantengono montate le primitive; quelle sotto la soglia di presenza non vengono aggiornate.
Non è stato introdotto LOD, instancing aggiuntivo, pooling parallelo o un secondo solver.
Gli array di geometria e simulazione appartengono ai produttori come prima.

L'audit delle facce usa le posizioni effettive di `emergentPoint` e gli indici di
`emergenceTemplate`: le celle estruse hanno normali esterne; i solidi ancorati hanno normali
interne. Con FrontSide, il renderer scarta proprio le facce rivolte all'osservatore.
Il test della normale contro il centro del pezzo riproduce il difetto; la parità CPU/GLSL
da sola non poteva trovarlo, perché entrambe le leggi avevano lo stesso errore.

Il timeout di `Layer.prepare` non era cancellato da `dispose`: con compilazione pendente
restava un riferimento al layer e dopo tre secondi `ready` poteva diventare vero sul layer
già distrutto. È una perdita temporanea di lifecycle, non evidenza di una perdita permanente
di VRAM. La regressione usa un driver simulato che non termina la compilazione.

## Accettazione e limiti

Gli esiti finali, le modifiche e i controlli sono nel [Graphics Refactor Report](graphics-refactor-report.md);
misure e regressioni nel [Performance Comparison](visual-performance-comparison.md).
Non attribuire VERIFIED globale alle scene sulla base di questa campagna.

Restano esplicitamente fuori: ascolto e cattura musicale reale, Windows/WebView2,
Tauri/WebKitGTK, hardware diverso, display a 144 Hz, fullscreen desktop, certificazione
del flicker e sessioni di ore. `pkg-config --exists webkit2gtk-4.1 alsa` passa sulla macchina
di questa sessione: la mancata prova desktop non è attribuita a dipendenze assenti.
Le transizioni spaziali di `world-transitions.md` e i mondi futuri sono studi, non difetti
da colmare in questo intervento.
