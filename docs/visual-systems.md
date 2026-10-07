# Visual Systems — il vocabolario grafico condiviso e Spectral Matter

Data: 6 ottobre 2026 (aggiornato il 7: vedi nota). Estende [world-engine](world-engine.md) e
[visual-director](visual-director.md).

> **Nota del 7 ottobre 2026.** Il [Matter Engine](matter-engine.md) estende questi sistemi:
> `VisualMaterial` è diventato `VisualMaterial` (tre proprietà in più, dalla morfologia del
> suono), la legge dei campi riceve un'àncora dalla nuova legge delle forme (`forms/`), la
> materia si disegna anche a faccette, l'osservatore orbita con il mondo e apre il campo
> visivo. Qualità, misure, parità e verifica aggiornate sono in quel documento; ciò che
> segue descrive i sistemi di base, ancora validi. Il World Engine ha dato a Euforia un corpo
fisico persistente; questo documento descrive il primo insieme di **primitive visuali
riusabili** (`src/render-systems/`) e la scena sperimentale che le usa,
**Spectral Matter** (`src/visualizers/spectral-matter/`).

```text
… Experience Engine → Experience Planner → World Engine → WorldState (presentato al tempo udito)
      → WorldView per layer (VisualDirector)
      → VISUAL GRAMMAR (render-systems)
           materiale derivato · campi spaziali · onde datate · materia · memoria visiva · osservatore
      → scena (orchestrazione) → Layer / RenderEngine
```

## 1. Perché esiste Spectral Matter

Le sette scene precedenti interpretano il mondo dentro una forma progettata in
anticipo: un tunnel resta un tunnel. Il cervello (Experience, Planner, World) è
diventato più ricco del vocabolario a sua disposizione. Spectral Matter è il
laboratorio per il passo successivo:

`audio → modifica le leggi di un ambiente → emerge una rappresentazione`

La scena non ha una forma finale. Un corpo di materia persistente (decine di
migliaia di elementi con posizione, velocità, età, energia, fase e affinità di banda)
evolve sotto campi di forza derivati dal `WorldState`. Nube, gusci, disco, anelli,
vortice, lamine a spirale, filamenti connessi, grani, dissoluzione non sono stati
programmati né sequenze: sono ciò che i campi fanno della materia. Non c'è un solo
`if (drop)`: un rilascio arriva come velocità radiale del mondo e come fronte d'onda
datato, e muove la materia in proporzione a ciò che il mondo aveva accumulato.

Lo scopo non è l'ottava scena: è capire quali strumenti servono perché Experience e
World Engine generino immagini coerenti, persistenti ed emergenti.

## 2. Scena e Visual System

| | Visual System (`render-systems/`) | Scena (`visualizers/<nome>/`) |
|---|---|---|
| Che cosa è | una legge o una risorsa riusabile: campi, materia, onde, memoria, osservatore | una configurazione: quali sistemi, con che scala, palette e preset |
| Stato | solo storia di rendering (particelle, fronti, buffer, inerzia della camera) | nessuno stato musicale; possiede le istanze dei sistemi |
| Ingressi | `WorldView`, `ExperienceSnapshot`, intenti, `EventStream`, `dt` | il contratto `Visualizer.update(…, modulation, clock)` |
| Conosce Three.js | solo i moduli GPU (`MatterSimulation`, `ParticleMatter`, `FeedbackPass`, `Observer.apply`) | sì |
| Verificabile senza GPU | sì: mapping, legge dei campi, onde, legge della memoria, osservatore, probe CPU | lifecycle e qualità con renderer simulato |

`SpectralMatterVisualizer` è ~110 righe di orchestrazione; `mapping.ts` contiene
l'unica traduzione specifica della scena (emissione, qualità). Tutto il resto è
condiviso.

## 3. Primitive introdotte

