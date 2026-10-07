# Spectral Shell — la membrana di Matter Field e il suo passato

Data: 7 ottobre 2026 (dopo [physical-scenes](physical-scenes.md)). Continua
[visual-engine](visual-engine.md). Corregge un'interpretazione: la scena aggiunta la notte
prima come *Field* (oggi **Vector Field**) non è ciò che si vede "dentro" Matter Field.

> Trovare la struttura circolare che c'è già, capirla, estrarla, conservarla, farla evolvere.
> Non inventare un'altra interpretazione di "field".

```text
altezze che suonano (72 pitch bin, DSP Rust) ┐
flow, coerenza di fase, eventi               ├→ ResonantPhysics (clock audio) → 12 modi + 8 impulsi causali
                                             ┘            │ snapshot.physics, presentato al tempo udito
                                                          ↓
              WaveSurfacePrimitive · RESONANT_DISC   la membrana viva        ← Matter Field (slot `surface`)
                          + ModalMemory              i suoi gusci (il passato) ← Spectral Shell (slot `shell`)
                                                          ↑
              GeometryState · uField · uWaveA/B      come sta nello spazio (mondo)
```

## 1. Audit: dov'è il grafico circolare dentro Matter Field

Matter Field monta cinque primitive (`src/visualizers/matter-field/recipe.ts`). Guardate una
alla volta su GPU reale (`?primitives=<id>`, sorgente sintetica `synthPop`, 1280×720, High):

| Slot | Primitiva | Che cosa si vede da sola | È il grafico circolare? |
|---|---|---|---|
| `matter` | `MatterPrimitive` | una nube: materia libera, e materia condensata sulla forma d'onda (`?matter=wave`) o sulla rete armonica (`?matter=harmonic`) | no: anche bloccata sulla forma d'onda resta una nube a lobi, non un grafico |
| `shockwaves` | `ShockwavePrimitive` | due anelli per evento, che si espandono e spariscono | no: brevi, senza deformazione |
| `filaments` | `FilamentPrimitive` | linee di flusso sui gusci | no |
| **`surface`** | **`WaveSurfacePrimitive`** | **un disco di anelli concentrici e raggi, deformato dal suono, visto di sbieco** | **sì** |
| `graph` | `ConnectionGraphPrimitive` | una gabbia di giunti su due gusci | no: è un poliedro, non reagisce alla forma del suono |

Il grafico circolare è lo slot `surface`: la membrana polare a fili.

**Dove nasce.** `src/visual-engine/primitives/WaveSurfacePrimitive.ts`, classe
`WaveSurfacePrimitive`, creata dalla recipe con topologia `polar`, stile `wire`, piano
`axial` (dal 7 ottobre la definizione è la costante condivisa `RESONANT_DISC`).

| | |
|---|---|
| Geometria | `surfaceVertices`: statica, 36 anelli × 144 settori + 24 raggi a High (12.048 vertici, `LineSegments`); ogni vertice porta solo le coordinate sul disco |
| Materiale | un `ShaderMaterial` additivo, senza depth test |
| Vertex shader | `law` (`pulse`, `surfaceHeight`) + posa: dimensione, inclinazione delle creste, rotazione, piano assiale, centro, strappo della turbolenza, fronti |
| Fragment shader | luce × (base + linee nodali + altezza), tre tinte della palette |
| Uniform propri | `uModes[12]`, `uPulses[8]`, `uTime`, `uRelief`, `uTexture`, `uPlace`, `uShape`, `uShow`, `uWave`, `uGrain`, `uAxial`, `uExposure`, `uColorA/B/C` |
| Uniform condivisi | `uField` (campi impacchettati), `uWaveA` / `uWaveB` (fronti datati) |
| Texture, buffer | nessuna texture; nessun buffer aggiornato per frame |

**Che cosa lo muove.**

