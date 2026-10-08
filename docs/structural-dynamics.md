# Structural Dynamics — elementi fisici, legami, frattura, riformazione

Data: 8 ottobre 2026. Continua [visual-engine](visual-engine.md), [physical-scenes](physical-scenes.md)
e [physics-engine](physics-engine.md). Prima milestone di un sottosistema additivo: nessuna scena
esistente è stata modificata, sostituita o migrata.

> L'audio inietta energia e struttura nel mondo. Il mondo la propaga. I sistemi di primitive
> decidono come si comporta la forma fisica. Il rendering rivela soltanto il risultato.

```text
audio → DSP Rust ─→ MultiscaleResonance (per hop, clock audio)      eccitazione: macro / meso / micro
                  └→ WorldEngine → WorldView → SpatialFields         ambiente: flusso, pressione, potenziale, fronti
                                         ↓
            StructuralSystem (passo fisso sul tempo udito)           materia / struttura: elementi, legami, memoria
              identità procedurale · ordine · temperatura · ruoli
                                         ↓
            topologia: campate, giunti, catene, poligoni chiusi
                                         ↓
            WirePolygonPrimitive (GPU: corde istanziate, punti, facce)   rendering
```

Regole conservate come principi (vedi anche AGENTS.md):

1. L'audio inietta energia; non coreografa l'immagine.
2. L'ambiente governa il moto macro.
3. La risonanza governa la risposta locale.
4. La struttura emerge da compatibilità locale e legami.
5. Caos e ordine sono regimi fisici continui, non cambi di scena.
6. La distruzione cambia la topologia; non uccide l'elemento.
7. I frammenti ereditano l'identità fisica.
8. Il silenzio non crea energia.
9. Il mondo persiste attraverso le rappresentazioni.
10. Il rendering rivela la fisica; non la inventa.

Nessuna IA, rete neurale o decisione non deterministica: campi, vincoli, risonanza, regole di
vicinato, dinamica, transizioni di stato deterministiche.

## 1. Audit: che cosa c'era e che cosa è stato riusato

| Area | Trovato | Decisione |
|---|---|---|
| Particle Field | equilibri in forma chiusa in pozzi di potenziale; nessuna interazione fra particelle, nessuna inerzia | non toccata; `wells.ts` riusato tramite il campo vettoriale |
| Matter Engine / Matter Field | materia GPU persistente (`matterStep`, `fieldLaw`), affinità di banda per particella (`home.w`), legami lungo un filo fisso | non toccati (cambiarli imporrebbe di ripetere la parità GPU ↔ CPU); il loro `layerRadius` e la loro molla radiale sono il potenziale che tiene gli elementi strutturali nel corpo |
| Vector Field | `fieldAt(P)`: flussi condivisi + gusci + vortici locali + parete, GLSL e CPU | **riusato così com'è** come moto macro: gli elementi strutturali sono trasportati dallo stesso F(P) dei traccianti |
| Fronti | `WaveField` + `frontsAt` (spinta datata sugli eventi) | riusati: gli impatti e i rilasci colpiscono le strutture |
| `ConnectionGraphPrimitive` | gabbia senza stato: un giunto "si vede finché tiene", candidati fissi a riposo | lasciata; non ha stato, stress né memoria: il modello nuovo le sta accanto |
| `ResonantPhysics` | dodici modi di membrana, numero fisso | **invariata**; accanto nasce `MultiscaleResonance`, a conteggi configurabili |
| `SonicGeometryMapper` / `GeometryState` | coerenza, simmetria, disordine, tensione, energia, frattura | sono i livelli dell'ambiente strutturale; nessun tratto nuovo |
| `VisualWorld` / `WorldRecipe` / `Primitive` | slot, budget, presenze, campi impacchettati una volta | la struttura è una primitiva come le altre; una sola aggiunta opzionale (`recipe.resonance` → `frame.resonance`) |
| Overlay DEV, `worldLab`, `matterLab` | pattern degli interruttori di sviluppo | stesso pattern: `structuralLab`, cockpit caricato solo in DEV |

