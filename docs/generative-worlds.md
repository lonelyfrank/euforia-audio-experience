# Generative Worlds: moto del mondo, ambienti procedurali, ecosistemi musicali

Data: 15 ottobre 2026. Branch `generative-worlds` da `scene-taxonomy-worlds` (`80206a7`), **non pushato, non mergiato**.
Brief: «Generative Worlds Expansion — Hybrid World Motion, Procedural Environments & Musical Ecosystems».
Tutto deterministico e con audio live: nessuna traccia precaricata, nessuna rete, nessun modello generativo,
nessun secondo WorldEngine, DSP, beat tracker, solver o registry.

| Commit | Step | Contenuto |
|---|---|---|
| `22721bd` | 1 | Cinque profili di locomozione e un rig di camera che una recipe può dare al suo osservatore |
| `ad7bb50` | 2 | Monolith Desert: il suolo del Terrain come pianura, monoliti che ne emergono |
| `1ef6efd` | 3 | Fractured Expanse: corpi sospesi del motore strutturale, camera in orbita |
| `d33d5ed` | 4 | Pulse Ocean: un mare geometrico su tre scale, sorvolato e cavalcato |
| `a3b9436` | 5 | Resonant Forest: una foresta che cresce dalla musica che sente e la ricorda; progetto dei mondi futuri |
| `69a79bd` | 6 | Integrazione: laboratorio Emergence · Worlds, robustezza, cambi scena, costi |
| (ultimo) | 7 | Rifiniture del laboratorio, documentazione, misure, README, AGENTS.md |

## 1. Stato iniziale (audit)

Il branch di partenza conteneva già ciò che il brief chiede di verificare prima (§0):

| Area | Trovato | Uso in questa espansione |
|---|---|---|
| Tassonomia | `category` obbligatoria nel registry (`particles`/`worlds`/`spectrum`), menu Scene → famiglia → scena, `scenesOf`/`categoryOf` | Le nuove scene sono `category: 'worlds'` con un `order` dopo il Terrain: compaiono da sole nell'anello Worlds |
| Composizione | `VisualWorld` + `WorldRecipe` (slot di primitive, budget, presenza) + `RecipeVisualizer` | Bastano: nessun livello di composizione nuovo. Aggiunto solo un campo opzionale `camera` alla recipe |
| Camera | `Observer` condiviso (inerzia, orbita come quota del giro del mondo) per le recipe Particles; il Tunnel ha il suo coordinatore; il Terrain tiene la camera ferma e fa scorrere il suolo | Il contratto nuovo affianca l'`Observer`, non lo sostituisce; Tunnel e Terrain invariati |
| Emersione | `EmergenceField` (pool fisso, ciclo dormant → … → recycle, cue, `FractureGate`), legge GLSL/TS ancorata a `terrainHeight` | Riutilizzata per i monoliti (posizionamento "pianura", forme, landmark: tutto spento di default) |
| Solidi | `SolidSystem` dentro `StructuralSystem`, popolazioni (`SolidPrimitive` + `population`) solo DEV | Riutilizzati per Fractured Expanse, la prima scena di prodotto fatta di solidi |
| Cue musicali | `snapshot.cues`: anticipazione, previsione, accento, frase, rilascio **udito** | Ogni azione irreversibile dei mondi nuovi agisce solo su `release` confermati |

Baseline prima di toccare il codice: typecheck e lint verdi; `vitest` 88 file, 739 test passati, 5 falliti, 1 saltato.
I cinque falliti erano quattro benchmark e un timeout di `AnalysisHost` con la CPU limitata a 10 W (batteria in
scarica); ripetuti da soli con un worker passano tutti (744 + 1 saltato). Core Rust non toccato.

## 2. Architettura: un WorldEngine, molti ambienti

Nessun motore nuovo. Ogni mondo è una **recipe** (`defineRecipe`) di primitive nel suo `VisualWorld`, come le scene
Particles e il Terrain: condivide stato musicale, clock udito, `WorldState`, eventi, cognizione e cue (dallo
snapshot), regia, qualità, ciclo di vita delle primitive. L'unica estensione dei contratti esistenti:

```text
WorldRecipe.camera?: WorldCamera        // l'osservatore del mondo, se ne ha uno suo
VisualWorld.update:  … interpretazione → camera.step(frame) → primitive …   (la camera prima: ciò di cui sposta la scena è di questo frame)
VisualWorld.place:   camera ? camera.apply(…) : observer.apply(…)
VisualWorld.reset:   … camera.reset()
VisualizerDefinition.locomotion?: Locomotion[]     // metadato per gli strumenti (Tunnel: travel, Terrain: glide)
```

