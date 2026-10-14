# Euforia Musical Cognition

Data: 14 ottobre 2026. Branch `musical-cognition`, sopra `music-response-terrain` (`1985a29`, a sua volta non
ancora su `main`). Nessun push, nessun merge.

Un livello che **capisce** la musica che sta ascoltando, fra le misure del DSP e la regia: un orologio musicale, una
memoria strutturale, una lettura di ciò che la musica sta facendo, e il conto di ciò che ci si aspetta e di che cosa ne
è stato. Non conosce il brano in anticipo, non guarda avanti, non usa rete né modelli: conoscenza musicale codificata
come priori, statistica causale sulle misure già esportate, isteresi.

```text
cattura → DSP Rust (hop 5,3 ms) ── AnalysisFrame · onset · beat · section ─────────────── [invariato]
                                         │
                     ExperienceEngine.ingest (per hop, clock di cattura)
                                         │  (build evidence dell'Experience: riusata, non ricalcolata)
                                         ▼
     ┌──────────────────────────── MusicalCognition ────────────────────────────┐
     │ MusicalClock      griglia del DSP + stato, inerzia, continuità, verifica, │  per hop e per evento
     │                   ottava, raggruppamento solo con evidenza                │
     │ StructuralMemory  vettori per beat e per battuta, metro dai cambiamenti,  │  per hop (somma) · per beat · per battuta
     │                   ripetizione, confini, posterior delle frasi 4/8/16/32   │
     │ StyleBlend        priori universali + profili pesati (mai una classe)     │  2 Hz (0,5 Hz in budget ridotto)
     │ Interpreter       dimensioni continue + stato con isteresi e ragione      │  a ogni beat e 10 Hz
     │ PredictionLedger  beat · downbeat · frase · transizione · rilascio        │  a ogni beat; esiti a ogni osservazione
     │ (rilascio udito)  quota di basso che rientra + attacco basso               │  per hop
     └───────────────────────────────────────────────────────────────────────────┘
                                         │  CognitionFrame nello snapshot (clock avanzato al tempo udito)
                     ┌───────────────────┴──────────────────────────┐
                     ▼                                              ▼
     ExperiencePlanner: finestra di transizione      RigController → ShowDirector: griglia di frase
     sulla frase della cognizione, se più sicura     della cognizione quando `leads`; altrimenti quella del DSP
                     │
     nessuna scrittura nel mondo, nello stato Experience o nell'event stream: le scene non cambiano
```

| | |
|---|---|
| Che cosa c'è di nuovo | `src/experience/cognition/` (clock, memoria, conoscenza, interprete, registro delle previsioni, regia, scenari, valutazione), il pannello Musical Cognition in Shift+D, le metriche `cognition.*`, il laboratorio Musical Cognition, i campi della cognizione nel report del replay, un benchmark |
| Che cosa **non** è cambiato | DSP, wire, WASM (`wire::VERSION` invariata), mondo, event stream, `drop` dell'Experience (§2.4–2.5 di [music-response](music-response.md)), Tunnel (digest bit per bit), Spectrum, Rigid Resonant Bodies, UI cinematica, impostazioni |
| Che cosa resta a chi ha orecchie | la validazione con musica reale (§9) — non eseguita |

## 1. Audit: che cosa esisteva

| Componente | Implementazione esistente | Riuso | Modifica |
|---|---|---|---|
| Audio DSP | `native/analysis`: hop 256, bande, loudness con percentili, onset (ODF), chroma, H/P/R (`frame.rs`, `context.rs`, `rhythm.rs`) | tutte le misure, così come sono | nessuna |
| Beat tracking | `beat.rs`: PLL fase + periodo, beat emessi al tempo previsto, retempo dopo 2,5 s, mezzo beat, freewheel di 8 beat; `meter.rs`: ipotesi 3/4/5/7 con astensione | la griglia **è** quella del DSP | esteso in TS (`MusicalClock`): stato, inerzia, continuità, verifica sugli onset, ottava |
| Downbeat / metro | accenti di basso per posizione (`beat.rs`, `meter.rs`); senza metro pubblicato le posizioni assumono 4 | il metro pubblicato | secondo testimone indipendente: dove la musica cambia (`StructuralMemory`); le posizioni in 4 non pubblicate **non** sono usate |
| Struttura | `structure.rs`: sezioni (intro/build/drop/break/outro), novità, similarità 4/8/16, frase = 8 battute contate dal cambio di sezione | sezioni (un `drop` del DSP è evidenza di rilascio), confidenza strutturale | frasi **inferite** (4/8/16/32 e offset) invece che contate |
| Event detection | `ExperienceEngine`: `impact`, `drop`, `buildPeak`, silenzi, `EventStream` | gli eventi del DSP | nessuna; il `drop` dell'Experience è solo **confrontato** con i rilasci uditi |
| Previsione | `predict()`: `next*Time`, `likely*` (evidenze, non probabilità); `AnticipationLedger` (conto delle anticipazioni) | `anticipation × anticipationConfidence` come evidenza di build | registro con finestre, esiti e calibrazione misurata |
| Adaptive calibration | `AdaptiveCalibration.ts` | — (la cognizione non ne dipende) | nessuna |
| Director | `ExperiencePlanner` (finestra di transizione), `ShowDirector` (look sui confini di frase, respiro prima del drop), `RigController` | intatti | la finestra e la griglia di frase seguono la cognizione solo quando è sicura (`leads`) |
| Diagnostics | registry (Shift+G), workspace a tre colonne, REC/export/segmenti, replay sintetico e di WAV, `OverrideLedger`, laboratori | tutto | una sezione `cognition`, metriche `cognition.*`, un laboratorio, campi nel report |
| Timestamp / latenza | clock di cattura; `present(heardTime)` estrapola il mondo; `ClockSync`, `Timing` | idem | `presentClock` avanza fase e tempo musicale al momento udito |

