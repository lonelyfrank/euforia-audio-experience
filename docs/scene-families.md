# Famiglie di scene, solidi fra le particelle, emersione dal terreno

Data: 14 ottobre 2026. Branch `scene-taxonomy-worlds` su `main` `dbc39f3`, sei commit, **non pushato**.
Brief: «Scene Taxonomy, Physical Particles & Generative Worlds Refactor». Tutto deterministico: nessun
modello generativo, nessun secondo DSP, WorldEngine, solver o registry.

| Commit | Contenuto |
|---|---|
| `0484a2d` | Tassonomia: `category` nei metadati del registry, menu Scene → famiglia → scena |
| `c28ed64` | Cue musicali: adattatore semantico fra ciò che il motore ha udito e le azioni strutturali nuove |
| `f325a9f` | Particles: solidi del motore strutturale fra la materia (esperimento DEV) e laboratorio Emergence |
| `80c55ba` | Generative Terrain: tre scale di risposta, la micro fuori dalla massa del paesaggio |
| `191a0ff` | Generative Terrain: strutture che emergono dal suolo, ancorate alla sua legge |
| (questo) | Laboratorio Emergence · Terrain, righe diagnostiche dei cue, benchmark, documentazione |

**Ordine cambiato rispetto al brief** (validazione degli eventi al secondo posto invece che al quinto): solidi
ed emersione si rompono e si moltiplicano sugli eventi musicali, quindi dovevano consumare un contratto già
validato; costruirli prima sul `drop` dell'Experience avrebbe significato propagare eventi di cui si conosce
lo scarto (§2.4–2.5 di [music-response](music-response.md)).

## 1. Audit iniziale

Baseline su `dbc39f3` (prima di toccare il codice): `npm run check` verde, **81 file, 691 test passati,
1 saltato**; core Rust (`cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline`) verde.

| Area | Stato trovato |
|---|---|
| Registry, menu | Un elenco piatto ordinato per `order`; l'anello Scene mostra tutte le 12 scene. `appMenu`/`parentMenu`/`coreTarget`/`menuSelection` puri e testati. Il cockpit DEV ha un suo `select` con tutte le scene. |
| Solidi | `SolidSystem` dentro `StructuralSystem`: XPBD, fratture via `FractureGate`, ricomposizione, profili rigid/elastic/legacy. Un solo corpo, solo nel laboratorio Solid (`SolidPrimitive` legato a `solidLab`). Nessun solido nelle scene di prodotto. |
| Generative Terrain | Reticolo fisso, legge in GLSL e TS **mai confrontate sulla GPU**; risposta: pressione → rilievo (già liscia), eccitazione → ottava fine **a ogni cassa**, shimmer → tremolio di ogni vertice **a ogni hi-hat** (misure §5). |
| Eventi | Il `drop` dell'Experience scatta ±2 s dal drop musicale e dopo le pause (§2.4–2.5 di music-response, decisione dell'utente); la cognizione ode i rilasci dove cadono (`signals.test.ts`) ma non ne esponeva il momento. |
| Workspace | Laboratori `structural`, `solid`, `cognition` sul ciclo di vita `Experiment`; override temporanee nel `OverrideLedger`. Phase 4 (Dynamic World Laboratory) non autorizzata: non toccata. |

## 2. Famiglie di scene

`SceneCategory = 'particles' | 'worlds' | 'spectrum'` è un campo **obbligatorio** di `VisualizerDefinition`
(il compilatore impedisce una scena senza famiglia); `SCENE_CATEGORIES` ne fissa ordine, nome e icona.
Tutto il resto si deriva dal registry: `scenesOf(famiglia)`, `sceneCategories()`, `categoryOf(id)`. Nessuna
lista parallela: il menu, il cockpit (selettore raggruppato) e chiunque verrà dopo leggono quelle.