## 2. Moduli

| File | Ruolo |
|---|---|
| `src/physics/MultiscaleResonance.ts` | i risonatori a tre scale, per hop dentro `ExperienceEngine`, nello snapshot (`snapshot.resonance`) |
| `src/visual-engine/structural/StructuralTypes.ts` | ruoli, lifecycle, configurazione, override di sviluppo, interfaccia dell'ambiente |
| `…/StructuralIdentity.ts` | identità fisica procedurale (hash intero, distribuzioni continue) |
| `…/ResonanceField.ts` | risposta risonante per (f0, Q): curva analitica + tabella per frame |
| `…/StructuralState.ts` | pool a capacità fissa in typed array (elementi, legami, memoria, poligoni) |
| `…/BondSystem.ts` | legami: forza, controvento dell'angolo, carico, danno, frattura, compatibilità, memoria |
| `…/StructuralLifecycle.ts` | ordine, temperatura, coesione, ruoli, lettura del lifecycle |
| `…/StructuralDynamics.ts` | `StructuralSystem`: passo fisso, griglia spaziale, formazione, contabilità, statistiche |
| `src/visual-engine/primitives/WirePolygonPrimitive.ts` | la primitiva che lo disegna, l'adattatore verso l'ambiente del mondo, `structuralLab` |
| `…/structural/lab/` | recipe e definizione dello **Structural Lab** (solo DEV) |
| `src/app/engine/EngineCockpit.ts` | il cockpit tecnico (solo DEV) |

## 3. Modello dell'elemento

Particelle, capi di un filo, vertici di un poligono e frammenti sono la stessa cosa: un **elemento**.

**Identità stabile** — non è memorizzata: `identityOf(seed, id, population)` è una funzione pura.
L'hash è aritmetica intera a 32 bit (`lowbias32`) e le estrazioni usano i 24 bit alti, quindi sono
valori float32 esatti: uno shader calcola gli stessi bit senza alcun buffer per particella. Il
sistema CPU ne tiene una copia per i suoi elementi.

| Proprietà | Legge (continua in `f0`, con una variazione propria) |
|---|---|
| `f0` risonanza naturale | centro della popolazione ± ampiezza, distribuzione triangolare, sull'asse log 20 Hz – 20 kHz |
| `mass` | 3,2 → 0,35 da un capo all'altro dell'asse (≈ 9 ×) |
| `q` selettività | massima per la materia media |
| `coupling` al mezzo | cresce con `f0`: la materia leggera segue ogni vortice |
| `bondAffinity` | campana sulla materia media: è quella che lega |
| `resistance` alla frattura | più alta in basso |
| `structuralAffinity` | ordine del poligono a cui tende (3 … 6, reale) |
| `damping`, `persistence`, `seed` | attrito interno, quanto conserva ciò che le accade (la materia finissima dimentica), numero proprio |

Non esistono categorie di particelle né `if` per tipo: solo una distribuzione.

**Stato dinamico** (un valore per elemento): posizione, velocità, eccitazione, oscillazione firmata,
micro-eccitazione, energia, stress, coesione, ordine locale, temperatura locale, shock della
frattura, età, pesi dei ruoli, ruolo dominante, lifecycle, strato di casa nel corpo del mondo.

## 4. Risonanza

**A monte** (`MultiscaleResonance`, per hop, deterministica, senza allocazioni): tre scale di un
unico asse di frequenza, a conteggi configurabili (default 12 / 32 / 8; limiti 4–16 / 8–64 / 2–16).

| Scala | Che cosa è | Che cosa la guida (solo misure già esportate dal DSP) |
|---|---|---|
| macro | pochi modi lenti (0,22–1,3 Hz visivi): flessione, respiro | `bandLevel` delle otto bande; gli eventi li colpiscono |
| meso | gruppi di risonatori lungo l'asse (0,9–6,5 Hz visivi; smorzamento 0,07 → 0,16: i bassi suonano per secondi) | `pitchBins` × tonalità; inviluppo ERB relativo alla banda più forte × energia; `bandTransient` li colpisce |
| micro | inviluppi della parte alta dello spettro (≥ ~1,3 kHz), senza portante | `bandLevel`, `sharpness`, `bandTransient` |

