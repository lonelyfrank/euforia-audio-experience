# Matter Engine — la materia che prende forma dal suono

Data: 7 ottobre 2026. Estende [visual-systems](visual-systems.md) (campi, materia GPU,
onde, memoria visiva) e [world-engine](world-engine.md). È la prima milestone del
refactor "3D Audio-Matter Rendering": non una scena nuova, ma tre strati nuovi fra il
DSP e la GPU, provati dentro la scena-laboratorio **Spectral Matter**.

> **Nota del 7 ottobre 2026 (sera).** Il [Visual Engine](visual-engine.md) generalizza
> questa milestone: `SpectralMatterMapping` non esiste più (materiale, campi ed emissione
> li derivano `SonicGeometryMapper`, `VisualWorld` e `MaterialSystem`; la materia è la
> `MatterPrimitive`), Spectral Matter è una recipe con la sola materia e il suo
> comportamento è invariato (stessi test, stessi uniform). `matterQuality` vive in
> `visual-engine/primitives/MatterPrimitive.ts`. Leggi, forme, misure e limiti descritti
> qui restano validi; al §9 la colonna "componente riusabile" è ora in parte realizzata
> (membrana di Resonant Field → `WaveSurfacePrimitive`).

> La musica non controlla una scena: modifica un mondo. Ciò che si vede emerge dal
> comportamento di una materia persistente in uno spazio 3D.

```text
cattura → DSP Rust (ora anche i parziali) → SoundMorphology        che proprietà ha il suono?
        → ExperienceEngine (memoria, previsione, planner, intenti)
        → WorldEngine → WorldState                                 che cosa succede alla materia?
        → VisualMaterial                                           che materia può rappresentarlo?
        → forme (segnale, rete armonica) + campi + onde            dove appartiene ogni elemento?
        → materia GPU persistente → punti, legami, faccette → osservatore → composizione
```

## 1. Audit iniziale (Phase 0): che cosa c'era e che cosa è stato riusato

| Area | Stato trovato | Decisione |
|---|---|---|
| `render-systems/` (6 ottobre) | campi spaziali, legge dei campi GLSL + CPU, materia GPU a ping-pong, onde datate, memoria visiva, osservatore | **esteso**, nessun modulo parallelo: la forma è un termine in più della legge dei campi |
| `MaterialCharacter` | 5 proprietà derivate dal mondo | rinominato `VisualMaterial`, + 3 proprietà derivate dalla morfologia |
| Parziali | calcolati in `harmony.rs` (12 picchi interpolati) per fit armonico e roughness, **non esportati**: il wire portava solo 72 pitch bin | esportati (frequenza, livello, pan, fase fra i canali); wire e WASM ricostruiti |
| Waveform / forma delle voci | `AudioFrame.waveform` (1024 campioni) e i cicli medi di `VoiceTracker` (`music.bassLine` / `leadLine`, 128 campioni) usati solo in 2D | sorgente della forma d'onda 3D |
| Prediction | `WorldEngine` carica già `potential` con `likelyBuild × confidence` e `anticipation × confidence`; solo un drop reale lo rilascia | riusata così: la materia legge `tension` e l'ultimo rilascio del mondo |
| Camera | `Observer` (quattro corpi smorzati) | + orbita portata dalla rotazione del mondo, + campo visivo |
| Scene esistenti | sette scene che interpretano il mondo in una forma propria | invariate; classificate al §9 |
| UI, direzione, ShowDirector, compositor | — | invariati (stessa scena, stesso id, stessi menu) |

## 2. Parziali sul wire

`FeatureFrame` porta quattro array da 12 (`PARTIALS`), aggiornati alla cadenza
dell'armonia (8 / 16 / 32 hop): `partialHz` (interpolata, 0 = slot vuoto),
`partialLevel` (relativo al più forte × tonalità × presenza, 0..1), `partialPan`
(−1 … 1 al bin del picco) e `partialPhase` (fase del canale sinistro rispetto al
destro, rad). Sono i picchi già usati per armonicità e roughness: nessuna analisi in
più. Gli slot sono ordinati per livello, **non tracciati**: lo stesso parziale può
cambiare slot fra due analisi (li segue `HarmonicForm`). Il record frame passa da 295 a
343 valori: frontend, backend e WASM vanno distribuiti insieme, come sempre.

