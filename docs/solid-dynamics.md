# Solid Dynamics — strutture volumetriche vive

Data: 11 ottobre 2026. Continua [structural-dynamics](structural-dynamics.md), di cui è un'estensione:
stessi elementi, stesso passo fisso, stesso ambiente. Prima milestone, solo in Laboratories (DEV):
nessuna scena del prodotto contiene un solido e nessuna è stata modificata.

> Euforia non anima un solido. Simula una struttura fisica che il rendering rende visibile.

> **Aggiornamento, stessa data.** Questo documento descrive il corpo tenuto dai soli link: ora è il
> materiale **Legacy** del laboratorio, invariato bit per bit. Il laboratorio apre sul materiale
> **Rigid** (forma conservata, pulsazione entro il 6 %, frattura solo sugli eventi musicali):
> [rigid-resonant-body](rigid-resonant-body.md). Le sezioni 5 (spinta risonante per link), 6
> (frattura per carico) e la dimostrazione del §12 valgono per Legacy.

```text
audio → DSP Rust ─→ MultiscaleResonance (per hop)        eccitazione: macro / meso / micro
                  └→ World Engine → WorldView → campi     ambiente: flusso, fronti, potenziale
                                         ↓
        StructuralSystem.step (1/120 s sul tempo udito)   moto predetto di ogni elemento
                                         ↓
        SolidSystem.solve (stesso passo)                  link e celle proiettati (XPBD), velocità corrette,
                                                          carico → fatica → frattura, memoria → ricomposizione
                                         ↓
        SolidState.book (solo a topologia cambiata)       facce, celle, componenti connesse, forma di ogni pezzo
                                         ↓
        SolidPrimitive                                    3 draw call: facce, link, vertici
```

## 1. Audit: che cosa c'era e che cosa è stato riusato

| Contratto esistente | Decisione |
|---|---|
| `StructuralState` (pool di elementi, identità procedurale, stato dinamico) | **riusato**: un vertice di un solido è un elemento come gli altri. Due campi nuovi per elemento: `body` (il corpo di cui è vertice, −1 se nessuno) e `links` (link che tiene) |
| `StructuralSystem` (passo fisso, mezzo, fronti, potenziale, vicinato, regimi) | **esteso, non duplicato**: un componente opzionale `solids` entra in tre punti dello stesso passo (`recall`, `begin`, `solve`); senza corpi il passo è quello di prima, bit per bit |
| `BondSystem` (fili e giunti: al più 1 + 3 legami per elemento) | non adatto alla valenza di un vertice (3 … 5 spigoli più i vincoli interni); le sue **leggi** sono riusate estraendole a funzioni pure con la stessa aritmetica: `loadOf` (carico), `tire` (fatica e guarigione), `fade` (decadimento della memoria), `BOND_COST`, `BREAK_HEAT` |
| `StructuralLifecycle` (ordine, temperatura, coesione, ruoli) | riusato così com'è: sono ordine e temperatura dei due capi a dare la resistenza di un link, ed è la coesione degli elementi a decidere quando un link può riformarsi. Un vertice che tiene link è materia saldata (ruolo `node`, lifecycle `bound` / `stressed`) |
| `ResonanceField`, `MultiscaleResonance` | riusati: nessuna FFT, nessuna misura nuova |
| Ambiente del mondo (dentro `WirePolygonPrimitive`) | estratto in `structural/WorldEnvironment.ts` (`createWorldEnvironment`, `readWorld`) e usato da entrambe le primitive: stesso mezzo, stessi fronti, stesso potenziale |
| `WirePolygonPrimitive` | invariata nel comportamento; esporta gli shader dei punti che la primitiva dei solidi riusa |
| Workspace a tre colonne | **già presente** (non committato, 11 ottobre): il laboratorio entra in `DevelopmentTools` accanto a Structural Lab; nessuna seconda implementazione del workspace |
| `registerLaboratory`, `RigController.pinned` | riusati: stesso meccanismo di Structural Lab |

## 2. Moduli

| File | Ruolo |
|---|---|
| `src/visual-engine/structural/SolidTypes.ts` | tipi, stati dei link, forme dei pezzi, budget, override di sviluppo e loro limiti, interruttore di sviluppo `solidLab` (qui e non nella primitiva: la diagnostica lo legge senza importare il laboratorio) |
| `…/SolidTopology.ts` | mesh di riferimento (tetraedro, cubo, icosaedro), `shellVolume`, `verifyShell` |
| `…/SolidState.ts` | pool a capacità fissa di link, triangoli, celle, corpi; cerniere; componenti connesse; forma di ogni pezzo |
| `…/SolidDynamics.ts` | `SolidSystem`: semina, solver XPBD, spinta risonante, carico e frattura, memoria e ricomposizione, misure |
| `…/WorldEnvironment.ts` | il mondo come lo campiona un sistema strutturale (condiviso con i fili) |
| `src/visual-engine/primitives/SolidPrimitive.ts` | rendering, viste, strumenti del laboratorio |
| `…/structural/lab/solid.ts` | recipe e definizione del laboratorio **Solid Dynamics** (fuori dal registry) |
| `src/app/engine/SolidCockpit.ts` | inspector del laboratorio nel workspace |
| `…/structural/Solid.test.ts`, `SolidLab.test.ts`, `src/bench/solid.bench.test.ts` | test deterministici, test del laboratorio, benchmark |