Macro e meso sono oscillatori smorzati esatti (lo stesso passo in forma chiusa di `ResonantPhysics`,
che resta com'è): spinti alla propria frequenza oscillano quanto sono spinti, e senza suono
decadono. Nulla è misurato in TypeScript.

**A valle** (`ResonanceField`): un elemento è un risonatore a `f0` con selettività `q`:

```text
risposta(u) = 1 / (1 + ((u − f0) / banda(q))²)        lorentziana sull'asse log; banda 0,22 (q = 0) → 0,035 (q = 1)
```

Un oscillatore per elemento sarebbe la stessa fisica a molte volte il costo. Una volta per frame
le risposte di tutti gli (f0, q) sono scritte in una tabella 64 × 4 (spostamento firmato, ampiezza,
micro), disposta come texture RGBA float; gli elementi la leggono con la propria identità. Un
elemento selettivo prende intero un tono alla sua altezza e poco di uno spettro diffuso; uno largo
il contrario. Elementi di altezza simile oscillano in fase.

## 5. Macro e micro

```text
accelerazione = drag · coupling / massa · (flusso − velocità)     il mezzo: fieldAt (surge, vortice, deriva, turbolenza, gusci, vortici locali, parete)
              + fronti / massa                                    gli eventi del mondo che passano
              + potenziale                                        la molla radiale del corpo: la pressione del mondo sposta il raggio di riposo
              + legami + controventi                              vincoli strutturali
              + vicinato                                          materia assestata e compatibile si avvicina
              + memoria                                           il richiamo verso il partner perduto
```

L'ambiente decide **dove** va un elemento; la risonanza decide **come** risponde dov'è: di quanto
oscilla attorno alla propria posizione (lungo il raggio), i modi di corda dei suoi fili, la sua
luce, il carico sui suoi legami. Il suono non scrive mai una posizione. La risposta al drag è
esatta sul passo (come `matterStep`).

## 6. Ordine, temperatura, ruoli, lifecycle

- **Ordine** locale ∈ [0, 1]: ciò che il mondo offre (coerenza × (0,6 + 0,4 · armonia)) per ciò
  che il vicinato ne fa (allineamento delle velocità, accordo di risonanza), meno ciò che lo agita.
  Sale in ~1 s, si perde in ~0,35 s.
- **Temperatura** (attività, non termodinamica): velocità rispetto al mezzo e rispetto ai vicini,
  turbolenza, rilascio, frattura recente. Si sente in ~0,12 s, si raffredda in ~1 s.
- **Coesione**: si integra mentre l'elemento è ordinato, freddo, fermo nel mezzo e di materia che
  lega, e solo in un mondo vivo. A 1 può legare. Ogni legame ne costa una parte: le strutture
  crescono un passo alla volta.

Caldo + disordinato = nube caotica; freddo + disordinato = ammasso amorfo; freddo + ordinato =
struttura stabile; caldo + ordinato = flusso coerente. Nessuno è un ramo: l'ordine rafforza i
legami e lascia crescere la coesione, la temperatura li carica e la trattiene.

**Ruoli** (pesi che sommano a 1: `free`, `node`, `edge`, `surface`, `anchor`, `fragment`, `tracer`):
tendenze continue dalle condizioni locali, seguite con tempi 0,35 / 0,7 s; il ruolo dominante
cambia solo oltre un margine (isteresi). **Lifecycle** (`dormant` → `excited` → `cohering` →
`bound` → `stressed` → `fractured` → `free` → `reforming`): solo un nome letto dallo stato
continuo per gli strumenti di sviluppo, con soglie più basse in uscita che in entrata.

## 7. Legami

Un legame è una molla smorzata fra due elementi con lunghezza di riposo, rigidezza, smorzamento,
resistenza, età, carico, danno e accoppiamento alla risonanza. Due specie differiscono solo nei
numeri:

- **campata** (`span`): ha una lunghezza: un filo. Un elemento ne porta al più una.
- **giunto** (`joint`): quasi nessuna lunghezza: la saldatura fra i capi di due fili. Al più
  `maxJoints` per elemento (1 = catene e poligoni; fino a 3 = reti).

Dove due fili si incontrano in un giunto, un **controvento** fra i loro capi lontani tiene l'angolo
del poligono a cui quella materia tende (ordine reale `n`): una catena si incurva e si chiude da sé.
Un giunto appena fatto è una cerniera e si irrigidisce in ~1,5 s. Tutte le forze sono centrali e a
coppie: struttura e frammenti conservano quantità di moto e momento angolare.

**Formazione** (mai globale, mai O(n²)): ogni elemento guarda i vicini in una griglia spaziale a
celle limitate (2048 secchi, 8 elementi per secchio, al più 20 vicini) e i partner che ricorda.

```text
compatibilità = exp(−((d − ideale)/raggio)² − ((f0ᵢ − f0ⱼ)/0,12)²) / (1 + |Δv|²/0,6²) · √(affinitàᵢ · affinitàⱼ) · parentela
```

Lega con il più compatibile se entrambi sono assestati (coesione ≥ 1), se c'è uno slot libero e se
la figura che ne risulta è ammessa (poligono chiuso di almeno tre lati; catena non più lunga del
massimo). Il legame nasce alla lunghezza a cui i due si trovano (nulla salta) e si assesta alla
propria in ~1 s.

**Carico e frattura**:

```text
carico = deformazione + velocità di chiusura + accoppiamento · (disaccordo di oscillazione + ampiezza)
       + tensione del mondo + temperatura + rilascio
resistenza = forza del legame · (0,55 + 0,45 · ordine) · (1 − 0,5 · danno)
```

Sopra il 55% della resistenza il legame si affatica (danno); un mondo ordinato e freddo lo ripara
lentamente. Si rompe quando il carico supera la resistenza o il danno è completo. Un giunto cede
prima di un filo (resistenza 1 contro 1,7). Modi di distruzione implementati: **frattura del
legame** (strappo del giunto, più raramente del filo) ed **espulsione** guidata dal rilascio e dal
campo (il fronte del `drop` e il flusso portano via i pezzi). L'architettura ammette gli altri
(collasso del nodo, distacco della superficie, taglio di campo, frattura armonica) come altri
termini del carico.

## 8. Frammenti e memoria

Rompere libera il legame, mai la materia. I due capi conservano posizione, velocità, eccitazione,
identità; ricevono uno shock (peso `fragment`, che svanisce in ~2,5 s) e una **memoria**: il partner,
la lunghezza che li teneva, il ruolo che avevano. La memoria decade (τ = 25 s a freddo, molte
volte più in fretta a caldo: la materia agitata dimentica). Finché è forte:

- richiama l'elemento verso il partner perduto, tanto più quanto è ordinato e freddo, e solo in un
  mondo vivo;
- lo rende **leale**: non prende un estraneo in quello slot, così una struttura rotta tende a
  ritrovarsi prima di diventare altro; svanita la memoria, può nascere un poligono nuovo.

Nessun pezzo diventa una particella decorativa: i frammenti continuano a risuonare alla propria
altezza, a oscillare, a essere trasportati dal campo.

## 9. Silenzio, determinismo, frame rate

- **Silenzio**: la risonanza decade, il mezzo si ferma, la temperatura scende, la velocità si
  smorza. Coesione, vicinato, memoria e potenziale agiscono solo in un mondo vivo: il silenzio
  finisce ciò che si era assestato e non assesta nulla di nuovo. Un mondo mai suonato non muove
  nemmeno un elemento (test: posizioni identiche bit per bit dopo 10 s).
- **Determinismo**: stessi seme, clock e mondo → stessa vita, bit per bit. Semi da `show/rng.ts`,
  nessun `Math.random` (verificato nei test).
- **Frame rate**: passo fisso (1/120 s) contato sul clock udito; al più otto passi per frame (uno
  stallo è saltato, non recuperato). Le cadenze interne sono in passi, mai in frame: il mezzo è
  campionato ogni due passi, un elemento visita il proprio vicinato ogni sei (a scaglioni: nessun
  passo pesa più di un altro), i poligoni si contano ogni dodici. Ciò che si mostra è estrapolato
  del resto del passo. A 30 / 60 / 144 fps la stessa vita: stessi legami alla fine (± 2), prima
  formazione e prima frattura entro 0,25 s.

## 10. WirePolygonPrimitive e Structural Lab

`WirePolygonPrimitive` disegna un `StructuralSystem`: gli elementi come punti, ogni legame come
una linea **istanziata** (il vertex shader la piega nei primi tre modi di corda del filo, tenuta ai
capi, in due polarizzazioni), i poligoni chiusi come facce tenui quanto sono piani, ordinati e
freddi. La legge della forma del filo (`wirePoint`) è scritta in GLSL e in TypeScript. Buffer a
capacità fissa, nessuna allocazione per frame, nessuna geometria ricreata.

Un poligono non è generato intero: `seedPolygon` posa la materia di N fili (due elementi ciascuno)
dove sarebbero i lati, ogni capo con la memoria del capo a cui appartiene. Lasciata libera, quella
materia si assesta, forma i fili, li salda uno alla volta e chiude la figura quando il mondo lo
permette. Triangolo, quadrato, pentagono, esagono.

**Structural Lab** (`structural-lab`, solo DEV): la struttura (un poligono in ~120 elementi liberi
di materia più fine, che risponde diversamente allo stesso suono e non si salda a esso), i fronti
resi visibili, le linee del campo che la trasporta. Non è nel registry delle scene: non compare
nell'anello Scene, lo show non lo sceglie, nessuna impostazione lo salva.

### La dimostrazione di riferimento

Segnale `buildDrop` attraverso WASM → Experience → World → lab (test automatico, 44 s):

1. il quadrato **non c'è** all'inizio: si forma dalla materia sciolta durante l'apertura (fra 3 e
   13 s), un legame alla volta, fino a otto legami e un ciclo chiuso di quattro lati;