| Famiglia | Scene | Perché |
|---|---|---|
| **Particles** | Particle Field, Resonant Field, Spectral Matter, Matter Field, Vector Field, Spectral Shell | materia, campi, geometria, modi e strutture del mondo condiviso |
| **Worlds** | Infinite Tunnel, Generative Terrain | uno spazio attraversato: profondità, avanzamento, ambiente |
| **Spectrum** | Spectrum, Galaxy, Liquid, Oscilloscope | il segnale è il protagonista |

**Galaxy** è valutata sul codice, non sul nome: il raggio di ogni stella è una regione dello spettro (centro
bassi, bordo alti, ognuna accesa dalla sua banda), i bracci seguono la forma della voce lead, il nucleo la
linea di basso; non legge il mondo né la materia. È una visualizzazione del segnale fatta di stelle: Spectrum.

ID, ordine, preset, palette e impostazioni salvate sono invariati (test). Spectrum riceve solo il metadato
`category` nel suo `index.ts`: nulla di ciò che la scena legge o mostra cambia.

### Menu

```text
core → Root ─ Scene ─┬─ Particles ─ Particle Field · Resonant Field · Spectral Matter · Matter Field · Vector Field · Spectral Shell
                     ├─ Worlds    ─ Infinite Tunnel · Generative Terrain
                     └─ Spectrum  ─ Spectrum · Galaxy · Liquid · Oscilloscope
```

- L'anello Scene è un arco di tre voci (come Direction e Rig); la famiglia che contiene la scena in uso è
  marcata. Scegliere una famiglia apre il suo anello (`scene:<famiglia>`), **non applica nulla e non tocca
  la cattura**. Scegliere una scena passa dalle impostazioni come prima e lascia l'anello aperto.
- Il core torna indietro di un anello: `Matter Field (scene:particles) → Scene → Root → chiuso`.
- Una famiglia non applica mai una scena che non è sua, né il mondo di un laboratorio registrato.
- Root, Audio, Palette, Settings, Direction (Auto/Manual, Rig Preset/Hybrid/Free), Fullscreen: invariati.

## 3. Cue musicali (`experience/MusicalCues.ts`)

Adattatore per hop dentro `ExperienceEngine`, dopo cognizione e anticipazione. Legge solo ciò che esiste
(EventStream, `MusicalCognition`, `AnticipationLedger`); **non scrive** nel mondo, nello stato né
nell'EventStream: Tunnel e scene vedono esattamente ciò che vedevano (digest del Tunnel invariati).

| Livello | Da dove | Cue / campo | Chi può agire |
|---|---|---|---|
| Anticipazione | `anticipation.level` (carica del mondo) | `cues.anticipation` | dosare quanto (densità), mai un evento |
| Previsione | previsioni `release` aperte della cognizione (confidenza ≥ 0,35) | `prepare` (predicted) / `withdraw` (refuted); `cues.expectation` | preparare e ritirare, mai confermare |
| Osservazione | impatto con significance ≥ 0,7 e confidenza ≥ 0,5, non nei 2 s dopo un silenzio; `phraseBoundary` con confidenza ≥ 0,5 | `accent` / `phrase` (observed) | luce, micro-risposta |
| Conferma | rilascio **udito** della cognizione (`stats.lastRelease`, nuovo campo additivo) | `release` (confirmed) | frattura, burst, emersione significativa |
| Esecuzione | — | il conto del consumatore (`cuesTaken`, `EmergenceStats`) | — |

Il `drop` dell'Experience **non è mai un cue**: è abbinato a un rilascio udito entro ±0,5 s (`dropsMatched`)
o contato non confermato (`dropsUnconfirmed`). Una previsione nata nei 4 s dopo un rilascio udito non prepara
nulla (la tensione si è appena risolta: misurato, la cognizione ne propone una subito dopo e poi la smentisce).
Le scene leggono i cue dallo snapshot (`snapshot.cues`, anello fisso di 16, copiato senza allocare) con
`forEachCue` e un cursore. Diagnostica: righe `cues.*` e `cues.stats.*` nel registry.

