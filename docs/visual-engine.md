# Visual Engine — un mondo visuale persistente, primitive condivise, recipe

Data: 7 ottobre 2026. Continua [visual-systems](visual-systems.md) (campi, materia GPU,
onde, memoria) e [matter-engine](matter-engine.md) (morfologia, materiale, forme). La
grammatica — che cosa chiede ogni proprietà del suono alla geometria, e perché — è in
[visual-grammar](visual-grammar.md).

> La musica non sceglie una scena e ne regola i parametri: modifica un mondo. Ciò che
> si vede sono le strutture di quel mondo, che si formano, si deformano e si sciolgono
> insieme.

```text
Audio → DSP Rust → SoundMorphology ┐
        ExperienceEngine / Planner ├→ SonicGeometryMapper → GeometryState   che geometria chiede il suono?
        WorldEngine → WorldView    ┘        │
                                            ├→ SpatialFields (uField) ┐
        EventStream → WaveField (uWaveA/B) ─┤                         ├→ ogni primitiva, lo stesso frame
        luce del mondo × Director ──────────┴→ MaterialState ─────────┘
        entropia del planner × tetto dello show → budget strutturale → presenza di ogni primitiva
                                            ↓
        VisualWorld (recipe) → RecipeVisualizer → Layer → RenderEngine
```

## 1. Audit iniziale: che cosa c'era, che cosa mancava

| Area | Trovato | Decisione |
|---|---|---|
| Interpretazione | `SoundMorphology`, `WorldState`/`WorldView`, `VisualMaterial`, `SpatialFields`, intenti | riusati senza modifiche; **nessun campo nuovo** in WorldState né sul wire |
| Contratto verso la geometria | materiale, campi, forme ed emissione derivati dentro il mapping di una sola scena (`SpectralMatterMapping`) | un contratto unico, `GeometryState` (estende `VisualMaterial`), prodotto da `SonicGeometryMapper` |
| Forma delle voci | `music.bassLine` / `leadLine` usate come curve da disegnare | anche **descritte**: quattro descrittori continui del ciclo (`voiceShape.ts`) |
| Campi | `fieldLaw` agiva solo sulla materia simulata | `flowLaw.ts`: gli stessi campi letti da ciò che non ha stato (linee, superfici, nodi) |
| Primitive | materia (punti, legami, faccette) come classi senza interfaccia comune; membrana e impulsi chiusi in Resonant Field | interfaccia `Primitive`; cinque primitive che condividono campi, fronti, materiale |
| Composizione | la scena orchestrava a mano i sistemi | `VisualWorld` + `WorldRecipe`; `RecipeVisualizer` lo espone come una scena qualunque |
| Regia | `ShowDirector` sceglieva fixture, tinta, effetto | + quanta **struttura** può portare ogni fixture (`SlotPlan.structure` → `SceneClock.structure`) |
| Render engine, Layer, compositor, UI, menu, palette, Direction | — | invariati (il nono anello Scene è generato dal registry) |

Duplicazioni fra scene rilevate e non ancora rimosse: semi con `Math.random` (Particle
Field, Galaxy, Tunnel), anelli da `ShockRings`/`HitLog` (Tunnel, Liquid) accanto a
`WaveField`, tracce `RollingTraces`, tre varianti di "particelle su gusci".

## 2. Moduli (`src/visual-engine/`)