| Modulo | Ruolo |
|---|---|
| `materials/VisualMaterial.ts` (ex `MaterialCharacter`) | carattere del materiale derivato: `fragmentation`, `symmetry`, `granularity`, `fluidity`, `rigidity` (+ `continuity`, `angularity`, `connectivity` dalla morfologia) |
| `fields/SpatialFields.ts` | `WorldView` + materiale + intenti → 22 grandezze di campo (funzione pura, limitata, finita per ogni ingresso) |
| `fields/fieldLaw.ts` | la **legge dei campi**: accelerazione di un elemento in un punto. Scritta due volte, affiancate e identiche termine per termine: GLSL (`fieldLawGlsl`) e riferimento CPU (`fieldLaw`) |
| `waves/WaveField.ts` | fino a 8 fronti datati, nati dagli eventi `impact` / `onset` forte / `drop` dello stream dell'Experience Engine |
| `particles/MatterSeeds.ts` | semi deterministici (mulberry32 di `show/rng.ts`): direzione × strato, affinità di banda continua, fasi; filamenti di 8 elementi |
| `particles/matterLaw.ts` | integrazione di un elemento (risposta esatta al drag), canale di energia, età e ri-formazione; GLSL + CPU |
| `particles/MatterSimulation.ts` | backend GPU WebGL2: stato in due texture float, ping-pong fra due target MRT, un pass per sotto-passo |
| `particles/MatterProbe.ts` | la stessa materia sulla CPU con le leggi di riferimento, e `measure()` (raggio, spessore, velocità, energia, schiacciamento, connettività) |
| `particles/ParticleMatter.ts` | disegno: punti additivi e legami dei filamenti letti dalle texture per `gl_VertexID` |
| `feedback/visualMemory.ts`, `FeedbackPass.ts` | memoria visiva: legge per pixel (CPU e GLSL) e pass di post-processing |
| `camera/Observer.ts` | osservatore con inerzia propria (quattro oscillatori quasi critici, passi esatti) |

### Legge dei campi

`accelerazione = F(P) + drag · U(P)`: **U** sono flussi (velocità a cui la materia
rilassa attraverso il suo drag), **F** forze. Unità visive (1 = raggio di riposo),
asse di simmetria z.

