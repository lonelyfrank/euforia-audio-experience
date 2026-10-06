# World Engine — il corpo fisico persistente di Euforia-Audio-Experience

Data: 5 ottobre 2026. Estende [realtime-analysis](realtime-analysis.md),
[experience-planner](experience-planner.md) e [physics-engine](physics-engine.md).
L'Experience Engine resta il cervello; il `WorldState` è il suo corpo; le scene sono
modi diversi di guardarlo.

```text
Live Audio → Capture Clock → DSP multi-rate (Rust/WASM) → Acoustic Model
  → Experience Engine (memoria · narrativa · previsione) → Experience Planner → Visual Intent
  → WORLD ENGINE (forze · impulsi · energia · vincoli)          [per hop, clock audio]
  → WorldState persistente (snapshot) → presentato al tempo udito (estrapolazione esatta)
  → WorldView per layer (adattatore di scena, guadagni del mood) → scena → GPU / composizione finale
UI (core, anelli, modal) resta un guscio separato.
```

## Audit iniziale e mappa di migrazione (Fase 0)

Prima del refactor il moto nasceva in tre posti diversi:

| Dove | Cosa produceva moto | Esito |
|---|---|---|
| `VisualDirector` | canali `rotation`, `expansion`, `turbulence` (molle/follower) da route audio → ogni scena li integrava a modo suo | **Rimossi**: rotazione, espansione e turbolenza sono forze/stati del mondo |
| Scene | integratori locali `phase += dt × flow × motion × audible` (spin, swirl, travel, roll, scroll, drift) e taglie da `openness`/`tension`/`music.drop` | **Sostituiti** da `WorldView`: posizioni dal mondo, delta per frame × guadagno del mood |
| `TunnelBody` | unico corpo fisico (parete-molla, momento di avanzamento e roll) locale al Tunnel | **Assorbito** dal mondo condiviso (stessa matematica, ora per tutte le scene) |
| `ShowDirector` | effetti `fan` (impulso di dimensione al downbeat) e `sweep` (offset sinusoidale per battuta) | **Convertiti** in osservazioni del mondo (pressione, bias laterale) |
| `ResonantPhysics` | membrana modale + onde (già fisica) | **Mantenuta** come campo modale condiviso, ora affiancata dal mondo |

Restano mappe dirette volute: forme delle voci, tracce, spettri e waveform disegnati
(la leggibilità del segnale, richiesta del progetto) e la luce del rig (impulsi temporizzati,
FlashGuard). Il DSP grafico TS non è toccato.

## Proprietà dei livelli

| Livello | Proprietario |
|---|---|
| Interpretazione acustica | Rust `native/analysis` (AnalysisFrame per hop) |
| Contesto musicale, memoria, narrativa | `ExperienceEngine`, `TemporalMemory` |
| Previsione | `ExperienceEngine.predict` (evidenze con confidence) |
| Intento | `ExperiencePlanner` (`INTENT.x`, strength × confidence) |
| **Stato del mondo e fisica condivisa** | **`world/WorldEngine` (+ `ResonantPhysics` per i modi della membrana)** |
| Interpretazione per scena | `world/WorldView` (uno per layer, dentro `VisualDirector`) + codice della scena |
| Regia | `ShowDirector` (rappresentazione, composizione, contrasto, continuità), `VisualDirector` (luce, bloom, camera, persistenza, guadagni del mood) |
| Rendering | `RenderEngine`, `Layer`, scene |

## WorldState

Vettore piccolo e coerente: **quattro corpi** del secondo ordine (posizione, velocità,
momento) e **sette campi** del primo ordine (rilassano verso ciò che la musica chiede,
ciascuno alla propria scala temporale). Unità visive, non SI.

| Grandezza | Tipo | Range | Scala | Significato |
|---|---|---|---|---|
| `radius`, `radialVelocity` | molla 0,55 Hz, ζ 0,5 | ~−0,6…0,9 (|v| < 2,5) | media | pressione: espansione (+) / contrazione (−) attorno al riposo silenzioso 0 |
| `angle`, `spin` | massa con attrito 0,6 s⁻¹ | rad illimitato, |spin| < 3 rad/s | media | momento angolare |
| `travel`, `speed` | massa con attrito 1,1 s⁻¹ | illimitato, 0…6 unità/s | media | moto in avanti (1 unità ≈ un passo per beat a moto pieno) |
| `bias`, `biasVelocity` | molla 0,3 Hz, ζ 0,8 | −1 (sx)…1 (dx) | media | origine laterale delle forze (stereo) |
| `excitation` | saturante, τ 0,45 s | 0…1 | veloce | energia d'onda/superficie a grande scala |
| `shimmer` | saturante, τ 0,18 s | 0…1 | veloce | eccitazione fine da transienti acuti |
| `turbulence` | sale 0,4 s, si calma 2 s | 0…1 | media/lenta | disordine spaziale (indipendente dal volume) |
| `coherence` | τ 1,5 s | 0…1 | media | accoppiamento strutturale; nel silenzio torna a 1 |
| `potential` | saturante, perdita 8 s | 0…1 | lenta | potenziale accumulato dalla previsione |
| `illumination` | sale 0,15 s, cala 1,4 s | 0…1 | media | luce continua (i flash restano del rig) |
| `openness` | τ 4 s | 0…1 | lenta | apertura spaziale |

