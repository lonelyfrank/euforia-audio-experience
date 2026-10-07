# Scene fisiche — Vector Field, Tunnel, Particle Field

> **Nota del 7 ottobre 2026 (dopo).** La scena qui chiamata **Field** si chiama ora **Vector Field** (id
> `vector-field`, cartella `src/visualizers/vector-field/`; le impostazioni salvate con `field` vengono seguite).
> Il nome diceva "il campo dentro Matter Field", ma ciò che questa scena mostra è il campo vettoriale dei
> flussi, non il grafico circolare che si vede dentro Matter Field: quello è la membrana a disco, estratta in
> [Spectral Shell](spectral-shell.md). Nel resto del documento "Field" indica Vector Field; codice, leggi e
> misure sono invariati.

Data: 7 ottobre 2026 (notte). Continua [world-engine](world-engine.md) e
[visual-engine](visual-engine.md). Tre interventi con una sola regola:

> Un visualizer non si anima perché passa il tempo. Evolve perché cambia il mondo musicale.

```text
analisi audio → WorldState persistente → risposta fisica → trasformazione spaziale → memoria → rilascio / riorganizzazione

World Engine
├── Spectral Matter  → materia / massa                 (recipe, invariata)
├── Matter Field     → materia + campo accoppiati      (recipe, invariata)
├── Vector Field     → campo vettoriale / forze        (recipe, NUOVA; già "Field")
├── Spectral Shell   → membrana risonante e il suo passato (recipe, vedi spectral-shell.md)
├── Spectrum         → frequenza / memoria spettrale   (invariata: riferimento)
├── Resonant Field   → vibrazione / risonanza          (recipe, invariata)
├── Tunnel           → spazio / architettura           (legacy, RIVISTA)
└── Particle Field   → organizzazione di particelle    (legacy, RIVISTA)
```

Le scene non condividono un linguaggio visivo: condividono il mondo. Galaxy, Liquid e
Oscilloscope non sono state toccate.

## 1. Audit: il campo dentro Matter Field

Che cosa si vede muoversi "dentro" Matter Field, e da dove viene:

| Che cosa | File | Sezione |
|---|---|---|
| I flussi a cui la materia libera rilassa | `render-systems/fields/fieldLaw.ts` | `fieldLawGlsl` / `fieldLaw`: termini `U` (surge, vortice, avanzamento, deriva, turbolenza ABC, shimmer) |
| Gli stessi flussi per ciò che non ha stato | `render-systems/fields/flowLaw.ts` | `flowAt` (verificata uguale a `fieldLaw / drag` a forze spente) |
| Le linee che li mostrano | `visual-engine/primitives/FilamentPrimitive.ts` | `filamentPoint`: passi lungo `flowAt` |
| La spinta dei fronti | `fieldLaw.ts` (ciclo sui `uWave*`), `flowLaw.ts` `frontsAt` | fronti datati di `render-systems/waves/WaveField.ts` |
| Come il mondo diventa campo | `render-systems/fields/SpatialFields.ts` | `deriveFields` |
| L'integrazione | `render-systems/particles/matterLaw.ts` | `matterStep`: risposta esatta al drag sul passo |

Equazioni dei flussi (unità visive, asse di simmetria z, `p = P − (lateral, 0, 0)`):

```text
surge      U += surge · min(r / R, 1,5) · r̂                    sorgente / pozzo        ← view.surge (velocità radiale del mondo)
vortice    U += vortex · 1,25 ρ / (0,25 + ρ²) · θ̂              rotazione differenziale ← view.spin
avanzam.   U += advection · 1,25 / (0,25 + d²) · (0, −z, y)     rollio attorno a x      ← view.speed (travel)
deriva     U.x += drift                                         flusso laterale         ← velocità del bias stereo
turbolenza U += turbulence · ABC(p · scala + fase)              solenoidale             ← view.disorder; la fase avanza solo con l'attività
shimmer    U += shimmer · affinità² · ABC(9p + 7·fase + seme)   micro-flusso            ← view.shimmer
fronti     F += 9 · k · d̂,  k = ampiezza · exp(−x²) · banda     spinta radiale datata   ← eventi impact / onset / drop
```