Senza `camera` una recipe è quella di prima bit per bit (l'`Observer` fa lo stesso passo). Il "livello di
composizione" del brief (§1.1) non è servito: terreno, solidi, particelle, campi, onde e camera si combinano già come
slot della stessa recipe; le relazioni fra primitive passano per riferimenti fra slot creati nello stesso builder (i
monoliti e gli alberi leggono il suolo dello stesso frame, le costellazioni leggono i corpi), come faceva già
l'emersione.

| Mondo | `id` | `order` | Locomozione | Primitive |
|---|---|---|---|---|
| Infinite Tunnel | `tunnel` | 1 | travel (metadato) | invariato |
| Generative Terrain | `terrain` | 12 | glide (metadato) | invariato |
| Monolith Desert | `monolith-desert` | 13 | glide + hover | `TerrainPrimitive` + `EmergencePrimitive` |
| Fractured Expanse | `fractured-expanse` | 14 | orbit | `SolidPrimitive` (popolazione) + `FieldTracerPrimitive` + `ConstellationPrimitive` + `ShockwavePrimitive` |
| Pulse Ocean | `pulse-ocean` | 15 | glide + drift | `OceanPrimitive` |
| Resonant Forest | `resonant-forest` | 16 | glide + drift | `TerrainPrimitive` + `ForestPrimitive` |

## 3. Hybrid World Motion (`render-systems/camera/locomotion.ts`)

```text
WorldView (+ tempo udito, + il soggetto che la scena offre)
   │  MotionInput { dt, view, time, timed, focus{x,y,z,weight} }
   ▼
profili (pesati; un profilo può avere una presenza propria: hover = calma del mondo)
   │  ognuno somma alla posa di riposo ciò che chiede: dP, dT, lente, rollio; e la distanza di cui porta avanti la scena
   ▼
CameraRig: limiti (reach, lente, rollio) → corpi critici smorzati (passi esatti) → posa → camera
           advance / speed: il moto relativo della scena · hold: quanto l'hover trattiene l'avanzamento
```

| Profilo | Legge | Cosa lo muove | A riposo |
|---|---|---|---|
| **Travel** | avanzamento = viaggio del mondo × `stride`, seguito su `tau` (un colpo è una spinta, non uno strappo); rollio nella curva | `dTravel`, `spin`, `speed` | fermo |
| **Glide** | come Travel ma più morbido; quota che sale con la pressione; lente che si apre con la velocità; `ride`: segue l'onda lunga sotto di sé | `pressure`, `speed`, la superficie della scena | quota di riposo |
| **Orbit** | angolo = quota del **giro del mondo** + quota del suo viaggio; elevazione dall'apertura; distanza che respira con la pressione e si stringe con la tensione (0,7…1,5); mira verso il soggetto | `dTurn`, `dTravel`, `openness`, `pressure`, `tension` | l'angolo resta dov'è |
| **Hover** | presenza = calma del mondo; sale con l'apertura e verso ciò che cresce; si sposta verso il lato del suono; gira lo sguardo (non l'osservatore) verso il soggetto; trattiene l'avanzamento | `speed`, `openness`, `lateral`, `tension`, il soggetto | posa di riposo |
| **Drift** | percorso laterale funzione della **distanza percorsa** (nessuna distanza, nessuna curva), più largo con la turbolenza e più semplice con la coerenza; guarda avanti lungo il percorso, si inclina nelle curve solo mentre si muove; mai oltre `corridor` | `dTravel`, `disorder`, `coherence`, `speed` | resta dove il percorso l'ha lasciato |

Regole (test `locomotion.test.ts`):

- **Nessun tempo proprio, nessun clock musicale**, nessuna lettura della cattura o della cognizione: solo `WorldView`
  seguito esattamente su un frame, o somme dello spostamento del mondo. Stesso percorso a 30, 60 e 144 fps (ingressi
  tenuti: esatto; l'angolo dell'orbita è una rampa campionata: entro 3 centesimi su raggio 10).