| Modulo | Ruolo |
|---|---|
| `geometry/GeometryState.ts` | il contratto: 36 tratti continui (gli 8 del materiale + 28), 0..1 salvo `skew` e `lateralBias` |
| `geometry/SonicGeometryMapper.ts` | suono + mondo → `GeometryState`; unico stato: i follower della forma delle voci |
| `geometry/voiceShape.ts` | `describeCycle`: edge, step, skew, ripple di un ciclo; nessuna etichetta |
| `geometry/VoiceCycles.ts` | i cicli vivi delle due voci come texture del mondo (128 × 2, R32F) + `voiceCycleGlsl` |
| `material/MaterialState.ts` | l'aspetto: emissione, bordi, faccette, rilievo, rim, brace… una luce per tutte le primitive |
| `Primitive.ts` | `Primitive`, `PrimitiveContext` (uniform condivisi), `WorldFrame` (il frame che ogni primitiva legge) |
| `WorldRecipe.ts` | `WorldRecipe`, `PrimitiveSlot` (base / costo / affinità / tempi) |
| `VisualWorld.ts` | il mondo: interpretazione una volta per frame, budget, presenze, memoria, osservatore, lifecycle |
| `RecipeVisualizer.ts` | adattatore `Visualizer` (compatibilità con `Layer`) e `defineRecipe` |
| `primitives/` | `MatterPrimitive`, `FilamentPrimitive`, `WaveSurfacePrimitive` (+ `ModalMemory`: i gusci, [spectral-shell](spectral-shell.md)), `ConnectionGraphPrimitive`, `ShockwavePrimitive` |

In `render-systems/fields/`: `fieldHeaderGlsl` (uniform e nomi dei campi, estratti dal
testo della legge senza cambiarlo: il GLSL risultante è identico byte per byte) e
`flowLaw.ts`.

### Chi possiede che cosa

- **Significato musicale**: ExperienceEngine, Planner, WorldEngine. Il Visual Engine non
  rileva eventi, non tiene anticipazione né spin né potenziale.
- **GeometryState / MaterialState**: per layer, per frame; funzione di ciò che è già
  stato interpretato. Stato locale ammesso: follower della forma delle voci, luce
  ammessa trattenuta, brace.