## 3. SoundMorphology (`src/morphology/`)

Descrive la morfologia istantanea del suono con proprietà continue; non nomina
strumenti, generi o forme d'onda. Non misura nulla: combina misure che il DSP Rust
esporta già, pesate con la presenza e lisciate sul clock audio (salita 80 ms, discesa
220 ms). Avanza per hop dentro `ExperienceEngine` e viaggia negli snapshot
(`snapshot.morphology`): ciò che un frame mostra dipende solo dal tempo udito.

| Proprietà | Da (misure Rust) |
|---|---|
| `periodicity` | fit armonico × stabilità di fase: un solo ciclo che si ripete |
| `harmonicity` | parziali netti e stabili, tanto più quanto stanno su una serie armonica |
| `noisiness` | √(flatness × imprevedibilità della fase): uno spettro piatto da solo non è rumore (un kick lascia vuoti i medi) |
| `roughness` | roughness |
| `sharpness` | sharpness ERB |
| `richness` | somma dei livelli dei parziali oltre il più forte, × stabilità di fase |
| `density` | entropia e bande sopra il proprio rumore di fondo |
| `transientness` | salita in più bande nello stesso hop (inviluppo: subito su, 0,3 s giù) + densità di onset |
| `stability` | 1 − variazione dello spettro complesso (1 nel silenzio) |
| `spatialWidth` | width × confidence stereo |
| `confidence` | presenza × confidence del timbro |

Valori medi misurati sul DSP reale (WASM versionato, 48 kHz, secondi 3–6 dei segnali di prova):

| Segnale | period. | harmon. | noisin. | sharpn. | richn. | transient. | stabil. |
|---|---|---|---|---|---|---|---|
| sine 1 kHz | 1,00 | 1,00 | 0,00 | 0,14 | 0,00 | 0,00 | 1,00 |
| saw bass | 0,63 | 0,76 | 0,12 | 0,27 | 0,83 | 0,02 | 0,71 |
| square lead | 0,94 | 0,94 | 0,01 | 0,45 | 0,55 | 0,23 | 0,87 |
| accordo (3 sinusoidi) | 0,34 | 0,57 | 0,01 | 0,05 | 0,84 | 0,02 | 0,84 |
| parziali inarmonici | 0,46 | 0,65 | 0,00 | 0,05 | 0,78 | 0,00 | 0,99 |
| rumore bianco | 0,00 | 0,02 | 0,98 | 0,81 | 0,01 | 0,15 | 0,00 |
| kick | 0,19 | 0,42 | 0,25 | 0,01 | 0,00 | 0,59 | 0,15 |
| hi-hat | 0,01 | 0,02 | 0,81 | 0,98 | 0,05 | 0,81 | 0,05 |

`shortTransient` non è usato per `transientness`: su toni bassi, ricchi e perfettamente
statici oscilla nella finestra da 512 (0,23–0,36 di media) e li farebbe sembrare percussivi.

## 4. VisualMaterial (`render-systems/materials/VisualMaterial.ts`)

Alle cinque proprietà derivate dal mondo (fragmentation, symmetry, granularity,
fluidity, rigidity) se ne aggiungono tre derivate dalla morfologia. Nessuna tabella
suono → forma: solo proprietà continue, che la frammentazione del mondo spezza.

| Proprietà | Da | Effetto |
|---|---|---|
| `continuity` | periodicity × stability | quota di materia sulla forma del segnale; larghezza dei nastri |
| `connectivity` | harmonicity × richness | quota di materia sulla rete armonica |
| `angularity` | √(sharpness × richness), attacchi netti | profondità dei lobi, rilievo delle faccette |
| `granularity` | + noisiness | scala di turbolenza e grani |

