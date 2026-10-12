# Rigid Resonant Body e frattura sugli eventi musicali

Data: 11 ottobre 2026. Estende [solid-dynamics](solid-dynamics.md): stessi elementi, stesso passo
fisso, stesso solver. Solo nel laboratorio Solid Dynamics (DEV): nessuna scena del prodotto contiene
un solido, e un corpo del materiale `legacy` è, bit per bit, il corpo di prima.

> Un corpo ha una forma sua. Il suono la fa pulsare e la fa vibrare un poco; non la disfa. Si rompe
> quando la musica dà un evento che spicca, lungo un piano, in pezzi che restano sé stessi.

```text
DSP Rust → hop frame → ExperienceEngine ─┬→ AdaptiveMusicCalibration → snapshot.calibration ─→ GeometryState.pulse ─→ env.pulse
                                         └→ EventStream (impact, drop: `significance`)  ─→ SolidPrimitive (EventCursor) ─→ FractureGate

StructuralSystem.step (1/120 s)   moto predetto di ogni elemento
SolidSystem.solve (stesso passo)  pulsazione → target di link, cerniere e celle (× 1 + p)
                                  proiezione XPBD di link, cerniere, celle (invariata)
                                  fit: shape matching di ogni pezzo sul proprio riferimento
                                  velocità = Δx / h · carico e fatica dei link (misurati)
                                  FractureGate.take → shatter: la legge di carico decide quali link cedono
```

## 1. Che cosa era e che cosa cambia

Nel corpo di prima il suono spostava il riposo di **ogni link per conto suo** (macro 14 %, meso 5 %,
micro 2 %) e il volume di riposo delle celle (25 %). Nulla teneva la forma oltre a link, cerniere e
celle: sul segnale di riferimento il cubo si deformava del 7–18 % della propria taglia già
nell'apertura e a 22 s era a 1 link su 18 (misure al §9).