- **Primitive**: risorse GPU e storia di rendering (la materia, la fase dell'increspatura).
- **Recipe**: configurazione. Nessuna sequenza, nessun `if (drop)`.

## 3. Campi condivisi: la stessa forza su tutto

`VisualWorld` deriva i campi una volta (`deriveFields`), li impacchetta in `uField` e
impacchetta i fronti in `uWaveA` / `uWaveB`: tre array stabili che ogni shader lega una
volta. La materia integra un'accelerazione (`fieldLaw`); ciò che non ha stato legge gli
stessi campi con tre risposte senza stato (`flowLaw.ts`, GLSL + riferimento CPU):

| Funzione | Che cosa restituisce | Chi la usa |
|---|---|---|
| `flowAt(P)` | la velocità con cui la materia libera è trasportata in P (surge, vortice, avanzamento, deriva, turbolenza) | filamenti |
| `settle(home, spread)` | dove riposa ora un punto del corpo: raggio e gusci, schiacciamento, rotazione della struttura, centro stereo, spostamento della turbolenza | filamenti (origine), nodi del grafo |
| `frontsAt(P, affinity)` | di quanto i fronti che passano spostano un punto tenuto, e quanta luce portano | filamenti, grafo, superficie |

`flowAt` è verificata contro la legge dei campi: con le forze spente
`fieldLaw / drag` coincide con `flowAt` a 10⁻¹⁰ (test). Esito: un vortice avvolge
particelle, filamenti e gabbia e ruota la membrana; il potenziale stringe tutto; un
rilascio apre tutto; un impatto è **un** fronte che spinge la materia, sposta i nodi,
increspa la membrana ed è ciò che la primitiva dei fronti disegna.

## 4. Primitive

Ogni primitiva: `object`, `update(frame, presence)`, `setPalette`, `setPixelRatio?`,
`reset`, `dispose`, `elements` / `vertices`, `debug`. Nessuna alloca nel percorso
continuo. Le quattro nuove sono **senza stato**: ogni vertice è funzione del frame, quindi
non c'è nulla da azzerare o tenere allineato; la loro legge è scritta in GLSL e in
TypeScript (riferimento per i test).

| Primitiva | Che cosa è | Dal frame |
|---|---|---|
| `MatterPrimitive` | la materia persistente (simulazione GPU, punti / legami / faccette, forme del segnale e dei parziali): la parte generica di ogni mondo di particelle | campi, fronti, materiale; `particleMass` → grandezza degli elementi |
| `FilamentPrimitive` | linee di flusso: partono da un punto del corpo e sono portate dallo stesso flusso della materia; vibrano come corde nella forma reale di una voce; si diramano | lunghezza ← `continuity`/`tonalShape`; scia ← `viscosity`, `trailPersistence`; arco ↔ retta ← `curvature`; corda ← cicli, altezza, `stepping`; rami ← `branching`; quante ← `density` |
| `WaveSurfacePrimitive` | una membrana: modi propri e impulsi causali di `ResonantPhysics`, più arco, increspature, terrazze, inclinazione delle creste; griglia o disco, punti o fili; su richiesta (`shells`) il proprio passato attorno come gusci | ampiezza ← `elasticity`, `tension`; arco ← `surfaceDisplacement`, `curvature`; increspatura ← `surfaceRoughness`, `waveScale`, `waveVelocity`; terrazze ← `stepping`; creste ← `skew`; strappo ← `fracture` |
| `ConnectionGraphPrimitive` | nodi su due gusci e giunti fra quelli vicini: una gabbia che si chiude, si rompe e si richiude | reticolo ↔ sparso ← `symmetry`, `coherence`; raggio dei giunti ← `connectionRadius`; apertura ← `fracture`; lampo dei nodi ← `impulse` |
| `ShockwavePrimitive` | i fronti del `WaveField`, visibili: due anelli per fronte, tondi o poligonali | poligono ← `edgeHardness`; luce ← `look.wave` (FlashGuard) |
| `FieldTracerPrimitive` | traccianti di un campo vettoriale (simulazione GPU propria): si vede il loro moto, non loro | topologia ← `disorder`, `coherence`, `fragmentation`, `energy`; scia ← `trailPersistence`; luce ← `look` |
| `FieldLinePrimitive` | linee di campo istantanee, senza stato, dello stesso campo | lunghezza ← `viscosity`, `trailPersistence`; quante ← `density` |

Nessuna connessione viene accesa o spenta per decisione: un giunto si vede finché tiene
(la distanza fra i due nodi, mossi dai campi, resta sotto il raggio). Un filamento in un
mondo fermo e silenzioso ha lunghezza zero. Una membrana senza clock è piatta.

## 5. VisualWorld e budget strutturale

Per frame, nell'ordine: reset se il clock torna indietro → geometria → campi (+ `tune`
della recipe) → fronti → impacchettamento → voci → materiale → budget e presenze →
`update` di ogni primitiva → memoria visiva → osservatore.

**Budget.** `budget → unit(2,6 × topologyComplexity) × ceiling`, con salita 1,6 s e
discesa 4 s: il quadro respira. Le primitive non di base lo riempiono nell'ordine della
recipe, ognuna per il suo costo; la presenza richiesta è `riempimento × affinità(geometria)`
e segue con i tempi propri (1,4 s per formarsi, 2,6 s per sciogliersi, salvo diversa
indicazione). Una primitiva assente non viene aggiornata né disegnata, ma resta montata:
niente ricostruzioni, niente compilazioni a metà brano.

- `topologyComplexity` viene dal planner (`desiredEntropy`, `visualEntropy`, fatica):
  l'entropia è già limitata nel tempo lì, non qui.
- `ceiling` è `SceneClock.structure`: lo `ShowDirector` dà al protagonista 0,55 / 0,8 / 1 /
  0,6 / 0,5 per intro / build / drop / break / outro, la metà ai supporti, 1 in Preset.
- Costo GPU e numero di fixture restano del `GpuBudget` (Matter Field: 1,2 unità).

**Silenzio.** I campi del mondo si fermano, il budget si svuota, le strutture si
sciolgono, la luce si spegne; `ember` (7% della luce recente, 6 s) le lascia raffreddare
invece di sparire.

**Sessione.** Un clock che torna indietro di più di 1 s azzera ciò che il mondo ha
imparato (forma delle voci, fronti, luce trattenuta, sorgenti delle forme); ciò che è a
schermo non viene abbattuto: si scioglie con la sua presenza, la materia rilassa da sola.