## 5. Forme: la stessa materia in stati diversi (`render-systems/forms/`)

Nessun elemento viene creato per una forma né rimosso con essa. Ogni filamento (8
elementi) ha, dai semi, una chiave di partizione: le chiavi basse vanno alla forma del
segnale, le alte alla rete armonica, per le quote correnti; ciò che resta è materia
libera sotto i campi (almeno il 10%). Quando le quote cambiano, la materia passa da uno
stato all'altro **filamento per filamento**.

La **legge delle forme** (`formLaw.ts`, GLSL + riferimento CPU) restituisce per ogni
elemento un'àncora e quanto tiene (0 = libero). La legge dei campi la trasforma in una
molla (`fields.form`, 16–60 s⁻², dalla rigidità), e allenta di altrettanto ciò che
modellerebbe la materia libera (guscio, schiacciamento, flussi di rotazione, struttura,
legami). Turbolenza, grani, surge del mondo e fronti d'onda agiscono anche sulla materia
tenuta: è così che una forma si deforma e si rompe. Nessuna posizione viene scritta.

**Forma del segnale** (`SignalForm` + `waveAnchor`): PCM → un ciclo per voce (basso e
lead, il ciclo medio reale: sinusoide, dente di sega, quadra…) → righe di una storia
(24 per voce) → geometria:

- il ciclo è un arco di lunghezza costante: una linea quando il suono non è periodico,
  un anello quando lo è (`closure`); la voce alta sta dentro quella bassa;
- il segnale sposta la curva verso l'esterno; il numero di lobi segue l'altezza
  (1 a 55 Hz, ~1,5 in più per ottava, sfumato fra due interi così l'anello resta chiuso);
- la storia arretra lungo l'asse: più righe = un tubo/superficie che si allontana; scorre
  con il viaggio del mondo (`speed`), con un filo di avanzamento finché c'è suono, ferma
  nel silenzio;
- i membri di un filamento alternano due lati: larghezza 0 = filamento lungo la curva,
  larghezza ≥ 1 riga = nastro; molti nastri = superficie (`ribbon` = continuity × stability).

Senza nulla di intonato la voce alta porta la waveform grezza (cambia a ogni frame: la
materia non può posarsi), ma una voce assente non trattiene materia.

**Forma armonica** (`HarmonicForm` + `harmonicAnchor`): ogni parziale diventa un nodo
persistente (8 al massimo). I parziali arrivano ordinati per livello: vengono
riconosciuti per altezza (±60 cent); un nodo scivola col suo parziale, sfuma quando
tace (0,45 s) e viene rilevato da un parziale nuovo solo quando è sparito o nettamente
più debole. Un cambio d'armonia **riconfigura** la struttura.

- posizione = il parziale: l'altezza lo avvolge su una spirale conica (un giro per
  ottava: le ottave si allineano, una quinta sta a 0,585 di giro), il pan lo sposta di
  lato, la fase fra i canali lo ruota appena;
- relazione fra due nodi = consonanza dell'intervallo (ottava, quinta, quarta, terze,
  seste, settima armonica; un semitono o un tritono valgono 0) × presenza di entrambi;
- un filamento appartiene a tre nodi: i due lati partono da due di essi e convergono sul
  terzo se tutti e tre sono legati (**poligono**), altrimenti sul punto medio
  (**filamento** lungo la coppia); è trattenuto solo finché la coppia è legata;
- i numeri di nodo assenti stanno per il nodo presente successivo: tre parziali
  trattengono diverse volte la materia che terrebbero da soli.

Esito a schermo (segnali sintetici): un tono ricco → una "molecola" di filamenti; un
accordo di tre note → il suo triangolo; un tono periodico → anello a lobi con la storia
che arretra; rumore → nessuna forma, materia libera e turbolenta.

## 6. Rappresentazioni e grammatica