2. finché sta in piedi **oscilla** con il suono (lo spostamento dei vertici cambia segno);
3. build e drop lo **rompono**: restano al più tre dei suoi legami;
4. i pezzi **restano vivi**: due secondi dopo rispondono ancora al suono e si muovono col campo; il
   numero di elementi non cambia mai;
5. nella musica più calma che segue i pezzi **si ritrovano**.

Lo stesso ciclo, con ambiente scritto a mano, arriva a richiudere il quadrato intero (test `the square`).

## 11. Cockpit del motore (solo DEV)

`?engine` oppure `Shift+E`. È una vista tecnica accanto a quella cinematica, non un'interfaccia per
l'utente: la UI esistente (core circolare, ruota, pannello) non è stata toccata e resta dentro la
viewport.

| Zona | Contenuto |
|---|---|
| sinistra | moduli (Structures, Resonance, Environment, Diagnostics; gli altri sono elencati come mappa, non costruiti), mondo nella viewport, segnale di prova, geometria da isolare (tutto / particelle / nodi / lati / poligono / superficie / frammenti), lati del poligono |
| centro | il mondo dal vivo: lo stage dell'applicazione in una cornice più piccola |
| destra | ispettore del modulo: valori dal vivo e override di sviluppo |
| basso | tracce (ordine, temperatura, stress, eccitazione, materia strutturata, frammenti; 30 s a 20 Hz) e costo del motore strutturale |