Misure (segnali di test attraverso il WASM, `MusicalCues.test.ts`):

| Segnale | `drop` Experience | Rilasci uditi (cue) | `prepare` / `withdraw` | Accenti |
|---|---|---|---|---|
| buildDrop (drop a 18,0 e 50,0 s) | 16,0 · 20,2 · 48,1 · 52,2 s — tutti non confermati | **18,00 · 50,00 s** | 2 / 0, ciascuno prima del suo rilascio | 3 |
| startStop | 22,2 · 34,4 · 43,1 s — non confermati | nessuno | 0 / 0 | 0 |
| breakdown | 25,3 · 29,5 · 63,6 · 67,7 · 71,8 s (uno abbinato) | 28,0 · 68,0 s | — | 4 |
| beat124 (40 s) · synthPop (40 s) | nessuno | nessuno | 0 / 0 | 3 · 1 |

Correzione globale del `drop`: **non fatta**. I difetti sono dimostrati solo su segnali sintetici e cambiarli
cambia il Tunnel dove piace (decisione dell'utente, §2.4). Le azioni nuove non ne dipendono.

## 4. Particles: solidi fra la materia (esperimento DEV)

Un solo solver: i corpi sono di `SolidSystem`. `SolidPrimitive` accetta una **popolazione** (più corpi, un
materiale, quali passi del ciclo usare); senza popolazione è il corpo del laboratorio Solid bit per bit
(i test del laboratorio passano invariati).

```text
free (semi sparsi, link ricordati) → aggregate (catene, poligoni) → form (superfici, gusci) → solid (volume sigillato)
     → fracture (FractureGate, solo su release udito) → fragments → riorganizzazione (riformazione fisica del motore)
```

- `start: 'free' | 'solid'` salta o no i primi passi; `fracture: 'none' | 'release' | 'accent'` dice cosa può
  rompere (default `release`); `profile` il materiale (default rigid: ritenzione 0,9, pulsazione ≤ 6 %).
- Gli stadi si leggono dai link (`stageOf` su `SolidSystem.read`, 5 volte al secondo), non si impongono.
- `solidSlot()` è montato in un mondo che gira con `VisualWorld.add` e tolto con `remove`: nessuna recipe di
  prodotto lo contiene (test), quindi **Matter Field senza esperimento è la scena di prima**. Funziona in ogni
  recipe Particles (Matter Field, Vector Field, Spectral Shell, Resonant Field).

Su Matter Field attraverso il WASM (`ParticleSolids.test.ts`), tre corpi (tetraedro, cubo, icosaedro):

| Segnale | Ciclo |
|---|---|
| buildDrop | free fino a ~5 s, solid tutti e tre a 17 s; fratture **a 18,00 e 50,00 s** (i rilasci uditi; nessuna ai `drop` ±2 s); frammenti; di nuovo solidi a 45 s; deviazione di forma < 0,02, pulsazione ≤ 6 % |
| beat124, startStop | si formano e restano interi: nessuna frattura |
| con `fracture: 'accent'` | su beat124 i corpi si rompevano due volte nel groove: per questo il default è solo `release` |

Stessi tempi di frattura a 30 e 60 fps; stesso seme e stessi frame → stessi corpi; in silenzio nulla si forma.

## 5. Worlds: la risposta musicale del terreno su tre scale

Misurato attraverso il WASM (beat124, synthPop, buildDrop, breakdown) prima di cambiare: il rilievo era già
liscio (la pressione del mondo è una molla, 0,03 % per frame); l'ottava fine (`crest`) oscillava di ±0,14 a ogni
cassa su tutte le pareti (~0,5 unità di altezza) e lo shimmer faceva tremare ogni vertice fino a 0,3 unità a
~8 Hz. I colpi raggiungono già il suolo localmente (fronti d'onda, la placca di un accento, le scintille del
materiale): ora massa e superficie seguono il **groove** (`TerrainResponse`, nel preset).

| Scala | Cosa la porta al suolo |
|---|---|
| micro (cassa, transiente, hi-hat) | fronti d'onda del mondo (locali), placca sollevata da un accento, scintille (luce) |
| intermedia (groove, intensità persistente, tensione) | massa: eccitazione seguita su 0,6 s (`groove`); superficie: shimmer seguito su 0,4 s (`surface`); rilievo dalla pressione; terrazze e gola dal potenziale |
| strutturale (build, drop udito, sezioni) | terrazze, gola, fronte del rilascio e nuova configurazione; l'emersione (§6) |

Registri configurabili e limitati (`lows`, `mids`, `highs`: guadagni 0…2; tempi 0…4 s): una lettura, non leggi
della musica. Variazione per frame, prima → dopo, a livello medio invariato:

| Segnale | `crest` rms/frame | `quake` rms/frame |
|---|---|---|
| beat124 | 0,0250 → 0,0011 | 0,0454 → 0,0025 |
| synthPop | 0,0104 → 0,0007 | 0,0220 → 0,0016 |
| buildDrop | 0,0209 → 0,0011 | 0,0342 → 0,0020 |
| breakdown | 0,0213 → 0,0011 | 0,0360 → 0,0020 |

`LEGACY_RESPONSE` riproduce il moto di prima **bit per bit** a 30, 60 e 144 fps (`terrain/response.test.ts`,
digest registrati sul codice invariato). Un cambio di intensità tenuto è seguito entro il tempo del groove;
i follower sono esatti per un ingresso tenuto a ogni frame rate.

## 6. Emersione dal terreno

```text
cue musicali + mondo + TerrainMotion (righe in vista, ring, tensione)
        │
        ▼
EmergenceField.step        pool fisso (≤ 64) · dormant → formation → emergence → active ⇄ resonance → fracture | retreat → recycle
        │  aAnchor · aBody · aBreak (3 vec4 per istanza, i primi `count`)
        ▼
emergenceLaw (GLSL e TS)   emergentPoint: legge il suolo con terrainHeight stessa, gli stessi uniform del suolo
        ▼
EmergencePrimitive         istanze di un modello (3 pezzi × 2 anelli × 6 angoli = 36 vertici): bordi + faccette (solo bordi a Low)
```

### Ancoraggio

Una struttura è ancorata a un punto del reticolo che non si muove (colonna J, riga R) e legge il proprio suolo
con la **stessa** `terrainHeight`, sugli **stessi** uniform (`TerrainPrimitive.shared`: gli stessi oggetti,
nessuna copia). Viaggia quindi con il suolo e ne segue terrazze, placche, fronti e rilasci.

- **Cella sollevata** (modalità 1, estrusione): i quattro angoli della base sono i vertici del suolo (la stessa
  chiamata che il suolo fa per loro); la cima è piatta sopra il più alto.
- **Solido nel suolo** (modalità 2): base sotto il più basso dei nove punti del reticolo attorno (raggio < 1
  cella, quindi tutto ciò che sta sotto l'impronta è fra quei punti), inclinato fino al 45 % della normale
  locale; a `rise = 0` è interamente sepolto, emergere è salire dal sottosuolo.
- **Distacco di una regione del suolo** (modalità 3): non implementata. Richiederebbe di staccare vertici del
  suolo principale (oggi una funzione pura del reticolo): resta uno studio.

Forme: pilastro, cristallo, prisma, blocco (angoli distinti 6/6/3/4, rastremazione). Le sceglie il suolo dove
nascono: un suolo terrazzato solleva le sue celle, un pendio ripido fa crescere cristalli. Rigidità: pezzi rigidi;
la pulsazione è un cambio di scala uniforme ≤ `PULSE_LIMIT` (solo l'altezza per una cella, che tiene i suoi
angoli); rotta, i pezzi superiori sono lanciati, ruotano, ricadono e sprofondano — funzione pura dell'età della
frattura datata all'evento. Il pezzo più basso resta dov'è.

### Ciclo di vita e regole musicali

Vive sul tempo della musica: in silenzio o senza clock nulla nasce e nulla si muove. Nasce dalle righe del
reticolo che entrano in vista (una ogni `spacing` righe, un candidato per lato della valle, mai nel corridoio
di volo): senza viaggio non nasce nulla.

| Momento musicale | Comportamento |
|---|---|
| groove stabile | densità bassa (0,12): poche strutture persistenti (2–6 misurate su beat124) |
| tensione che cresce | più strutture, organizzate: a coppie attraverso la valle, a passo regolare |
| previsione di rilascio (`prepare`) | ciò che nasce attende in formazione (alone a terra) |
| previsione ritirata (`withdraw`) o scaduta (12 s) | le formazioni tornano nel suolo |
| rilascio udito (`release`) | le formazioni emergono, le tre righe successive si riempiono (burst, strutture più alte), il `FractureGate` può rompere le più cariche (alte e risonanti), datate al rilascio |
| breakdown | niente di nuovo, subito; ciò che sta in piedi rientra una struttura ogni 1,2 s |
| silenzio | niente di nuovo, tutto fermo |
| accento osservato | un momento di luce sulla struttura più vecchia, nient'altro |

Mai una struttura per cassa; mai il numero dal volume istantaneo (test: stesse strutture a due livelli diversi
del mondo); isteresi sulla risonanza; budget separati: strutture (28), in formazione o emersione (6), in
frattura (4). A Low cambia solo il disegno (solo bordi), non la logica.

Attraverso il WASM (`Emergence.test.ts`): buildDrop → burst e fratture ai due rilasci uditi, mai ai `drop` ±2 s;
beat124 e startStop → strutture presenti, nessun burst, nulla di rotto. Stessa musica e stesso seme → stesse
strutture; a 30, 60 e 144 fps nascono le stesse.

### Parità GPU ↔ CPU (`runTerrainParity`, Intel UHD, ANGLE GL ES 3.2)

| Misura | Risultato |
|---|---|
| Base delle celle sollevate contro i vertici del suolo, **sulla GPU** (due programmi) | **0** (72 angoli, tre stati del suolo) |
| Base dei solidi rispetto al più basso dei nove vertici attorno, sulla GPU | sempre sotto, di almeno 0,037 unità (234 vertici) |
| Legge del suolo GPU ↔ CPU (4473 punti) | mediana 3e-4, p99 9e-3 unità; massimo 1,83 (un gradino di terrazza) |
| Legge delle strutture GPU ↔ CPU (2592 vertici) | mediana 4e-4; p99 0,23 (un solido intero) |
| Shader | compilati, nessun errore |

La divergenza puntuale è dell'**hash del paesaggio preesistente** (`terrainHash`): in f32 la GPU fonde
moltiplicazioni e somme, e un valore che cade su un confine di `fract` o di un gradino di terrazza finisce
dall'altra parte. Sulla GPU struttura e suolo leggono gli stessi valori (l'ancoraggio è esatto); il riferimento
CPU serve solo a decidere dove nascere e che forma avere, dove l'errore non conta. Non l'ho corretto: cambiare
l'hash cambia il paesaggio. Proposta in §12.

## 7. Laboratorio Emergence (DEV)

Laboratories → **Avvia Emergence** (o `?engine=emergence`). Un laboratorio del ciclo `Experiment` come gli
altri: pin temporaneo della scena studiata, impostazioni proprie (nessuna salvata), alla fine il mondo è
restituito com'era (slot e parametri), il pin a ciò che era. Logica senza DOM in `app/engine/emergence.ts`.

- **Terrain**: emersione on/off, strutture (capacità), in formazione e in frattura insieme (budget),
  ancoraggio (entrambi / celle / solidi), rigidità (pulsazione 0–6 %), densità, frequenza di emersione,
  risposta musicale, frattura on/off; Reset; eventi sintetici (rilascio udito, previsione, ritiro, accento)
  attraverso lo stesso percorso dei cue. Letture: strutture per fase, nate/riciclate/passate/ritirate/rotte/
  rifiutate, gate, cue, ms CPU.
- **Particles**: scena ospite (le recipe Particles), solidi on/off, corpi, inizio, cosa rompe, materiale.

Non anticipa la Phase 4 del workspace: non crea né distrugge entità nel mondo di prodotto oltre ciò che il
laboratorio monta e restituisce.

## 8. Diagnostica

- `cues.*` e `cues.stats.*` (fase, anticipazione, aspettativa, conteggi per tipo, drop abbinati/non confermati).
- `primitive.terrain.emergence.debug.*` e `primitive.<recipe>.solids.debug.*`: arrivano da soli dal debug delle
  primitive (nessun canale nuovo): strutture per fase, nate, riciclate, rotte, rifiutate, densità, ms.
- `primitive.terrain.ground.debug.ring` / `stir`: le due scale intermedie del suolo.

## 9. Benchmark

### CPU sintetica (`bench/families.bench.test.ts`, µs, macchina a 17 W, non isolata)

| | p50 | p95 | p99 |
|---|---:|---:|---:|
| Cue musicali, per hop | 1,7 | 3,4 | 4,2 |
| Moto del terreno, `LEGACY_RESPONSE` | 2,41 | 4,48 | 6,43 |
| Moto del terreno, tre scale | 2,55 | 4,83 | 6,98 |
| Emersione, pool pieno (48 strutture vive) | 13,1 | 23,7 | 30,4 |
| Tre solidi fra le particelle (passo del motore strutturale) | 198 | 286 | 326 |

### GPU reale

Chromium headless sulla Intel UHD (ANGLE GL ES 3.2), 1280×720, vsync 60 Hz, segnale `buildDrop`, 10 s di
misura. Il processo Tauri dell'utente era attivo sulla stessa GPU: valgono solo i confronti dentro la stessa
serie. "JS" è il tempo di script del main thread per frame (CDP), "draw" e "primitive" sono contati
intercettando le chiamate WebGL. Ripetizioni alternate (A, B, A, B), una pagina nuova per prova.

**Generative Terrain, emersione spenta → accesa** (misura 18–28 s, dopo il drop: 10–11 strutture visibili in media)

| Qualità | fps | p95 / p99 ms | frame > 33 ms in 10 s | JS ms/frame | draw | primitive |
|---|---|---|---|---|---|---|
| Low | 60,0 → 60,0 | 16,7 / 16,7 → 16,7 / 16,7 | 0 → 0 | 1,64 → 1,64 (seconda coppia) | 3 → 4 | 45 196 → 46 307 |
| Medium | 43,8 → 42,1–42,4 | 33,3 / 33,3 → 33,3 / 33,3 | 0 → 0–1 | 2,80 → 2,97–3,01 | 17 → 19 | 84 812 → 87 770 |
| High | 32,7 → 31,9–32,2 | 33,3 / 50 → 50 / 50 | 11 → 18–19 | 3,22 → 3,44 | 17 → 19 | 130 487 → 133 750 |

A Low l'emersione non toglie frame (60 fps pieni, una draw call). A Medium e High la scena era già limitata
dalla GPU prima (43,8 e 32,7 fps a 1280×720): l'emersione costa 1,5 fps (−3,5 %) e 0,7 fps (−2 %), sette frame
oltre 33 ms in più in 10 s a High. Nessun pass nuovo, nessuna texture; risorse +1 geometria a Low, +2 sopra.

**Matter Field, senza → con tre solidi (DEV)** (misura 12–22 s)

| Qualità | fps | JS ms/frame | draw | passo strutturale |
|---|---|---|---|---|
| Low | 60,0 → 60,0 | 1,84–1,98 → 2,51–3,14 | 7,9 → 11 | 0,32–0,34 ms |
| Medium | 35,8 → 35,4–36,1 | 3,05–3,34 → 3,76–4,10 | 26,6 → 29,7 | 0,46–0,59 ms |
| High | 23,2–23,5 → 22,6–22,8 | 3,59–4,13 → 4,86–5,20 | 27,5 → 30,6 | 0,92–0,97 ms |

**Controllo, stessa serie (12–22 s)**: Infinite Tunnel 60 / 40,9 / 29,3 fps (Low / Medium / High), Spectrum
60 / 39,2 / 29,6, Matter Field 60 / 37,4 / 22,7. Tutte le scene tengono i 60 fps a Low su questa GPU; a Medium e
High nessuna li tiene a 1280×720 (come già misurato il 13 ottobre). GPU per frame non misurata qui (le query a
tempo del workspace vanno usate a mano: `Profiling GPU`).

## 10. Test

| File | Cosa |
|---|---|
| `app/menus.test.ts` | famiglie dai metadati, nessun duplicato, navigazione avanti/indietro, selezione marcata, persistenza, impostazioni salvate valide, nessun effetto sulla cattura, root e altri anelli invariati |
| `experience/MusicalCues.test.ts` | contratto (drop mai cue, accenti, previsioni, reset, cursore); scenari della cognizione (buildDrop, falseBuild, shortPause, longPause, tempoChange, meterChange, stable, sourceLost) |
| `visual-engine/structural/ParticleSolids.test.ts` | montato e restituito, nessuna recipe di prodotto lo contiene, popolazione reale, silenzio, solo i rilasci rompono, determinismo |
| `validation/families.signals.test.ts` | il percorso reale (WASM → Experience → cue, Matter Field con i solidi, Terrain con l'emersione), **una sessione per segnale condivisa** da tutti: buildDrop (rilasci, fratture e burst ai rilasci uditi, ciclo dei solidi), startStop, beat124, buildDrop a 30 e 60 fps |
| `visualizers/terrain/response.test.ts` | legacy bit per bit (30/60/144), scale separate, cambio tenuto, registri configurabili e limitati, frame rate, reset |
| `visualizers/terrain/Emergence.test.ts` | legge (basi = vertici del suolo, mai sopra le faccette, sepolto a riposo, segue lo scorrimento, rigidità, pezzi rigidi, GLSL), ciclo (silenzio, groove e livello, previsione e ritiro, rilascio con burst e frattura datata, accento, breakdown, budget, determinismo e frame rate, riciclo e reset), scena con e senza |
| `app/engine/emergence.test.ts` | laboratorio senza DOM: montare, cambiare, restituire; Particles in ogni recipe; eventi sintetici sullo stesso percorso |
| `bench/families.bench.test.ts` | costi CPU sopra |

Risultato finale: `npm run check` verde, **88 file, 744 test passati, 1 saltato** (baseline: 81 file, 691);
core Rust non toccato (baseline verde). Una nota di stabilità, misurata: con la CPU limitata a 17 W (era 28 W
alla baseline) `bench/solid.bench.test.ts` — che misura `StructuralSystem.step`, codice non toccato — è
uscito tre volte oltre la sua soglia di p95 (2,4–2,6 ms contro 2) quando le corse WASM nuove giravano su tre
worker in parallelo; da solo, in coppia con le corse nuove, e la baseline alle stesse condizioni passano. Le
corse WASM sono ora una sessione per segnale in un solo file (da 11 a 5 analisi, un worker) e il benchmark
nuovo è breve: dopo, verde. La soglia non è stata toccata; resta vicina al limite su questa macchina sotto carico.

## 11. Portali futuri

Verificato senza implementare nulla (`docs/world-transitions.md`): Worlds è un metadato, non un gestore; Tunnel
e Terrain non si conoscono (nessun import fra i due); l'emersione è una primitiva della recipe del Terrain
(un portale Terrain → Tunnel → Terrain la troverebbe montata e riattaccata al suo suolo); niente stato
globale nuovo fuori da ExperienceEngine (i cue sono nello snapshot come il resto).

## 12. Limiti noti

- **Nessuna prova con musica reale né a occhio nel tempo**: solo segnali sintetici e Chromium headless sulla
  Intel UHD. La taratura visiva (quante strutture, quanto alte, quanto luminose, quanto si vedono da lontano) è
  un punto di partenza.
- Il `drop` dell'Experience resta ±2 s fuori e falso dopo le pause: le azioni nuove non lo usano, il Tunnel sì.
- L'hash del paesaggio diverge in f32 fra GPU e CPU su singoli vertici (§6): innocuo per l'ancoraggio.
- Ricomposizione dei solidi parziale sotto musica che spinge (proprietà del motore strutturale, già nota).
- La modalità "distacco di una regione" del terreno non esiste.
- I solidi fra le particelle sono solo un esperimento DEV (nessun solido nelle scene di prodotto).
- Windows, Tauri/WebKitGTK, Raspberry Pi: non provati. Nessuna compatibilità dichiarata.

## 13. Validazione con audio reale — da fare

Con cattura di sistema, musica vera, a occhio, almeno Low e High:

1. Menu: Root → Scene → Particles → Matter Field e ritorno; cambiare scena da ogni famiglia con la musica che
   suona: nessuna interruzione dell'audio, nessun salto della cattura.
2. Generative Terrain su un brano con build e drop (EDM, hardstyle): le strutture si preparano nel build,
   emergono e si rompono **sul** drop che si sente, non prima; dopo il drop restano poche; nel breakdown
   rientrano; in una pausa tutto si ferma.
3. Lo stesso su un groove lungo e stabile (techno, house): poche strutture, nessuna rottura, nessun "tremolio"
   del paesaggio sugli hi-hat; il paesaggio respira con il groove, non con la singola cassa.
4. Un brano con ripresa dopo una pausa (startStop reale): nessun burst, nessuna frattura alla ripresa.
5. Matter Field con il laboratorio Emergence · Particles: i corpi si formano, restano riconoscibili, si
   rompono solo sui drop uditi, si ricompongono.
6. Confronto Terrain con e senza emersione (laboratorio) a Low su una GPU integrata: fps e frame lunghi.
7. Infinite Tunnel come prima (dovrebbe essere identico: i digest lo confermano in test).

## 13bis. Proposta del prossimo intervento

Nota di verifica grafica, 15 ottobre 2026: la legge dei solidi ancorati percorre ora l'anello
in senso coerente con gli indici di `emergenceTemplate`. Prima le normali delle facce erano
interne e `FrontSide` scartava le superfici esterne. Il set dei vertici, le celle estruse,
le età di frattura e l'ancoraggio non cambiano. `SurfaceWinding.test.ts` controlla le
normali sulle posizioni effettive; `runTerrainParity()` controlla la traduzione CPU/GLSL.
Evidenze e limiti della precisione: [Visual Fidelity Audit](visual-fidelity-audit.md).

1. Decidere §2.4 di music-response con musica reale: il Tunnel potrebbe leggere lo stesso `release` confermato.
2. Rendere robusto l'hash del paesaggio (intero, non `fract` di prodotti in f32) — cambia il paesaggio: da
   guardare prima.
3. Taratura visiva dell'emersione su musica reale (visibilità a distanza, altezze, luce); varianti di forma.
4. Portare i solidi fuori dal DEV in una scena Particles, se a occhio convincono; mettere Terrain nel rig Free.
5. La modalità 3 (distacco di regioni) come studio di architettura della mesh.
