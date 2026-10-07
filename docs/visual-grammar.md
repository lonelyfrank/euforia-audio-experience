# Visual Grammar — che cosa chiede il suono alla geometria

Data: 7 ottobre 2026. È il contratto fra interpretazione e disegno del
[Visual Engine](visual-engine.md): `GeometryState` (`src/visual-engine/geometry/`),
prodotto ogni frame da `SonicGeometryMapper`, e `MaterialState`
(`src/visual-engine/material/`). Nessuna primitiva legge bande, beat o spettri: legge
questi tratti, quindi un filamento, una superficie e una nuvola di particelle
rispondono allo stesso suono nello stesso modo.

Regole della grammatica:

- **solo tratti continui**: nessuna classe ("questo è un dente di sega"), nessuna tabella
  suono → forma; un suono fra due casi da manuale è un punto fra i loro angoli;
- **ogni tratto ha una ragione percettiva leggibile** (colonna "Perché");
- **niente si misura di nuovo**: il mapper combina ciò che DSP Rust, Experience, Planner
  e World hanno già deciso; l'unica cosa che guarda direttamente è la *forma* dei cicli
  delle voci che l'analisi grafica già produce;
- **a riposo tutto è zero** tranne `coherence` (e la `rigidity` che ne segue): un mondo
  che nulla disturba è intero. Il silenzio riporta la geometria a riposo da solo;
- finito e nei limiti per qualunque ingresso; uguale a 30, 60 e 144 fps.

## 1. Sorgenti

| Sorgente | Che cosa dice | Da dove |
|---|---|---|
| `SoundMorphology` | che tipo di suono è (periodicità, armonicità, rumore, ricchezza, sharpness, transienti, stabilità, larghezza) | misure Rust, per hop, negli snapshot |
| `WorldView` | che cosa succede alla materia (pressione, spin, travel, bias, turbolenza, coerenza, potenziale, luce, apertura, ultimo impatto, ultimo rilascio) | WorldEngine, al tempo udito |
| `ExperienceState` / piano | quanta struttura può portare il momento (`desiredEntropy`, `visualEntropy`, fatica), risonanza, flusso, pressione, moto | ExperienceEngine, Planner |
| cicli delle voci | la forma reale della linea di basso e del lead (`music.bassLine`, `leadLine`, 128 campioni) | analisi grafica TS (`VoiceTracker`) |
| `VisualMaterial` | che materia potrebbe rappresentarlo (8 proprietà) | `deriveMaterial`, invariato ([matter-engine](matter-engine.md) §4) |

## 2. La forma di una voce (`voiceShape.ts`)

`describeCycle(ciclo)` misura quattro cose di un periodo, senza nominarlo:

| Descrittore | Misura | Sinusoide | Dente di sega | Quadra | Rumore |
|---|---|---|---|---|---|
| `edge` | la variazione più ripida, rispetto alla ripidità di una sinusoide della stessa ampiezza | 0 | 1 | 1 | — |
| `step` | quota del ciclo che resta ferma fra i salti (× `edge`) | 0 | 0 | 1 | 0 |
| `skew` | da che parte pende: + se scende più in fretta di quanto sale (× `edge`) | 0 | ±1 | 0 | ~0 |
| `ripple` | quanto oscilla oltre una salita e una discesa | 0 | 0 | 0 | 1 |

Le due voci si combinano pesate con il quadrato della loro presenza (decide la più
chiara; una voce assente non ha forma) e scivolano in ~0,12 s. I cicli arrivano
**limitati in banda e mediati**: un basso a dente di sega reale è un picco che decade
(`edge` ≈ 0,9, `skew` > 0), una quadra reale ha plateau che scendono (`step` ≈ 0).

## 3. Tratti della geometria

Oltre agli 8 del materiale (fragmentation, symmetry, granularity, fluidity, rigidity,
continuity, angularity, connectivity):