**Structures**: elementi, materia libera / strutturata, nodi, legami (fili, giunti), poligoni chiusi,
frammenti, ordine, temperatura, stress, eccitazione e resistenza medi, energia cinetica, legami
fatti / rotti, pesi dei ruoli, conteggi del lifecycle. **Override** (bordo tratteggiato, "not
saved"): coerenza e temperatura (sostituiscono il valore del mondo solo se spuntate), soglia di
frattura, forza dei legami, accoppiamento alla risonanza, accoppiamento all'ambiente. Azioni:
Seed, Form, Strike, Scatter.

Nulla scrive le impostazioni dell'utente: il mondo nella viewport è fissato sul rig
(`RigController.pinned`), il segnale è quello di debug, gli override vivono in `structuralLab` e
tornano ai valori del prodotto alla chiusura. Il cockpit e il laboratorio non entrano nel bundle
di produzione.

## 12. Verifica (8 ottobre 2026)

Test unitari / mock (Vitest), **34 nuovi in 3 file**:

- `physics/MultiscaleResonance.test.ts` (7): conteggi configurabili e limiti; un tono fa suonare il
  gruppo alla sua altezza e poco altro; oscillazione firmata; decadimento nel silenzio (nulla sale,
  i bassi durano più degli alti); transienti, eventi, micro; determinismo, ingressi rotti, reset;
  copia posseduta nello snapshot, `ResonantPhysics` intatta.
- `visual-engine/structural/Structural.test.ts` (20): identità deterministica e continua; risposta
  con picco su `f0`; materia diversa, risposta diversa; formazione di un legame (non istantanea);
  nessuna formazione in condizioni incompatibili (altezza, distanza, incoerenza, turbolenza,
  silenzio, override, elementi che si allontanano); rottura sotto carico senza salti di posizione;
  limiti delle risorse in una corsa lunga e violenta; eredità del frammento; decadimento della
  memoria; caos → ordine; ordine → frattura; ruoli senza sfarfallio; silenzio; ambiente rotto
  (NaN, infiniti, clock che salta); determinismo senza `Math.random`; 30 / 60 / 144 fps; ciclo del
  quadrato completo; triangolo … esagono.
- `visual-engine/structural/StructuralLab.test.ts` (7): legge del filo; il lab non è una scena del
  prodotto (registry, fixture, menu Scene) e gli altri mondi non hanno campo di risonanza; buio e
  fermo senza suono; buffer fissi e rilascio delle risorse GPU; interruttore di sviluppo letto solo
  a cockpit aperto; scala di qualità; **dimostrazione di riferimento** sul segnale reale.

Suite completa (`npm run check`): **422 test in 54 file** (1 saltato come prima), typecheck, ESLint e build
di produzione riusciti; il bundle di produzione non contiene cockpit, laboratorio né sistema strutturale
(solo `MultiscaleResonance` e `ResonanceField`). Core Rust invariato e rieseguito: 59 test + 1 doctest.

Prove su GPU reale (Intel UHD CML GT2, ANGLE/Mesa, Chromium headless, 1440×810 e 1280×720, High,
sorgente sintetica): shader della struttura compilati senza errori né warning; cockpit aperto con
`?engine` e a runtime con `Shift+E`, poi richiuso (viewport 732×544 ↔ 1280×720, scena cinematica
ripristinata, impostazioni salvate invariate); tutte le undici scene del prodotto montate una dopo
l'altra senza errori; fotogrammi guardati del lab (formazione, dopo il drop, poligono isolato) e
dei moduli Resonance, Environment, Diagnostics.

**Non verificato**: musica reale di qualunque genere (solo segnali sintetici); il movimento nel
tempo a occhio (solo fotogrammi e numeri); gusto e leggibilità; app desktop, WebView2 / WebKitGTK;
1080p; macchina scarica; tempo GPU (non misurato: nessuna timer query); parità GPU ↔ CPU
dell'hash dell'identità (non esiste ancora una popolazione GPU che lo usi).

## 13. Prestazioni

Misure dell'8 ottobre 2026 su i7-10510U con macchina **molto carica e rallentata** (load ≈ 4,
1,8 GHz: un `Math.exp` costava ~65 ns): valgono come ordine di grandezza su questa macchina.