Misure di partenza sui segnali di prova nel percorso reale (WASM → Experience, prima di questo intervento):
`beat124` agganciato a 124 con downbeat a confidenza 0 (quattro casse uguali: nessun accento) e metro mai pubblicato;
`waltz` metro 3 pubblicato dopo ~16 s; `tempoRamp` inseguito con qualche BPM di ritardo; `buildDrop` sezione `drop` del
DSP a 20,16 s (+2,2 s) e a 50,01 s; `startStop` tre `drop` dell'Experience senza alcun build (§2.5).

## 2. Architettura

Cinque responsabilità, come nel brief, ognuna in un modulo:

| Brief | Modulo | Che cosa fa |
|---|---|---|
| A. Musical Knowledge | `knowledge.ts` | priori universali (frasi 0,3/0,4/0,2/0,1 per 4/8/16/32; tempo log-normale a 120 BPM; metro 4 più frequente di 3, 5, 7) e otto profili (generic, techno, house, trance, hardstyle, drum & bass, rock, ambient) come insiemi degli stessi priori; `StyleBlend` li pesa per somiglianza su minuti, generic non scende sotto 0,35 |
| B. Musical Clock | `MusicalClock.ts` | §3.1 |
| C. Structural Memory | `StructuralMemory.ts` | §3.2 |
| D. Musical Reasoning | `Interpretation.ts` | §3.3 |
| E. Musical Prediction | `Predictions.ts` + `MusicalCognition.forecast/expire` | §3.4 |
| Orchestrazione | `MusicalCognition.ts` | rate, silenzi, sorpresa, rilascio udito, raggruppamento, fallback |
| Contratto | `types.ts` | `CognitionFrame` (§4) |
| Regia | `director.ts`, `ExperiencePlanner.ts`, `RigController.ts` | §5 |

Stati candidati del brief → `MUSICAL_STATES`: `unknown`, `establishingPulse`, `stableGroove`, `developing`,
`risingTension`, `breakdown`, `transition`, `release`. Lo stato è il **dominante**; le dimensioni sono tutte esposte
(una sezione può essere groove e tensione insieme).

## 3. Algoritmi

### 3.1 Orologio musicale

- **Stato.** `acquiring` finché la griglia del DSP non ha confidenza ≥ 0,35 e 4 beat confermati; `locked`; `coasting`
  quando la griglia non è sostenuta (confidenza del DSP < 0,15 o silenzio): la fase è estrapolata dall'ultimo beat e la
  confidenza decade come `exp(−età / 1,5 s)`; oltre **2 battute (8 beat) o 4 s** il clock è `lost` e fase, battuta e
  frase spariscono. Il clock non continua senza segnale.
- **Continuità.** Un beat che torna su un multiplo intero del periodo trasportato (±20 % del periodo, tempo entro il
  5 %) continua il conteggio dei beat; altrimenti il clock si riancora e la memoria delle battute riparte. Contati:
  `losses`, `relocks`, `continuations`, `relockSeconds`.
- **Verifica.** Ogni beat previsto attende gli onset in ±min(70 ms, 15 % del periodo): il primo onset ≥ 0,3 lo
  conferma (supporto, errore medio, jitter); un beat che la musica marcava (supporto ≥ 0,7) e non ha marcato è
  un'**assenza** (`missedBeat`). Un accento forte fuori di max(25 ms, 3 × jitter) è `earlyAccent` / `lateAccent`.
- **Ottava.** Solo attacchi con basso (cassa, basso: regione low ≥ 0,3): basso anche a metà fra i beat → `doubleTime`;
  basso molto più forte a beat alterni → `halfTime`; ciascuno pesato dal priore di tempo del tempo alternativo, e dal
  priore stilistico per l'half-time. È una **plausibilità**: il tempo del tracker non viene cambiato. Giudicata solo
  dopo 12 attacchi sui beat.
- **Raggruppamento.** Due testimoni: il metro pubblicato dal DSP (accenti di basso), e la memoria (dove la musica cambia,
  §3.2). Si segue il testimone già seguito salvo che un altro sia più sicuro di 0,1. Le posizioni nella battuta sono
  mostrate solo con metro noto e confidenza di downbeat ≥ 0,3: **mai una battuta 4/4 presunta**.
- **Tre tempi distinti.** Clock di cattura (tutti i tempi, `nextBeat`), tempo musicale (`beat`, `bar`: contati dal
  punto di ancoraggio), tempo di rendering: lo snapshot è presentato al momento udito e `presentClock` vi avanza fase e
  tempo musicale con il periodo (funzione pura, uguale a ogni frame rate).