Derivati: `kinetic`, `elastic`, `stored` (= potential), `wave` (= excitation + shimmer),
`energy` (somma), `releaseTime/Strength`, `impulseTime/Strength`. `forces` contiene le
forze tenute fino al prossimo hop (ciò che l'estrapolazione integra) ed è visibile
nell'overlay. Campi scartati perché derivabili o senza semantica visiva chiara:
density, entropy, depth, persistence, elasticity, viscosity separata (la coerenza fa da
viscosità), fragmentation (= turbolenza vs coerenza), expansion/contraction (segno di `radius`).

## Forze: intent → forza → stato → geometria

Ogni hop (`setForces`), con `p` = presenza e intenti pesati `strength × confidence`:

| Ingresso | Effetto fisico |
|---|---|
| `expand − contract`, bassi sopra il loro floor, `openness` lenta, `potential` | equilibrio radiale `0,45·expand + 0,3·bass + 0,2·openness − 0,35·potential` (pressione vs tensione) |
| `rotate`, flow × motion, velocità laterale | coppia; `decelerate`/`suspend` aumentano l'attrito (frenata) |
| motion (attività, non volume), `accelerate`, `potential` | spinta in avanti (la tensione trattiene) |
| `balance × stereoConfidence` | equilibrio laterale (mono: centro) |
| `bandTransient` 0–4 / 5–7 | calci a `excitation` / `shimmer` (somma per hop = ampiezza dell'attacco, indipendente dall'hop) |
| risonanza (armonicità × fase), attività acuta | eccitazione sostenuta |
| chaos, roughness, complessità senza ordine, incoerenza tra canali, `fragment`/`dissolve`/`cohere` | bersaglio della turbolenza |
| armonicità, coerenza di fase, correlazione L/R; silenzio → 1 | bersaglio della coerenza |
| `energy` × (1 − 0,3·potential) | bersaglio della luce |
| `likelyBuild × predictionConfidence`, `anticipation × anticipationConfidence` | carica del potenziale |

Eventi discreti, al loro tempo audio:

- **impact** (`ExperienceEngine` lo emette): impulso radiale (pieno se banda bassa), surge in
  avanti, spin e spinta laterale proporzionali al **pan della banda** più forte (un colpo a
  sinistra spinge e ruota il mondo da sinistra; mono: solo respiro e surge), eccitazione.
- **drop** (rilascio reale): il potenziale accumulato diventa moto (radiale, avanzamento,
  spin, eccitazione). Senza preparazione c'è poco da rilasciare; una previsione mancata
  non viene mai rilasciata, si disperde (perdita 8 s). *Previsione → potenziale, evento →
  rilascio cinetico*, mai un evento futuro inventato.

Le velocità hanno limiti morbidi (`tanh`), i campi sono saturanti per costruzione: nessuna
saturazione incontrollata dei parametri.

## Integrazione, clock e presentazione

- Per hop (`advance(time)`): si integrano le forze tenute dall'hop precedente, poi gli
  impulsi dell'hop, poi le nuove forze. Soluzioni esatte: molle con la `springMatrix`
  condivisa, attrito lineare in forma chiusa, campi esponenziali. Nessun Euler.
- Gli snapshot (≤ 120 Hz, 256 slot) contengono una copia del mondo. `present(heard)`
  copia l'ultimo snapshot non futuro e lo **estrapola fino al tempo udito** con le stesse
  forze: lo stato mostrato è funzione pura di (audio, tempo udito), quindi identico a
  30/60/144 fps e con qualsiasi batching quando l'analisi precede il tempo udito (caso
  normale). Se il tempo udito supera l'analisi, l'estrapolazione è la stima causale migliore.
- Semantica del tempo udito invariata: nessun impulso viene mostrato prima del suo tempo
  audio (test); un trasporto fermo oltre 0,5 s non è presentato come live.
- Reset solo al cambio di sessione/epoch (`ExperienceEngine.reset`). Cambiare scena,
  mood, palette o qualità non tocca il mondo.

## Adattatori di scena (`WorldView`)

