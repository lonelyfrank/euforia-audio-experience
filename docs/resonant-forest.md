# Resonant Forest — refactor verso la direzione artistica

Riferimento visivo: la tavola **Resonant Forest — Render Mockup v0.1** (canvas di design, 16 ottobre 2026): quattro viste
(Resonant Clearing, Crystal Tree Close-up, Forest Traversal, Deep Resonant Forest), stati musicali, profili di qualità e
handoff tecnico-artistico. Il mockup è un renderer Canvas 2D: geometria, palette e parametri sono quelli usati per le
tavole, non il runtime. Questo documento è il percorso dal runtime di ottobre ([generative-worlds.md](generative-worlds.md)
§7) a quella direzione, per fasi.

Regole che il refactor non cambia: un solo `WorldEngine`; alberi ancorati al reticolo del suolo con `terrainHeight` sugli
uniform del suolo; forma fissata alla semina e mai mossa dal suono; ciclo di vita sul tempo vissuto della musica (fermo in
silenzio); memoria come firma di sei tratti × `cues.repetition`; azioni irreversibili solo su `release` confermati; leggi
GLSL e TS identiche con `runForestParity()`; Terrain bit per bit; nessuna fixture del rig finché manca la prova con musica
reale.

## 1. Fase A — audit del codice di partenza