### 3.2 Memoria strutturale

Per beat, la media degli hop sonori di un vettore di 26 misure già esportate (forma spettrale in 8 bande, livello nel
range del brano, forza e densità degli attacchi, quota percussiva, flatness, **quota di basso**, 12 chroma × confidenza);
per battuta, la media dei suoi beat. Ring fissi: 256 beat, 64 battute (≈ 2 minuti a 128 BPM); la finestra configurabile
(`memorySeconds`, 90 s di default, 30 s in budget ridotto) limita quanto indietro guardano i confronti. 41,4 kB tipizzati
per tutta la cognizione. Nessun campione audio.

- **Quota di basso** (`lowShare`): il sub contro il livello totale delle bande, come lo confronta `structure.rs`, 0 a
  −20 dB, 1 a −4 dB. Non l'attività sopra il floor: misurato sul segnale `buildDrop`, il riser di rumore riempie ogni banda
  sopra il proprio floor, ma lascia il sub a −17…−37 dB dal livello, contro ≈ −2 dB del groove e −55…−70 dB
  dell'ambient.
- **Metro dai cambiamenti.** Per ogni beat, quanto il suo vettore cambia dal precedente; sugli ultimi 64 beat, per ogni
  raggruppamento 3/4/5/7, la posizione che cambia di più contro la media, in errori standard, **meno ciò che il massimo di
  m posizioni darebbe senza struttura (√(2 ln m))**: un ciclo lungo non vince per avere più posizioni. Il priore
  universale scioglie solo i quasi pareggi. Su `beat124` (quattro casse uguali) è ciò che trova il 4/4 e il downbeat.
- **Ripetizione.** Similarità dell'ultima battuta a quella 1, 2, 4, 8, 16 battute prima, seguita per lag; il pattern è il
  lag più corto che spiega la ripetizione.
- **Confini.** Il beat che apre una battuta contro il più vicino dei beat che hanno aperto le ultime 8 battute (un
  pattern fino a 8 battute ha lì la sua corrispondenza; il nuovo no). La scala è la distanza tipica di una
  **ripetizione** (imparata solo dalle battute che si ripetono); conta solo l'**inizio** di un episodio di deviazione
  (contro il massimo delle tre battute prima): le battute dopo un confine sono nuove anch'esse finché il nuovo pattern non
  ha fatto un giro.
- **Frasi.** Ogni lunghezza L ∈ {4, 8, 16, 32} con ogni offset è un'ipotesi; la sua verosimiglianza cresce con quanto i
  confini alle sue posizioni superano la media e con quante volte è stata vista; i priori (mix degli stili) pesano le
  lunghezze; un'ipotesi «nessuna frase» (0,5) le tiene oneste. Una lunghezza è creduta solo quando un confine è tornato al
  suo offset. Un cambio di raggruppamento azzera tutto ciò che era per battuta (le battute sono altre fette dei beat).

### 3.3 Interpretazione

| Dimensione | Evidenza |
|---|---|
| pulse | stato del clock × √confidenza |
| groove | pulse × (0,4 + 0,6 × ripetizione) × (0,5 + 0,5 × supporto) |
| tension | evidenza di build dell'Experience × confidenza (riusata; **scontata nei 5 s dopo un silenzio ≥ 1 s**: una ripresa sale, non costruisce — §2.5), livello e attacchi che salgono battuta su battuta (pendenze su 8–16 beat di suono), basso ritirato mentre gli attacchi continuano, fine di frase che si avvicina sotto pressione (× quanto lo stile si aspetta che un build si risolva lì); azzerata da un rilascio |
| breakdown | quota di basso sotto metà di quella abituale del brano, rado, sotto il livello, dopo un groove |
| transition | inizio di confine forte, sezione cambiata dal DSP |
| release | età del rilascio udito |
| development | pulse × novità, fuori dalla tensione |

Stato dominante per priorità (release > transition > breakdown > risingTension > developing > stableGroove >
establishingPulse > unknown) fra quelli oltre la soglia d'ingresso; tenuto finché resta sopra quella d'uscita; cambiato
solo dopo 1,5 s di permanenza, salvo i momenti (release, transition, silenzio). La **ragione** è una costante che nomina
l'evidenza più forte (nessuna stringa costruita per hop).

**Expectation e surprise.** `expectation` = massimo, fra le previsioni strutturali aperte (frase, transizione,
rilascio; beat e downbeat, quasi certi, esclusi), di confidenza × vicinanza nell'orizzonte di 8 s. `surprise` = la
distanza di ciò che è successo da un'aspettativa **affidabile**, decrescente (1,2 s), con la confidenza di
quell'aspettativa e il tipo: `missedBeat`, `earlyAccent` / `lateAccent`, `pause` (solo sotto una pulsazione sicura e
marcata: un silenzio senza aspettativa non è una sorpresa), `patternBreak` (non quando cade dove era attesa una frase),
`offPhraseChange`, `phraseProlonged` (una transizione attesa e scaduta), `unannouncedRelease`, `meterChange`,
`tempoChange`. Silenzi distinti: `pause` (< 2 s, la sorgente consegna), `silence`, `noSignal` (≥ 8 s o niente da inizio
sessione), `sourceLost` (l'analisi ha smesso di arrivare).

### 3.4 Previsioni

Un'aperta per tipo; ognuna con istante, finestra, confidenza, evidenza, orizzonte e stato (`proposed`, `updated`,
`confirmed`, `expired`, `refuted`). Rifiutate se il loro istante è già passato; confermate solo da un'osservazione
dentro la finestra e successiva alla proposta. Una previsione il cui istante è arrivato aspetta la sua osservazione
(non viene spostata sulla successiva).