**A runtime.** `world.add(slot)` e `world.remove(id)` montano e smontano una primitiva
mentre il mondo gira (si forma da zero; rilascia ciò che possiede).

## 6. Recipe

```ts
export const matterFieldRecipe: RecipeBuilder<MatterFieldParams> = (p, quality) => ({
  id: 'matter-field', seed: p.seed, tilt: p.tilt, memory: 'half', trail: 0.5, spatial: 0.5,
  tune: (fields, g) => { fields.gather *= 1 - 0.5 * g.particleSpread; },
  slots: [
    { id: 'matter', base: true, create: (c) => new MatterPrimitive(c, matterQuality(p, quality), { pointSize: p.pointSize, forms: true, mass: 0.5 }) },
    { id: 'shockwaves', cost: 0.3, attack: 0.3, release: 1.5, create: (c) => new ShockwavePrimitive(c) },
    { id: 'filaments', cost: 1, affinity: (g) => …, create: … },
    { id: 'surface',   cost: 1, affinity: (g) => …, create: … },   // WaveSurfacePrimitive con RESONANT_DISC: il grafico circolare
    { id: 'graph',     cost: 1, affinity: (g) => …, create: … },
  ],
});
export default defineRecipe({ id: 'matter-field', name: 'Matter Field', …, preset, recipe: matterFieldRecipe });
```

| Scena | Stato | Recipe |
|---|---|---|
| **Matter Field** (nuova) | solo architettura nuova | materia + fronti + filamenti + membrana + grafo |
| **Spectral Matter** | convertita, comportamento invariato (stessi test, stessi uniform) | la sola materia |
| **Resonant Field** | convertita a parità di aspetto | la sola membrana (griglia di punti), `grammar` 0,6 |
| **Vector Field** (7 ottobre notte; nata come *Field*, id `field` → `vector-field`) | solo architettura nuova | traccianti + linee di un campo vettoriale ([physical-scenes](physical-scenes.md)) |
| **Spectral Shell** (nuova, 7 ottobre, dopo) | solo architettura nuova | la membrana a disco di Matter Field con i propri gusci + fronti + polvere ([spectral-shell](spectral-shell.md)) |
| Tunnel, Galaxy, Particle Field, Liquid, Oscilloscope | legacy (`Visualizer` diretto); Tunnel e Particle Field riviste come scene fisiche | — |
| **Spectrum** | legacy, **da non toccare** | nessuna estrazione dal suo codice |

Vecchie scene e recipe convivono: per `Layer`, show e menu sono tutte `Visualizer`
(crossfade e supporti compresi). `?legacy=resonant-field` (solo DEV) monta la scena
com'era, per il confronto a occhio.

**Resonant Field, parità.** La scena legacy disegna come `Points` una `PlaneGeometry`
indicizzata: ogni punto è inviato circa sei volte e somma sei volte la sua luce. La
recipe lo disegna una volta con esposizione 4,2 (stessa immagine, un sesto dei vertici).
Confronto su otto fotogrammi alternati, `synthPop`, 1280×720: quota di pixel chiari
4,55% (recipe) contro 4,27% (legacy); stessa forma, stessi colori. Differenze volute:
la dimensione segue `F_RADIUS` (0,4), la rotazione è quella della struttura (0,15 rad/rad
invece di 0,08), la luce è quella del materiale condiviso.

## 7. Qualità e prestazioni

| Qualità | Materia | Filamenti × segmenti | Membrana (anelli) | Nodi | Memoria |
|---|---|---|---|---|---|
| High | 60.016 | 336 × 24 | 36 | 132 | metà risoluzione |
| Medium | ~39.000 | 219 × 20 | 29 | 86 | metà |
| Low | ~21.000 | 117 × 16 | 21 | 46 | nessuna |