| Tratto | Da | Perché | Chi lo usa |
|---|---|---|---|
| `curvature` | forma tonale, senza spigoli né rumore | un suono liscio che si ripete è una linea tonda e continua | filamenti: arco sul guscio ↔ retta; membrana: arco |
| `edgeHardness` | `edge` delle voci; angularity; attacchi netti e brillanti | gli spigoli stanno nel ciclo stesso (la caduta di una saw, i fianchi di una quadra) | fronti d'urto: cerchio ↔ poligono |
| `stepping` | `step` delle voci | tratti piatti fra i salti = gradini | membrana: terrazze; corde dei filamenti: sample-and-hold |
| `skew` (−1..1) | `skew` delle voci | una rampa ha una direzione | membrana: creste inclinate |
| `tonalShape` | voce chiara e pulita; periodicità × stabilità | c'è qualcosa con una forma propria da disegnare | filamenti: lunghezza, ampiezza delle corde, affinità |
| `noiseShape` | noisiness; `ripple` | nessun periodo: irregolarità | rugosità della membrana |
| `coherence` / `disorder` | campi del mondo | ordine e disturbo sono stati del mondo, non del frame | grafo: reticolo; linee nodali della membrana |
| `density` | densità spettrale e temporale | più suono occupa più spazio | quanti filamenti si vedono |
| `branching` | connectivity; parziali legati ma non un solo ciclo; complessità | un accordo si dirama, una nota no | rami dei filamenti |
| `topologyComplexity` | entropia del planner, meno la fatica | quanta struttura regge il momento | budget strutturale del mondo |
| `elasticity` | risonanza, fluidità | un suono risonante continua a vibrare | ampiezza dei modi della membrana |
| `viscosity` | materia poco fluida; potenziale | ciò che è teso o rigido trattiene il moto | scie dei filamenti più corte |
| `tension` | potenziale del mondo | l'attesa tende le strutture | corde e membrana più tese |
| `waveScale` | poca sharpness, molta parte bassa | bassa frequenza = grandi lunghezze d'onda | lunghezza delle increspature; tinta (`blend`) |
| `waveVelocity` | travel del mondo, moto | le onde corrono quanto il mondo si muove (ferme nel silenzio) | fase delle increspature |
| `particleMass` | parte bassa, peso | suono grave = materia pesante e grande | grandezza degli elementi della materia |
| `particleSpread` | apertura, larghezza stereo | un suono aperto riempie il volume | meno raccolta sui gusci (`tune`) |
| `connectionRadius` | symmetry, connectivity, rigidità; meno frammentazione | il suono ordinato e imparentato si lega a distanza | raggio dei giunti del grafo |
| `trailPersistence` | coerenza × stabilità, continuità; meno shimmer e turbolenza | un suono fermo lascia tracce lunghe | memoria visiva, scie dei filamenti |
| `surfaceDisplacement` | pressione, flusso, eccitazione | il sustain è una pressione continua su una superficie | arco della membrana, affinità |
| `surfaceRoughness` | roughness, rumore, grana | battimenti e rumore sono la trama di una superficie | increspature |
| `spatialDepth` | apertura, velocità, larghezza | un mondo aperto e in viaggio è profondo | profondità dell'osservatore |
| `stereoSpread` | larghezza stereo attendibile | larghezza = estensione laterale | stiramento della membrana |
| `lateralBias` (−1..1) | bias del mondo | da dove arrivano le forze | inclinazione della membrana |
| `impulse` | forza ed età dell'ultimo impatto del mondo (0,25 s) | un transiente è un impulso breve | lampo dei nodi |
| `fracture` | forza ed età dell'ultimo rilascio (0,9 s) | un rilascio apre le strutture, che si richiudono | forme della materia, gabbia, fili della membrana |
| `energy` | luce ed eccitazione del mondo | quanto è vivo il mondo | lunghezza minima dei filamenti |

Esempi misurati nei test (sound stage sintetico): sinusoide → `curvature` > 0,6,
`edgeHardness` < 0,2; dente di sega → `edgeHardness` + 0,5, `skew` > 0,5, `stepping` < 0,1;
quadra → `stepping` > 0,6, `skew` ≈ 0; rumore → `noiseShape` > 0,6, `tonalShape` < 0,1.

## 4. Materiale: come si vede (`MaterialState`)

La geometria dice che cosa c'è; il materiale come emette. Le palette restano dell'utente:
qui non c'è nessun colore, solo come pesare le tre tinte. Estetica astratta e sintetica
per costruzione: emissione, bordi, luce di contorno; nessuna texture.

| Proprietà | Da | Uso |
|---|---|---|
| `emissive` | luce del mondo × gate del Director (brightness × visibility) | livello di base di tutto |
| `glow`, `spark`, `surface` | risonanza, shimmer, eccitazione | materia (bagliore interno, scintille, energia esterna) |
| `wave` | luce degli impatti **ammessa dal FlashGuard**, trattenuta mentre i fronti viaggiano; mai meno di una traccia | fronti su ogni primitiva |
| `opacity` | emissione del Director, dissolve, frammentazione | quota di elementi mostrata |
| `edge`, `fill`, `relief` | legami dei campi × coerenza; angularity | legami, giunti, faccette |
| `blend` | `waveScale` | filamenti e grafo: il suono grave pende verso la prima tinta della palette, quello brillante verso la seconda |
| `grain` | rugosità, grana | membrana: luce disuguale punto per punto |
| `fresnel`, `depthFade` | curvature, profondità | **calcolate, non ancora usate da alcuna primitiva** (luce di contorno e dissolvenza in profondità: prossimo passo) |
| `ember` | 7% della luce recente, 6 s | le strutture si raffreddano invece di sparire |
| `gate` | gate del Director | una primitiva con una luce propria (la membrana che risuona) la scala con questo |

Impulsi luminosi e geometria restano vie distinte: con Reduce Flashing i fronti spingono,
strappano e increspano come prima, ma brillano meno.

## 5. Suono → mondo → strutture, in breve

| Suono | Geometria | Che cosa si vede in Matter Field |
|---|---|---|
| tono liscio e stabile | curvature, tonalShape, continuity | filamenti ad arco sui gusci, corde sinuose; materia sulla curva del segnale |
| dente di sega | edgeHardness, skew | corde seghettate, fronti poligonali, creste inclinate |
| quadra / gradini | stepping | terrazze sulla membrana, corde a scalini |
| accordo, pad ricco | connectivity, branching, connectionRadius | rete dei parziali, rami, gabbia che si chiude |
| rumore | noiseShape, surfaceRoughness, granularity | materia libera e granulosa, increspature fini, nessuna gabbia |
| basso sostenuto | particleMass, waveScale, surfaceDisplacement | elementi grandi, increspature lunghe, membrana bombata |
| transiente | fronte del `WaveField`, impulse | anello che si espande, nodi che lampeggiano, materia spinta |
| build | tension, viscosity | tutto si stringe e si tende; il campo visivo si chiude |
| drop | fracture, surge | forme, gabbia e fili si aprono insieme, poi si richiudono |
| turbolenza | disorder, fragmentation | i giunti cedono, i filamenti si aggrovigliano |
| silenzio | tutto a riposo | il budget si svuota, le strutture si sciolgono, resta la brace, poi buio |