| Termine | Tipo | Effetto |
|---|---|---|
| radiale | F | molla verso il raggio dello strato dell'elemento; `gather` porta gli strati su tre gusci |
| surge | U | velocità radiale del mondo (un rilascio arriva qui come moto) |
| vortice | U | rotazione differenziale attorno a z (più veloce all'interno) |
| schiacciamento | F | la rotazione riduce l'altezza di ogni elemento di una quota: disco e anelli con uno spessore, mai un collasso |
| avanzamento | U | rotolamento attorno all'asse laterale: la parte alta viene verso chi guarda |
| deriva | U | flusso laterale (velocità del bias stereo); il centro dei campi si sposta col bias |
| turbolenza | U | flusso ABC a divergenza nulla, una o due ottave; la sua fase avanza solo con l'attività del mondo |
| shimmer | U | micro-moto fine, pesato con affinità² |
| struttura | F | attrazione sulle lamine di un motivo a spirale di ordine n (due ordini interi sfumati); ogni elemento mira di lato alla lamina di una quota che si chiude con la coesione: amorfo → strutturato |
| grani | F | attrazione nelle celle di un reticolo (frammentazione) |
| legami | F | i vicini lungo un filamento si richiamano quando si allontanano: connettività reale |
| onde | F | spinta verso l'esterno dove il fronte si trova ora, pesata sull'affinità di banda; carica il canale di energia |

Vortice e rotolamento sono rotazioni perché la materia è trattenuta su gusci: un
flusso con divergenza superficiale la ammasserebbe a un polo (la prima versione usava
una circolazione poloidale e lo faceva; la coesione sull'asse annodava i poli: entrambe
corrette dopo averle viste a schermo e nel probe).

### Onde

Ogni fronte è descritto dal solo tempo audio dell'evento: raggio = velocità × età,
ampiezza = forza × e^(−decadimento × età). Parte quindi sull'evento, non prima che
sia udito, e ha lo stesso aspetto a 30, 60 o 144 fps e con eventi arrivati in ritardo
(test). Un `impact` pesa per forza × peso strutturale × confidence × quanto la scena
prende i transienti; un `onset` conta solo se forte; un `drop` è un fronte unico,
largo, lento e lungo, forte quanto ciò che è stato rilasciato. Le bande basse danno
fronti larghi e lenti, le alte sottili e veloci. `beat` e `downbeat` non generano
nulla. Nessun rilevamento locale: lo stream è l'unica fonte.

### Memoria visiva

```text
kept    = history × decay^(1 + 3 × irregularity × grain)
memory' = min(max(fresh × imprint, kept + (1 + accumulate) × (1 − decay) × fresh), 4)
shown   = max(fresh, memory')            decay = exp(−dt / persistence)
```

È una scia, non una somma: un'immagine costante si assesta al più a
(1 + accumulate) × sé stessa, qualunque siano decay e frame rate; il tetto limita il
resto. Coerenza alta → memoria lunga e pulita; turbolenza → memoria irregolare (grana
e piccolo spostamento); shimmer → scie brevi; impatto **ammesso dal FlashGuard** →
afterimage breve e forte; silenzio → dissoluzione entro `MAX_PERSISTENCE` (1,6 s).

## 4. Mapping World → Render

| Mondo (`WorldView`) | Campo / parametro |
|---|---|
| `pressure` (radius × guadagno del mood) | raggio della materia (+ apertura; − potenziale) |
| `surge` (velocità radiale, **nuovo campo del WorldView**) | flusso radiale |
| `spin`, `turn` | vortice, schiacciamento in disco, avvolgimento e rotazione del motivo |
| `speed` | rotolamento in avanti, evoluzione dei campi disordinati |
| `lateral`, `biasVelocity` | centro dei campi, deriva laterale, origine delle onde, mira dell'osservatore |
| `disorder` | ampiezza della turbolenza, irregolarità della memoria, (con poca coerenza) frammentazione |
| `coherence` | coesione, legami, raccolta sui gusci, rigidità, persistenza della memoria |
| `excitation` | energia degli strati esterni, luce accumulata, evoluzione dei campi |
| `shimmer` | micro-moto, scintille, scie più brevi |
| `tension` (potential) | convergenza, compressione, raccolta, rigidità, drag, meno dispersione |
| `release` / `impact` (eventi) | fronti d'onda; l'energia rilasciata è già nei corpi del mondo (surge, spin, travel) |
| `light` (illumination) | emissione di base |
| `openness` | raggio, ordine del motivo, elevazione dell'osservatore |

Intenti del planner (`strength × confidence`, componenti di forza, nessun ramo):
expand/contract → raggio; rotate → vortice; accelerate → rotolamento;
decelerate/suspend → drag (e flussi ridotti); fragment → meno legami e coesione, più
turbolenza e grani; cohere → coesione e raccolta; dissolve → vita più breve e densità.

Luce: `illumination` → livello di base; `resonance` → bagliore degli strati interni;
`shimmer` → scintille sulla materia ad alta affinità; `excitation` → energia degli
strati esterni; fronti → il canale di energia per elemento, cioè una luce che viaggia
con l'onda. Il bloom segue solo l'intensità (route propria della scena): niente
`beat → bloom`. La luminosità dei fronti è scalata da `SceneClock.light`, la luce
degli impatti **già ammessa dal FlashGuard condiviso**: con Reduce Flashing i fronti
restano geometrici ma meno luminosi. Come per le altre scene, questo non certifica
l'assenza di ogni variazione luminosa continua.

## 5. Proprietà globali

Restano nel `WorldState`, invariato: pressione, spin, travel, bias, eccitazione,
shimmer, turbolenza, coerenza, potenziale, illuminazione, apertura. Significato
musicale, anticipazione, potenziale di rilascio ed eventi appartengono a
ExperienceEngine/WorldEngine. Modifiche ai contratti esistenti, tutte additive:

- `WorldView.surge` = velocità radiale × guadagno di espansione;
- `SceneClock.events` (lo `EventStream` della sessione, da leggere con un
  `EventCursor` fino a `clock.time`) e `SceneClock.light` (luce degli impatti ammessa);
  `RigValues.events`;
- `Visualizer.debug?`: numeri per l'overlay di sviluppo.

## 6. Proprietà derivate localmente

| Derivata | Da |
|---|---|
| `fragmentation` | turbolenza × (1 − coerenza) × complessità |
| `symmetry` | coerenza × armonicità × presenza |
| `granularity` | complessità, shimmer, entropia |
| `fluidity` | flow + resonance − fragmentation |
| `rigidity` | coerenza + potenziale |

Stato locale ammesso: particelle, fronti, buffer di memoria, inerzia dell'osservatore,
fase dei campi disordinati, follower della luce ammessa. Niente anticipazione, spin,
travel, pressione o potenziale propri.

## 7. Lifecycle

- `init`: semi → `MatterSimulation` (2 target MRT float, 2 texture di semi, materiale,
  quad) → `ParticleMatter` (punti, legami) → `FeedbackPass` consegnato al Layer con
  `addPass(…, 'pre-bloom')`.
- `update`: mapping → `WaveField.update(clock.time, clock.events)` → sotto-passi della
  simulazione → uniform → osservatore. Nessuna allocazione nel percorso continuo.
- `dispose`: la scena rilascia simulazione e materia; il Layer rilascia i pass. Test:
  a ogni qualità target, texture di semi, materiali e geometrie vengono rilasciati e la
  scena resta vuota.
- La materia si forma già all'equilibrio dei campi: montare la scena non produce moto.
  Cambio di scena, crossfade e qualità non toccano il mondo; una nuova sessione
  azzera i fronti (epoch dello stream), la materia rilassa da sola.
- La simulazione avanza in `update` (anche per un layer non composto): pochi texel,
  ma è lavoro GPU fuori dalla regola "solo i layer visibili".

## 8. Qualità e prestazioni

| Qualità | Elementi | Legami disegnati | Memoria visiva | Turbolenza | Bloom |
|---|---|---|---|---|---|
| High / Auto iniziale | 96.096 | 25% dei filamenti | piena risoluzione | 2 ottave | sì |
| Medium | 62.496 | 10% | metà risoluzione | 2 ottave | sì |
| Low | 33.672 | nessuno | nessun pass | 1 ottava | no |

L'esposizione per elemento cresce con 1/√densità, così il corpo conserva la
luminosità. Passo di simulazione: al più 1/50 s, fino a 4 sotto-passi per frame
(30 fps → 2, 60 e 144 fps → 1); drag integrato in forma esatta; velocità, raggio ed
energia limitati; NaN/Infinito fanno ri-formare l'elemento.

Senza `EXT_color_buffer_float` lo stato usa half float (movimenti lenti più
grossolani): percorso previsto ma **non provato** su un dispositivo che ne sia privo.

**Misure (6 ottobre 2026, i7-10510U, Intel UHD CML GT2, Chromium headless ANGLE/GL,
1280×720, DPR 1, sorgente sintetica, vsync, 300 frame dopo 5 s).** La macchina era
carica (load average 4–7, un'altra app in esecuzione): Galaxy, usata come riferimento
nella stessa sessione, ha oscillato fra 25 e 39 ms di media a High. I valori sono
quindi **indicativi e non confrontabili in assoluto**.

| Qualità | Galaxy (media ms) | Spectral Matter (media ms) |
|---|---|---|
| High | 24,6 – 38,6 | 36,6 – 40,6 |
| Medium | 18,4 – 19,0 | 23,6 – 23,7 |
| Low | 16,7 | 16,7 |

Varianti a High nella stessa serie (media ms): completa 36,6; senza memoria 29,2;
senza bloom 30,1; senza punti 35,0; senza legami 34,9; senza simulazione 34,4. Il
costo principale sono i due pass a tutto schermo della memoria (su target MSAA), non
le particelle né la simulazione. Invio dei pass di simulazione dalla CPU: 0,2–0,5 ms
per frame (overlay; il tempo GPU non è misurato). Costo come fixture dello show:
1,2 (stima, come Liquid). Non misurati: 1080p, WebView2/WebKitGTK, GPU dedicate,
timer GPU per pass.

## 9. Verifica

Test unitari/mock (Vitest): mapping World → campi (ogni corpo e campo, potenziale,
coerenza ≠ turbolenza, intenti, limiti con ingressi corrotti, indipendenza dal frame
rate); onde (datazione, nessun anticipo, 30/60/144 fps e arrivi in ritardo, drop,
carattere di banda, limite a 8, mount a metà sessione, nuova sessione); memoria
(relazioni col mondo, 30/60/144 fps, nessuna deriva in 300 s, silenzio, irregolarità);
osservatore (stesso percorso a 30/60/144 fps, moto contenuto, quiete); materia sul
probe CPU (semi deterministici, affinità continua, determinismo elemento per elemento,
quiete senza suono, dissipazione nel silenzio, coerenza macroscopica a 30/60/144 fps,
150 s densi senza NaN né energia incontrollata, build → convergenza, rilascio
proporzionale al potenziale, un beat da solo non rilascia, coerente ≠ caotico,
rotazione → disco); scena (registry e fixture, scala di qualità, campi dal mondo,
fronte da un impatto udito e luce ammessa, indipendenza da `Math.random`, rilascio
delle risorse a ogni qualità).

Prova su GPU reale (stessa macchina, ANGLE / Mesa Intel UHD): shader compilati senza
errori JS/GLSL a High, Medium e Low; **parità GPU ↔ riferimento CPU** su 1.024
elementi, 240 passi con tutti i campi attivi, due fronti, ri-formazioni e `dt` misti:
errore medio di posizione ~3,5·10⁻⁶, massimo ~1,4·10⁻⁴ unità (entrambe le varianti di
dettaglio). La parità è una prova manuale, non un test della suite: dopo ogni modifica
alla legge va ripetuta, perché GLSL e TypeScript sono due testi.

Non verificato: musica reale di qualunque genere (solo segnale sintetico: le domande
percettive A–I restano aperte e richiedono occhi e un corpus), silenzio e drop
osservati a schermo, WebView2/WebKitGTK, cattura reale, 1080p. Montaggio e smontaggio
ripetuti (sei andate e ritorni con Galaxy a High) lasciano invariati i conteggi di
texture e geometrie del renderer (22 / 3).

Debug (solo DEV, `?debug` / Shift+D): riga `Scene` in fondo alla sezione World con
elementi, raggio, vortice, turbolenza, coesione, frammentazione derivata, fronti attivi,
decay della memoria, sotto-passi, ms di invio della simulazione (verificata a schermo;
l'overlay è più alto di una finestra 720p).

## 10. Roadmap

Funziona oggi: i quattro sistemi dell'MVP (materia, campi, onde, memoria), osservatore
ed emissione dalla materia, tre livelli di qualità, test e documentazione.

Non implementato, previsto dai confini attuali:

- **Reaction-diffusion**: un secondo ping-pong 2D i cui parametri vengono da
  `VisualMaterial` (coerenza → stabilità, complessità → perturbazione, risonanza →
  propagazione) e i cui semi sono i fronti di `WaveField`.
- **SDF / geometria implicita**: la legge dei campi è già una funzione di P; una
  superficie implicita può campionare gli stessi `SpatialFields` senza passare dalle
  particelle. Nessun raymarching oggi.
- **Densità / volume**: splatting delle posizioni in una texture di densità (2D
  proiettata prima del 3D) come ingresso di nebbia, plasma o superfici.
- **Backend compute (WebGPU)**: `MatterSimulation` espone due texture, `step`, `reset`,
  `dispose`; un backend compute implementa `fieldLaw` e `matterStep` (il riferimento
  CPU è la specifica) senza toccare Experience, World o mapping.
- **Vicinato reale**: i legami sono lungo filamenti fissi; coesione e allineamento fra
  vicini spaziali richiedono una griglia (compute).
- Taratura percettiva su musica reale; timer GPU per pass; simulazione sospesa per i
  layer non composti; memoria a risoluzione indipendente a High.

## 11. Usare i sistemi in un'altra scena

```ts
// init
const seeds = seedMatter(matterLayout(count * quality.density), seed);
this.simulation = new MatterSimulation(renderer, seeds, true);            // + un MatterForms per le forme
this.matter = new ParticleMatter(seeds.layout, this.simulation.homes, this.simulation.traits, this.simulation.formSeeds, size, exposure, 0);
this.scene.add(this.matter.object);
this.memory = new FeedbackPass(0.5); addPass(this.memory, 'pre-bloom');

// update
const view = modulation?.world ?? REST_VIEW;
deriveMaterial(material, view, clock?.experience);
deriveFields(fields, view, material, clock?.experience?.intents);
fields.cohesion = 0;                       // la scena sceglie quali campi usa e con che scala
if (clock) waves.update(clock.time, clock.events, view.lateral, clock.hitScale);
this.simulation.step(fields, waves, clock?.time ?? time, dt);
this.matter.setState(this.simulation.positions, this.simulation.velocities);
deriveMemory(this.memory.memory, view, modulation?.persistence ?? 0.5, clock?.light ?? 0);
```

Regole: non scrivere posizioni dalla musica; non rilevare eventi; non tenere stato
musicale; scalare la luce dei fronti con `clock.light`; rilasciare ciò che si crea.
Se si cambia `fieldLaw` o `matterStep`, cambiare GLSL e CPU insieme e ripetere la
prova di parità.

## 12. Evoluzione delle scene esistenti (nota, non implementata)

| Scena | Sistemi riusabili | Primo passo sensato |
|---|---|---|
| Tunnel | geometria + `WaveField` + campo di flusso | sostituire gli anelli da `ShockRings`/HitLog con fronti di `WaveField` (stessa datazione, più carattere di banda) |
| Galaxy | materia + vortice + onde | le stelle come `ParticleMatter` con `vortex`, `flatten`, `winding` e `cohesion`: bracci che si avvolgono davvero; oggi la persistenza è del campo, non per stella |
| Particle Field | materia + turbolenza + coesione | il candidato più diretto: `turbulence`, `clumping`, `gather` al posto di `uDisorder`/`uTension` calcolati nel vertex shader |
| Liquid | superficie + flusso + onde | `WaveField` per gli anelli; `FeedbackPass` al posto di `AfterimagePass` (stessa spesa, memoria guidata dal mondo) |
| Spectrum | geometria spettrale + onde | solo `WaveField` per gli echi: lo spettro resta misura |
| Oscilloscope | geometria del segnale + memoria | `FeedbackPass` + `deriveMemory` al posto del fosforo a damp fisso |
| Resonant Field | risonanza + superficie + onde | i suoi modi restano in `ResonantPhysics`; `WaveField` darebbe fronti con banda e rilascio |

Ordine consigliato: `FeedbackPass` in Oscilloscope e Liquid (sostituzione uno a uno,
verificabile a occhio), poi `WaveField` al posto di `ShockRings`, infine la materia in
Particle Field e Galaxy. `VisualMaterial` e `SpatialFields` sono usabili subito da
qualunque scena come lettura comune del mondo, anche senza particelle.