- **A riposo** ogni offset è zero e l'osservatore si ferma; l'orbita non gira perché passa il tempo.
- **Limiti**: `reach` attorno alla posa di riposo (per un'orbita il suo diametro), lente e rollio limitati;
  l'accelerazione è limitata dai corpi smorzati (`ω² × 2·reach`): nessuno strappo di un frame.
- **Primo frame e reset**: la posa chiesta è presa subito (un mondo montato non "vola dentro").
- `Travel` è nel vocabolario ma il Tunnel **non** lo usa: il suo `TunnelMotionCoordinator` resta com'è
  (`tunnel/preservation.test.ts`, digest invariati). Il Terrain non ha camera: il suo moto resta `TerrainMotion`.

`RigCamera` (`visual-engine/RigCamera.ts`) è il `WorldCamera` fatto di un rig: `aim` scrive il soggetto prima del passo
(leggendo ciò che le primitive hanno mostrato), `after` passa il risultato alla scena (quanto avanza il suolo).

## 4. Monolith Desert

**Riuso**: il suolo è `TerrainPrimitive` con parametri da deserto (fondovalle più largo della vista: 50 unità di
semiampiezza; mesas lontane ai bordi; celle grosse, 3 unità: un deserto più low-poly e monoliti più larghi; quota 7,
passo più lento), i monoliti sono l'**emersione del Terrain**. Nessuna legge copiata. Estensioni dell'emersione, tutte
spente di default (i test e i digest del Terrain sono invariati):

| Parametro | Default (Terrain) | Deserto |
|---|---|---|
| `placement` | `walls` (accanto alla valle) | `plain`: sul fondo, fuori da un corridoio di `corridor` unità attorno alla linea di volo |
| `forms` | — (decide il suolo) | `block, block, pillar, prism`: lastre, pilastri, prismi |
| `keep` | 0 | 3: il breakdown lascia in piedi i tre più alti (i landmark del luogo) |
| `low` / `high` (× rilievo) | limiti 1,5 / 2 | 1,0 / 2,4 (limiti alzati a 3 / 4) |
| `fracture` | on | **off**: il deserto è emersione e scala; la frattura è l'identità di Fractured Expanse |
| `focus()` | — | lettura (non cambia nulla): il monolite che il luogo mostra ora, con isteresi (un altro deve chiedere 1,5×) |

`TerrainMotion.pace` (default 1: `× 1` è esatto) è la quota del viaggio del mondo che il suolo percorre: il deserto lo
lega a `rig.hold`, così mentre l'osservatore è in hover il deserto scorre più lento.

| Momento | Comportamento |
|---|---|
| intro / groove stabile | pochi monoliti (densità 0,16), lontani: lo spazio vuoto domina |
| build | la densità sale con la tensione; ciò che nasce durante una previsione attende in formazione |
| rilascio udito | i monoliti in attesa emergono, le righe seguenti si riempiono (più alti), il fronte del rilascio corre sul suolo |
| breakdown | niente di nuovo; si ritirano uno ogni 1,2 s, tranne i tre più alti |
| silenzio | niente nasce, niente si muove, l'osservatore si ferma |

Camera: Glide (quota stabile, la profondità della pianura) + Hover (con la musica calma: quasi fermo, sale e gira lo
sguardo verso il monolite che emerge; quando il mondo corre l'hover sparisce).

## 5. Fractured Expanse

Uno spazio profondo senza suolo. Sette corpi di `SolidSystem` (un solo solver, materiale `rigid`, `FractureGate`) in
tre gruppi, nei campi e nei fronti condivisi, con la risonanza del mondo per frequenza propria (`recipe.resonance`).

| Stato richiesto | Come esiste |
|---|---|
| aggregazione | `start: 'free'`: la materia si raccoglie e sigilla quando il mondo lo permette (formati a ~15 s su `buildDrop`) |
| stabilità | materiale rigido: ritenzione di forma, pulsazione uniforme ≤ `PULSE_LIMIT` |
| risonanza | `ResonanceField`: ogni corpo risponde alla sua frequenza propria (i medi lo fanno vibrare) |
| perturbazione | pressione e deriva del campo (i bassi spingono e spostano) |
| frattura | solo un `release` **udito**, al passo che raggiunge il suo tempo audio; mai accento né previsione |
| dispersione / ricomposizione | i pezzi volano via e si ritrovano dove la fisica lo permette (memoria dei link per minuti: la storia della frattura resta) |

Primitive di supporto: la **polvere** del campo (`FieldTracerPrimitive`, 6 000 traccianti a High, senza memoria
visiva: con la memoria impastava lo schermo), i **fronti** (`ShockwavePrimitive`) e una primitiva nuova,
`ConstellationPrimitive`: linee fra i pezzi che erano un corpo (il ricordo di una frattura, nel colore di ciò che
scotta, finché il motore non li riunisce) e fra pezzi vicini di corpi diversi, accese dagli alti. Un draw call.

Camera Orbit: gira con una quota del giro e del viaggio del mondo; dopo un rilascio lo sguardo va sul corpo che si è
rotto (6 s) e torna all'insieme; distanza che respira, elevazione dall'apertura.

**Decisione da confermare**: AGENTS.md diceva «nessun solido nelle scene del prodotto». Il brief chiede esplicitamente
questa scena di prodotto con SolidDynamics: il test ora dice che **nessuna scena Particles** contiene solidi e che
**l'unica** scena di prodotto fatta di solidi è Fractured Expanse; AGENTS.md è aggiornato di conseguenza. Una
popolazione accetta ora il budget che le si passa (la popolazione DEV riceve il default: invariata).

## 6. Pulse Ocean

Nessuna fluidodinamica. Il mare è un reticolo su cui la mesh scorre (il reticolo del Terrain, ora un costruttore
condiviso: `lattice.ts`; la mesh del Terrain è identica al bit, digest registrati prima dell'estrazione), la sua
altezza una **legge nuova in GLSL e TS** (`oceanLaw.ts`):

| Scala | Onde | Cosa la porta | Tempo |
|---|---|---|---|
| swell | 2 lunghe (48 e 34 celle) | energia persistente e struttura: apertura, pressione, potenziale, eccitazione | seguite su 3 s |
| groove | 3 medie (14, 10, 8 celle), creste appuntite dai medi duri | il groove dei bassi (eccitazione su 0,6 s) | 0,6 s |
| ripple | 2 corte (4, 3 celle) + bagliori sui punti del reticolo | l'attività degli alti (shimmer su 0,25 s) | 0,25 s |
| fronti | anelli dei fronti datati del mondo; un rilascio è un fronte che corre via dall'osservatore (45 u/s) | eventi, `releaseAge` | età |

- Le **fasi** sono calcolate sulla CPU in doppia precisione dal punto del reticolo da cui parte la mesh: niente
  cuciture né perdita di precisione dopo ore di viaggio (test con 3·10⁷ righe).
- Il **tempo proprio delle onde** è l'integrale esatto di quanto il mondo è vivo (`RateFollower`): in silenzio le onde
  rallentano, si appiattiscono e si fermano; è un mare calmo, non un mare congelato a metà.
- Un rilascio cambia **quanto conta** ogni onda (5 configurazioni scelte dal suo tempo audio, `Reorganization`),
  in dissolvenza sull'età del rilascio; mai la direzione (un mare ruotato scorrerebbe via).
- Camera Glide (cavalca l'onda lunga sotto di sé: il 35 % dell'altezza, lo sguardo la metà) + Drift (± 4 unità).

`runOceanParity()` sulla Intel UHD: media 3,6e-5, massimo 2,8e-4 unità (soglia 2e-3).

## 7. Resonant Forest

Sul suolo del Terrain (colline basse, una radura che il volo segue). Alberi: un ciclo di vita nuovo
(`forestGrowth.ts`) e una legge nuova in GLSL e TS (`forestLaw.ts`). Dal 16 ottobre gli alberi seguono la direzione
artistica del mockup: volumi chiusi sfaccettati, materiale ossidiana, emissione strutturale per stato; quattro draw call
(corteccia, rametti, fiori e nodi, filamenti; a Low niente filamenti). Percorso, fasi e misure:
[resonant-forest.md](resonant-forest.md); ciò che segue in questa sezione sul ciclo di vita e sulla memoria vale ancora.

```text
dormant → seed (1,2 s) → growth (profondità dopo profondità, punta per ultima) → mature ⇄ resonance → decay (foglie che cadono, rami che rientrano) → recycle
```

- **Forma**: fissata alla semina da seme + musica sentita allora (ramificazione, curvatura, densità della geometria;
  la tensione tira i rami in alto), quantizzata a quarti: un frame di differenza non cambia un albero. Tronco, radici e
  rami tubolari chiusi, rametti e fiori ([resonant-forest.md](resonant-forest.md) §3). Non cambia mai forma dopo:
  cresce, si piega rigidamente (vento: il lato del suono, ≤ 0,06 rad), decade.
- **Ancoraggio**: il tronco parte dal vertice del suolo al suo punto del reticolo, attraverso `terrainHeight` sugli
  stessi uniform (come i monoliti), 8 cm sotto: non può galleggiare.
- **Dove e quanto**: le righe che entrano in vista, fuori da una radura larga quanto il corridoio + la chioma; la
  densità dallo stato lento (groove), mai dal livello; la crescita va più veloce col groove forte e il clock stabile.
  Al primo istante di musica tutto il suolo in vista viene seminato (semi che crescono con ciò che segue).
- **Memoria (Musical Cognition)**: ogni albero conserva la firma della musica in cui è nato (sei tratti lenti della
  geometria: forma tonale, rumorosa, curvatura, durezza, densità, ramificazione). Quando la cognizione sente la musica
  **ripetersi** (`cues.repetition`) e la firma attuale torna vicina a quella, quegli alberi risuonano di nuovo e
  filamenti li uniscono. Memoria tipizzata di configurazioni: non riconosce una canzone né ne prevede il futuro.
- **Cue**: previsione → gemme (i nodi si accendono), ritirata → si spengono; rilascio udito → gli alberi maturi
  fioriscono di luce e aprono tutte le foglie, le righe seguenti si seminano; breakdown → i più deboli decadono uno
  ogni 1,5 s; ogni albero vive `span` secondi di musica e poi decade.
- **Camera**: Glide + Drift in un corridoio (± 2,5) più stretto della radura (7 + chioma): testato che nessun ramo
  vicino all'osservatore entri a meno di 1,5 unità dal corridoio in 150 s di volo con turbolenza alta.

`MusicalCues` espone ora due **livelli** in più, copiati dalla cognizione: `repetition` (quanto le ultime battute
ripetono il pattern) e `stability` (stabilità del clock). Mai cue; zero senza cognizione. Il Tunnel non legge i cue.

`runForestParity()` sulla Intel UHD: mediana 2e-4 unità; radici sul vertice del suolo sulla GPU entro 8e-8; il
massimo (0,017) è l'albero il cui punto cade sulla divergenza f32 nota dell'hash del terreno
([scene-families](scene-families.md) §6).

## 8. Continuità musicale

| Mondo | Previsione (`prepare`/`withdraw`) | Osservazione (`accent`) | Conferma (`release` udito) | `drop` dell'Experience |
|---|---|---|---|---|
| Monolith Desert | i monoliti nuovi attendono in formazione / rientrano | luce sul più vecchio | emersione, burst | mai |
| Fractured Expanse | — | — (configurabile, default no) | frattura (gate), sguardo sul corpo rotto | mai |
| Pulse Ocean | — | — | (legge `releaseAge` del mondo: il fronte e la nuova configurazione, come il Terrain) | indiretto, come il Terrain |
| Resonant Forest | gemme / spente | luce sul più vecchio | fioritura, semina | mai |

Nessun secondo rilevatore; i detector globali non sono stati toccati. Eventi a bassa confidenza: non passano i cue
(accenti sotto significance 0,7 o confidenza 0,5, previsioni sotto 0,35): il mondo resta nella sua risposta continua.

## 9. Stato, persistenza, ciclo di vita

| Fase | Cosa succede |
|---|---|
| creazione | il builder crea la recipe (camera compresa): ogni montaggio ha la sua |
| attivazione | `init`: risorse GPU una volta; la camera prende la posa al primo frame |
| aggiornamento | interpretazione → camera → primitive, senza allocare (pool e buffer a dimensione fissa) |
| sospensione | silenzio o assenza di clock: niente nasce, niente si muove (test per ogni mondo) |
| reset | nuova sessione (il clock torna indietro): followers e cue dimenticati; ciò che sta in scena resta e si rilassa |
| smontaggio | `dispose`: ogni geometria e materiale creati (test: dieci montaggi/smontaggi per mondo, alle qualità alternate) |

Memoria locale di ciascun mondo: nei suoi pool (monoliti ≤ 64, corpi 7 con link ricordati, alberi ≤ 40 con firma).
Nulla di condiviso fra mondi, nulla oltre la sessione; la memoria dei link dei corpi è quella del motore (minuti).

## 10. Menu e regia

Scene → **Worlds**: Infinite Tunnel, Generative Terrain, Monolith Desert, Fractured Expanse, Pulse Ocean, Resonant
Forest (verificato nel browser: scegliere ciascuno cambia scena senza toccare la sessione audio). ID esistenti
invariati. Preset e palette: ogni mondo ha il suo `preset.json`; la palette arriva per `setPalette` come a tutte.

**Regia automatica: non toccata.** I mondi nuovi non sono in `show/fixtures.ts` (come il Terrain): il costo GPU è
misurato (§11), il comportamento con musica reale no. Proposta per quando lo sarà (affinità da verificare):

| id | costo proposto | intro | build | drop | break | outro |
|---|---|---|---|---|---|---|
| monolith-desert | 1 | 0,8 | 0,6 | 0,5 | 0,8 | 0,9 |
| fractured-expanse | 1,1 | 0,5 | 0,8 | 0,9 | 0,6 | 0,6 |
| pulse-ocean | 1 | 0,8 | 0,7 | 0,6 | 0,9 | 0,8 |
| resonant-forest | 1 | 0,9 | 0,6 | 0,5 | 0,8 | 0,9 |

## 11. Prestazioni

### GPU reale

Chromium headless sulla Intel UHD (ANGLE GL ES 3.2), 1280×720, vsync 60 Hz, `buildDrop`, 10 s misurati da 12 s,
pagina nuova per prova, due giri alternati, CPU a 28 W; il server di sviluppo dell'utente era attivo. Valgono solo i
confronti dentro la stessa serie (dati: `generative-worlds-benchmark.json`).

| Qualità | Scena | fps (giro 1 / 2) | p95 / p99 ms | frame > 33 ms | JS ms/frame | draw | primitive | geometrie / programmi |
|---|---|---|---|---|---|---|---|---|
| Low | Terrain | 60 / 60 | 16,7 / 16,7 | 0 / 0 | 1,6–2,8 | 4 | 45 762 | 4 / 4 |
| Low | Monolith Desert | 60 / 60 | 16,7 / 16,7 | 0 / 0 | 1,7–2,0 | 4 | 29 556 | 4 / 4 |
| Low | Fractured Expanse | 60 / 60 | 16,7 / 16,7 | 0 / 0 | 2,5–2,7 | 9 | 9 793 | 8 / 9 |
| Low | Pulse Ocean | 60 / 60 | 16,7 / 16,7 | 0 / 0 | 1,5 | 3 | 53 791 | 3 / 3 |
| Medium | Terrain | 46,9 / 46,6 | 33,3 / 33,3 | 0 / 0 | 2,9 | 19 | 86 623 | 5 / 14 |
| Medium | Monolith Desert | 48,5 / 47,8 | 33,3 / 33,3 | 0 / 0 | 2,8 | 17 | 50 960 | 5 / 14 |
| Medium | Fractured Expanse | 47,5 / 48,6 | 33,3 / 33,3 | 1 / 0 | 4,2–4,3 | 23 | 15 238 | 8 / 18 |
| Medium | Pulse Ocean | 49,1 / 48,4 | 33,3 / 33,3 | 0 / 0 | 2,7 | 17 | 97 445 | 3 / 12 |
| High | Terrain | 34,0 / 34,8 | 33,3 / 50 | 6 / 9 | 3,4–3,5 | 19 | 132 089 | 5 / 14 |
| High | Monolith Desert | 34,3 / 35,5 | 33,3 / 50 | 4 / 3 | 3,3–3,4 | 19 | 78 006 | 5 / 14 |
| High | Fractured Expanse | 34,8 / 38,7 | 33,3 / 50 | 7 / 2 | 4,7–5,7 | 24 | 21 543 | 8 / 18 |
| High | Pulse Ocean | 36,2 / 37,4 | 33,3 / 50 | 4 / 3 | 3,0–3,2 | 17 | 150 961 | 3 / 12 |

Seconda serie (stesse condizioni, dopo la foresta):

| Qualità | Scena | fps | p95 / p99 ms | frame > 33 ms | JS ms/frame | draw | primitive |
|---|---|---|---|---|---|---|---|
| Low | Terrain · Resonant Forest | 60 / 60 · 60 / 60 | 16,7 · 16,7 | 0 · 0 | 1,8–2,1 · 1,7–1,9 | 4 · 5 | 45 762 · 41 686 |
| Medium | Terrain · Resonant Forest | 48,0 / 49,7 · 46,6 / 51,3 | 33,3 · 33,3 | 0 · 0 | 2,7–2,9 · 2,6–3,0 | 19 · 19 | 86 635 · 71 075 |
| High | Terrain · Resonant Forest | 35,0 / 35,1 · 35,6 / 36,7 | 33,3 / 50 · 33,3 / 50 | 9, 5 · 9, 3 | 3,2–3,3 · 3,2–3,3 | 19 · 19 | 132 081 · 104 381 |

A Low tutti i mondi tengono 60 fps pieni su questa iGPU, come il Terrain. A Medium e High ogni scena è limitata dalla
GPU (a 1280×720 nessuna tiene i 60 fps, già misurato il 13 e il 14 ottobre): i mondi nuovi sono in linea con il Terrain
o più leggeri. Fractured Expanse costa più **CPU** (il motore strutturale: +1,3–2,2 ms di script per frame). Nessun
pass nuovo, nessuna texture nuova; i bloom/composite sono quelli di sempre.

Montaggio (dalla navigazione al primo frame del mondo, pagina nuova): 1,3–1,8 s per tutti, Terrain compreso.
**Cambio scena** a scena accesa (Medium, crossfade, tre giri): frame peggiore nei 3 s dopo il cambio 33–67 ms per i mondi
nuovi, 67–83 ms per il Terrain nella stessa serie; geometrie, texture e programmi tornano agli stessi valori a ogni giro
(nessuna risorsa orfana). Cambio qualità Low → High → Auto → Medium e ridimensionamento con la foresta in vista: nessun
errore, slot invariati.

### CPU sintetica (`bench/worlds.bench.test.ts`, µs, 28 W, non isolata)

| | p50 | p95 | p99 |
|---|---:|---:|---:|
| Rig Glide + Hover, per frame | 1,9 | 4,0 | 5,1 |
| Rig Orbit | 1,5 | 3,5 | 4,5 |
| Rig Glide + Drift (con la cavalcata) | 1,6 | 3,1 | 4,5 |
| Mare, per frame | 1,7 | 3,9 | 5,4 |
| Foresta, pool pieno (40 alberi) | 28,7 | 47,3 | 57,6 |
| Crescita della forma di un albero (alla semina) | 9,2 | 13,9 | 17,8 |
| Sette corpi di Fractured Expanse (passo strutturale) | 368 | 512 | 611 |

## 12. Diagnostica e laboratorio (DEV)

- Righe `camera.*` (posa, bersaglio, lente, rollio, velocità dell'osservatore, avanzamento, peso del soggetto, peso di
  ciascun profilo) e l'etichetta `camera.locomotion`, per ogni mondo con una camera sua; le primitive nuove arrivano
  da sole come `primitive.<mondo>.<slot>.debug.*` (monoliti, corpi, polvere, costellazione, mare, alberi).
- Laboratorio **Emergence** → soggetto **Worlds** (nessuna dashboard nuova): scelta del mondo (pin temporaneo come gli
  altri soggetti), tessere Locomotion / Observer / Speed · lens / Subject / Cues / Cost, tabella del soggetto
  (monoliti, corpi, mare, alberi e memoria), Reset del soggetto, cue sintetici (rilascio udito, previsione, ritiro,
  accento) attraverso il percorso dei cue della sessione; il mare non ne prende. Nulla di salvato.
- `scripts/workspace-browser.mjs acceptance` e `release` (build di produzione): **pass**.
- Prove di parità da console: `runOceanParity()`, `runForestParity()` (accanto a `runTerrainParity()`).

## 13. Test

| File | Cosa |
|---|---|
| `render-systems/camera/locomotion.test.ts` | profili e rig: frame rate, distanza esatta, riposo, limiti e accelerazione, orbita, hover, drift, primo frame |
| `visual-engine/VisualWorld.test.ts` (+1) | la camera della recipe sostituisce l'Observer e si resetta con la sessione |
| `visual-engine/primitives/lattice.test.ts` | la mesh del Terrain identica al bit dopo l'estrazione (digest registrati prima) |
| `visualizers/monolith-desert/MonolithDesert.test.ts` | registro, riuso, pianura fuori dal corridoio, forme, rilascio senza frattura, landmark, silenzio, hover e passo, sguardo, frame rate, qualità, spento, smontaggio |
| `visualizers/fractured-expanse/FracturedExpanse.test.ts` | registro, popolazione nel budget, aggregazione e solo rilascio rompe, sguardo, orbita ferma col mondo fermo, frame rate, silenzio senza energia, sessione di 5 minuti, smontaggio |
| `visualizers/pulse-ocean/PulseOcean.test.ts` | legge (piatta a riposo, limitata), scale separate, frame rate, rilascio, fasi dopo 3·10⁷ righe, camera (cavalca, deriva, si ferma), smontaggio |
| `visualizers/resonant-forest/ResonantForest.test.ts` | legge (forma deterministica, radice sul vertice, crescita in ordine, piega rigida), ciclo (silenzio, groove e livello, memoria, cue, budget, frame rate), camera mai negli alberi, smontaggio |
| `experience/MusicalCues.test.ts` (+1) | `repetition` e `stability` come livelli, zero senza cognizione |
| `app/engine/worlds.test.ts` | il soggetto Worlds del laboratorio senza DOM |
| `validation/worlds.robustness.test.ts` | ogni mondo: sei minuti di sessione (tempo che cambia, build, rilascio, breakdown, silenzio, cambio sorgente, audio intermittente, previsione smentita, raffica di accenti); dieci montaggi/smontaggi |
| `visual-engine/structural/ParticleSolids.test.ts` (modificato) | nessuna scena Particles contiene solidi; l'unica di prodotto è Fractured Expanse |
| `app/menus.test.ts` (modificato) | gli ID di prima restano; i mondi nuovi in coda all'anello Worlds |
| `bench/worlds.bench.test.ts` | costi CPU sopra |

Risultato finale (CPU a 28 W): `npm run check` verde, **97 file, 815 test passati, 1 saltato** (baseline: 88 file,
744 + 1 saltato da soli), build di produzione ok; core Rust (`cargo test -p spectrum-analysis -p spectrum-analysis-wasm
--offline`) verde, non toccato. I digest del Tunnel (`tunnel/preservation.test.ts`) e del Terrain (`terrain/response.test.ts`,
`lattice.test.ts`) sono invariati.

## 14. Limiti e criticità

- **Nessuna prova con musica reale né a occhio nel tempo**: segnali sintetici, harness con mondi scritti a mano,
  Chromium headless sulla Intel UHD. Tutte le tarature visive (altezze dei monoliti, densità, polvere, onde,
  dimensione delle foglie, velocità di crescita) sono punti di partenza.
- La riflessione d'acqua dell'app (impostazione `reflection`, attiva di default) taglia a metà ogni mondo sorvolato,
  Terrain compreso: per un oceano il riflesso è strano. Non toccato (è l'UI cinematica); da decidere.
- Il `drop` dell'Experience resta ±2 s fuori: i mondi nuovi non lo usano (il mare, come il Terrain, legge il rilascio
  del `WorldState`, che ne dipende).
- Fractured Expanse: nessuna collisione fra corpi (il motore non ne ha); la ricomposizione resta parziale sotto
  musica che spinge (già noto); costo CPU 0,4–0,6 ms per frame.
- Resonant Forest: le foglie sono piccole e poco visibili; la memoria scatta solo quando la cognizione vede una
  ripetizione (`repetition`), che non è stata misurata su musica reale.
- Fullscreen non provato in headless (il ridimensionamento sì). Windows, Tauri/WebKitGTK, Raspberry Pi: **non
  provati**; nessuna compatibilità dichiarata.
- La prova di parità del terreno conserva la divergenza f32 dell'hash su singoli punti (innocua per l'ancoraggio).

## 15. Validazione con audio reale — da fare

Con cattura di sistema, musica vera, a occhio, almeno Low e High:

1. Menu: Scene → Worlds → ciascuno dei quattro; cambio fra mondi con la musica che suona; nessun salto della cattura.
2. **Monolith Desert** su un brano con build e drop: i monoliti nascono rari, attendono nel build, emergono sul drop
   che si sente; nel breakdown rientrano i piccoli e restano i tre più alti; lo sguardo si gira verso ciò che emerge
   senza nausea; in pausa tutto si ferma.
3. **Fractured Expanse**: i corpi si formano, restano riconoscibili, vibrano sui medi; si rompono **solo** sul drop
   udito; i pezzi si ritrovano; l'orbita è lenta e motivata; mai rotazioni continue a musica ferma.
4. **Pulse Ocean** su musica calma e su un groove pesante: onde lunghe con l'energia, medie col groove, increspature
   con gli alti; il rilascio come un'onda che corre via; in silenzio un mare calmo; orizzonte leggibile.
5. **Resonant Forest** su un brano con strofe che ritornano: la foresta cresce, nel ritorno di una sezione gli alberi
   nati in quella sezione si riaccendono (filamenti); nessun ramo attraversa la camera.
6. Ogni mondo a Low su GPU integrata per 10 minuti: fps, frame lunghi, memoria.
7. Infinite Tunnel e Generative Terrain come prima (identici: i digest lo confermano in test).

## 16. Proposta per la fase successiva

Aggiornamento grafico del 15 ottobre 2026 (non sostituisce la verifica musicale del §15):

- Monolith Desert abilita `emergence.initial`: quando il viaggio rivela la prima nuova riga
  e la densità musicale ha un target positivo, valuta una volta anche la pianura iniziale.
  Usa hash, distanze, corridoio, densità e budget di formazione esistenti. Non aumenta la
  capacità né genera strutture a viaggio fermo. Il default è `false`, quindi il ciclo del
  Generative Terrain resta quello precedente. Questo evita di dover attraversare tutto il
  campo prima che i primi landmark raggiungano una profondità leggibile.
- Resonant Forest consuma la prima semina solo quando la musica ammette una densità positiva:
  il primo frame udibile può ancora avere fase `silence` durante l'acquisizione. Un reset di
  sessione cancella le date degli accenti e delle fioriture precedenti, preservando alberi e
  memoria geometrica. Non produce più una fioritura artificiale quando il clock torna a zero.
- Le facce ancorate del terreno/deserto hanno winding esterno (leggi TS/GLSL aggiornate
  insieme). Nessuna modifica a solver, pulse limit, camere, DSP o regia.

La [campagna visiva](visual-fidelity-audit.md) conserva le immagini prima/dopo e distingue
i comportamenti osservati da quelli ancora non dimostrati, in particolare la selettività
della memoria della foresta su musica reale.

1. Validazione con musica reale (§15), poi taratura visiva per mondo.
2. Decidere la riflessione per i mondi sorvolati (spenta per scena? un parametro del layout?).
3. Mettere i mondi validati nella regia automatica con le affinità di §10 dopo averle confrontate con la musica.
4. Harmonic Cathedral e Gravitational Abyss ([future-worlds](future-worlds.md)), nell'ordine proposto là.
5. Collisioni minime fra corpi in Fractured Expanse (un lavoro del motore strutturale, non della scena).