Un `WorldView` per layer, posseduto dal `VisualDirector`, esposto come `modulation.world`.
I guadagni del mood (`Character.motion`, `.expansion`, `.turbulence`) scalano le
**velocità**: `travel` e `turn` integrano lo spostamento del mondo dal frame precedente ×
guadagno. Un cambio di mood o una scena montata durante un crossfade continuano quindi il
moto senza salti; la nuova scena eredita momento, pressione ed eccitazione dal primo frame.
Senza clock sincronizzato la vista è `REST_VIEW`: niente si muove da solo.

| Mondo | Tunnel | Galaxy | Particle Field | Liquid | Spectrum | Oscilloscope | Resonant Field |
|---|---|---|---|---|---|---|---|
| travel | avanzamento | deriva bracci, camera | volo del campo | deriva delle correnti, clock | propagazione degli echi | scorrimento delle voci | — |
| angle/spin | roll + **torsione** | **rotazione orbitale** differenziale | **vortice** (twist con la profondità) | taglio delle correnti (flusso rotazionale) | rotazione | — | rotazione lenta della membrana |
| radius (pressione) | raggio della parete | raggio del disco | dispersione | altezza degli strati | raggio dell'anello | distanza tra i canali | espansione |
| bias | curva il fondo verso la sorgente | camera verso la sorgente | flusso laterale | — | — | — | inclinazione della membrana (+ origine onde) |
| excitation | anelli | anelli d'onda | anelli | ampiezza della superficie | — | persistenza del fosforo ↑ | modi (già nel campo modale) |
| shimmer | scintille | scintillio | scintille | — | scintille | — | — |
| turbulence | curvatura della linea centrale | ondulazione dei bracci + dispersione | dispersione locale | libertà (rottura degli strati) | dispersione degli echi | persistenza ↓ | — |
| coherence | — | stelle sui bracci (1 − dispersione) | gusci strutturati | laminazione (viscosità) | — | — | nitidezza delle linee nodali |
| potential | contrazione (via riposo radiale) | bracci avvolti, disco raccolto | raggruppamento sui gusci | superficie tesa e stretta | echi compressi | canali vicini, più "digitali" | contrazione |
| release | fronte di pressione | fronte radiale | esplosione dei gusci | anello ampio | fronte | breve sovraccarico del fosforo | — |
| illumination | luminosità della griglia | livello | energia | — | densità | — | luce |

Energia ≠ complessità: la luce e il potenziale seguono l'energia/la previsione, la
turbolenza segue disordine e complessità senza ordine. Un drone forte è luminoso e calmo,
un glitch quieto è scuro e turbolento (test).

## Transizioni

Il crossfade resta il meccanismo di rendering (0,9 s), ma entrambi i layer osservano lo
stesso `WorldState` presentato (stesso oggetto): la scena entrante non parte da default,
interpreta il mondo che continua a evolvere. I supporti dello `ShowDirector` (fino a tre
slot) leggono lo stesso mondo: sono manifestazioni causalmente legate, non visualizzatori
indipendenti che reagiscono separatamente allo stesso beat.

## ShowDirector e VisualDirector

`ShowDirector` decide rappresentazione, composizione, contrasto e continuità; non fabbrica
più moto: `sweep` sposta i supporti verso il bias del mondo, `fan` fa respirare la
composizione con la pressione al downbeat (target, non impulsi). Strobe/chase/pulse sono
impulsi **luminosi** e passano tutti dal `FlashGuard`. `VisualDirector` è il direttore della
fotografia: luce, bloom, camera, persistenza, emissione, deformazione delle voci e guadagni
del mood sul mondo.

## Silenzio, accessibilità, qualità

- **Silenzio**: le forze vanno a zero ma il momento continua, le oscillazioni decadono,
  la luce sfuma, la coerenza torna; l'inattività emerge dallo smorzamento (test: energia
  monotona decrescente, < 2% in 12 s; il moto prosegue dopo lo stop).
- **Reduce Flashing** limita solo gli impulsi luminosi del rig (FlashGuard). Il mondo non
  legge il guard: onde, momento e deformazioni restano (test).
- **Qualità GPU** (densità, risoluzione membrana, bloom, pass) non tocca il mondo, che vive
  nell'ExperienceEngine. Il **budget DSP** cambia solo le cadenze lente (armonicità,
  pitch): il mondo vede descrittori aggiornati meno spesso ma con le stesse forze; hop, beat
  e onset restano invariati.

## Prestazioni

Per hop: due matrici di molla in cache (passo costante), una manciata di `exp`, nessuna
allocazione. Presentazione: una copia e un'integrazione per frame (le matrici si
ricalcolano perché il passo varia). Verso la GPU passano solo pochi uniform scalari per
scena (nessun trasferimento dello stato intero).