| | Legacy (com'era) | Rigid | Elastic |
|---|---|---|---|
| Forma | link, cerniere, celle | + fit di forma, ritenzione 0,9 | + fit di forma, ritenzione 0,5 |
| Risposta al suono | ogni link per conto suo | pulsazione uniforme ≤ 6 % + 10 % della spinta locale | pulsazione ≤ 6 % + 50 % della spinta locale |
| Frattura automatica | carico > resistenza (`load`) | solo eventi musicali (`events`) | solo eventi musicali |

Nessun secondo solver, nessun secondo clock: tutto è dentro `SolidSystem.solve`, nello stesso passo.

## 2. Moduli

| File | Ruolo |
|---|---|
| `structural/SolidTypes.ts` | `SolidTuning` (campi nuovi: `shapeRetention`, `maxPulse`, `toughness`, `recovery`, `fragmentIntegrity`), `PULSE_LIMIT`, profili (`solidProfile`), `FractureTuning`, `solidLab` (apre su Rigid + events) |
| `structural/SolidState.ts` | riferimento di forma (`rest`), scala di riferimento (`bodyScale`), rotazione del pezzo (`frame`), assestamento (`settled`), `bodyLargest`, `bodyIntact` |
| `structural/SolidDynamics.ts` | `breathe` (pulsazione), `fit` (shape matching), `shapeRate` (conversione), `shatter` (frattura da evento), misure nuove del `BodyReadout` |
| `structural/FractureGate.ts` | **nuovo**: se un evento musicale può rompere, e quanto |
| `structural/StructuralTypes.ts`, `WorldEnvironment.ts` | `StructuralEnvironment.pulse`, letto da `GeometryState.pulse` |
| `visual-engine/geometry/GeometryState.ts`, `SonicGeometryMapper.ts` | tratto `pulse` (dai bassi calibrati) |
| `primitives/SolidPrimitive.ts` | consegna al gate gli eventi datati (`EventCursor`); comandi del laboratorio |
| `app/engine/SolidCockpit.ts` | pannelli Material, Fracture, Adaptive Calibration, Debug & Metrics |
| `structural/SolidRigid.test.ts`, `SolidLab.test.ts`, `bench/solid.bench.test.ts` | test e benchmark |

## 3. Geometria di riferimento

Ogni corpo conserva, scritti alla semina e **mai dal suono né da una frattura**:

| Dato | Dove | Note |
|---|---|---|
| posizioni di riferimento | `SolidState.rest` (per elemento) | la figura nella posa di semina; un corpo seminato sparso si riferisce alla figura, non a dove è caduto |
| massa | `StructuralState.mass` (identità) × fattore | per elemento; il centro di massa è sempre pesato |
| scala di riferimento | `SolidState.bodyScale` | distanza RMS (pesata per massa) dal centro di massa del riferimento |
| orientamento | `SolidState.frame` (quaternione per elemento, uguale per pezzo) | identità alla semina; un pezzo che si stacca parte dall'orientamento che aveva nell'intero |
| connettività | link, facce, celle | invariata: il fit non crea e non toglie nulla |

I cinque moti sono distinti: **traslazione** e **rotazione** sono libere (il fit segue il pezzo, non
lo trattiene: quantità di moto e momento angolare restano quelli che erano); la **pulsazione** è una
scala sola per corpo; la **deformazione residua** è ciò che resta della spinta per link; la
**frattura** è dei link.

## 4. Conservazione della forma

Per ogni pezzo (componente connessa) di almeno tre elementi, dopo le iterazioni XPBD di link,
cerniere e celle:

```text
c  = Σ m x / M            o  = Σ m q / M              centri di massa: del pezzo, e della sua parte del riferimento
A  = Σ m (x − c)(q − o)ᵀ                              matrice di covarianza
R  = rotazione più vicina ad A                        ricerca iterativa su quaternione, da quella del passo prima (3 passi)
gᵢ = c + (1 + p) · R (qᵢ − o)                         il posto di ogni elemento, alla scala che il corpo pulsa
xᵢ ← xᵢ + β (gᵢ − xᵢ)        β = k h² / (1 + k h²)    una molla implicita di rigidezza k (per unità di massa)
```

Una sola quota β per tutto il pezzo e un obiettivo centrato sul suo stesso centro di massa: la
correzione non dà quantità di moto né momento angolare. La rotazione parte da quella del passo
prima: un pezzo schiacciato o rovesciato conserva la rotazione propria che aveva (nessun cambio
improvviso di orientamento, e una configurazione speculare viene riportata dal lato giusto). Il
solver non è duplicato, le iterazioni non crescono (restano 4).

### La conversione dal 90 % a una rigidezza

Il 90 % è un obiettivo di comportamento, non un coefficiente:

> ritenzione ρ = la quota della deformazione che uno stesso colpo lascia nel corpo tenuto dai soli
> link, e che questo corpo non mostra.

Lo spostamento di picco di un oscillatore colpito con una velocità va come 1/ω, quindi per
lasciarne (1 − ρ) serve una rigidezza aggiunta di `1/(1 − ρ)² − 1` volte quella che c'è:

```text
k(ρ) = K_SHAPE · (1 / (1 − ρ)² − 1)        K_SHAPE = 150 s⁻² per unità di massa        (SolidDynamics.shapeRate)
ρ = 0,9  →  k = 14 850 s⁻²  →  β = 0,51 per passo a 120 Hz
```

`K_SHAPE` è tarato sulla prova di deformazione (colpo di riferimento del laboratorio, forza 5 a
1,4 raggi, mezzo fermo). Residuo misurato, picco della deviazione dalla forma rispetto al Legacy:

| ρ | Tetraedro | Cubo | Icosaedro | Atteso (1 − ρ) |
|---:|---:|---:|---:|---:|
| 0,50 | 0,62 | 0,59 | 0,63 | 0,50 |
| 0,75 | 0,31 | 0,30 | 0,32 | 0,25 |
| **0,90** | **0,094** | **0,089** | **0,098** | **0,10** |
| 0,95 | 0,037 | 0,035 | 0,039 | 0,05 |

La legge è esatta a 0,9 (il valore di prodotto del profilo Rigid) e monotòna ovunque; ai valori
bassi il residuo è un poco più alto del nominale (l'integrazione implicita smorza). Torsione a
ρ = 0,9: 0,056–0,079. Recupero: entro un decimo del picco in 0,03 s (Legacy: 0,12–0,42 s); a fine
prova la deviazione è < 10⁻⁷ della taglia.

### Forme e frammenti

Un pezzo tiene una forma per quanto la sua forma topologica ne ha una (× la ritenzione):

| Forma del pezzo | Quota | Perché |
|---|---:|---|
| `free`, `chain` | 0 | un elemento o una catena non hanno una forma: i loro link sono tutto ciò che sono |
| `polygon` | 0,4 | un anello di link |
| `surface` | 0,85 | un pezzo di superficie è una lastra |
| `shell` | 0,95 | superficie chiusa senza cella verificata |
| `volume` | 1 | almeno una cella tiene |

Il riferimento di un frammento è **la sua parte** del riferimento del corpo (nulla viene ricalcolato
o riscritto alla frattura). `fragmentIntegrity` (0 … 1) scala la ritenzione dei frammenti rispetto
all'intero. Un pezzo che si è appena unito a un altro prende la forma dell'intero col tempo
(`settled`, 2,5 s / `recovery`): solo un link che unisce due pezzi diversi lo azzera, non uno che
si richiude dentro un pezzo.

**Passo limitato.** Un pezzo fuori forma (più del 3 % della scala, `IN_SHAPE`) viene tirato dal fit
di non più dell'1 % della scala per passo (`FIT_STEP`): pezzi che si ritrovano fuori posto entrano
in forma a un passo che si segue con l'occhio, mai di scatto. Un corpo in forma ne è sempre dentro.

## 5. Pulsazione

Una sola rappresentazione, fisica: `p` scala ciò a cui tendono link (`× (1 + p)`), cerniere
(`× (1 + p)`), celle (`× (1 + p)³`) e il fit (`× (1 + p)`). Nessuna scala visiva: il rendering
mostra le posizioni che ne seguono.

```text
drive  = env.pulse × accoppiamento alla risonanza                 (0 … 1, dai bassi calibrati: vedi adaptive-calibration)
mean  += (drive − mean)(1 − e^(−h / 1,6 s))                       il livello recente
target = maxPulse · tanh(2,5 · (drive − mean)) · vivo             solo in un mondo vivo (energia)
p     → target      attacco 35 ms, rilascio 220 ms / recovery     |p| ≤ maxPulse ≤ PULSE_LIMIT = 0,06
```

Il corpo risponde allo **scarto** del drive dal proprio livello recente: un kick lo apre, la pausa
dopo lo richiama, un livello che resta fermo non muove nulla. Il limite è sulla **scala lineare**
(non sul volume: a +6 % il volume è +19 %). Un pezzo che è una forma non resta mai più grande o più
piccolo di `1 ± PULSE_LIMIT`: se la sua scala misurata (proiezione sul riferimento fittato) lo
passa, viene riscalato attorno al proprio centro di massa (nessun momento). In silenzio il mondo non
è vivo e `p` torna a 0.

`GeometryState.pulse` (a monte, in `SonicGeometryMapper`): `low · (0,5 + 0,5 · energy) + 0,3 ·
transient · low` dalla calibrazione. La primitiva non legge bande.

## 6. Materiale

| Proprietà | Dove | Limiti | Rigid | Elastic | Legacy |
|---|---|---|---:|---:|---:|
| Shape retention | `SolidTuning.shapeRetention` | 0 … 0,98 | 0,9 | 0,5 | 0 |
| Maximum pulse | `SolidTuning.maxPulse` | 0 … 0,06 | 0,06 | 0,06 | 0 |
| Elastic compliance | `SolidTuning.stiffness` (esistente) | 0,1 … 4 × | 1 | 1 | 1 |
| Damping | `SolidTuning.damping` (esistente) | 0 … 4 × | 1 | 1 | 1 |
| Resonance coupling | `StructuralTuning.resonanceCoupling` (esistente) | 0 … 3 × | 1 | 1 | 1 |
| Structural toughness | `SolidTuning.toughness`: il danno cresce 1/toughness più piano | 0,25 … 8 × | 2 | 1,5 | 1 |
| Fracture resistance | `StructuralTuning.fractureThreshold` (esistente) | 0,2 … 3 × | 1 | 1 | 1 |
| Recovery rate | `SolidTuning.recovery`: assestamento di link, celle e forma, rilascio della pulsazione | 0,25 … 4 × | 1 | 1,5 | 1 |
| Fragments integrity | `SolidTuning.fragmentIntegrity` | 0 … 1 | 1 | 1 | 1 |

Ogni valore è tenuto nei propri limiti qualunque cosa scriva uno strumento (`within`); ciò che non
è un numero vale il valore di prodotto. Nessuna proprietà duplica una di `SolidTuning` o
`StructuralTuning`: tre erano già lì e sono riusate.

## 7. Frattura sugli eventi musicali

`FractureTuning.mode`: `load` (com'era: un link cede quando porta più di quanto regge) oppure
`events`. In `events` il carico di ogni link è **misurato e mostrato** e lo affatica (fino a 0,95:
la fatica non completa una rottura), ma non rompe nulla fra un evento e l'altro.

### Il gate (`FractureGate`)

Gli eventi sono quelli dell'`EventStream` dell'Experience Engine, **senza un secondo bus**:
`impact` e `drop`, con il campo nuovo `significance` (quanto l'evento spicca fra quelli recenti del
brano: [adaptive-calibration](adaptive-calibration.md) §5). La primitiva li legge con un
`EventCursor` fino al tempo udito e li consegna; il gate li giudica al **passo fisso che raggiunge
il loro tempo audio** (la stessa frattura a 30, 60 e 144 fps).

| Condizione | Valore | Esito se manca |
|---|---|---|
| l'evento spicca | peso ≥ soglia (0,7). Peso: `significance`; per un `drop`, almeno `0,6 + 0,4 · strength` | `threshold` |
| è affidabile | `confidence` ≥ 0,5 | `confidence` |
| cooldown | ≥ 4 s dall'ultima frattura, sul clock della simulazione | `cooldown` |
| isteresi | dopo il cooldown la soglia sta a metà strada verso 1 e scende in un altro cooldown | `threshold` |
| un corpo può prenderlo | budget di frammentazione (sotto) | `budget` |

Mai una soglia di volume: la `strength` di un impatto non entra nel peso. La **quantità** chiesta
(0,2 … 1) segue di quanto l'evento ha passato la soglia e quanto conta per la forma
(`structuralWeight`).

### Dove si rompe (`SolidSystem.shatter`)

L'evento è uno shock che taglia ogni pezzo abbastanza grande lungo un piano: per il centro di massa
se la frattura è grande, spostato fino al 55 % del raggio se è piccola (scheggia). La direzione è
data dal **tempo audio dell'evento** (`seedOf`, mai `Math.random`). I link che attraversano il piano
portano lo shock (0,55 … 1,6 × la loro resistenza, ÷ *fracture resistance*) in più di ciò che già
portavano secondo `loadOf`: cede quello che porta di più, e con lui quelli che allora portano più di
quanto reggono, i più carichi per primi, al più metà dei link del pezzo. Gli altri si affaticano
(`tire`). Ogni rottura passa da `sever`: nulla è creato, tolto o spostato.

I due lati vengono poi allontanati con quantità di moto uguale e opposta (0,5 … 1,4 u/s, come forza
per 0,12 s: la velocità non salta).

**Budget di frammentazione**: un pezzo sotto i 4 elementi non viene rotto ancora; un corpo non
prende eventi mentre è in tanti pezzi quanti i suoi elementi diviso 3, o tiene meno del 60 % dei
suoi link. Un corpo si rompe di nuovo solo quando si è in gran parte ritrovato.

**Contro lo sfarfallio**: dopo una frattura da evento nulla si riforma per 1,5 s; un link formato da
meno di 1,5 s non viene rotto dalla musica (un corpo appena seminato compreso). Lo strumento
*Fracture test* del laboratorio passa dallo stesso gate (`force`) e non aspetta.

La ricomposizione è quella di prima (memoria dei link, coesione, distanza, velocità, verso delle
celle) e **non è garantita**: con pezzi rigidi i link ricordati tirano corpi rigidi, che tornano in
posa insieme.

## 8. Laboratorio

**Laboratories → Avvia Solid Dynamics** (`?engine=solid`). Apre sul corpo **Rigid** che si rompe sugli
**eventi**. Pannelli aggiunti all'inspector esistente (nessuna seconda dashboard):

| Pannello | Contenuto |
|---|---|
| Material | Material mode (Rigid / Elastic / Legacy), Shape retention, Maximum pulse, Damping ×, Resonance coupling ×, Structural toughness ×, Recovery rate × |
| Fracture | Mode (Events / Load), ultimo evento ed esito, peso / soglia, passati, rifiutati; Event confidence, Fracture threshold, Cooldown, Fragments integrity, Fracture resistance × |
| Adaptive Calibration | Enabled / Disabled; Learning state, Confidence, Relative energy, Dynamic range, Response gain, Track scale; bassi, attacco, drive della pulsazione |
| Debug & Metrics | Rest shape deviation, Max edge strain, Volume error, Inverted cells, Body pulse (chiesto e scala), Fragments, Fracture events, Solver, Frame budget |
| Experiment | + *Musical event*: un evento che spicca, offerto al gate come uno della sessione |

Confronti, sempre su **un** corpo e uno dopo l'altro (mai due simulazioni insieme):

| Confronto | Come |
|---|---|
| Legacy / Rigid | Material mode: stesso seme, stessi pool; cambiare materiale risemina il corpo |
| calibrazione attiva / disattiva | Adaptive Calibration → Disabled (ripristinata all'uscita) |
| sintetico / live | selettore del segnale in Experiment Controls (esistente) |
| impulso manuale / evento musicale | *Fracture test* (per il gate, senza attese) / *Musical event* (giudicato dal gate) / gli eventi della sessione |

## 9. Misure

### Dimostrazione di riferimento

Segnale `buildDrop` attraverso WASM → Experience → World → laboratorio (test automatico, 44 s):

| | Tetraedro | Cubo | Icosaedro |
|---|---|---|---|
| 0–19 s (apertura, build): link | 6 / 6 | 18 / 18 | 30 / 30 |
| pulsazione | −4,9 … +5,7 % | uguale | uguale |
| deviazione dalla forma | ≤ 0,03 % | ≤ 0,02 % | ≤ 0,03 % |
| prima frattura | al drop (≈ 19 s) | al drop | al drop |
| link dopo la frattura | 3 / 6 | 10 / 18, 2 pezzi | 20 / 30, 2 pezzi |
| deviazione dei pezzi | — (catena) | 0,05–0,06 % | 0,05–0,07 % |
| di nuovo intero | ≈ 34 s | ≈ 38 s | ≈ 38 s |

Lo stesso segnale sul corpo Legacy (cubo): deviazione 3,6 % a 2 s, 7,3 % a 6 s, 18,6 % a 14 s; 12
link su 18 a 14 s, 2 a 18 s, 1 a 22 s.

Con la **calibrazione disattiva** (stesso seme, stesso segnale): i bassi non calibrati salgono al
loro livello e ci restano, la pulsazione dopo i primi secondi è entro ± 0,3 %, nessun evento spicca
e nessuna frattura avviene.

### Prove su GPU reale

Chromium headless, ANGLE su Intel UHD (CML GT2), 1672 × 941, High, `buildDrop`: shader senza errori
né warning; 60,0 fps, p50 = p95 = p99 = 16,7 ms, 0 frame oltre 33 ms (2947 frame Rigid, 734 Legacy);
20 draw call del frame; passo solido 0,03–0,04 ms per frame; prima frattura a 19,1 s, intero a 33,8 s
(tetraedro), 37,7 s (cubo). Uscita dal laboratorio 83 ms, ingresso 181 ms; calibrazione e pin
ripristinati.

### Costo

Vedi [solid-dynamics](solid-dynamics.md) §11 e
[solid-dynamics-benchmark.json](solid-dynamics-benchmark.json). Il fit costa una manciata di somme
per elemento: passo del cubo 24,4 µs (Rigid) contro 23,8 (Legacy), icosaedro 36,4 contro 35,4,
budget pieno 139 contro 133 (p50, stessa corsa): entro la variabilità fra corse (± 5–10 %).

## 10. Verifica

`npm run check` (11 ottobre 2026): 587 test passati, 1 saltato, 70 file; build di produzione riuscita.

- `SolidRigid.test.ts` (16): i materiali e i loro limiti; un corpo Legacy non sente pulsazione né
  eventi; un minuto di suono ritmico sui tre solidi (interi, pulsazione entro il 6 %, deviazione
  < 0,5 %, nessuna cella rovesciata, stato finito); residuo di deformazione a ρ = 0,9 e monotonia;
  libertà di moto e di rotazione, quantità di moto, riferimento mai riscritto, centro di massa
  fermo; pulsazione sullo scarto e non sul livello, ferma in silenzio; lo stesso corpo a 30, 60 e
  144 fps con gli eventi; il gate (soglia, fiducia, cooldown, isteresi, budget, coda limitata,
  tempo dell'evento); nulla si rompe da sé; frattura lungo un piano con identità, massa e
  continuità; quantità di moto opposta dei pezzi; cooldown e budget; frammenti che tengono la
  forma contro quelli Legacy; ricomposizione senza salti, silenzio, oblio.
- `SolidLab.test.ts` (9, di cui 4 nuovi): il laboratorio apre su Rigid; materiali cambiati sul
  posto; lo strumento di frattura attraverso il gate; eventi della sessione presi al loro tempo e
  solo da quando il corpo è montato; pulsazione dai bassi calibrati; dimostrazione `buildDrop` per
  i tre solidi; calibrazione attiva contro disattiva.
- Traiettoria Legacy contro `d27cb24`: identica (verifica una tantum, per hash).

Esiti completi, benchmark prima / dopo e ciò che non è stato verificato:
[resonant-body-report](resonant-body-report.md).

## 11. Limiti noti

- **Taratura su segnali sintetici.** Soglia del gate, cooldown, ampiezza dello shock e della
  spinta che separa i pezzi sono punti di partenza. **Non verificato con musica reale né a occhio
  nel tempo.**
- **Frammenti piccoli.** Con 4, 8 e 12 vertici un taglio lascia facilmente vertici soli o catene,
  che non hanno forma da tenere. Frammenti volumetrici veri chiedono solidi suddivisi.
- **La ricomposizione resta rapida in un punto**: quando due facce si richiudono la loro cerniera
  si innesta e i vertici si muovono fino a ~5 u/s per qualche frame (0,09 unità in un frame a
  60 fps), come nel Legacy. È continuo e sotto `V_MAX`; non è lento.
- **Un evento che passa apre sempre almeno un link.** Su un corpo scarico un evento appena sopra
  soglia fa una crepa, non un distacco.
- **Il gate è del sistema, non del corpo**: con più corpi il cooldown è comune.
- **Nessuna collisione** (come prima): un pezzo può attraversare l'altro.
- **La conversione ρ → rigidezza** è tarata a 0,9; a 0,5 il residuo misurato è 0,6.
- Tempo GPU dei draw call non misurato.