Vertici inviati a High: ~188.000 (di cui ~154.000 della materia). Per frame: un `uField`
da 23 valori, due array da 32 per i fronti, una texture 128 × 2 delle voci, più quanto già
caricava la materia.

Misure del 7 ottobre 2026 (i7-10510U, Intel UHD CML GT2, Chromium headless ANGLE/GL,
1280×720, vsync, `synthPop`, 240 frame dopo 5 s). **La macchina era molto carica**
(load average 5–6, l'app dell'utente in esecuzione): i valori assoluti non significano
nulla, contano solo i confronti alternati nella stessa sessione.

| Scena, High | giro 1 (ms medi / p95) | giro 2 |
|---|---|---|
| Spectral Matter | 102 / 117 | 102 / 117 |
| Matter Field | 86 / 100 | 54 / 67 |
| Matter Field, tutte le primitive forzate | 91 / 100 | 57 / 67 |
| Galaxy | 58 / 83 | 33 / 50 |

Lettura prudente: Matter Field non costa più di Spectral Matter (meno materia, memoria a
metà risoluzione); le quattro primitive nuove insieme pesano pochi millisecondi. Non
misurati: macchina scarica, 1080p, WebView2/WebKitGTK, GPU dedicate, tempi per pass.

## 8. Debug (solo DEV)

`?debug` / Shift+D → blocco **Visual World** in fondo all'overlay: recipe, budget di
entropia e tetto, primitive presenti, elementi e vertici, i 28 tratti della geometria,
presenza e vertici di ogni primitiva, campi attivi, fronti, budget GPU.
`?primitives=matter,surface` blocca il mondo su quelle primitive (per guardarle una alla
volta); `?legacy=resonant-field` monta la scena precedente. Nulla di questo esiste nella
build di produzione.

## 9. Verifica

Test unitari / mock (Vitest), 51 nuovi:

- **forma delle voci**: sine, dente di sega, quadra, rumore negli angoli attesi; continuità
  fra gli angoli; cicli mediati e un basso reale come l'analisi lo consegna; indipendenza
  da livello e offset; ingressi corrotti;
- **mapper**: riposo; quattro tipi di suono → geometrie diverse; basso/acuto, larghezza;
  entropia dal planner, eventi dal mondo; finito e nei limiti per qualunque ingresso;
  deterministico e uguale a 30 / 60 / 144 fps; nessun salto fra due frame; decadimento
  senza audio; reset;
- **campi senza stato**: `flowAt` ≡ flussi della legge dei campi; riposo; `settle` (raggio,
  gusci, schiacciamento, rotazione, centro); turbolenza limitata; fronti;
- **leggi delle primitive** (riferimento CPU): filamenti (semi, lunghezza zero nel silenzio,
  vortice, arco ↔ retta, rami, limiti), grafo (reticolo, chiusura col raggio, rottura per
  disordine / turbolenza / rilascio, fronti), fronti d'urto (raggio = velocità × età,
  poligoni), membrana (modi, impulsi causali, arco, increspature, terrazze, bordo);
- **mondo** (Matter Field montata su renderer simulato): solo il corpo e buio senza suono;
  le strutture crescono nell'ordine della recipe **senza ricreare nulla** (stesse istanze,
  nessun dispose) e senza salti di presenza, poi si sciolgono; brace; stessi campi e
  fronti per tutte le primitive; tetto dello show; scala di qualità; `add` / `remove`;
  nuova sessione; **10 minuti simulati** con mondo che cambia (finito, limitato, stessi
  oggetti); indipendenza da `Math.random`; rilascio delle risorse a ogni qualità; pin DEV;
- **Resonant Field recipe**: registry, fisica condivisa al tempo udito, piatta senza
  clock, luce mentre risuona, campi condivisi, terrazze per quota;
- **ShowDirector**: struttura per sezione, supporti a metà, Preset = 1.

Spectral Matter e la materia sul riferimento CPU passano i test precedenti attraverso il
nuovo percorso (mapper → campi → forme).