| Ingresso | Da dove | Effetto |
|---|---|---|
| 12 modi propri | `snapshot.physics.modes` ← `ResonantPhysics` (`src/physics/ResonantPhysics.ts`), nell'`ExperienceEngine`, sul clock audio. Ogni modo è un oscillatore smorzato eccitato dal massimo di 6 dei **72 pitch bin** del DSP Rust × `state.flow` × coerenza di fase, alla propria frequenza naturale | **la forma**: quali modi suonano e quanto |
| 8 impulsi causali | `snapshot.physics.waves`: un evento dell'esperienza (`eventId`, `eventStrength`, `eventTime`) lancia un impulso dal lato del bilanciamento stereo; dà anche momento ai modi | onde che partono, viaggiano e si riflettono al bordo |
| `physics.energy` | idem | la membrana resta illuminata finché risuona |
| Geometria (`GeometryState`) | `elasticity`, `tension`, `surfaceDisplacement`, `curvature`, `surfaceRoughness`, `waveScale`, `waveVelocity`, `stepping`, `skew`, `stereoSpread`, `lateralBias`, `fracture`, `coherence` | ampiezza, arco, increspature, terrazze, inclinazione, strappo, nitidezza delle linee nodali |
| Mondo, via campi | `F_RADIUS` (pressione, apertura, potenziale), `F_TURN` (rotazione accumulata), `F_LATERAL` (bias stereo), `F_TURBULENCE*` e `F_PHASE` (disordine) | dimensione, rotazione, centro, strappo |
| Eventi, via fronti | `uWaveA/B` ← `WaveField` ← `SceneClock.events` | i fronti attraversano il disco: lo spingono e lo sollevano |
| Luce | `look.emissive`, `ember`, `gate`, `wave`, `grain` (`MaterialState`, FlashGuard condiviso) | visibilità, mai forma |
| Presenza | budget strutturale × affinità (`elasticity`, `surfaceDisplacement`) | in Matter Field compare e scompare: per questo sembra emergere dalla materia |

**Non** è mosso da spettro FFT grezzo, waveform, `VoiceTextures`, `SignalTexture` o
`RollingTraces`: è una membrana modale. "Spettrale" è corretto in questo senso: lo spettro
delle altezze (pitch bin) ripiegato su dodici risonatori.

Un candidato scartato va nominato perché il codice lo suggeriva: la *forma del segnale*
della materia (`SignalForm` + `waveAnchor` in `formLaw.ts`) avvolge davvero il ciclo delle
voci ad anello, ma a schermo è una nube che si addensa, non il grafico a linee che si legge
dentro la scena. L'identificazione è stata fatta sulle immagini, non sui nomi.

## 2. Che cosa è stato estratto e che cosa è condiviso

Nulla è stato copiato. `WaveSurfacePrimitive` era già una primitiva condivisa (Resonant Field
la usa come griglia di punti); l'estrazione è stata:

- **`RESONANT_DISC`** (in `WaveSurfacePrimitive.ts`): la definizione del disco di Matter
  Field, prima scritta dentro la sua recipe. Matter Field e Spectral Shell la usano entrambe:
  stessa topologia, stile, piano, dimensione, rilievo, esposizione.
- **`shells`** (opzione della stessa primitiva, spenta di default): il passato della
  membrana attorno a essa. Matter Field e Resonant Field non la chiedono e restano a un solo
  layer.
- **`ModalMemory`** (`visual-engine/primitives/ModalMemory.ts`, nuovo): la memoria dei modi.

Lo shader della membrana senza gusci differisce da quello precedente in tre punti senza
effetto numerico (`uModes[0 + i]`, `uTime − 0.0 − w.z`, una variabile per lo strappo); tutto
il resto del codice dei gusci è escluso a compile time (`#if LAYERS > 1`). Verificato
confrontando il testo dello shader compilato di Matter Field prima e dopo.

Riusati così come sono: `fieldHeaderGlsl`, `flowLawGlsl` (`frontsAt`), `ShockwavePrimitive`,
`MatterPrimitive` (senza forme), `VisualWorld`, `SonicGeometryMapper`, `MaterialSystem`.
Nessuna modifica a DSP, wire, WASM, `ExperienceEngine`, `WorldEngine`, `fieldLaw`, `formLaw`,
`matterStep`, leggi dei traccianti, Spectrum.