Ingressi del World Engine: `surge`, `spin`, `speed`, `lateral`, `biasVelocity`, `disorder`,
`shimmer`, `tension`, `coherence`, `pressure`, `openness`, `excitation`, `light`, più gli eventi
dello stream. Ciò che in Matter Field tiene la materia in un *corpo* (molla radiale sul
proprio strato, struttura a spirale, legami, grani, forme) è tutto fra le forze `F`: non è
il campo. Riusati senza modifiche: `fieldHeaderGlsl`, `flowLawGlsl` / `flowAt`, `settle`,
`frontsAt`, `WaveField`, `deriveFields`, `substeps`, il layout dei texel e le costanti di
`matterLaw`.

## 2. Field: il mondo come campo vettoriale

`src/visualizers/vector-field/` è una **recipe** (regola del progetto: una scena nuova è una recipe,
non un visualizer monolitico; il `FieldVisualizer` del piano è `RecipeVisualizer` +
`vectorFieldRecipe`). Non è Matter Field senza il guscio: è un sistema suo, F(P), e nella scena
non c'è altro che ciò che lo rende visibile.

```text
F(P) = flowAt(P)                                             i flussi condivisi (§1)
     + r̂ · well · R · 0,3 · wellPull((r/R − 0,55) / 0,3)     gusci: potenziale stazionario del corpo
     + Σ_k awake_k · (−1)^k · eddy · 2c / (c² + |d⊥|²) · exp(−|d|² / a²) · (a_k × d)     vortici locali
     − r̂ · 2,5 · max(0, r − 2,6 R)                           parete morbida, lontana
```

- **Gusci** (`render-systems/fields/wells.ts`): un flusso che converge sui tre gusci del
  corpo. `well = 2,2 · gather · unit(2,5 · energy)`: ordine e potenziale lo approfondiscono,
  ma solo finché il mondo è vivo; nel silenzio il campo non riordina ciò che ha lasciato.
- **Vortici locali**: quattro, attorno ad assi radiali (i vertici di un tetraedro, a 0,6 R),
  di verso alternato, a divergenza nulla. `eddies = 4 · unit(1,6 · disorder + 0,6 ·
  fragmentation − 0,1)` li sveglia uno alla volta: il disordine cambia la **topologia** del
  campo (compaiono nuovi centri), non lo scuote soltanto.
- **Niente avanza col tempo**: l'unica fase è quella del disordine dei campi condivisi,
  ferma quando il mondo è fermo. A riposo F = 0 ovunque dentro la parete (test).

Il campo è uno **spazio**, non un corpo: i traccianti sono seminati fino a 2,4 R
(`FIELD_SPAN`), il corpo con gusci e vortici ne è il centro.

| Mondo | Campo |
|---|---|
| `surge` (velocità radiale, pressione) | sorgente / pozzo: divergenza |
| `spin`, `turn` | vortice attorno all'asse; rotazione della struttura (assi dei vortici) |
| `speed` / `dTravel` | rollio di avanzamento |
| `lateral`, velocità del bias | centro del campo, deriva |
| `coherence` | gusci (lamine) contro flusso disordinato; drag |
| `disorder` | turbolenza ABC e vortici locali |
| `tension` | raggio più stretto, gusci più profondi, drag più alto |
| eventi (`impact`, `onset`, `drop`) | fronti che attraversano il campo; il `drop` è un fronte largo e lento |
| `shimmer` | micro-flusso sui traccianti brillanti, scintille |
| `openness`, larghezza stereo | volume (`radius` + 0,25 · `particleSpread`) |
| `light` | **visibilità**, mai moto (`look.emissive`) |

Due primitive, che leggono gli stessi `uField`, `uWaveA/B` e la stessa `uTopology`:

- `FieldTracerPrimitive` (base): traccianti con stato su GPU (`TracerSimulation`, ping-pong
  come la materia). `accelerazione = fronti + drag · (F + shimmer)`, integrata con la stessa
  risposta esatta al drag della materia. Di un tracciante si disegna il **moto**: una scia
  dalla posizione indietro lungo la sua velocità (lunga quanto si è appena mosso, luminosa
  quanto è veloce) e una testa. Un tracciante fermo mostra un decimo di luce: un campo quieto
  è un quadro quasi vuoto. Si rinnovano solo mentre il mondo è vivo (`0,12 · energy` al secondo).
- `FieldLinePrimitive` (budget strutturale): linee di campo istantanee, senza stato. Ogni
  linea parte da un punto del corpo (`settle`) e segue F a valle; il passo è lungo quanto
  il campo è forte, fino a un massimo: campo debole = trattini, campo forte = curve lunghe.
  Dove F = 0 la linea non ha lunghezza.

