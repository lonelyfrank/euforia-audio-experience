# Generative Terrain

Data: 13 ottobre 2026. Scena sperimentale, autonoma, accanto a Infinite Tunnel: il mondo condiviso
come terreno da sorvolare. Non sostituisce nulla e non conosce il Tunnel; quello che i due hanno in
comune è il mondo e i follower di [shared/motion](../src/visualizers/shared/motion.ts)
(vedi [music-response](music-response.md)).

> **Aggiornamento 14 ottobre 2026** ([scene-families](scene-families.md)): la risposta musicale ha tre scale
> (`TerrainResponse`: un colpo resta locale, massa e superficie seguono il groove; `LEGACY_RESPONSE` è il moto
> descritto qui sotto, bit per bit) e dal suolo possono emergere strutture ancorate alla sua legge (slot
> `emergence`, due draw call in più, una a Low). Con `emergence.enabled = false` la scena è esattamente il
> suolo descritto in questo documento.

> Il Tunnel è il mondo come corridoio. Il terreno è lo stesso mondo come suolo: stessa corsa, stessa
> tensione, stesso rilascio, un'altra materia.

```text
WorldView, GeometryState, MaterialState, eventi datati          (gli stessi di ogni recipe)
        │
        ▼
TerrainMotion.step          viaggio (RateFollower) · terrazze e gola (potenziale) · placche (HysteresisGate,
        │                   AccentGate) · fronte del rilascio e nuova configurazione (Reorganization)
        │  TerrainValues  → packTerrain → uTerrain[23]
        ▼
terrainLaw (GLSL e TS)      altezza di un punto del reticolo: paesaggio + ciò che il mondo aggiunge
        ▼
TerrainPrimitive            un reticolo, due draw call (faccette scure + filo), nessuna texture, nessun pass
```

## 1. Moduli

| File | Ruolo |
|---|---|
| `src/visualizers/terrain/{index.ts,recipe.ts,preset.json}` | la scena: `id: 'terrain'`, nome «Generative Terrain», recipe di una primitiva (`ground`, base), senza memoria visiva e senza Observer |
| `src/visual-engine/primitives/terrainLaw.ts` | la legge dell'altezza, scritta in GLSL (`terrainLawGlsl`) e in TS (`terrainHeight`, riferimento dei test); `packTerrain`, `terrainBound` |
| `…/primitives/terrainMotion.ts` | `TerrainMotion`: la lettura del mondo per il suolo (il corrispettivo del coordinatore del Tunnel); `CONFIGURATIONS`, `strainOf` |
| `…/primitives/TerrainPrimitive.ts` | geometria (una volta), shader, uniform; `terrainQuality` |
| `src/visualizers/shared/motion.ts` | follower, cancello e accenti condivisi con il Tunnel |
| `src/visualizers/terrain/Terrain.test.ts` | 16 test: legge, moto, scena, ciclo di vita |

È una **recipe** (`defineRecipe`), come chiede il Visual Engine: nessun visualizer monolitico, nessuna
analisi propria. La primitiva legge `frame.view`, `frame.geometry`, `frame.look`, i fronti condivisi
(`uWaveA` / `uWaveB`) e gli eventi datati attraverso `AccentGate`: mai bande, beat o spettri.

## 2. Continuità: un reticolo che non si muove

Il suolo è un reticolo di celle fisso nel mondo. Un vertice della mesh **è** un punto del reticolo
(colonna `j`, riga `r`); viaggiare fa scorrere la mesh sul reticolo di celle intere, in avanti
(`row` + `shift`) e di lato mentre l'osservatore segue la valle (`col` + `shiftX`). Quindi:

- un punto del paesaggio conserva la propria altezza mentre si avvicina: nulla «nuota» (test: la
  stessa quota, bit per bit, vista da quattro posizioni del percorso, anche a cavallo del periodo);
- il paesaggio è una funzione pura del punto (un hash e due reticoli di valori interpolati, 16 e 4
  celle): **niente da caricare, generare in anticipo o conservare**. Nessun chunk, nessuna coda,
  nessuna allocazione dopo il mount;
- si ripete ogni `PERIOD = 1024` righe, che ogni scala del reticolo e ogni dimensione di placca
  divide: la giunzione non esiste. La posizione è tenuta entro un periodo (ore di volo non fanno
  crescere nulla, né perdono precisione);