`ParticleMatter` disegna la stessa materia in tre modi, letti dalle texture della
simulazione per indice di vertice (nessun dato CPU → GPU per elemento):

| Rappresentazione | Quando si vede |
|---|---|
| punti | sempre |
| legami (linee fra vicini di filamento) | finché i due elementi restano vicini; in una rete armonica anche lunghi (tratteggiano i poligoni) |
| faccette (triangoli su tre vicini) | solo quando il filamento si è **aperto** (tre elementi in linea non coprono nulla) e resta piccolo |

La materia raccolta su una forma è densa: ogni elemento porta meno luce (0,75 sulla
forma d'onda, 0,3 sulla rete), una faccetta grande è più sottile. Le faccette restano
piccole di proposito: riempire ogni poligono della rete, uno per filamento, costava
decine di schermi di fill (+29 ms a High sulla Intel UHD).

| Grammatica richiesta | Oggi |
|---|---|
| Geometry | point, particle, line/filament, ribbon, triangle, polygon (tratteggiato), surface/membrane (nastri), fragment; **manca** volume, mesh indicizzata |
| Matter | dust, fluid, elastic, rigid, filament, granular (proprietà continue del materiale e dei campi) |
| Forces | attract (molla, forma), repel/pressure (surge), vortex, wave (fronti), flow (advection, drift), turbulence, impulse (fronti), orbit (vortex), grani |
| Topology | radial/spherical (gusci), planar (disco), orbital, axial (storia lungo l'asse), network (rete armonica), cylindrical (tubo) |
| Transformations | connect/disconnect (legami), aggregate, fracture (rilascio), dissolve (lifetime), crystallize (cohesion, forme), stretch/compress (radius, tension) |
| Lighting | emissive, pulse (fronti, FlashGuard), rilievo delle faccette; **manca** volumetrico, direzionale |

## 7. Mondo, previsione, camera

- **Previsione**: nessun percorso nuovo. Il potenziale del mondo (caricato solo da
  previsioni pesate con la loro confidence) tende la curva (`amplitude` −35%), raccoglie
  e frena la materia (campi esistenti) e stringe il campo visivo; una previsione incerta
  carica poco, una mancata si disperde in 8 s.
- **Rilascio**: `view.releaseStrength` / `releaseAge` aprono tutte le forme
  (`fracture`, costante 0,9 s) mentre surge e fronte del drop spingono: la geometria si
  frattura in proporzione a ciò che è stato rilasciato e si richiude da sola.
- **Camera** (`Observer`): è portata intorno alla materia da una quota (0,12) della
  rotazione del mondo, quindi ferma quando il mondo è fermo; segue un'espansione in corso
  (`surge`); il campo visivo si apre con l'apertura (+9°) e si stringe con il potenziale
  (−5°). Nessun urto sul beat.
- **Silenzio**: le quote vanno a zero, la materia torna sui gusci per inerzia e si ferma.

## 8. Qualità e prestazioni

| Qualità | Elementi | Legami | Faccette | Vertici inviati |
|---|---|---|---|---|
| High | 96.096 | 25% dei filamenti | 50% | 246.246 |
| Medium | 62.496 | 10% | 25% | 108.584 |
| Low | 33.672 | — | — | 33.672 |

Per frame: due texture piccole caricate solo se cambiate (segnale 128 × 48 R32F,
rete 8 × 9 RGBA32F) e un vettore di 15 uniform; nessuna allocazione nel percorso continuo.

Misure (7 ottobre 2026, i7-10510U, Intel UHD CML GT2, Chromium headless ANGLE/GL,
1280×720, vsync, `synthPop`). **La macchina era carica** (app desktop dell'utente in
esecuzione, load average 6–16): contano solo i confronti alternati nella stessa sessione.

| Confronto (ms medi) | faccette sì | faccette no | senza forme |
|---|---|---|---|
| High, rete armonica | 51,1 | 47,0 | 45,4 |
| High, forma d'onda | 43,9 | 40,0 | 43,4 |
| Medium, rete armonica | 27,4 | 26,3 | 27,4 |

Le forme non costano in modo misurabile nella simulazione; le faccette ~4 ms a High.
Galaxy nella stessa serata: 31–39 ms a High. Non misurati: 1080p, WebView2/WebKitGTK,
GPU dedicate, tempi GPU per pass.

## 9. Scene esistenti: che cosa se ne può estrarre

| Scena | Com'è fatta | Classe | Componente riusabile |
|---|---|---|---|
| Resonant Field | membrana di punti 3D, modi propri da `ResonantPhysics` | 1 — riusabile quasi per intero | i modi come spostamento della superficie del segnale (forma "membrana") |
| Tunnel | geometria assiale procedurale nello shader, camera ferma | 2 — componenti | topologia assiale, flusso in avanti (`dTravel`), sezione dalla linea di basso |
| Galaxy | posizioni GPU da semi, senza stato per stella | 2 — componenti | topologia orbitale: già esprimibile con `vortex` + `winding` + `cohesion` sulla materia |
| Particle Field | particelle GPU senza stato su gusci = tracce polari delle voci | 2 → 4 | è la forma del segnale: candidata a essere sostituita dalla materia quando tarata |
| Spectrum | spettrogramma radiale 2D in un fragment shader | **da preservare così com'è** | nessuna estrazione: è il riferimento di fedeltà a ritmo e melodia; la geometria spettrale si costruisce accanto, non a partire dal suo codice |
| Oscilloscope | tre tracce 2D (`Line2`), fosforo | 3 — legacy | la ripetizione del ciclo per altezza (`fillCycles`) = sorgente della forma d'onda |
| Liquid | nastri 2D analitici, `AfterimagePass` | 3 — legacy | `RollingTraces`; `ShockRings` → `WaveField`; `FeedbackPass` |
| Spectral Matter | orchestrazione dei render-systems | laboratorio | — |

**Spectrum non si tocca** (indicazione dell'utente, 7 ottobre 2026): né la scena né il
significato di ciò che legge (`AudioFrame`, voci di `music.*`, campi e guadagni del
`WorldView`, `VoiceTextures`, `SignalTexture`, `audibleGlsl`, `hzToPosition`). In questa
milestone la cartella è intatta e le modifiche a `WorldView` e ai tipi sono solo aggiunte.

Nessuna scena è stata rimossa o modificata. `VoiceTextures` e `RollingTraces` erano già
condivisi; l'estrazione vera (Phase 3) resta da fare, nell'ordine: Resonant Field →
forma membrana; geometria spettrale da ERB; Particle Field e Galaxy come stati della materia.

## 10. Debug (solo DEV)

`?debug` / Shift+D → blocco **Matter** in fondo all'overlay: stato della materia
(quote onda / armonica / particelle), SoundMorphology, VisualMaterial, previsione →
carica → potenziale, numeri della scena (nodi, legami, closure, ribbon, fracture, campi,
fronti, sotto-passi), draw call / triangoli / punti / linee del frame, texture, programmi,
ms e fps. Il secondo menu (o `?matter=wave|harmonic|particles`) **blocca** la materia in
uno stato, per guardare ogni esperimento da solo. Nulla di questo esiste nella build di
produzione né tocca la UI principale.

## 11. Verifica

Test unitari / mock (Vitest):

- morfologia **sul DSP reale** (WASM): sine, saw, quadra, accordo, rumore, kick, hi-hat
  negli angoli attesi; silenzio = 0; indipendenza dal batching; ingressi corrotti;
- parziali end-to-end attraverso il wire; morfologia presentata al tempo udito;
- materiale: sei tipi di suono → caratteri diversi; mondo che frammenta; limiti;
- rete armonica: consonanza, struttura di un tono e di un accordo, posizioni (ottave
  allineate, quinta a 0,585 di giro, pan), identità dei nodi al riordino, glide, cambio
  d'armonia senza taglio, fiducia, dissolvenza, 30/60/144 fps, ingressi corrotti;
- forma del segnale: ciclo reale per voce, waveform grezza, cadenza della storia a ogni
  frame rate, storia ferma senza flusso, lobi;
- legge delle forme: partizione continua, anello ↔ linea, filamento ↔ nastro, scorrimento
  senza salti al push di una riga, filamento ↔ poligono, centro / rotazione / scala, frattura;
- materia sul riferimento CPU: **si condensa sulle forme e torna particelle senza salti
  né ri-formazioni** (nessun elemento supera la sua velocità massima, nessuna età torna
  indietro), determinismo elemento per elemento; tono / accordo / rumore = tre corpi
  diversi; rilascio che apre e richiude; 30/60/144 fps;
- osservatore: orbita = quota della rotazione del mondo, ferma col mondo; campo visivo;
- scena: uniform e texture delle forme, upload solo al cambio, rilascio GPU a ogni qualità.

Rust: parziali di un tono armonico (frequenze, livelli 1/n, mono centrato), pan e fase
fra i canali, rumore e silenzio.

Prove su GPU reale (Intel UHD, ANGLE/Mesa): shader compilati senza errori a High, Medium
e Low; **parità GPU ↔ CPU** con `runParity()` (`render-systems/particles/parity.ts`):
1.024 elementi, 240 passi, tutti i campi, entrambe le forme con storia che scorre e rete
che si riconfigura, due fronti, ri-formazioni, `dt` misti → errore medio 2,4·10⁻⁵ unità,
massimo 1,1·10⁻⁴ (uguale senza la seconda ottava di turbolenza), su uno spostamento medio
di 1,2 unità; una serie precedente, con altri semi, aveva dato un massimo di 7,4·10⁻⁴.
Va ripetuta dopo ogni modifica a `fieldLaw`, `formLaw` o `matterStep`:

```js
(await import('/src/render-systems/particles/parity.ts')).runParity()   // console del browser, server Vite
```

Guardati a schermo (screenshot headless, segnali sintetici): saw bass, serie armonica,
accordo, quadra, mix sintetico, rumore bianco; i tre stati bloccati; Low senza bloom né
memoria (la geometria resta leggibile).

Esiti del 7 ottobre 2026: `npm run check` riuscito (**271 test in 41 file**, 1 saltato,
typecheck, lint, build); core Rust **59 test + 1 doctest**; layout rigenerato; WASM
ricostruito e uguale byte per byte a quello versionato; `cargo check` della shell desktop
riuscito con il nuovo frame.

**Non verificato**: l'app desktop avviata con il nuovo backend nativo (solo `cargo check`:
un `desktop:dev` già in esecuzione va riavviato, perché il wire è cambiato); musica reale di qualunque genere; il movimento nel tempo (solo
fotogrammi); rilascio e build osservati a schermo; 1080p; WebView2/WebKitGTK; cattura
reale; dispositivi senza render target float.

## 12. Limiti noti e passi successivi

- **Mix densi**: con molte note che cambiano in fretta la rete insegue l'armonia e
  l'immagine è poco leggibile. Serve taratura su musica reale (quote, tempi dei nodi,
  esposizione) e gli occhi dell'utente.
- Elasticità: la materia tenuta oscilla attorno all'àncora (smorzamento 0,16–0,28); manca
  uno smorzamento proprio della forma.
- I poligoni della rete sono tratteggiati dai legami, non riempiti (costo di fill).
- La storia vuota all'avvio non mostra la riga viva finché non avviene il primo push.
- `transientness` è bassa sui mix densi (0,2 su `synthPop`): soglia da tarare.
- Geometria spettrale da ERB/FFT (disposizioni sferiche, cilindriche, a spirale), volume
  e illuminazione direzionale non sono implementati.
- Le transizioni emergenti esistono dentro la materia; il cambio fra scene diverse usa
  ancora il crossfade del compositore.