| Voce | Costo |
|---|---|
| `MultiscaleResonance.update` per hop (12 + 32 + 8) | ~20 µs (`ResonantPhysics`: ~7 µs); ~0,4% di un core a 187 hop/s; paga in ogni sessione, anche senza lab |
| `ResonanceField` (tabella 64 × 4) per frame | ~0,15–0,2 ms; solo nei mondi che la chiedono |
| `StructuralSystem`, 128 elementi, per frame | 1,1–2,3 ms di cui 0,5–0,9 di contabilità (griglia, vicinato, poligoni); 240 elementi: ~0,7 ms per passo |
| GPU della struttura | 3 draw call; 9.236 vertici a capacità piena (136 punti, 272 legami × 32, facce); non misurato in ms |

Il costo CPU cresce linearmente con gli elementi (vicinato limitato). Le scene esistenti non
pagano nulla oltre i 20 µs per hop della risonanza.

## 14. Limiti e compromessi

- **Simulazione su CPU.** Giusta per una topologia rada e mutevole di centinaia di elementi; non
  per decine di migliaia. Identità procedurale, tabella di risonanza in formato texture, stato in
  typed array e vicinato limitato sono pronti per un passo GPU, che non esiste ancora.
- **Taratura solo su segnali sintetici.** Soglie di carico, tempi di coesione, forza della memoria,
  guadagni della risonanza sono punti di partenza; con musica reale possono risultare troppo
  fragili o troppo tenaci (gli override del cockpit servono a questo).