Modificati: `StructuralTypes.ts` (`solids?` nella configurazione, `V_MAX` / `R_MAX` condivisi),
`StructuralState.ts`, `StructuralLifecycle.ts`, `BondSystem.ts`, `StructuralDynamics.ts`,
`WirePolygonPrimitive.ts`, `DevelopmentTools.ts`, `workspace.css`, `DiagnosticsController.ts` (lo stato
di `solidLab` entra nella firma di configurazione dei report, come quello di `structuralLab`).

## 3. Rappresentazione topologica

| Entità | Che cos'è | Dove sta |
|---|---|---|
| **Element** | il vertice: un elemento del sistema strutturale, con la sua identità (massa, `f0`, `q`, smorzamento, resistenza, persistenza) | `StructuralState` |
| **Link** | ciò che lega due elementi: uno **spigolo** geometrico (`EDGE`) o un **controvento** (`BRACE`), un legame interno che serve alla simulazione e non è mai uno spigolo della figura. Lunghezza di riposo attuale e d'origine, compliance, smorzamento, resistenza, accoppiamento, stress, danno, deformazione, età, memoria. Stato: `INTACT`, `BROKEN` (ricordato), `LOST` (dimenticato) | `SolidState.link*` |
| **Cerniera** | la rigidezza a flessione della superficie attraverso un link: una distanza fra i due vertici lontani dei due triangoli che vi si incontrano. Non è un link (non lega frammenti, non si rompe): esiste finché **entrambi** i triangoli tengono | `SolidState.hinge*` |
| **Face** | un triangolo della superficie, orientato verso l'esterno; i triangoli di una faccia geometrica condividono un gruppo | `SolidState.face*` |
| **Cell** | un volume: un insieme **chiuso e orientato** di triangoli con un volume di riposo. Un tetraedro e l'intero guscio di un corpo sono lo stesso tipo di cella | `SolidState.cell*` |
| **Solid** | elementi (un intervallo contiguo), link, triangoli e celle seminati insieme, con volume di riferimento e stato | `SolidState.body*` |
| **Fragment** | una componente connessa per link intatti: gli stessi elementi, dove erano | `SolidState.component` |

Tutto il resto si **legge dai link**, in `SolidState.book()`, solo quando la topologia è cambiata:

- un triangolo tiene finché i suoi tre link sono intatti;
- una cella tiene finché ogni link del suo contorno è intatto **e** il suo volume è stato verificato;
- un frammento è una componente connessa (union-find; il nome di un pezzo è il suo elemento di
  numero più basso, quindi non dipende dall'ordine delle rotture).

Ne seguono le politiche richieste: una faccia non sta mai su due frammenti, una cella non tiene
mai un guscio aperto, e **uno spigolo rotto non crea un frammento**: apre i due triangoli che lo
toccano e la cella che essi chiudevano; un pezzo si stacca solo quando nulla lo lega più al resto.

Ogni pezzo ha una **forma**, il grado di struttura più alto che tiene:

| Forma | Condizione |
|---|---|
| `free` | un elemento solo |
| `chain` | più elementi, nessun ciclo |
| `polygon` | un ciclo di link, nessun triangolo che tiene |
| `surface` | almeno un triangolo che tiene, con un bordo |
| `shell` | superficie chiusa (ogni link con triangoli ne ha due), nessuna cella verificata |
| `volume` | almeno una cella che tiene |

`verifyShell` decide se un insieme di triangoli è il contorno di un volume: **chiuso** (ogni
spigolo in due triangoli), **orientato** (ogni spigolo percorso una volta per verso), **connesso**,
**non degenere e non rovesciato** (volume con segno > 10⁻³ × spigolo medio³). `addCell` rifiuta
tutto il resto: poligoni vicini non sono un solido.

### I tre solidi

| | Vertici | Spigoli | Facce | Triangoli | Controventi | Cerniere | Celle |
|---|---:|---:|---:|---:|---:|---:|---|
| Tetraedro | 4 | 6 | 4 | 4 | 0 | 0 | 1 (sé stesso) |
| Cubo | 8 | 12 | 6 | 12 | 6 | 6 | 5 tetraedri |
| Icosaedro | 12 | 30 | 20 | 20 | 0 | 30 | 1 (il guscio) |

- **Cubo**: i sei controventi sono una diagonale per faccia, fra i quattro vertici che nessuno
  spigolo unisce; sono gli spigoli della cella centrale, attorno alla quale stanno quattro
  tetraedri d'angolo. Così ogni spigolo geometrico appartiene a una sola cella: romperlo ne apre
  una e lascia le altre quattro. Le cerniere tengono piane le sei facce.
- **Icosaedro**: una superficie triangolata convessa è rigida, quindi non ha interno: una sola
  cella, il guscio. Le trenta cerniere danno alla superficie la resistenza a piegarsi quando si
  apre (senza, i vertici attorno a un buco si ripiegano all'interno e non tornano).

Le figure sono **condizioni iniziali**: dopo la semina il corpo è ciò che la fisica fa dei suoi link.

## 4. Solver e vincoli

**Scelta**: dinamica a posizioni estesa (XPBD), dentro il passo esistente. Il passo di
`StructuralSystem` (mezzo con risposta esatta al drag, fronti, potenziale, fili, memoria) produce
il moto *predetto*; `SolidSystem.solve` lo proietta sui vincoli dei corpi e corregge le velocità
(`v += Δx / h`). Nessun secondo loop: stesso `h = 1/120 s`, stesso clock, stessi otto passi al più
per frame. Rispetto a molle esplicite: stabile a qualunque rigidezza, e la compliance è una
proprietà del materiale indipendente dal passo.

Per ogni vincolo `C(x) = 0` con compliance `α` e smorzamento `β`, a ogni iterazione:

```text
α̃ = α / h²        γ = α · c / h   con c = 2 ζ √(k μ)   (ζ: rapporto di smorzamento, k = 1/α, μ: massa ridotta)
Δλ = (−C − α̃ λ − γ ∇C·(x − x_prev)) / ((1 + γ) Σ wᵢ |∇Cᵢ|² + α̃)
λ ← λ + Δλ        xᵢ ← xᵢ + wᵢ ∇Cᵢ Δλ          wᵢ = 1 / massaᵢ
```

`λ` si accumula sulle iterazioni di un passo e si azzera al successivo. Le iterazioni sono una
**costante del budget** (4; limiti 1–8): non crescono per inseguire un errore.

| Vincolo | `C` | Rigidezza (materia di massa 1) |
|---|---|---|
| link | `lunghezza − riposo` | spigolo 140, controvento 100 (forza / lunghezza); scala con la massa ridotta dei capi, quindi ogni link di un corpo suona nella stessa banda (~2,7 Hz) |
| cerniera | `distanza dei vertici lontani − riposo` | 45; solo con entrambi i triangoli integri |
| cella | `volume con segno − riposo` | modulo di volume 500 (energia per unità di volume): `α = V₀ · compliance / 500` |

Il volume di una cella è `V = ⅙ Σ a·(b × c)` sui suoi triangoli orientati, e il suo gradiente in
un vertice è un terzo dell'area dei triangoli attorno, verso l'esterno. È lo stesso vincolo per un
tetraedro e per un guscio di venti facce: contrasta la compressione, **rigira una cella invertita**
(il volume è con segno) e non rende il corpo rigido (i volumi si conservano entro pochi per cento
con la compliance di prodotto). Elasticità, torsione e flessione non sono vincoli a parte: sono
ciò che link, cerniere e celle permettono. La **rotazione** non è data: nasce dalle velocità degli
elementi (un vortice del mezzo li trascina, un colpo fuori asse li fa girare).

**Protezioni numeriche**

| Rischio | Protezione |
|---|---|
| esplosione | vincoli impliciti; ogni proiezione sposta un elemento al più di ¼ della lunghezza del link (o della taglia della cella) |
| vertici sovrapposti | senza direzione fra due elementi, se ne usa una data dai loro numeri (deterministica) |
| cella collassata | gradiente nullo → il vincolo di volume salta il passo; le celle invertite sono contate (`stats.inverted`) |
| velocità, posizioni | `V_MAX` = 12, `R_MAX` = 8, gli stessi del sistema strutturale |
| stato non finito | l'elemento resta dov'era a inizio passo, fermo; contato in `stats.repairs` |
| energia senza sorgente | nessuna forza esterna dal solver; test: l'energia meccanica non sale in nessun passo |
| override fuori scala | ogni fattore è tenuto entro `SOLID_LIMITS` qualunque cosa scriva uno strumento |
| quiete | lunghezze e volumi di riposo sono misurati in doppia precisione con la stessa aritmetica del solver: un corpo a riposo non si sposta di un bit |

## 5. Risonanza musicale

Il suono **non scrive mai una posizione**. Sposta ciò a cui link e celle *tendono*, secondo
ciò che la loro materia prende dalla risonanza multiscala; il corpo segue con la sua inerzia.

| Scala | Che cosa muove | Ampiezza |
|---|---|---|
| macro | un modo lento per link (scelto dalla fase dei capi) e il volume di riposo di ogni cella: il corpo respira e si inclina | link 14%, celle 25% × accoppiamento × modo |
| meso | lo swing firmato dei due capi alla propria altezza (`ResonanceField.at(f0, q)`): link e facce vibrano; capi di altezza diversa si deformano l'uno contro l'altro | 5% × accoppiamento × swing |
| micro | l'eccitazione fine che prendono, come piccola dilatazione | 2% |

Le ampiezze decrescono con la frequenza perché, a pari velocità, un moto lento porta più ampiezza:
un link che vibrasse del 20% a 3 Hz muoverebbe i vertici a 4 unità/s, e quella è temperatura (il
corpo si scalderebbe fino a rompersi da solo: misurato, vedi §11). Tutto è interno (coppie e
celle): un corpo e ogni suo frammento conservano la quantità di moto. Senza suono (o con
l'accoppiamento a zero) nulla di questo esiste e nessuna posizione cambia.

**Ambiente**: il mezzo trasporta ogni vertice (drag esatto), i fronti lo colpiscono dal lato da cui
arrivano, il potenziale del mondo lo tiene al proprio strato (la pressione del mondo gonfia il
corpo contro il suo volume). Tensione, turbolenza e rilascio del mondo entrano nel carico dei
link; coerenza e armonia, attraverso l'ordine degli elementi, nella loro resistenza.

## 6. Frattura

Per ogni link intatto, a ogni passo (la stessa legge dei fili, `loadOf`):

```text
carico     = 6 · |deformazione| + velocità di chiusura + accoppiamento · (disaccordo di swing + ampiezza)
           + tensione del mondo + temperatura + rilascio
resistenza = forza del link · soglia · (0,55 + 0,45 · ordine) · (1 − 0,5 · danno)
```

Sopra il 55% della resistenza il link si affatica (`tire`); un mondo ordinato e freddo lo ripara.
Cede quando il carico supera la resistenza o il danno è completo. Uno spigolo regge 1,6 × la
resistenza della sua materia, un controvento 1,3.

Quando cede (`SolidSystem.sever`, lo stesso percorso per la legge del carico, per uno strumento e
per un test): il link diventa `BROKEN` con memoria 1; i due capi ricevono uno shock, perdono la
coesione, si scaldano; **nulla è creato, rimosso o spostato**. Poi `book()` rilegge facce, celle e
componenti. Non si tagliano mesh: la frattura segue le connessioni della topologia e i confini fra
celle.

## 7. Memoria e ricomposizione

Un link rotto è ricordato dai suoi due capi, e la memoria decade come quella di un filo (`fade`:
τ ≈ 25 s a freddo, molte volte più in fretta a caldo); svanita, il link è `LOST` e non si riforma.
Finché dura, **in un mondo vivo**:

- è una molla debole verso la lunghezza che il link aveva, **da entrambi i lati** (capi caduti
  insieme si allontanano come capi volati via si riavvicinano), tanto più ferma quanto più i capi
  sono ordinati e freddi; rigidezza 40 a memoria piena (circa un quarto del link), al più 6 di
  forza, portata 4 unità;
- una cella aperta **ricorda il proprio volume** allo stesso modo, lungo il gradiente del volume:
  le lunghezze da sole non distinguono un corpo dalla sua immagine speculare, e un pezzo che si è
  capovolto può stare a ogni distanza ricordata ed essere rovesciato;
- un link ricorda la propria lunghezza solo per quanto le celle che delimita sono dal verso
  giusto: prima il lato giusto, poi la distanza giusta.

Un link si **riforma** solo se tutte queste condizioni valgono insieme:

| Condizione | Valore |
|---|---|
| ambiente | mondo vivo (`energy` > 0): il silenzio non forma nulla |
| integrità dei capi | coesione ≥ 1 per entrambi (ordinati, freddi, fermi nel mezzo, non più freschi di frattura: è `stepCohesion`) |
| distanza | entro il 15% della lunghezza che aveva |
| velocità relativa | ≤ 0,6 unità/s |
| orientamento | ogni cella che il link delimita ha almeno il 25% del proprio volume, con il segno giusto |
| memoria | non dimenticato |

Si riforma **alla lunghezza a cui si trova** (nulla salta) e torna alla propria in ~2,5 s; porta un
danno residuo (0,25 o più: non è nuovo); costa a ciascun capo parte della coesione, quindi un
corpo ricresce un link alla volta. Una cella il cui guscio si è richiuso torna a tenere il volume
solo dopo la verifica, dal volume che ha in quel momento. Nulla è riportato alla geometria iniziale.

## 8. Formazione

La stessa memoria costruisce un corpo che non c'è ancora. `seedSolid(kind, radius, { bonded: false,
scatter })` posa la materia del solido più larga della figura, con ogni link **ricordato** e
nessuno che tiene: 4, 8 o 12 elementi liberi. In un mondo vivo e ordinato si avvicinano, si
assestano e si legano uno alla volta; il corpo passa per `free → chain → (polygon | surface) →
volume`, e diventa `volume` solo quando un guscio si è chiuso ed è stato verificato. In silenzio
resta materia sciolta, esattamente dov'è.

È l'infrastruttura richiesta più un test di formazione controllato: la figura a cui la materia
tende è data dal seme (come `seedPolygon` per i poligoni). `SolidState` espone anche la
costruzione esplicita (`addBody`, `addLink`, `addFace`, `addHinges`, `addCell`) con le stesse
verifiche. La generazione libera di solidi da materia qualunque, senza una figura ricordata, non
è in questa milestone.

## 9. Rendering

`SolidPrimitive` disegna un `StructuralSystem` che tiene corpi: **3 draw call** (facce, link,
vertici), `BufferGeometry` persistenti, buffer allocati una volta alla taglia dei pool, nessuna
`Mesh` creata nel frame loop, materiali con uniform di colore condivisi, `dispose` esplicito.

Ogni posizione inviata alla GPU è una posizione della simulazione, portata al tempo del frame
dalla propria velocità per meno di un passo: **nessuno shader sposta un vertice**. I link sono
segmenti dritti da vertice a vertice; una faccia non disegnata è una faccia che non tiene. Il
normale di una faccia è preso dalle derivate nel fragment shader (la faccia com'è), per una luce
tenue di taglio; fusione additiva, nessuna texture. Di ogni buffer si invia e si disegna solo la
parte in uso (`setDrawRange`, `addUpdateRange`).

| Vista | Che cosa mostra |
|---|---|
| Vertices | gli elementi |
| Edges | gli spigoli geometrici intatti |
| Faces | i triangoli che tengono |
| Wireframe + Faces | spigoli e facce (predefinita) |
| Structural Constraints | tutti i link: spigoli, controventi, e quelli solo ricordati (tenui, nel colore del caldo) |
| Fragments | tutto, con ogni pezzo nel suo colore |
| All | tutto |

Le viste cambiano ciò che è illuminato, mai la simulazione. Fuori dal laboratorio un corpo è buio
senza suono come ogni altra struttura; il laboratorio lo illumina comunque (una lampada sua), per
poterlo provare in silenzio.

## 10. Laboratorio

**Laboratories → Avvia Solid Dynamics** (oppure `?engine=solid`). Solo DEV, fuori dal registry
delle scene: non compare nell'anello Scene, lo show non lo sceglie, nessuna impostazione lo salva.
Un laboratorio alla volta: avviarne uno termina l'altro e ripristina il pin precedente.

| Colonna | Contenuto |
|---|---|
| sinistra | navigazione del workspace (Laboratories), come per Structural Dynamics |
| centro | il viewport originale con il mondo `solid-lab`: il corpo, i fronti, le linee del campo |
| destra | l'inspector del laboratorio |

| Pannello | Contenuto |
|---|---|
| Solid Dynamics | solido (tetraedro, cubo, icosaedro), vista, stato del mondo |
| Geometry | tipo, vertici, spigoli (intatti / totali), facce (che tengono / totali, triangoli), celle, legami interni |
| Material, Fracture, Adaptive Calibration | materiale, modo di frattura e gate, calibrazione: [rigid-resonant-body](rigid-resonant-body.md) §8 |
| Physics | massa (totale e fattore), rigidezza, smorzamento, compliance volumetrica, solver; cursori: massa ×, rigidezza ×, compliance volumetrica ×, accoppiamento ambientale × (lo smorzamento è in Material) |
| Structural Health | integrità, stress medio e di picco, energia cinetica, energia elastica stimata, volume attuale / di riferimento, vincoli rotti (ricordati / persi), frammenti, stato (forma, sigillato o aperto), 10 s di tracce |
| Resonance | macro (firmato), meso, micro, deformazione dei link (× 10) (l'accoppiamento alla risonanza è in Material) |
| Debug & Metrics | deviazione dalla forma, deformazione massima di uno spigolo, errore di volume, celle invertite, pulsazione, frammenti, eventi di frattura, solver, budget |
| Experiment | Reset structure, Seed & form, Impulse, Torsion, Fracture test, Musical event; cursori: coerenza e temperatura dell'ambiente (sostituiscono il valore del mondo solo se spuntate); Restore initial conditions (la resistenza alla frattura è in Fracture) |
| Budget & Cost | pool usati / capacità, iterazioni, passi del frame, costo del passo solido, della topologia, dei buffer, frame oltre budget, draw call, primitive disegnate |

Ogni numero è una misura dello stato della simulazione (`SolidSystem.read`, su richiesta a 5 Hz);
l'energia elastica è **stimata** dalla compliance dei vincoli. Gli strumenti sono impulsi (velocità),
mai spostamenti: un colpo da fuori accanto a un vertice, una torsione (le due estremità ruotate
l'una contro l'altra, senza rotazione netta), un colpo dall'interno abbastanza forte da rompere.
Gli override vivono in `solidLab`, sono tenuti entro limiti fissi e tornano ai valori di prodotto
all'uscita; nulla scrive le impostazioni dell'utente. Per provare senza musica basta lasciare la
sorgente in silenzio: colpi e torsioni dissipano, nulla di nuovo si forma finché il mondo non è vivo.

## 11. Budget e prestazioni

| Budget (`SolidBudget`) | Valore di default / laboratorio |
|---|---|
| corpi | 4 |
| elementi | dalla capacità del sistema: 48 nel laboratorio |
| link (intatti o ricordati) | 128 |
| triangoli di superficie | 96 |
| celle | 24 |
| iterazioni del solver | 4, fisse (1–8) |
| CPU del passo solido per frame | 0,5 ms: oltre, il frame è **contato** (`stats.over`), mai compensato |
| draw call / triangoli | 3 / ≤ 96 (più ≤ 128 segmenti e ≤ 48 punti) |

I pool sono allocati una volta e non crescono: ciò che non entra è rifiutato (`seedSolid` → −1,
`stats.refused`). La qualità grafica cambia quante linee di campo circondano il corpo; **non**
tocca topologia, pool o iterazioni, e nulla segue gli FPS.

Benchmark sintetico (`npm run bench`, `src/bench/solid.bench.test.ts`; dati in
[solid-dynamics-benchmark.json](solid-dynamics-benchmark.json)): passi fissi in un mondo vivo e
sonoro, i7-10510U a ~4,4 GHz, macchina non isolata (load ≈ 1,1), 11 ottobre 2026, codice finale
(con il materiale Rigid). Microsecondi per chiamata; fra una corsa e l'altra p50 oscilla del 5–10 %,
p95 e massimi del 30–50 % con il carico della macchina. La tabella della prima milestone era stata
presa a ~3,5 GHz e non è confrontabile riga per riga: il confronto prima / dopo, fatto nella stessa
sessione, è in [resonant-body-report](resonant-body-report.md) §6.

| Scenario | Passo · p50 / p95 / p99 / max | Passi di frattura · p95 / max | Passi di ricomposizione · p95 / max | Topologia · p95 / max | Creazione · p50 | Rotti / riformati |
|---|---|---|---|---|---:|---|
| tetraedro | 15 / 55 / 82 / 473 | 57 / 390 | 37 / 496 | 4 / 101 | 74 | 3 / 3 |
| cubo | 24 / 48 / 73 / 346 | 23 / 77 | 28 / 324 | 15 / 86 | 184 | 12 / 13 |
| icosaedro | 35 / 47 / 57 / 389 | 30 / 54 | 38 / 311 | 14 / 54 | 135 | 21 / 24 |
| 4 icosaedri (budget pieno) | 133 / 154 / 201 / 367 | 108 / 216 | 111 / 357 | 10 / 37 | 395 | 99 / 98 |
| tetraedro · Rigid | 11 / 38 / 55 / 368 | 68 / 870 | 46 / 439 | 1 / 14 | 14 | 3 / 3 |
| cubo · Rigid | 24 / 32 / 41 / 399 | 25 / 178 | 34 / 427 | 2 / 6 | 52 | 8 / 8 |
| icosaedro · Rigid | 36 / 49 / 58 / 422 | 32 / 128 | 43 / 320 | 4 / 9 | 72 | 10 / 10 |
| 4 icosaedri · Rigid (budget pieno) | 139 / 156 / 198 / 416 | 120 / 461 | 149 / 581 | 14 / 68 | 302 | 44 / 44 |

Le righe Rigid pagano nello stesso passo il fit di forma di ogni pezzo e, alla frattura, il taglio
da evento; le colonne «creazione» e «topologia» calano con l'ordine in cui gli scenari girano (JIT
caldo), non con il materiale.

Buffer GPU (`draw`, vista All): 4–9 µs p50, 6–22 µs p95 per corpo. Il passo strutturale senza
corpi costa 0,7–1,5 µs: tutto il resto è il passo solido. A 60 fps (due passi per frame) un corpo
costa 0,03–0,07 ms di CPU e il budget pieno ~0,27 ms. I massimi isolati (0,35–0,9 ms) compaiono in
ogni colonna, anche nei passi a riposo: sono del runtime (JIT, GC), non della frattura o della
ricomposizione, i cui passi stanno nella stessa banda degli altri. Un massimo sopra il budget di
0,5 ms è contato (`stats.over`), non compensato. Nel browser, con GPU reale (Intel UHD, Chromium
headless, 1672 × 941, High, materiale Rigid): passo solido 0,03–0,04 ms per frame smussato, 3 draw
call del corpo su 20 del frame; nei primi frame dopo l'apertura 2–3 frame oltre budget (picco
8,3 ms, una volta). **Non misurato**: tempo GPU dei tre draw call (nessuna timer query in questo
percorso).

## 12. Verifica (11 ottobre 2026)

Test unitari (Vitest), **31 nuovi in 3 file**; nessuno ripete soltanto la struttura.

- `Solid.test.ts` (25) — *topologia*: vertici, spigoli, facce, celle, valenza, Eulero, orientamento
  e volumi analitici dei tre solidi; `verifyShell` rifiuta guscio aperto, faccia rovesciata, corpo
  rovesciato, piatto, sconnesso; un corpo seminato è fatto di elementi ordinari in pool fissi (e i
  suoi vertici non prendono fili); budget e rifiuti; costruzione link per link. *Volume*: un corpo
  compresso torna al suo volume, tanto meno ne cede quanto più rigide le celle; una cella
  invertita è rigirata; un corpo schiacciato in un punto resta un insieme finito di pezzi.
  *Stabilità*: a riposo non si muove di un bit; colpito o torto perde l'energia e non ne guadagna
  in nessun passo; la torsione non dà rotazione netta; ambiente e strumenti rotti (NaN, infiniti,
  clock che salta). *Tempo*: determinismo bit per bit senza `Math.random`; la stessa vita a 30, 60
  e 144 fps (stesso stato allo stesso numero di passi, comprese fratture e ricomposizioni).
  *Frattura*: uno spigolo rotto non crea un frammento; i pezzi (vertice libero, catena, anello,
  superficie) si leggono dai link; un colpo rompe per carico conservando posizione, velocità e
  identità; segue la resistenza del materiale. *Ricomposizione*: tetraedro e cubo si ritrovano un
  link alla volta; non in silenzio, non in un mondo caldo o incoerente, non oltre la portata, non
  fra capi in moto; un pezzo capovolto è rigirato prima di essere ripreso; ciò che è dimenticato
  non si riforma. *Formazione*: i tre solidi si formano da materia sparsa passando per catene e
  superfici, volume solo a guscio chiuso; in silenzio no. *Risonanza e ambiente*: tono, modi lenti
  e bande fini deformano come previsto e non spostano il corpo; sordo o in silenzio non cambia una
  posizione; vortice, fronte, potenziale, accoppiamento a zero; un mondo caotico e un suono forte
  alla sua altezza lo rompono.
- `SolidLab.test.ts` (5) — non è una scena del prodotto (registry, fixture, menu Scene; nessuna
  scena ha uno slot `solid`); buio e fermo senza suono, lo stesso corpo a ogni qualità; buffer
  fissi, ciò che è disegnato è lo stato della simulazione, rilascio delle risorse GPU;
  l'interruttore è letto solo a laboratorio aperto (override, solidi, strumenti, viste);
  **dimostrazione di riferimento** sul segnale reale.
- `solid.bench.test.ts` (1) — il benchmark del §11, con limiti larghi.

### La dimostrazione di riferimento

Segnale `buildDrop` attraverso WASM → Experience → World → laboratorio, per i tre solidi:

1. nell'apertura (0–11 s) il corpo resta **intero** e la musica lo deforma: fino al 4–5% RMS
   della lunghezza dei link, volume fra −7% e +11%, deformazione dei link che cambia segno di
   continuo, stress di picco 0,4–0,6;
2. build e drop lo **rompono** (primo link a 12,8 / 13,4 / 14,9 s): a 20 s restano 0 link su 6
   (tetraedro), 1 su 18 (cubo), 3–5 su 30 (icosaedro); nessun elemento in meno;
3. due secondi dopo i pezzi rispondono ancora al suono e si muovono;
4. nella musica più calma il tetraedro **si ritrova** (5 link su 6 a 32 s), il cubo in parte
   (4 a 32 s, 9 su 18 a 44 s), l'icosaedro no (3 su 30).

Il test automatico copre i primi 32 s e asserisce i punti 1–3 per i tre solidi e il punto 4 per il
tetraedro; i numeri a 44 s vengono da una corsa di misura.

Suite completa (`VITEST_MAX_WORKERS=2 npm run check`): typecheck, ESLint, **542 test passati, 1
saltato come prima, 67 file**, build di produzione. Il bundle principale non contiene codice dei
solidi; il chunk lazy della diagnostica, che già portava il sistema strutturale per le sue sonde,
ne porta ora anche il componente solido; laboratorio, primitiva e cockpit non sono in nessun chunk
di produzione.

Prove su GPU reale (Chromium headless, ANGLE su Intel UHD, 1672 × 941 e 1280 × 720, High, segnali
sintetici `beat124` e `buildDrop`): shader compilati senza errori né warning; ingresso da
Laboratories e da `?engine=solid`; i tre solidi, le sette viste, colpo, torsione, frattura, semina;
passaggio a Structural Lab e ritorno; uscita con scena, pin e impostazioni ripristinati
(impostazioni salvate identiche). Nel mondo vivo di `beat124`: il tetraedro seminato si forma in
~15 s e dopo la frattura si ricompone in ~15 s; il cubo arriva a 17 link su 18 in 30 s e dopo la
frattura a 12–13; l'icosaedro a 20 su 30 e a 25–26.

**Non verificato**: musica reale di qualunque genere (solo segnali sintetici); il movimento nel
tempo a occhio (solo fotogrammi e numeri); gusto e leggibilità; app desktop, WebView2 / WebKitGTK;
1080p; tempo GPU; cattura system reale. Il core Rust non è toccato.

## 13. Limiti noti e comportamenti sperimentali

- **Taratura su segnali sintetici.** Rigidezze, ampiezze della spinta risonante, soglie di carico e
  forza della memoria sono punti di partenza. Sul segnale reale di prova il drop distrugge quasi
  del tutto il corpo: con musica vera può risultare troppo fragile o troppo tenace (la soglia di
  frattura del laboratorio serve a deciderlo). Trappola trovata: l'eccitazione meso di un segnale
  reale è ~4 volte quella di un tono sintetico a «livello 0,6»; tarata su quel tono, la spinta
  scaldava i vertici fino a distruggere ogni corpo nel primo secondo.
- **La ricomposizione non è garantita.** In un mondo che continua a suonare forte i link appena
  riformati (danneggiati, ancora disallineati) possono rompersi di nuovo; cubo e icosaedro spesso
  si ricompongono solo in parte, e un icosaedro in molti pezzi di rado si richiude. Il potenziale
  del mondo tiene aperti i pezzi quando la sua pressione è lontana dalla taglia del corpo.
- **Nessuna collisione.** I vertici non urtano facce o altri corpi: un pezzo può attraversare il
  resto del corpo (è così che un pezzo capovolto viene rigirato).
- **Un corpo per volta nel laboratorio.** Il sistema ne regge quattro (provato nel benchmark), ma
  l'inspector e gli strumenti agiscono sul primo.
- **L'icosaedro è un guscio**: non ha celle interne; rotto un solo spigolo perde l'unica cella e
  con essa il vincolo di volume, finché non si richiude.
- **Le cerniere non si rompono e non caricano i link**: una piega non affatica lo spigolo attorno
  a cui avviene.
- **Energia elastica stimata** dalla compliance (link, cerniere, celle), non misurata.
- **I ruoli** di un vertice sono quelli degli elementi (`node`, `fragment`): `surface` non è
  ancora assegnato ai vertici di una faccia di un solido.
- **Il cursore della massa** scala la massa degli elementi del corpo dopo l'integrazione del passo:
  l'effetto sul drag arriva al passo successivo.
- **Formazione** solo verso una figura ricordata (seme): non emergono solidi da materia qualunque.
- **Simulazione su CPU**, giusta per decine di vertici; nessun passo GPU.

## 14. Prossima milestone consigliata

1. **Occhi e musica reale** nel laboratorio: decidere quanto deve essere fragile un corpo e quanto
   deve deformarsi, su un corpus vario; poi fissare soglie e ampiezze.
2. **Superfici e gusci emergenti**: celle che nascono da facce che si chiudono (la verifica esiste
   già), oltre i solidi seminati.
3. **Collisioni interne minime** (vertice–faccia) dove servono alla leggibilità, e contatto fra
   corpi.
4. **Più corpi nel laboratorio**, selezione del corpo nell'inspector, confronto fra materiali.
5. **Frattura per celle** su solidi suddivisi (più tetraedri per corpo), per frammenti volumetrici
   veri invece di lamine e vertici.
6. Tempo GPU per pass nel cockpit, dove la piattaforma lo consente.