- la riga che entra in fondo e le colonne ai lati entrano dal buio (nebbia + dissolvenza dei bordi).

Chunk e LOD **non** sono stati introdotti: a qualità piena la mesh è 72 × 150 celle (32 623 vertici,
54 222 fra segmenti e triangoli), a Low 11 346 vertici; il vertex shader è il costo, ed è misurato
sotto. Se servirà più profondità, il primo passo è una spaziatura delle righe a tratti (2× oltre una
certa distanza), che conserva il reticolo.

## 3. La legge

`altezza = paesaggio + ciò che il mondo aggiunge`. Ogni termine aggiunto vale **zero in un mondo a
riposo**: resta il paesaggio, fermo e in penombra.

| Termine | Che cosa fa | Da dove viene | Classe |
|---|---|---|---|
| `relief` | l'altezza dei versanti | pressione del mondo (corpo radiale, 0,55 Hz): `relief × (1 + 0,35 · pressione)`, pressione tenuta fra −0,6 e 0,9 | media |
| `crest` | l'ottava fine del rilievo «suona» | eccitazione del mondo (decade in 0,45 s) | rapida |
| `ridge` | le creste si piegano a spigolo | `edgeHardness` / `angularity` della geometria, seguite su 0,6 s | media |
| `quake` | il suolo trema, ogni punto a modo suo | shimmer (0,18 s) | rapida |
| fronti (`uWave*`) | anelli che attraversano il suolo: i bassi alti e larghi, gli alti sottili e quasi solo luce | `WaveField` condiviso, datato sugli eventi | rapida |
| `terrace` | le quote si raccolgono su terrazze | potenziale immagazzinato oltre 0,2 (quello che la musica stabile tiene), seguito su 0,3 s | lenta |
| `throat` | la valle si stringe in lontananza | potenziale | lenta |
| `lift` | placche intere si sollevano, ciascuna come un pezzo rigido | sforzo (potenziale² + disordine) attraverso un cancello con isteresi; accento di un evento che spicca; rilascio | lenta / evento |
| `front`, `release`, `bulge` | una cresta che corre lungo la valle a 60 unità/s | l'età dell'ultimo rilascio del mondo | evento |
| `plate*`, `steps*` | dietro il fronte il suolo ha un'altra configurazione, davanti ancora la vecchia | `Reorganization` (scelta dal tempo audio del rilascio) | evento |
| `lean` | l'estremo lontano piega verso l'origine stereo: il suolo si flette come un pezzo solo | bias laterale, seguito su 0,4 s | media |

Nessun vertice è mosso da un'ampiezza audio: bassi, medi e alti arrivano come **forze del mondo**
(pressione, eccitazione, shimmer), come tratti della geometria o come eventi datati. Le placche
sono traslazioni rigide (test: ogni punto di una placca si sposta della stessa quantità), le
terrazze sono multipli esatti del gradino. Ogni altezza è limitata per qualunque ingresso
(`terrainBound`), anche con mondo rotto (NaN, infiniti) e con qualunque `dt`.

Luce: le linee portano la luce del mondo (`look.emissive`, `look.ember`) sopra una penombra di
riposo; fronti e rilascio si accendono per quanto ha ammesso il **FlashGuard** condiviso
(`look.wave`); gli alti accendono singoli punti (`look.spark`). Le diagonali del reticolo sbiadiscono
mentre il suolo si organizza in terrazze: da low-poly irregolare a griglia ordinata.

## 4. Movimento

Lo stesso principio del Tunnel, con gli stessi pezzi:

- **avanzamento**: `WorldView.dTravel × stride`, seguito su 0,2 s con l'integrale esatto
  (`RateFollower`): la distanza è quella del mondo (entro 10⁻³ righe a 30, 60 e 144 fps), un kick è
  uno slancio e mai uno scatto, e il suolo si ferma quando il mondo si ferma;
- **accelerazione / decelerazione**: sono del mondo (spinta dal moto della musica, freno delle
  intenzioni `decelerate` / `suspend`, trattenuta del potenziale): il terreno non ne aggiunge;
- **inclinazione** nel verso della rotazione del mondo (≤ 0,1 rad) e **piega** verso l'origine stereo;
- **preparazione**: il potenziale che il mondo accumula sotto una previsione credibile organizza il
  suolo (terrazze, gola) progressivamente, mai a scatto (test: < 1 % per frame);