Misure (6 ottobre 2026, i7-10510U, Node/V8, macchina carica: load average 6–10 per un'app
Tauri di debug di un'altra sessione): mondo **7–9 µs per hop** (≈ 0,16% di un core a 48 kHz),
presentazione (copia + estrapolazione) **≈ 7,5 µs per frame**; tre ripetizioni da 200.000
iterazioni. Nessun pass GPU aggiunto; uniform nuovi: `uLateral` (Tunnel, Particle Field,
Resonant Field), `uScatter` (Galaxy), `uDisorder` (Particle Field).

## Verifica (6 ottobre 2026)

- Test unitari/mock: 14 invarianti del mondo e delle viste (silenzio, nessuna energia
  spontanea, 30/60/144 fps e batching, continuità dell'estrapolazione, nessun futuro,
  limiti su 120 s densi, stereo, confidence della previsione, rilascio, energia ≠
  complessità, intenti come forze, Reduce Flashing, reset solo di sessione, scena montata a
  metà sessione, guadagni sulle velocità), 7 test di grammatica delle scene sul mondo,
  regressione dello ShowDirector (nessun impulso geometrico).
- Benchmark sintetici: invarianza PCM → WASM → esperienza → mondo a 30/60/144 fps con batch
  128/480/2048 entro 1e-8; harness di replay 60 fps/480 vs 144 fps/2048 entro 1e-8.
- Prova GPU reale (Chromium/ANGLE, Intel UHD, 1280×720, Medium, sorgente sintetica): sette
  scene senza errori JS/GLSL; durante un cambio Galaxy → Tunnel la vista entrante osserva
  la stessa pressione del mondo dal primo frame. Tempi di frame **non validi** (carico
  esterno, p50 33–66 ms anche sulla baseline). Screenshot confrontati con HEAD per
  Particle Field e Spectrum: stesso carattere.
- Non eseguibili qui: corpus musicale reale (nessun file locale), WebView2/WebKitGTK e
  cattura reale, timer GPU per pass, prova percettiva dell'utente.

## Validazione

- Test di invarianti: `src/world/WorldEngine.test.ts`, `src/world/WorldView.test.ts`,
  grammatica delle scene `src/visualizers/grammar.test.ts`, invarianza del percorso
  completo in `src/bench/experience.bench.test.ts` e `src/validation/replay.test.ts`.
- **Corpus reale** (mai versionato): `EUFORIA_AUDIO_EXPERIENCE_CORPUS=~/euforia-audio-experience-corpus npm run replay`. Ogni
  `<nome>.wav` (PCM 16/24/32 bit o float 32), opzionale `<nome>.beats` (`tempo [posizione]`,
  1 = downbeat) e `corpus.json` `{"<nome>": {"style": "jazz", "tags": ["no-percussion",
  "odd-meter"]}}`. Stile e tag organizzano solo il report: l'engine non li vede (niente
  priori di genere). Uscita in `<dir>/euforia-audio-experience-report/`: traccia CSV a 20 Hz, JSON per brano,
  `summary.json`. Metriche: onset/s, beat, BPM mediano/IQR/salti, beat/downbeat F1 ±70 ms e
  fase (con annotazioni), metro e confidence, downbeat, sezioni/frasi, novelty, ricorrenza,
  energia/complessità e loro correlazione, confidence di previsione, anticipazioni e false
  anticipazioni (nessun rilascio entro 8 s), impatti, silenzi, emivita dell'energia del
  mondo nel silenzio e risalite, saturazione e passo massimo per frame (continuità).
  Copertura consigliata: elettronica, house/techno, drum & bass, hip-hop, rock, metal,
  jazz, classica, ambient, acustica, colonna sonora, sperimentale; casi difficili senza
  percussioni, sincopi, metri dispari, cambi di tempo, falsi drop, build lunghi, registrazioni
  quiete, master compressi, live, poliritmie, ambient lunghi, tagli netti, fade-out.
- **Debug percettivo** (solo DEV, `?debug` / Shift+D): sezione World con corpi, campi,
  bilancio energetico, forze tenute, ultimo impulso/rilascio e uscita dell'adattatore del
  protagonista. Shift+T scarica la traccia della sessione (ultimi 10 minuti, 20 Hz).

## Approssimazioni note

Modello fisico visivo, non meccanica calibrata: masse unitarie, unità arbitrarie, energia
contabile solo per coerenza visiva. Le particelle GPU non hanno velocità per particella:
la persistenza è quella del campo (travel/vortice condivisi). Lo Spectrum resta uno
spettrogramma misurato: oscillatori accoppiati per colonna sono stati valutati ma
avrebbero sostituito la lettura dello spettro reale con una simulazione. I coefficienti
sono tarati su segnali sintetici: la taratura percettiva richiede musica reale e occhi.
Nessun ML: un eventuale livello semantico appreso resterebbe opzionale e fuori dal core.