| Tipo | Proposta | Confermata | Smentita / scaduta |
|---|---|---|---|
| beat | clock agganciato o in inerzia | un onset sul beat | la musica (presente) non l'ha marcato |
| downbeat | posizioni di battuta mostrate | attacco con basso sul downbeat, o un confine | scade |
| phrase | confidenza di frase ≥ 0,3 | confine ≥ 0,3 sulla battuta attesa | smentita da un confine forte altrove; altrimenti scade (molti confini sono quieti) |
| transition | frase ≥ 0,45 e il pattern è durato quanto lo stile lo lascia durare, o tensione | confine forte, sezione del DSP o rilascio nella finestra | scade (→ `phraseProlonged`) |
| release | tensione ≥ 0,4 con confidenza: sul prossimo confine di frase; senza griglia, una finestra larga di 8 s | **un rilascio udito** nella finestra | smentita se la tensione svanisce o se il rilascio arriva fuori finestra; un build che supera il confine è riportato **una volta** al confine successivo (drop ritardato) |

**Il rilascio è udito, mai previsto.** Dopo almeno 1,5 s di suono senza basso (il silenzio non conta e ne cancella il
conto: una ripresa non è un rilascio), sotto tensione o dopo un breakdown, la quota di basso torna ≥ 0,7 con il livello
nella metà alta del brano, e un attacco con basso cade al più 0,1 s prima o entro 0,35 s dopo: il rilascio è datato su
quell'attacco. Anche un `drop` deciso dal DSP (`structure.rs`) è evidenza. Nessuna previsione conferma un rilascio.

Il `drop` dell'Experience **non è cambiato** (AGENTS, §2.4): ogni suo evento è confrontato con i rilasci uditi entro 4 s
(`experienceDrops`, `experienceDropsOff` oltre ±0,5 s, `experienceDropsUnheard`, `dropOffset`). È lo strumento per
decidere §2.4 con musica reale.

Le confidenze **non** sono probabilità calibrate: il registro ne misura il Brier score per tipo (scadute contate come
non confermate), per poterle calibrare su un corpus.

## 4. Contratto

`ExperienceSnapshot.cognition: CognitionFrame` (`types.ts`), copiato nello snapshot (forma fissa, nessuna allocazione),
presentato al momento udito. Convenzioni del progetto: tempi sul clock di cattura, 0 = nessuno; BPM 0 e metro 0 =
ignoti; posizioni −1 = ignote.

```ts
interface CognitionFrame {
  time; enabled; leads;                     // la regia segue la cognizione ora? (diagnostics.fallback dice perché no)
  clock: { state, bpm, period, confidence, beatPhase, nextBeat, beat, meter, meterConfidence, downbeatConfidence,
           barPosition, barPhase, bar, nextDownbeat, phraseBars, phraseBar, phraseConfidence, nextPhrase,
           stability, syncErrorMs, jitterMs, support, halfTime, doubleTime, ambiguity, coastAge, losses, relocks, continuations, relockSeconds };
  understanding: { state, previous, confidence, since, reason, pulse, groove, tension, tensionConfidence, breakdown,
                   transition, release, development, repetition, pattern, novelty, boundary, expectation,
                   surprise, surpriseConfidence, surpriseKind, surpriseAt, silence, silenceSeconds, style, styleConfidence, styles };
  predictions: Prediction[8];               // aperte (id 0 = vuota)
  recent: Prediction[8];                    // ultimi esiti, beat esclusi
  stats: { proposed, confirmed, refuted, expired, brier, error, lead (per tipo), missedBeats, surprises, stateChanges,
           releases, releasesUnannounced, experienceDrops, experienceDropsOff, experienceDropsUnheard, dropOffset };
  diagnostics: { hops, updateMicros, memoryBytes, bars, beats, fallback };
}
```

**DSP → Cognition**: solo `AnalysisFrame` (bandDb, loudnessPosition, onsetStrength/Density, percussiveShare, flatness,
chroma, campi del beat e del metro, presenza), onset, beat, sezioni, e dall'Experience `anticipation` /
`anticipationConfidence` (`CognitionContext`). **Cognition → Director**: lo snapshot. Il Director non dipende da nessun
modulo interno.

Configurazione (`MusicalCognition.config`): `enabled` (spenta: niente calcolo, il frame lo dice; Experience e regia sono
quelle di prima), `direct` (la regia può seguirla), `memorySeconds`, `style`, `budget` (`low`: ragionamento solo ai beat,
stile ogni 2 s), `profile` (costo misurato su un hop ogni 16).

## 5. Integrazione con la regia