Prove su GPU reale (Intel UHD, ANGLE/Mesa, Chromium headless): shader di tutte le
primitive compilati senza errori a High / Medium / Low; fotogrammi guardati per ogni
primitiva isolata, per Matter Field su `synthPop`, `sawBass`, `buildDrop`, per Resonant
Field nuova contro legacy; overlay; anello Scene con nove voci.

**Non verificato**: musica reale di qualunque genere; il movimento nel tempo (solo
fotogrammi); gusto e leggibilità (servono gli occhi dell'utente); parità GPU ↔ CPU delle
leggi nuove con lettura dei risultati (per la materia esiste `runParity()`, per filamenti,
grafo, membrana e anelli il GLSL è stato solo confrontato a vista con il riferimento);
l'app desktop; 1080p; WebView2/WebKitGTK; cattura reale. `runParity()` non è stata
ripetuta: `fieldLaw`, `formLaw` e `matterStep` non sono cambiati (testo GLSL identico).

## 10. Limiti e compromessi

- **Taratura solo su segnali sintetici**: affinità, costi, guadagno del budget (2,6),
  esposizioni e tempi sono punti di partenza.
- I cicli delle voci arrivano limitati in banda e mediati: `edge` è misurato rispetto alla
  ripidità di una sinusoide (un dente di sega reale dà ~0,9); `stepping` richiede tratti
  davvero piatti ed è raro nei segnali reali (una quadra reale ha plateau che decadono).
- I filamenti non sono scie con memoria: sono linee di flusso istantanee. Scie vere
  richiedono una storia per elemento.
- Il grafo ha un reticolo fisso di candidati (vicini a riposo); non cerca vicini nello
  spazio. I giunti sono linee: niente facce riempite.
- La membrana usa i modi di una membrana rettangolare anche sul disco (tenuto al bordo).
- Le transizioni fra scene diverse restano il crossfade del compositore: l'evoluzione
  senza taglio vive dentro un mondo, non ancora fra due.
- La camera non risponde ai transienti (scelta: nessun urto sul beat).
- Il planner non è stato modificato: decide entropia e intenti, mai primitive.

## 11. Percorso successivo

1. **Occhi e musica reale** su Matter Field: affinità, costi, esposizioni, ordine delle
   primitive; poi decidere se Resonant Field debba guadagnare filamenti e particelle
   (una riga per slot nella sua recipe).
2. `runLawParity()`: un pass che valuta `filamentPoint`, `nodePoint`, `surfaceHeight`,
   `ringPoint` per texel e li confronta con il riferimento CPU, come `runParity()`.
3. **Particle Field** e **Galaxy** come recipe: `MatterPrimitive` con `vortex`,
   `winding`, `gather` (semi deterministici al posto di `Math.random`).
4. **Tunnel**: anelli da `ShockwavePrimitive` / `WaveField` al posto di `ShockRings`;
   topologia assiale come primitiva.
5. **Oscilloscope** → `SignalTracePrimitive` (traccia 3D del segnale); **Liquid** →
   superficie deformabile sulla stessa legge dell'altezza.
6. Transizioni fra recipe dentro lo stesso `VisualWorld` (cambiare gli slot invece del
   layer), così anche il cambio di scena diventa una trasformazione.
7. Volume / nebbia, illuminazione direzionale, vicinato reale (griglia o compute).

## 12. Aggiungere una primitiva o una recipe

- **Primitiva**: implementare `Primitive`; legare `uField` / `uWaveA` / `uWaveB` del
  contesto e includere `fieldHeaderGlsl` + `flowLawGlsl`; leggere solo `frame.geometry`,
  `frame.fields`, `frame.look` (mai bande, beat o spettri); scrivere la legge anche in
  TypeScript e provarla lì; moltiplicare la luce per `presence`; semi da `show/rng.ts`.
- **Recipe**: `defineRecipe` in `src/visualizers/<nome>/index.ts`, costo e affinità in
  `show/fixtures.ts` e carattere in `show/relationships.ts`. L'ordine degli slot è l'ordine
  in cui la complessità li fa comparire.