- **La formazione richiede 5–8 s** sui segnali provati; nella dimostrazione sul segnale reale il
  quadrato dopo il drop ritorna a 6–7 legami su 8 entro la fine del brano, non sempre a figura
  chiusa (lo fa con l'ambiente scritto a mano).
- I poligoni emergenti dalla materia libera sono rari in un mezzo fermo: i fili si formano in
  fretta, le catene si chiudono solo se i loro capi si incontrano.
- I ruoli `anchor` e `tracer` sono descrittivi: non modificano ancora la dinamica. `surface` è una
  faccia per ciclo chiuso, non una superficie fatta di più poligoni.
- Un poligono oltre il quadrato non è rigido fuori dal proprio piano (un esagono può piegarsi).
- Il controvento usa l'ordine preferito della materia finché la catena è aperta: una catena di
  materia diversa può chiudersi con un numero di lati diverso da quello a cui tende.
- L'oscillazione di un elemento è lungo il raggio del mondo, non lungo la normale della struttura.
- `MultiscaleResonance` è sempre attiva in `ExperienceEngine` con i conteggi di default; la classe
  è configurabile ma il motore non espone ancora la scelta.
- Il cockpit copre quattro moduli; non misura il tempo GPU; se l'overlay di debug è aperto insieme,
  i due si dividono i contatori del renderer.

## 15. Prossima milestone consigliata

1. **Occhi e musica reale** nel lab: tarare carico, coesione, memoria e risonanza su un corpus
   vario, usando gli override; decidere quanto deve essere fragile una struttura.
2. **Popolazione GPU**: l'identità in GLSL (stesso hash) e la tabella di risonanza come texture
   per decine di migliaia di elementi liberi, con parità GPU ↔ CPU come per la materia; la
   topologia resta su CPU.
3. **Superfici**: facce che condividono lati (reticoli con `maxJoints` > 1), distacco di una
   superficie come modo di distruzione.
4. **Integrazione**: `WirePolygonPrimitive` come slot di Matter Field (una riga nella recipe), solo
   dopo la taratura.
5. Estendere il cockpit agli altri moduli (Input, Analysis, World, Matter, Recipes, Render) e, dove
   la piattaforma lo consente, al tempo GPU per pass.