- **ExperiencePlanner.** La finestra di transizione (`plan.transitionStart/End/Confidence`, letta solo dallo
  ShowDirector) usa il confine di frase della cognizione quando questa **guida** ed è più sicura della previsione del DSP;
  altrimenti è numero per numero quella di prima (test). Intenti, forze e mondo non cambiano.
- **ShowDirector** (via `followCognition` nel `RigController`): quando la cognizione guida, la griglia di frase che lo
  show legge (confine per i look in Hybrid/Free dopo il loro hold, tinta per frase, respiro prima di un drop atteso) è
  quella inferita; altrimenti quella del DSP. Il fallback è per frame, senza nulla da commutare.
- **`leads`** richiede una griglia di frase con confidenza ≥ 0,5, che a sua volta richiede downbeat con evidenza, un clock
  che tiene e un tempo non ambiguo. Una previsione a bassa confidenza non produce nulla di visibile.
- Nessuna mesh, materiale o geometria è toccata; Rigid Resonant Bodies, Tunnel, Spectrum, Terrain e le recipe leggono il
  mondo come prima. Preset (default di installazione) non usa la griglia di frase: lì la cognizione non cambia nulla di
  ciò che si vede; in Auto (= Hybrid) e Free cambia **quando** un look può cambiare.

## 6. Diagnostica e laboratorio