- **rilascio**: fronte + nuova configurazione + ciò che il mondo stesso fa al drop (slancio, pressione);
- **falsa previsione**: il potenziale perde, terrazze e gola tornano indietro in secondi, le placche
  si posano; nessun fronte, nessuna configurazione nuova, nulla resta sospeso (test dedicato).

Che cosa è condiviso e che cosa no è in [music-response](music-response.md) §6.

## 5. Risorse e ciclo di vita

| | |
|---|---|
| Draw call | 2 (faccette + filo), dallo **stesso** buffer di vertici |
| Texture, render target, pass | nessuno (la recipe ha `memory: 'off'`) |
| Programmi | 2 |
| Allocazioni per frame | nessuna: `TerrainValues` e `uTerrain` sono oggetti stabili riscritti sul posto |
| Stato | una dozzina di scalari (`TerrainMotion`); a una nuova sessione i follower ripartono, il suolo percorso resta |
| Rilascio | `dispose` libera 2 geometrie e 2 materiali; 30 cicli Tunnel ↔ Terrain rilasciano esattamente ciò che 30 mount possiedono |
| Loop, timer, listener propri | nessuno (test) |
| Seme | `show/rng.ts` (`seedOf`); mai `Math.random` |

## 6. Scelte fatte, da confermare

- **Non è una fixture** (`show/fixtures.ts`): la si sceglie come ogni scena, ma il rig Free non la
  compone da sé finché non è stata giudicata con musica reale. Aggiungerla è una riga.
- **Osservatore spento**: la vista è quella del volo (camera all'origine, suolo impostato da lì).
  L'`Observer` delle recipe orbita attorno a un corpo e non ha senso su un terreno.
- **Un solo slot**: le «strutture secondarie» (guglie, piloni istanziati lungo i bordi della valle)
  non ci sono. Il budget strutturale del Visual Engine le porterebbe dentro come secondo slot.
- **Con il riflesso d'acqua attivo** (impostazione dell'app, non della scena) il terreno occupa la
  metà alta e si specchia: non è stato adattato in alcun modo.

## 7. Verifica

Automatica (`Terrain.test.ts`, 16 test): rigidità del reticolo e paesaggio; ogni termine del mondo
vale zero a riposo e fa una cosa sola; fronti; limiti e finitezza; distanza del mondo a 30 / 60 / 144
fps e attraverso il periodo; riposo senza moto (con e senza clock); build progressivo, musica stabile
senza effetto, falsa previsione senza residui; rilascio e riorganizzazione; cancello con isteresi e
accenti; registri; invarianza al frame rate (3 ‰); mondi rotti e `dt` qualunque; nuova sessione;
registry (Tunnel intatto, terreno non fixture); 2 draw call e nessun pass; nessun loop / timer /
listener; seme; rilascio delle risorse e 30 cambi Tunnel ↔ Terrain.

Su GPU reale (Chromium headless, ANGLE su Intel UHD CML GT2, segnale `buildDrop`): shader compilati
senza errori né warning, fotogrammi guardati a Low e High; misure in
[music-response](music-response.md) §10.

**Non verificato**: l'aspetto **a occhio nel tempo** e con **musica reale** (è il criterio vero);
la parità GPU ↔ CPU della legge con un readback (il riferimento TS replica la precisione singola
dello shader, ma nessuna prova in browser lo confronta: manca un `runTerrainParity()`); Tauri /
WebKitGTK e Windows; hardware diverso dalla Intel UHD di sviluppo.

## 8. Limiti noti

- **Costanti tarate su segnali sintetici**: soglie del cancello, quote di terrazze e gola, `stride`,
  altezza dei fronti.
- **Il rilascio arriva quando lo rileva l'Experience Engine**, che sul segnale sintetico non coincide
  con il drop musicale ([music-response](music-response.md) §2.4): il fronte del terreno eredita
  quell'anticipo o ritardo, come quello del Tunnel.
- **Le placche spezzano anche il fondo valle**: a sforzo pieno il percorso ha gradini fino a ± 1,1
  unità (l'osservatore è a 2,4).
- **Le linee sono larghe un pixel** (limite di WebGL): a Low (pixel scale 0,5) il filo è più grosso
  e meno fitto.
- **Nessun LOD**: le righe lontane sono fitte sullo schermo; la nebbia le attenua.