| Area | Mockup | Runtime di partenza (`a3b9436` + `97425e2`) | Divario |
|---|---|---|---|
| Albero | volumi chiusi: tronco tubolare a 5–8 lati, svasato, curvo, radici, rami gerarchici fino alla profondità 4, rametti, fiori | prisma a 3 spigoli disegnato come **linee** additive, 24 segmenti, foglie triangolari | totale: wireframe vs volumi |
| Materiale | ossidiana scura, luce di base costante (key, rim dall'orizzonte, rimbalzo), facce emissive con gradiente, venature | solo colore additivo dalla palette dell'app, nessuna occlusione | totale |
| Emissione | scala E per stato: 0,30 silenzio … 1,00 drop; nodi a parte | luce per albero da crescita, risonanza, flush | manca la scala E |
| Cristalli | radice, ramo, sospesi (170), di risonanza | nodi = triangoli piatti alle biforcazioni | totale (Fase C) |
| Rete | filamenti a catenaria fra ancore di profondità 2, k vicini, corde fra monumentali, impulsi | segmento retto fra le chiome di alberi che ricordano la stessa musica | parziale (Fase C) |
| Suolo | low-poly scuro illuminato, radura e ruscello bagnati con riflesso stilizzato, crepe emissive, anelli sul drop | wireframe del Terrain additivo + facce quasi nere | totale (Fase D) |
| Cielo e aria | gradiente zenit → bagliore viola all'orizzonte, nebbia esponenziale colorata in quota, colonne di luce, particelle | sfondo del compositore (vuoto + foschia "navy" + stelle) **additivo sotto ogni scena**; nebbia della foresta verso il nero | totale (Fase D, con una decisione: §5) |
| Popolazione | ~25 alberi in vista, monumentali (40–54 m), pareti di foresta ai lati del percorso | pool di 40, una pianta per lato ogni 3 righe, 6–13 unità | parziale |
| Camera | quattro composizioni fisse | Glide + Drift nel corridoio, nessuna composizione | da decidere (Fase D) |
| Qualità | Low/Medium/High: lati, profondità, LOD, distanza, cristalli, riflessi, bloom | filamenti spenti a Low, suolo più rado | parziale |

Vincoli scoperti nell'audit:

- **Il compositore è additivo** (`compositeShader.ts`): `backdrop(uv) + scene(uv)`. Ciò che una scena disegna di scuro
  non copre la foschia e le stelle del cielo: un tronco "nero" lascia passare lo sfondo. Le silhouette scure del mockup
  contro un orizzonte luminoso richiedono che la scena possa coprire lo sfondo (§5).
- `TerrainPrimitive` è condiviso con Generative Terrain (digest bit per bit) e Monolith Desert: ogni cambio d'aspetto del
  suolo per la foresta deve essere opt-in, con default che lasciano il Terrain com'è.
- Scala: il mockup è in metri, il runtime in unità del reticolo (cella 1,5). Ho adottato **1 unità ≈ 2 m** per altezze,
  nebbia e luci (nebbia 0,009 m⁻¹ → 0,018 unità⁻¹, quota della nebbia 22 m → 11, colore della nebbia a 38 m → 19).
- Distanza LOD per albero: il mockup sceglie il dettaglio in base alla distanza della vista fissa; nel runtime gli alberi
  vengono incontro all'osservatore, e la forma si fissa alla semina. Il dettaglio è quindi **per qualità**, non per
  distanza (la geometria non cambia mentre un albero si avvicina).

## 2. Piano

| Fase | Contenuto | Stato |
|---|---|---|
| A | Audit (questo documento) | fatto |
| B | Anatomia dell'albero a volumi chiusi, materiale ossidiana e luce di base, facce emissive e venature, scala E e scala nodi dagli stati musicali, dettaglio per qualità, parità | **fatto** (§3) |
| C | Cristalli (radice, ramo, sospesi, risonanza) e rete di risonanza: ancore di profondità 2, catenarie, vicini, corde fra monumentali, impulsi datati sugli eventi (`EventCursor`, nessun secondo clock) | da fare |
| D | Ambiente: suolo della foresta (opt-in su `TerrainPrimitive`: facce illuminate, radura/ruscello bagnati, crepe emissive, anelli sul rilascio udito), cielo con bagliore d'orizzonte e nebbia colorata, colonne di luce, particelle; popolazione più densa e monumentali; composizioni della camera | da fare, una decisione aperta (§5) |
| E | Profili di qualità completi, budget misurati sulla Intel UHD (Low/Medium/High), prova a occhio con musica reale | da fare |

## 3. Fase B — l'albero cristallino

**Anatomia** (`forestLaw.ts`, `growTree`): funzione pura di seme, tratti musicali quantizzati alla semina e dettaglio della
qualità; nessuna allocazione (scratch di modulo).

- Tronco: tubo chiuso di `sides` facce (7 a High, +1 per i monumentali) e `rings` anelli; ogni anello ruotato e con raggi
  ±15 %; svasatura ×1,65 alla base (×1,35 a Low); rastremazione fino a 0,6 r0; curvatura laterale 5–12 % della lunghezza;
  parte mezzo raggio sotto il punto di radice. Si divide al 40–58 % dell'altezza.
- Radici: 3–6 tubi a 4 lati dalla svasatura verso il basso e fuori, lunghi 1,6–2,8 r0.
- Rami: 2–3 limbi dal colmo del tronco; poi in ampiezza (la crescita e un budget esaurito arrivano alle punte per ultime)
  figli ×0,62–0,78 in lunghezza e ×0,53–0,61 in raggio, spinti in alto; tre figli al primo livello, due o tre dopo
  (`branching`). Sotto 0,004·H di raggio un ramo è una linea.
- Rametti: due livelli di linee scure alle punte, fiori puntiformi viola/lilla/magenta/blu; nodi alle biforcazioni.
- Monumentali: 12 % degli alberi, altezza ×1,5, raggio ×1,12, un lato e due anelli in più.
- Tratti musicali come prima: `branching` dalla ramificazione della geometria, `spread` dalla curvatura, `upright` dalla
  tensione, `foliage` dalla densità; altezza dal seme fra `low` e `high` (ora 10–18 unità).

**Emissione** (scritta alla semina, mai mossa): probabilità per triangolo 0,1 × (0,4 + 1,6 (1−h)²) sul tronco (più luce in
basso; magenta/viola sotto il 30 %, viola/lilla/blu/ciano sopra), 0,14 sulle radici, 0,06 sui rami; le colonne-vena 0,5.
Una o due colonne di spigoli del tronco (una sui limbi, metà delle radici) sono **venature**: una linea lungo lo spigolo,
almeno un pixel e mezzo (`fwidth`), intensità 1 alla base → 0,55 in cima.

**Disegno** (`ForestPrimitive.ts`, `forestLook.ts`): quattro draw call (tre a Low).

| Draw | Cosa | Stato GL |
|---|---|---|
| corteccia | tronchi, radici, rami: triangoli piatti, normale per faccetta da `dFdx/dFdy` | opaca, depth write |
| rametti | linee scure, nebbia | opaca |
| fiori e nodi | triangoli additivi | additiva |
| filamenti | come prima (Fase C li rifà) | additiva, non a Low |

- Pool fisso: ogni slot ha la sua parte dei buffer (2 556 vertici di corteccia e 512 di rametti a High, 2 046/384 a
  Medium, 768/192 a Low; **multipli di un triangolo e di una linea**: una parte che non inizia su una primitiva sfasa
  tutti i triangoli degli slot seguenti — è stato il primo difetto visto sulla GPU). Scrittura parziale alla semina.
- Legge del vertice: `radice(J, R) + lean(base + (punto − base) · cresciuto(nascita))`. Un segmento cresce dal suo inizio;
  un vertice non usato nasce dopo la maturità e non cresce mai.
- Luce di base costante (in spazio display come il mockup, poi lineare una volta): ossidiana × tono della faccia + key
  (−0,50, 0,55, 0,65) + rim² dal bagliore d'orizzonte (0, 7, −220) + rimbalzo viola sulle facce verso il basso.
- Nebbia: `(1 − e^(−d·0,018)) · (0,62 + 0,38 e^(−y/11))`, colore da #422696 al suolo a #101036 a 19 unità; dissolvenza al
  fondo e ai lati del reticolo come il suolo.
- Palette propria della foresta (`DEFAULT_LOOK`, sovrascrivibile da `visual.look` della preset): la foresta non prende
  la palette dell'app (il tint del compositore continua ad agire sul layer).

**Scala E e nodi** (`forestGrowth.ts`): dalla fase della cognizione (silenzio 0,30/0,35, breakdown 0,45/0,50, groove
0,75/0,70, rising 0,82/1,15, release 1,00/1,00; senza cognizione 0,30 + groove), seguite in 1,5 s sul frame e **ferme**
quando arrivano (aggancio entro 1e-4). Un rilascio udito porta E a 1 e la lascia in 2,5 s. Mai dal livello; la luce di
base non ne dipende. Silenzio: una foresta fioca, non assente.

### Misure (sintetiche, CPU limitata a 7 W, Intel UHD)

- `growTree` a High: ~1 700 vertici di corteccia in media; 0,18–0,25 ms per albero (una volta alla semina; la prima semina
  ne fa diversi nello stesso frame; ×3–4 mentre gira tutta la suite). Bench: soglia 1,5 ms. Il frame della foresta a pool
  pieno resta ~40–60 µs.
- `runForestParity()` sulla Intel UHD: corteccia 11 892 vertici, rametti 2 964, fiori 2 388: mediana 3,6e-4 unità, massimo
  0,0167 (la divergenza f32 nota dell'hash del terreno, [scene-families](scene-families.md) §6); radici sul vertice del
  suolo sulla GPU entro 7,6e-8. La prova ora rende i punti senza frustum culling (prima un layout lontano dall'origine
  veniva scartato da three e la prova leggeva il render precedente).
- Catture deterministiche (`scripts/visual-fidelity-browser.mjs`, `buildDrop`, High): gli alberi sono volumi chiusi
  sfaccettati; il resto della scena (suolo wireframe, cielo del compositore) è ancora quello di prima.

Non verificato: musica reale, a occhio nel tempo, Windows/Tauri, costo GPU per qualità (Fase E).

## 4. Differenze dal mockup che restano dopo la Fase B

- Suolo wireframe e cielo del compositore: la scena non ha ancora l'orizzonte viola né il suolo scuro (Fase D).
- Pochi alberi, lontani dal corridoio: la popolazione è quella di prima (Fase D).
- Nessun cristallo, rete ancora retta fra le chiome (Fase C).
- Alberi trasparenti alla foschia e alle stelle del cielo (§5).

## 5. Decisione aperta: coprire lo sfondo del compositore

Il mockup vive di silhouette scure contro un cielo che si accende all'orizzonte. Con la composizione additiva una scena
non può essere più scura dello sfondo che le sta dietro. Strade possibili:

1. **Copertura opt-in nel compositore**: il layer porta in alfa quanto la scena è opaca (0 dove non ha disegnato nulla);
   il compositore fa `backdrop · (1 − copertura) + scena`. Default: copertura 0 per ogni scena esistente (immagine
   identica), la foresta la scrive. Resta un pass solo. Tocca `compositeShader.ts`, il clear dei layer e la verifica
   delle altre scene (riflesso, crossfade).
2. **Cielo della scena**: la foresta disegna il proprio cielo (gradiente e bagliore) in fondo al suo layer; lo sfondo del
   compositore resta sotto, sommato. Nessun cambio condiviso, ma stelle e foschia dell'app restano visibili attraverso i
   tronchi e il cielo risulta più chiaro del mockup.
3. Accettare lo sfondo dell'app come cielo della foresta.

Raccomandazione: 1 (è l'unica che dà le silhouette), con il default che non cambia nessuna scena.