Qualità: 36.096 / 23.408 / 12.656 traccianti (High / Medium / Low), 200 × 24 / 130 × 20 /
70 × 16 linee, memoria visiva a metà risoluzione (assente a Low), seconda ottava della
turbolenza da Medium.

**Parità GPU ↔ CPU** delle leggi nuove: `runTracerParity()`
(`render-systems/particles/tracerParity.ts`), come `runParity()` per la materia. 7 ottobre
2026, Intel UHD CML GT2, target full-float, 1.024 traccianti × 120 passi di durata
variabile, tutti i flussi, gusci, vortici e due fronti attivi: media **1,07 · 10⁻⁵**,
massimo **1,46 · 10⁻⁴** unità, percorso medio 1,03 unità, nessuno stato non finito.

## 3. Tunnel: architettura sotto forze acustiche

`TunnelVisualizer` resta la scena che era (sezione dalla linea di basso, anelli dei colpi,
linee del lead, curva, griglia fine, scintille). La parete non è più un tubo fisso:
`tunnel/topology.ts` è una funzione pura della `WorldView` che dice quanto si è aperta, in
che cosa, e dov'è l'ultimo rilascio. Regimi continui, nessuno stato a soglia:

| Regime | Che cosa fa la geometria | Da |
|---|---|---|
| Corridoio | la struttura canonica: tutti i termini a zero | mondo a riposo o coerente |
| Respiro | bassi: anelli che si gonfiano (com'era); medi: la sezione si schiaccia in un ovale il cui asse gira lungo il tunnel; alti: corrugazione fine della parete. Ognuno rotola via con la propria traccia | tracce `LOW` / `MID` / `HIGH`, `midAudible`, `highAudible` |
| Guida d'onda | la parete porta i dodici modi di `ResonantPhysics` (lo stesso campo modale di Resonant Field): coseni attorno alla parete × seni lungo il tunnel, con limite morbido | `snapshot.physics.modes`, `coherence` |
| Torsione | ogni sezione è ruotata in proporzione alla profondità: parete, linee e pannelli si avvolgono insieme (prima era solo l'inclinazione delle linee) | `spin` |
| Frattura | la parete si apre in anelli (tagli assiali) e pannelli (tagli angolari); ogni pezzo è rigido, si solleva e il suo anello ruota; i bordi tagliati sono illuminati | `tension²`, `disorder`, `spin`, impatti (0,35 s), rilascio |
| Collasso | la sezione prende spigoli (poligono) e il fondo del tunnel si stringe | `tension` |
| Rilascio | un fronte di pressione scende nel tunnel a 42 unità/s: dove passa la parete si gonfia e si apre; **dietro** il tunnel ha un'altra struttura (lati della sezione, pannelli, lunghezza degli anelli), davanti ancora quella di prima | `releaseAge`, `releaseStrength`, `Reorganization` |

I pezzi restano sulla stessa superficie attorno allo stesso percorso: descrivono ancora un
volume percorribile (sollevamento ≤ 20% del raggio, tagli ≤ 36% / 28% di una cella).
Implementazione: geometria statica (un cilindro), tutto nel vertex shader; i tagli sono
`discard` nel fragment shader, con le stesse coordinate di cella del vertex shader
(`panelChunk`). Il valore di un pannello è costante sul pannello e si raccorda ai vicini
dentro il taglio, che non viene disegnato.

## 4. Particle Field: particelle che si organizzano

Restano mappatura sullo spettro (nucleo = bassi, bordo = alti), sezione dalle voci, volo,
swirl, anelli dei colpi, scintille, forza laterale stereo. In più le particelle
galleggiano in **un potenziale stazionario comune** (`particle-field/regimes.ts`,
`render-systems/fields/wells.ts`): pozzi attraverso l'asse (gusci), attorno all'asse
(raggi) e lungo l'asse (piani). Non c'è interazione a coppie: le particelle finiscono
insieme perché rispondono allo stesso potenziale, come la polvere sui nodi di un tubo di
Kundt. Quali pozzi sono profondi lo decide il mondo:

| Pozzo | Profondità | Che cosa si vede |
|---|---|---|
| gusci | `order` | gusci ↔ nuvola |
| raggi | `order · unit(tension + 0,8·|spin| + 0,5·excitation)` | con i gusci e il volo: filamenti; con il twist: eliche; il vortice li avvolge (`wind = 0,27 · spin`) |
| piani | `order · unit(1,2·excitation + 0,5·tension)` | lamine attraverso il volo, fronti stazionari; con gli altri due: reticolo |

`order = smoothstep(0,3 … 0,85, coherence) · (1 − 0,75 · disorder) · (1 − melt)`.
A riposo i gusci tengono e ogni altro pozzo è piatto: il campo com'era.

- **Collasso**: il potenziale immagazzinato stringe tutto il campo (fino al 25%).
- **Impatto**: un fronte che entra nel campo a 70 unità/s e attira a sé le particelle che
  attraversa: un'onda di densità, datata sull'impatto del mondo.
- **Rilascio**: il potenziale fonde (in ~0,12 s, senza salti: all'istante del rilascio le
  particelle sono dove erano), l'esplosione dei gusci resta com'era, poi le particelle
  migrano dai pozzi che avevano a quelli della nuova struttura (altri ordini, scelti dal
  rilascio) in circa un secondo.
- **Instabilità fine**: il bordo trema con lo shimmer; le scintille restano libere.

`wellRest(x, a) = x − a · sin(2πx) / 2π` è l'equilibrio in forma chiusa (monotono per
a < 1: le particelle si raccolgono, non si scavalcano); applicato due volte: pozzi poco
profondi inclinano, pozzi profondi stringono in linee sottili.

## 5. Primitive condivise

Estratto solo ciò che due scene usano davvero:

| Modulo | Che cosa | Chi |
|---|---|---|
| `render-systems/fields/wells.ts` | `wellPull` (flusso verso il pozzo), `wellRest` (equilibrio in forma chiusa); GLSL + TS | Field (gusci), Particle Field (gusci, raggi, piani) |
| `world/Reorganization.ts` | quale struttura ha lasciato l'ultimo rilascio (prima / dopo / età), scelta dal tempo audio del rilascio, mai uguale a quella che sostituisce; canonica prima del primo rilascio e a ogni nuova sessione | Tunnel, Particle Field |
| `render-systems/fields/vectorField.ts` | F(P) e la sua topologia; GLSL + TS | traccianti e linee di Field |
| `flowLaw.ts`, `fieldHeaderGlsl`, `WaveField`, costanti di `matterLaw.ts` | riusati così come sono | Field |

Non estratti: il passo dei traccianti duplica dodici righe di `matterStep` (cambia solo
dove un tracciante si riforma: nello spazio del campo, non su uno strato del corpo);
toccare `matterStepGlsl` avrebbe richiesto di ripetere la parità della materia per un
gancio. Tunnel e Particle Field hanno ciascuno la propria funzione dei regimi: le
mappature sono diverse per costruzione.

## 6. Silenzio e frame rate

- **Stato delle scene**: Tunnel e Particle Field non hanno integratori nuovi. Regimi,
  tagli, fronti e riorganizzazione sono funzioni di `WorldView` e delle età degli eventi;
  i tempi sono quelli del mondo (turbolenza 0,4 s / 2 s, potenziale 8 s, eccitazione
  0,45 s) e degli eventi stessi. Field ha uno stato (i traccianti): quando F si annulla
  costeggiano per ~1 / drag secondi e restano dove sono; non vengono rinnovati né raccolti.
- **Nessuna energia nuova**: nei test l'energia cinetica dei traccianti nel silenzio è
  monotona decrescente fino a 10⁻⁶ del valore iniziale; in un mondo mai suonato nessun
  tracciante si muove; gli uniform di Tunnel e Particle Field in un mondo a riposo restano
  identici (a meno della coda del rilascio, 10⁻⁸ dopo 30 s).
- **Frame rate**: uniform uguali a 30 e 144 fps entro 10⁻³ relativo (quanto lasciano i
  guadagni del Director sul viaggio accumulato); nube dei traccianti uguale a 30 / 60 /
  144 fps entro pochi percento nelle misure d'insieme e 0,05 unità di scarto medio per
  tracciante (un percorso turbolento amplifica il passo); la struttura lasciata da un
  rilascio non dipende dalla cadenza.
- Residui ammessi: scorrimento sub-campione delle tracce (vuote nel silenzio) e delle
  scintille, che avanzano con tempo × tempo musicale / shimmer com'era.

## 7. Verifica (7 ottobre 2026)

Test unitari / mock (Vitest), 47 nuovi in 3 file:

- `render-systems/fields/vectorField.test.ts` (12): pozzi; campo nullo a riposo; uguale a
  `flowAt` senza topologia; sorgente / vortice; gusci; vortici a divergenza nulla, continui,
  limitati, che ruotano con la struttura; parete; topologia dal mondo; linee di campo.
- `visualizers/vector-field/VectorField.test.ts` (16): traccianti sul riferimento CPU (semi, quiete,
  circolazione / sorgente / pozzo, vortici e lamine, fronti mai prima del loro tempo,
  silenzio, 30 / 60 / 144 fps, determinismo, mondi rotti) e scena montata su renderer
  simulato (registry, buio senza suono, un solo campo per traccianti e linee, luce ≠ moto,
  sotto-passi, qualità, sessione lunga, indipendenza da `Math.random`, rilascio GPU).
- `visualizers/regimes.test.ts` (19): `Reorganization`; topologia del Tunnel (corridoio a
  riposo, tensione / disordine / torsione, impatto, fronte, limiti e continuità) e scena;
  regimi di Particle Field e scena; silenzio, 30 / 144 fps, semi deterministici, dispose.

I test precedenti di Tunnel e Particle Field (`grammar.test.ts`) passano senza modifiche.

Prove su GPU reale (Intel UHD CML GT2, ANGLE/Mesa, Chromium headless, 1280×720, High,
sorgente sintetica): shader delle tre scene compilati senza errori; `runTracerParity()` e
`runParity()` (materia: media 2,4 · 10⁻⁵, massimo 1,1 · 10⁻⁴, come prima dell'intervento);
fotogrammi guardati per Field (`synthPop`, `buildDrop`, `stereoWidth`, `whiteNoise`), Tunnel
(`buildDrop`: corridoio → torsione e tagli → fronte → nuova struttura) e Particle Field
(`buildDrop`; raggi, reticolo e nuvola forzati dagli uniform).

**Non verificato**: musica reale di qualunque genere (ambient, percussioni, basso
elettronico, mix densi, materiale stereo sbilanciato: solo i segnali sintetici
corrispondenti); il movimento nel tempo (solo fotogrammi); gusto e leggibilità (servono
gli occhi dell'utente); `npm run replay` su un corpus (nessun file locale; l'harness
esercita analisi → esperienza → mondo, non le scene); app desktop, WebView2 / WebKitGTK,
1080p; tempi di frame su macchina scarica.

## 8. Limiti e compromessi

- **Taratura solo su segnali sintetici**: guadagni dei tagli, velocità dei fronti, profondità
  dei pozzi, esposizione e scie di Field sono punti di partenza.
- Field: le scie sono rette (posizione − velocità × tempo); la curvatura viene dalla memoria
  visiva. Una storia per tracciante darebbe traiettorie vere. I vortici locali hanno sedi
  fisse (ruotano con la struttura): non nascono dove il suono li mette.
- Tunnel: i pezzi sono celle di una griglia (anelli × pannelli), non frammenti liberi; un
  secondo rilascio mentre il primo fronte è ancora nel tunnel cambia la struttura oltre quel
  fronte in un colpo (nella nebbia). I tagli sono netti (`discard`), con bordi seghettati a
  Low. La guida d'onda usa gli ordini dei modi della membrana rettangolare.
- Particle Field: i regimi sono equilibri in forma chiusa, non una dinamica: le particelle
  non hanno inerzia propria (il tempo è quello dei campi del mondo). Visti lungo l'asse, i
  piani si leggono come onde di densità che passano, non come lamine ferme.
- `Reorganization` riparte dalla struttura canonica quando il clock si perde (come a una
  nuova sessione).
- Le scintille di Tunnel e Particle Field e i semi delle particelle ora vengono da
  `show/rng.ts` (prima `Math.random`): stessa distribuzione, disposizione diversa ma fissa.

## 9. Prossime scene da portare su questo modello

1. **Galaxy** → gravità / orbite: bracci come onde di densità in un potenziale centrale
   (`wells.ts` in coordinate a spirale), `Reorganization` per il numero di bracci, semi
   deterministici.
2. **Liquid** → superficie fluida: la legge dell'altezza di `WaveSurfacePrimitive` più un
   trasporto da `flowAt`; anelli dai fronti condivisi (`WaveField`) al posto di `ShockRings`.
3. **Oscilloscope** → segnale / traccia: una `SignalTracePrimitive` 3D, deformata dagli
   stessi campi.
4. **Tunnel come recipe**: la parete come primitiva assiale che legge `uField` e `uWave*`,
   così gli anelli dei colpi diventano i fronti condivisi.
5. **Field**: storia per tracciante (traiettorie vere), vortici che nascono sulle sorgenti
   stereo, una vista "in sezione" del campo.