## 3. La scena

`src/visualizers/spectral-shell/` è una recipe di tre primitive:

| Slot | Primitiva | Quando |
|---|---|---|
| `shell` (base) | `WaveSurfacePrimitive` con `RESONANT_DISC` + `shells` | sempre: è il corpo del mondo, buio e piatto senza suono |
| `shockwaves` | `ShockwavePrimitive` | con qualunque suono (costo 0,3) |
| `dust` | `MatterPrimitive` senza forme, 16.000 elementi a High | suono pieno e fitto: `unit(0,25 + 0,9·density + 0,5·noiseShape)` |

La membrana viva è **esattamente** quella di Matter Field (stessi vertici, stessa legge
dell'altezza, stessi uniform a parità di suono e di mondo: test). La polvere è la stessa
materia libera del mondo, in piccola quantità: la struttura si vede attraverso di essa, come
dentro Matter Field, senza ricostruirle intorno Matter Field.

### I gusci: una storia volumetrica del suono

Ogni guscio è la stessa membrana **come risuonava un momento fa**:

- i **modi** vengono da `ModalMemory`: un anello limitato di righe a 30 tick al secondo del
  clock audio (non una riga per frame). Il valore a un tick è interpolato fra i due frame
  che lo contengono; una lettura fra l'ultimo tick e adesso, fra quel tick e i modi vivi.
  Prima che qualcosa suonasse la membrana era piatta;
- gli **impulsi** non hanno bisogno di memoria: sono datati, e il guscio li valuta a
  `uTime − età` (restano causali).

Età del guscio k di n: `span · (k / n)^1,6`, con `span` = 1,4 s. A High (4 gusci): 0,15 /
0,46 / 0,88 / 1,4 s — i primi seguono la membrana da vicino, gli ultimi sono la sua memoria.
I modi girano a 0,45–1,8 Hz: gusci di età diversa mostrano fasi diverse dello stesso moto,
quindi un'onda che si legge passare dal centro verso l'esterno.

**Legge del guscio** (`shellPoint`, GLSL + riferimento TS). Il disco è piegato nella calotta
della sfera che passa per il suo bordo:

```text
b = piega,  a = raggio del bordo,  r = distanza dal centro sul disco (0..1),  h = altezza
laterale = a · sin(r·b) / sin(b) + sin(r·b) · h
assiale  = lato · ( a · (cos(r·b) − cos(b)) / sin(b) + cos(r·b) · h )
```

Il bordo resta nel piano della membrana (un cerchio di raggio `a`: gli anelli concentrici
del grafico si estendono verso l'esterno), il polo si alza di `a · tan(b/2)`, e l'altezza
del suono sposta ogni punto lungo la normale della calotta: `r(θ, φ) = raggio + forma del
suono`. Con `b → 0` è la membrana piatta, più grande; con `b = π/2` un emisfero. I gusci
stanno alternati sopra e sotto la membrana: il passato la chiude in un guscio (con il
pavimento riflettente attivo si vede la metà sopra e il suo riflesso).

### Che cosa decide il suono, che cosa il mondo

Il suono dà la forma; il mondo non la scrive mai (test: gli stessi modi in ogni mondo).

| Mondo | Effetto sulla struttura | Dove |
|---|---|---|
| `pressure` | espansione / contrazione di tutto | `F_RADIUS` (già della membrana) |
| `tension` (potenziale) | membrana più tesa (−35% di ampiezza); gusci tirati dentro (−40% di distanza) e chiusi (+0,45 di piega) | `shells.spread`, `shells.bend` |
| `coherence` | linee nodali nitide, fili integri | `uShow.y` (già della membrana) |
| `disorder` | strappo della turbolenza, fino a 3× sui gusci più vecchi (sono stati più a lungo nel flusso) | `uPlace.w · (1 + 2·quota)` |
| `spin` / `turn` | rotazione della struttura; **torsione**: ogni guscio è rimasto dov'era la struttura quando suonò, quindi la pila si avvita | `F_TURN`; `− 0,5 · F_VORTEX · età` |
| `lateral`, velocità del bias | centro e inclinazione; i gusci **restano indietro** quando il centro si sposta | `F_LATERAL`; `− 1,5 · F_DRIFT · età` |
| `openness`, larghezza stereo | gusci più distanti, volume più ampio | `shells.spread ∝ 0,4 + 0,6·particleSpread` |
| rilascio (`releaseStrength`, `releaseAge`) | i gusci si separano dal nucleo (+120%) e si aprono (−0,4 di piega), poi si richiudono (0,9 s); il fronte largo del drop attraversa tutto; i fili si allentano | `fracture`; `uWaveA/B` |
| `shimmer` | increspatura fine su tutta la struttura; la sua fase avanza solo con l'attività del mondo | `0,05 · F_SHIMMER · sin · sin` |
| `light` | visibilità, mai geometria | `look.emissive`, `ember` |

Il ritardo laterale è esatto al primo ordine (`F_LATERAL` cambia a 1,5 × `F_DRIFT`); la
torsione è stilizzata (la struttura gira un quinto più piano: la torsione vera non si
leggerebbe).

Luce dei gusci: −70% al più vecchio; quelli oltre la *portata* sfumano
(`reach = 0,35 + 0,9 · trailPersistence`: un suono stabile e coerente lascia tracce lunghe,
uno caotico mostra solo i gusci più giovani); ciò che sta dietro il centro è più tenue con
`look.depthFade` (profondità leggibile senza volumetria).

### Silenzio e frame rate

- **Silenzio**: i modi si smorzano da soli (fisica dell'engine), gli impulsi decadono, la
  memoria si svuota in `span` secondi e ogni guscio torna piatto; la luce scende alla brace
  e poi a zero; la polvere si scioglie. Dopo, nessun uniform cambia più (test: fase
  dell'increspatura e campi identici dopo 40 s).
- **Nessun orologio decorativo**: non c'è `uTime` che animi nulla. `uTime` è il tempo audio
  udito e serve solo a datare impulsi e fronti. La fase dell'increspatura avanza con
  `waveVelocity`, quella dello shimmer con l'attività del mondo.
- **Frame rate**: i gusci dipendono dal tempo audio, non dai frame. A 30 / 60 / 144 fps i
  modi di ogni guscio coincidono entro 0,005 (errore dell'interpolazione lineare fra tick)
  con lo stato vero a `tempo − età` (test).
- **Sessione**: un clock che torna indietro di più di 1 s svuota la memoria; senza clock
  nulla è datato e tutto è piatto.

## 4. Vector Field (già Field)

La scena *Field* resta: è utile e ha un'identità sua (il mondo come campo vettoriale, con
traccianti e linee di campo). Cambia solo il nome, che diceva una cosa diversa da ciò che
mostra: **Vector Field**, id `vector-field`, cartella `src/visualizers/vector-field/`,
`vectorFieldRecipe`. Le impostazioni salvate con `scene: "field"` seguono la scena
(`RENAMED_SCENES` in `settingsStore.ts`). Leggi, primitive (`FieldTracerPrimitive`,
`FieldLinePrimitive`, `vectorField.ts`) e misure sono invariate.

Famiglia delle scene, una interpretazione fisica ciascuna:

| Scena | Che cosa mostra |
|---|---|
| Spectral Matter | materia / massa |
| Matter Field | materia e strutture accoppiate |
| Vector Field | il campo dei flussi e delle forze |
| **Spectral Shell** | la membrana risonante e la sua storia nello spazio |
| Spectrum | frequenza come struttura analitica e memoria (**invariata**) |
| Resonant Field | vibrazione / risonanza (la stessa fisica modale, griglia di punti) |
| Tunnel | spazio / architettura |
| Particle Field | organizzazione di particelle |

Spectral Shell non duplica Spectrum (uno spettrogramma radiale 2D in un fragment shader,
analitico e storico) né Resonant Field (una membrana quadrata di punti, senza storia, senza
gusci): è la stessa fisica modale di Resonant Field, in un'altra topologia e con il tempo
reso spazio.

L'anello Scene ha ora undici voci. Un anello pieno con un numero dispari di voci ne ha due
affiancate in basso: `ringRadius` (`ui/Dial.ts`) allarga l'anello quanto basta alle loro
etichette (138 px invece di 110 con undici voci; gli altri menu restano com'erano).

## 5. Qualità e prestazioni

| Qualità | Anelli della membrana | Gusci | Vertici della struttura | Polvere | Memoria visiva |
|---|---|---|---|---|---|
| High | 36 | 4 | 31.232 | 16.000 | metà risoluzione |
| Medium | 29 | 3 | 17.216 | ~10.400 | metà |
| Low | 21 | 2 | 8.320 | ~5.600 | nessuna |

I gusci hanno il 60% degli anelli della membrana. Per frame: 60 float di modi (12 per
layer), nessuna texture, nessuna geometria ricostruita, nessuna allocazione; la memoria è
un `Float32Array` fisso (44 righe × 12).

Misure del 7 ottobre 2026 (i7-10510U, Intel UHD CML GT2, Chromium headless ANGLE/GL,
1280×720, vsync, `synthPop`, 240 frame 8 s dopo l'avvio diretto sulla scena). **Macchina
molto carica** (load average 6–12, app dell'utente in esecuzione, due server Vite): i valori
assoluti non significano nulla, contano i confronti nella stessa sessione.

| Scena, High | ms medi |
|---|---|
| Matter Field, prima dell'intervento (worktree a `8409d15`) | 73,3 · 74,8 |
| Matter Field, dopo | 73,4 · 72,3 |
| Vector Field | 59,1 |
| Spectral Shell | 54,5 · 53,0 · 35,6 |
| Spectral Shell, solo `shell` | 32,6 · 33,4 |
| Galaxy | 42,9 · 42,2 |

Lettura prudente: Matter Field non è cambiata; Spectral Shell costa meno di Matter Field e
di Vector Field. La differenza fra 35 e 54 ms nelle serie di Spectral Shell è il carico
della macchina in quel momento (tempi quantizzati dal vsync), non una proprietà della scena.
Non misurati: macchina scarica, 1080p, WebView2 / WebKitGTK, GPU dedicate, tempi per pass.

## 6. Verifica (7 ottobre 2026)

Test unitari / mock (Vitest), 19 nuovi:

- `visual-engine/primitives/Primitives.test.ts` (+5): legge del guscio (piatto = la
  membrana più grande; bordo nel piano, polo a `a·tan(b/2)`, ogni punto sulla sfera,
  altezza lungo il raggio, emisfero a piena chiusura, lato speculare), gusci annidati ed
  età, layer per vertice; `ModalMemory` (stesso passato a 30 / 60 / 144 fps, piatto prima
  di ogni suono, limite allo `span`, stallo, clock che esita, nuova sessione, ingressi
  corrotti);
- `visualizers/spectral-shell/SpectralShell.test.ts` (12): registry, fixture, grafo delle
  scene; **stessa primitiva, stessi vertici e stessi uniform della membrana di Matter
  Field** a parità di suono e mondo; buio e piatto senza suono né clock; ogni guscio = la
  membrana di `età` fa, uguale a ogni frame rate; il mondo decide come stanno i gusci e non
  tocca i modi; silenzio; nuova sessione; qualità; sessione lunga con mondo che cambia
  (finito, limitato, stessi oggetti, nessun dispose); indipendenza da `Math.random`;
  rilascio GPU a ogni qualità; Matter Field conserva il suo `surface` nella stessa posizione;
- `ui/Dial.test.ts` (1): raggio dell'anello; `stores/settingsStore.test.ts` (+1): la scena
  rinominata.

I test precedenti di Matter Field, Resonant Field, della membrana e di Vector Field (16,
solo rinominati) passano senza modifiche alle attese.

Esito: `npm run check` riuscito, **388 test in 51 file** (1 saltato), typecheck, lint e
build. Con la macchina carica e Chromium accanto, alcune esecuzioni complete hanno visto
fallire a turno test a tempo che il cambio non tocca (soglia del benchmark, timeout di 5 s
di `AnalysisHost`, `VisualWorld`, `VectorField`): eseguiti da soli passano tutti. Il core
Rust non è stato rieseguito: nessun file Rust, wire o WASM è cambiato.

Prove su GPU reale (Intel UHD CML GT2, ANGLE/Mesa, Chromium headless, sorgente sintetica):
shader della membrana compilati senza errori con 1 layer (Matter Field, Resonant Field) e
con 3 / 4 / 5 layer (Low / Medium / High); testo dello shader di Matter Field confrontato
prima / dopo; fotogrammi guardati per ogni primitiva di Matter Field isolata (l'audit del
§1), per Spectral Shell su `synthPop`, `buildDrop`, `pad`, `sawBass`, `kicks`, `startStop`
(buia nel silenzio, di nuovo accesa alla ripresa), con e senza pavimento riflettente, a
High / Medium / Low; Matter Field e Resonant Field dopo l'intervento; Vector Field con il
nuovo id e con un'impostazione salvata `field`; anello Scene con undici voci.

`runParity()` e `runTracerParity()` **non** sono state ripetute: `fieldLaw`, `formLaw`,
`matterStep`, `vectorField`, `tracerLaw`, `tracerStep` e `wells` non sono cambiati.

**Non verificato**: musica reale di qualunque genere; il movimento nel tempo (solo
fotogrammi: l'onda che passa da un guscio all'altro, la torsione e il ritardo laterale sono
provati nei numeri, non guardati); gusto e leggibilità (servono gli occhi dell'utente);
parità GPU ↔ CPU di `shellPoint` con lettura dei risultati (il GLSL è stato confrontato a
vista con il riferimento, come per le altre primitive senza stato); app desktop,
WebView2 / WebKitGTK, 1080p; tempi di frame su macchina scarica.

## 7. Limiti e compromessi

- **Taratura solo su segnali sintetici**: età, distanza, piega, torsione, portata,
  esposizione della polvere sono punti di partenza.
- La forma viene da dodici risonatori lenti (0,45–1,8 Hz), non dalla waveform: la struttura
  risponde alle altezze e agli eventi, non ai singoli cicli. Chi cerca la forma d'onda
  avvolta ad anello la trova nella forma del segnale della materia (`?matter=wave`), che è
  un'altra cosa e non è stata toccata.
- La membrana usa i modi di una membrana rettangolare anche sul disco (limite già noto
  della primitiva): le figure nodali non sono quelle di un tamburo circolare.
- I gusci ricordano i **modi**, non la geometria: arco, increspature, terrazze e
  inclinazione sono quelli del mondo presente su ogni guscio.
- Con il pavimento riflettente (default) i gusci sotto la membrana non si vedono: si vede
  la metà sopra e il suo riflesso. Vengono comunque inviati alla GPU (2 su 4 a High).
- La torsione è stilizzata (5× la rotazione reale della struttura).
- Le transizioni verso e da Matter Field restano il crossfade del compositore: la membrana
  non "esce" dalla materia di Matter Field per diventare Spectral Shell.

## 8. Passi successivi

1. **Occhi e musica reale**: età e numero dei gusci, piega, torsione, quanta polvere.
2. Modi di una membrana circolare (funzioni di Bessel) per il disco: figure nodali ad anelli
   e diametri, più coerenti con la topologia polare. Tocca `ResonantPhysics` e la legge
   dell'altezza: va fatto anche per Matter Field, insieme.
3. `runLawParity()` anche per `shellPoint` (già in backlog per le altre primitive).
4. Gusci solo sopra quando il pavimento riflettente è attivo (la primitiva oggi non lo sa).