- **Shift+D** (Audio & Analysis) ed Experience & Direction, DEV: sezione `cognition` con quattro pannelli — Musical
  Clock (BPM e confidenza con traccia, stato del clock, fase, downbeat, metro, battuta, frase, stabilità, errore di sync e
  jitter, ambiguità ½ / 2×), Musical Understanding (stato, ragione, profilo stilistico, undici dimensioni, tensione /
  sorpresa / aspettativa sugli ultimi 10 s), Predictions (aperte: tipo, fra quanto, confidenza, stato, evidenza; esiti
  recenti), Cognition Diagnostics (perché la regia segue o no, esiti e Brier per tipo, rilasci contro i `drop`
  dell'Experience, clock persi / ripresi, memoria, costo campionato, pesi dei profili). Il viewport non si sposta, la UI
  cinematica non è toccata, un solo timer a 5 Hz come gli altri pannelli.
- **Registry** (anche in release, Shift+G): `cognition.clock.*`, `cognition.*`, `cognition.stats.*`,
  `cognition.<tipo>.proposed/confirmed/refuted/expired/brier/error/lead`, `cognition.next.in/confidence`, etichette
  `cognition.state`, `cognition.reason`, `cognition.next.kind`, `cognition.leads`. REC, export e replay li includono.
- **Controlli di esperimento** (Laboratories): `Cognition: preset / regia reattiva / spenta`, tramite
  `controller.overrides` (`cognition.enabled`, `cognition.direct`): «Termina esperimento» li restituisce.
- **Laboratorio Musical Cognition**: gli scenari sintetici di `scenarios.ts` (frasi di 8 e 16 battute, cambio di tempo,
  half/double-time, 3/4, cambio di metro, casse mancanti, pause brevi e lunghe, loop, cambio fuori frase, build → drop,
  drop in ritardo, build senza drop, rumore, silenzio, sorgente interrotta) eseguiti su una cognizione propria, accanto a
  quella live, senza audio, senza pin e senza override; timeline (verità, beat previsti con esito, bande di clock e stato,
  curve, previsioni dalla proposta all'esito, rilasci uditi) e valutazione; «Esegui tutti» con la tabella di §7.
  `?engine=cognition` lo apre all'avvio. Il replay esistente (Diagnostics & Reports) resta quello per i segnali di prova
  attraverso tutta la pipeline: non è stata aggiunta una seconda infrastruttura di replay.
- **Report del replay** (`npm run replay`, `validation/replay.ts`): `cognition*` (clock, esiti per tipo, Brier dei rilasci,
  rilasci, sorprese), `experienceDropsOffRelease`, `experienceDropsUnheard`, `releaseTimes` accanto a `dropTimes`.

## 7. Test e risultati

`npm run check` sul primo commit: **690 superati, 1 saltato (preesistente), 80 file**; sul branch completo **691 superati, 1 saltato, 81 file** (il benchmark della cognizione); typecheck, ESLint, build. Erano
643 + 1 saltato alla baseline (`1985a29`): 47 nuovi (33 sugli scenari, 9 unitari di registro e conoscenza, 5 sul
percorso WASM). Tutti i preesistenti invariati, compresi i digest del Tunnel (`tunnel/preservation.test.ts`), i test di
ShowDirector, Experience, calibrazione, solidi. Core Rust non toccato (nessun file sotto `native/`).
`scripts/workspace-browser.mjs acceptance` (DEV) e `release` (build + preview) superati su Chromium con GPU Intel UHD,
dopo aver aggiunto la sezione `cognition` al loro elenco.

Tre livelli di prova, da non confondere:

1. **Scenari sintetici di feature** (`cognition.test.ts`): deterministici, con verità annotata; il tracker vi è un mock
   semplice di quello del DSP. Provano la logica, non il tracker.
2. **Segnali di prova attraverso il WASM** (`signals.test.ts`): il tracker vero, audio sintetico.
3. **Musica reale**: non eseguita (§9).

| Richiesta del brief | Dove | Esito |
|---|---|---|
| 1 beat stabile | `stable`, `beat124` (WASM) | errore mediano del beat previsto 0 ms sul mock; su WASM 34/34 beat confermati, sync < 15 ms |
| 2 tempo variabile | `tempoChange`; `tempoRamp` (sonda WASM) | seguito, sorpresa `tempoChange`, nessuna perdita; sulla rampa reale il DSP insegue con ritardo e molti beat previsti risultano non confermati (misurato, §8) |
| 3 half / double | `halfTime`, `doubleTime` | plausibilità > 0,5; < 0,2 su four-on-the-floor; tempo del tracker invariato |
| 4 metro ≠ 4/4 | `waltz`, `meterChange`, `waltz` (WASM) | 3/4 riconosciuto, mai una battuta da 4; downbeat confermati > 90 % su WASM |
| 5 beat assente | `dropout` | assenza notata, griglia tenuta |
| 6 ripresa dopo pausa | `shortPause`, `longPause`, `startStop` (WASM) | pausa breve: continuità; lunga: persa e ripresa in < 4 s |
| 7 pattern ripetuto | `loop` | pattern 4, ripetizione > 0,6, novità < 0,3, nessuna frase inventata |
| 8 cambiamento inatteso · 12 transizione fuori frase | `offPhrase` | sorpresa `offPhraseChange` / `patternBreak` |
| 9 confine di frase | `stable`, `phrases16` | lunghezza inferita (8, 16), precisione 1,00 |
| 10 falsa previsione di drop | `falseBuild` | previsione smentita, nessun rilascio, letto come breakdown |
| 11 drop confermato | `buildDrop`, `lateDrop`, `buildDrop` (WASM) | rilascio previsto con 12–13 s di anticipo e udito sul drop; su WASM entrambi i drop uditi in [drop − 0,1, drop + 0,6] s |
| 13 audio non musicale | `noise`, `pad` e `whiteNoise` (WASM) | nessun clock, nessuna previsione, `unknown` |
| 14 silenzio prolungato | `silence` | `noSignal`, nulla atteso, nessuna sorpresa |
| 15 cambio sorgente | `sourceLost`, reset di sessione, gap nell'Experience | griglia persa, previsioni ritirate, `sourceLost`; reset completo |
| 16 riavvio del motore | determinismo dopo `reset()` | stessa lettura bit per bit |
| 17 degrado controllato | budget `low` + memoria 30 s | stessi beat, rilasci, perdite e frasi |
| previsioni non retroattive | tutti gli scenari | verificato |
| confidenza che cala senza evidenza | `longPause` | monotona in inerzia, 0 quando persa |
| il clock non continua all'infinito | `longPause` | inerzia ≤ 4 s |
| stati che non oscillano | tutti gli scenari | < 15 cambi al minuto, 0 transizioni false |
| nessun evento confermato dalle sole aspettative | tutti gli scenari | ogni rilascio udito coincide con un rilascio vero |
| modalità precedente con il livello spento | `ExperienceEngine` acceso / spento / senza regia | mondo, stato ed eventi identici; piano identico quando non guida |

Valutazione su tutti gli scenari (`evaluate.ts`; mock del tracker; macchina di sviluppo):

| scenario | beat ms | downbeat | perso/ripreso/continuo | frasi P / R | transiz. false | cambi/min | rilasci veri/uditi/presi/anticipati | prev. rilascio conf./smentite/scadute | Brier frase · rilascio | anticipo rilascio s | sorprese | µs/hop pieno / ridotto |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| stable | 0 | 1.00 | 0/0/0 | 1.00 / 0.50 | 0 | 8.3 | 0/0/0/0 | 0/0/0 | 0.30 · — | — | patternBreak 1, pause 1 | 10.4 / 5.0 |
| tempoChange | 0 | 0.78 | 0/0/0 | — / 0.00 | 0 | 7.7 | 0/0/0/0 | 0/0/0 | — · — | — | missedBeat 1, tempoChange 1, pause 1 | 7.8 / 4.7 |
| halfTime | 0 | 1.00 | 0/0/0 | — / — | 0 | 5.1 | 0/0/0/0 | 0/0/0 | — · — | — | pause 1 | 5.2 / 3.9 |
| doubleTime | 0 | 1.00 | 0/0/0 | — / — | 0 | 3.9 | 0/0/0/0 | 0/0/0 | — · — | — | pause 1 | 6.7 / 3.9 |
| waltz | 0 | 1.00 | 0/0/0 | — / 0.00 | 0 | 10.5 | 0/0/0/0 | 0/0/0 | 0.61 · — | — | patternBreak 1, pause 1 | 4.2 / 3.5 |
| meterChange | 0 | 0.71 | 0/0/0 | — / 0.00 | 0 | 8.0 | 0/0/0/0 | 0/0/0 | — · — | — | pause 1 | 3.6 / 3.7 |
| dropout | 0 | 1.00 | 0/0/0 | — / 0.00 | 0 | 8.8 | 0/0/0/0 | 0/0/0 | — · — | — | missedBeat 1, pause 1 | 3.4 / 3.7 |
| shortPause | 0 | 0.40 | 0/1/1 | — / — | 0 | 8.6 | 0/0/0/0 | 0/0/0 | — · — | — | pause 2 | 6.8 / 4.4 |
| longPause | 0 | 1.00 | 1/1/0 | — / — | 0 | 7.8 | 0/0/0/0 | 0/0/0 | — · — | — | pause 2 | 4.9 / 3.3 |
| loop | 0 | 1.00 | 0/0/0 | — / — | 0 | 2.8 | 0/0/0/0 | 0/0/0 | — · — | — | pause 1 | 4.4 / 4.2 |
| phrases16 | 0 | 1.00 | 0/0/0 | 1.00 / 0.50 | 0 | 4.3 | 0/0/0/0 | 0/0/0 | 0.35 · — | — | patternBreak 2, pause 1 | 4.4 / 4.3 |
| offPhrase | 0 | 1.00 | 0/0/0 | 1.00 / 0.20 | 0 | 7.6 | 0/0/0/0 | 0/0/0 | 0.32 · — | — | patternBreak 2, offPhraseChange 1, pause 1 | 4.2 / 3.8 |
| buildDrop | 0 | 1.00 | 0/0/0 | 1.00 / 0.50 | 0 | 10.6 | 1/1/1/0 | 1/1/0 | 0.33 · 0.15 | 13.1 | pause 1 | 5.8 / 4.5 |
| lateDrop | 0 | 1.00 | 0/0/0 | — / 0.00 | 0 | 9.7 | 1/1/1/0 | 1/1/1 | 0.20 · 0.09 | 12.1 | pause 1 | 4.9 / 3.7 |
| falseBuild | 0 | 1.00 | 0/0/0 | — / — | 0 | 9.9 | 0/0/0/0 | 0/1/0 | — · 0.03 | — | missedBeat 1 | 4.8 / 4.2 |
| noise | — | — | 0/0/0 | — / — | 0 | 0.0 | 0/0/0/0 | 0/0/0 | — · — | — | — | 3.0 / 2.7 |
| silence | — | — | 0/0/0 | — / — | 0 | 0.0 | 0/0/0/0 | 0/0/0 | — · — | — | — | 2.4 / 1.8 |
| sourceLost | 0 | 1.00 | 1/1/0 | — / — | 0 | 8.2 | 0/0/0/0 | 0/0/0 | — · — | — | pause 1 | 6.4 / 4.5 |

Il richiamo delle frasi è calcolato sui confini dopo i primi due: un sistema causale deve sentire due frasi prima di
conoscerne la lunghezza. «pause 1» alla fine di ogni scenario è il silenzio finale dopo un groove (corretto). L'errore
del beat a 0 ms riflette il mock ideale, non il DSP.

Sul percorso reale (segnali di prova, WASM, tracker del DSP): `beat124` 4/4 per cambiamento (il DSP non pubblica un
metro), downbeat confermati 6/6 con Brier 0,11, nessuna frase e nessun rilascio inventati; `waltz` 3/4, downbeat
22/22; `startStop` nessuna previsione di rilascio e nessun rilascio, i 3 `drop` dell'Experience risultano **non uditi**
(§2.5 di music-response, ora misurato); `buildDrop` rilasci uditi su entrambi i drop, nessuno non annunciato, e i `drop`
dell'Experience tutti fuori di ±0,5 s (+2,2 s dopo il primo rilascio udito); `breakdown` rilascio udito a 67,9 s per un
drop a 68,0 s, l'ultimo `drop` dell'Experience +3,9 s dopo.

## 8. Benchmark e confronto con la baseline

Macchina: i7-10510U, Intel UHD, limite di potenza 51 W (alimentata), altre app in esecuzione (non isolata).

| | baseline `1985a29` | branch |
|---|---:|---:|
| cognition da sola, budget pieno (µs/hop, mediana di 5 · min–max) | — | **4,26** (4,09–7,89) |
| cognition da sola, budget ridotto | — | 4,04 (3,45–4,88) |
| `ExperienceEngine` per hop, cognition spenta / accesa (µs, node) | 81,1 | 88,6 (+7,5: cognition + copia dello snapshot) |
| CPU per secondo d'audio (cognition, 187,5 hop/s) | — | 0,8 ms |
| memoria tipizzata della cognizione | — | 41,4 kB; + 20 oggetti per snapshot × 257 snapshot |
| bundle principale (byte · gzip) | 736 845 · 212 939 | 779 281 · 226 068 (+42 kB · +13 kB) |
| worker del replay | 73 019 | 121 092 (include l'Experience) |
| Tunnel, Low, 1280 × 720, Chromium + GPU Intel, 30 s × 2 corse alternate: frame p50 / p95 / p99, oltre 20 ms | 16,7 / 16,7 / 16,7 ms, 0 | 16,7 / 16,7 / 16,7 ms, 0 |
| stessa pagina, cognition spenta / accesa ogni 10 s: tempo in `ingest` | 14,9–15,7 ms/s | 17,6–19,6 ms/s |

`npm run bench` include `src/bench/cognition.bench.test.ts`; `EUFORIA_COGNITION_BENCH_REPORT=<file>` ne scrive il JSON.
Fra due server diversi il tempo di script del main thread differiva di 16–31 ms/s, ma due corse della **stessa** versione
differivano già di 9–24 ms/s: con la stessa pagina e la cognizione commutata, la differenza è 2–4 ms/s. Il budget ridotto
risparmia poco: il costo dominante è l'accumulo per hop della memoria e del clock, non il ragionamento. Non misurati:
WebKitGTK / WebView2, Windows, ThinkPad T14 Gen 1, Raspberry Pi 4 (obiettivo futuro: lì il costo per hop va rimisurato),
sessioni lunghe.

## 9. Limiti noti e incertezze

- **Nessuna validazione con musica reale.** Tutto è provato su scenari di feature sintetici e su segnali di prova sintetici.
- **Ripresa che sposta la battuta.** Su `shortPause` la musica riprende due beat dopo, su una battuta nuova: la griglia
  dei beat continua correttamente, ma l'allineamento della battuta resta il vecchio finché l'evidenza dei cambiamenti
  (64 beat) non lo sposta: 40 % dei downbeat collocati. Proposta: un priore musicale («dopo una pausa si riparte spesso
  sul downbeat») come terzo testimone del raggruppamento, solo dopo una pausa.
- **Cambio di metro** lento a essere seguito (0,71 dei downbeat su `meterChange`): stessa finestra di 64 beat.
- **Tempo in rampa**: il tracker del DSP la insegue con un ritardo di qualche BPM (retempo dopo 2,5 s di disaccordo); i
  beat previsti risultano allora spesso non confermati. È misurato, non corretto: la griglia resta quella del DSP.
- **Confini di frase** dipendono dalla ripetizione: musica che non si ripete mai (o frasi di 4 battute fatte ognuna di
  materiale nuovo) non dà una griglia di frase — la cognizione allora non guida, come deve.
- **Profili stilistici**: numeri iniziali, da rivedere su un corpus; un four-on-the-floor somiglia a più profili (test).
- **Confidenze non calibrate**: il Brier è misurato, non usato per ricalibrare.
- **Errore delle previsioni di rilascio senza griglia**: la finestra è larga (8 s) e il suo «istante» è nominale; nel
  pannello è indicato «in finestra», nelle medie per tipo l'errore va letto con questo.
- **Costo**: la copia dello snapshot (120 Hz) pesa quanto il calcolo; il budget ridotto non lo tocca.
- **Regia**: l'effetto su Hybrid / Free / Auto (quando un look cambia) non è stato guardato con occhi; Preset non cambia.

## 10. Validare con audio reale

Workspace aperto, **REC** attivo (Shift+G), Shift+D per il pannello. Per ogni brano: il registry esportato (JSON) e, se
possibile, un'annotazione dei beat per `npm run replay` (formato `time [position]`, come per il corpus Rust).

**A — Four-on-the-floor (techno / house)**
- [ ] `cognition.clock.state` `locked` in pochi secondi; `syncErrorMs` < 20; `support` > 0,9.
- [ ] Metro 4 dopo 30–40 s anche senza accenti; downbeat dove li si sente (contare 1-2-3-4 con il pannello).
- [ ] Frase: dopo due confini, `phraseBars` 8 o 16 e confini confermati dove la musica cambia; `leads` solo allora.
- [ ] `stableGroove` per lunghi tratti, cambi di stato < 10 al minuto; nessun `release` senza un drop.

**B — Build e drop (trance, hardstyle)**
- [ ] `risingTension` durante il build, `expectation` che sale; una previsione di rilascio aperta.
- [ ] Il rilascio udito sul drop (il `releaseTimes` del replay, o la timeline): annotare lo scarto.
- [ ] **§2.4**: `dropOffset` e `experienceDropsOff`: di quanto il `drop` dell'Experience precede o segue il rilascio udito.
- [ ] Build senza drop: la previsione di rilascio è smentita o scade, nessun rilascio.

**C — Drum & bass, half-time**
- [ ] `halfTime` / `doubleTime` alti quando la pulsazione è ambigua; il tempo del tracker non cambia.

**D — Non percussivo (ambient, voce, pause)**
- [ ] `unknown` o `establishingPulse`; nessuna previsione strutturale; nessun rilascio.

**E — Silenzio, pause, cambio sorgente**
- [ ] Pausa breve in un groove: `coasting`, poi `continuations` +1; sorpresa `pause`.
- [ ] Silenzio lungo: `noSignal`, clock `lost`, `expectation` 0.
- [ ] Ripresa dopo una pausa: **nessun** rilascio (lo è invece il `drop` dell'Experience, §2.5: `experienceDropsUnheard`).
- [ ] Cambio sorgente: tutto riparte (`hops` da 0).
- [ ] Controlli di esperimento: «regia reattiva» e «spenta» non cambiano nulla del Tunnel; «preset» li ripristina.

## 11. Commit

| Commit | Che cosa |
|---|---|
| `bfd50d4` | Musical cognition: clock, memoria, conoscenza, interpretazione, registro delle previsioni, rilascio udito, regia; test |
| `1b9283f` | Workspace: pannelli, registry, laboratorio, report del replay, benchmark; collaudo del workspace aggiornato |
| ultimo | Documentazione (questo documento, README, scheda tecnica, AGENTS) |

Branch `musical-cognition`, locale. Nessun push, nessun merge su `main`.
