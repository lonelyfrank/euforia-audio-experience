# Rapporto: Rigid Resonant Body, Musical Event Fracture, Adaptive Calibration, Tunnel Balanced

Data: 11 ottobre 2026. Intervento additivo su `main` a partire da `d27cb24`. Documenti di
riferimento: [rigid-resonant-body](rigid-resonant-body.md), [adaptive-calibration](adaptive-calibration.md),
[tunnel-motion](tunnel-motion.md).

**In una riga**: le quattro capacità sono implementate, provate con test deterministici, con segnali
sintetici attraverso l'analisi reale (WASM) e nel browser su GPU reale. **Non sono state provate con
musica reale né guardate a occhio nel tempo**: quella parte dei criteri di accettazione è aperta.

## 1. Stato iniziale verificato

| | |
|---|---|
| HEAD | `d27cb24` «Solid dynamics: volumetric bodies…», albero pulito |
| Suite | `npx vitest run`: **542 passati, 1 saltato, 67 file** (uguale a quanto dichiarato in `solid-dynamics.md`) |
| Macchina | i7-10510U, Intel UHD (CML GT2), Fedora 44; PL1 51 W (non limitata); frequenza 3,1–4,4 GHz secondo il momento |
| Comportamento dei solidi | su `buildDrop` il cubo si deforma del 7–18 % della propria taglia nell'apertura e a 22 s tiene 1 link su 18 |
| Comportamento del Tunnel | su `buildDrop`: la velocità inverte 12 volte al secondo, la torsione 24, l'apertura degli anelli 12 |

Che cosa l'audit ha trovato di già pronto, e che ha deciso il progetto:

- il DSP esporta già noise floor, percentili del loudness, bande relative alla propria storia e
  sopra il proprio floor: il calibratore **non rianalizza nulla**;
- `EventStream` è già la rappresentazione degli eventi musicali: è bastato **un campo**
  (`significance`), non un secondo bus né un planner;
- la scena Spectrum legge `WorldView`: la calibrazione **non può entrare nel World Engine** senza
  cambiare ciò che Spectrum legge. Sta accanto;
- `MusicContext` vive sul frame grafico e serve le scene; la calibrazione vive sugli hop come
  morfologia e risonanza: nessuno stato duplicato;
- il solver XPBD dei solidi lavora già su posizioni di lavoro in doppia precisione con velocità
  derivate: lo shape matching entra come una proiezione in più, senza un secondo solver.

## 2. File

**Nuovi**

| File | Che cosa |
|---|---|
| `src/visual-engine/structural/FractureGate.ts` | quando un evento musicale può rompere i corpi di un sistema, e quanto |
| `src/experience/AdaptiveCalibration.ts` | `AdaptiveMusicCalibration`, `CalibrationFrame` |
| `src/visualizers/tunnel/motion.ts` | `TunnelMotionCoordinator`, `TunnelMotion`, `tunnelLab` |
| `src/visual-engine/structural/SolidRigid.test.ts` | 16 test: materiali, corpo rigido, gate, frattura da eventi |
| `src/experience/AdaptiveCalibration.test.ts` | 14 test |
| `src/bench/response.bench.test.ts` | costo di calibratore e coordinatore |
| `docs/rigid-resonant-body.md`, `adaptive-calibration.md`, `tunnel-motion.md`, `resonant-body-report.md`, `response-benchmark.json` | documentazione e dati |

**Modificati**

| File | Che cosa |
|---|---|
| `structural/SolidTypes.ts` | campi nuovi di `SolidTuning`, `PULSE_LIMIT`, profili, `FractureTuning`, `solidLab` (profilo, frattura), comando `event` |
| `structural/SolidState.ts` | `rest`, `frame`, `settled`, `bodyScale`, `bodyLargest`, `bodyIntact`, `shape()` |
| `structural/SolidDynamics.ts` | `breathe`, `fit`, `shapeRate`, `shatter`, `able` / `breakable`, legge di carico con tenacità e modo `events`, spinta che separa i pezzi, misure nuove |
| `structural/StructuralDynamics.ts`, `StructuralTypes.ts`, `WorldEnvironment.ts` | tempo audio del passo ai solidi, reset del gate, `StructuralEnvironment.pulse` |
| `geometry/GeometryState.ts`, `SonicGeometryMapper.ts` | tratto `pulse` |
| `primitives/SolidPrimitive.ts` | eventi datati al gate (`EventCursor`), comandi `fracture` (per il gate) ed `event` |
| `experience/EventStream.ts`, `ExperienceEngine.ts`, `types.ts` | `AudioEvent.significance`; calibrazione per hop, nello snapshot; reset di sessione distinto dalla perdita di frame |
| `visualizers/tunnel/TunnelVisualizer.ts`, `topology.ts`, `preset.json` | target → coordinatore → uniform; `architecture` / `crackOf`; `balance: 1` |
| `app/engine/SolidCockpit.ts`, `diagnostics/workspace/DevelopmentTools.ts` | pannelli Material, Fracture, Adaptive Calibration, Debug & Metrics; selettore Tunnel |
| `SolidLab.test.ts`, `regimes.test.ts`, `grammar.test.ts`, `bench/solid.bench.test.ts` | test adattati ed estesi |
| `README.md`, `AGENTS.md`, `docs/technical-overview.md`, `docs/solid-dynamics.md`, `docs/solid-dynamics-benchmark.json` | documentazione |

Non toccati: `native/` (DSP, wire, WASM), `src-tauri/`, cattura e trasporto, World Engine,
ExperiencePlanner, ShowDirector, RigController, renderer e pass, registry delle scene, menu e UI
cinematica, impostazioni, `CalibrationView` (sincronia), scena Spectrum e ciò che legge. Nessuna
dipendenza aggiunta. Nessun modello, nessuna rete.

## 3. Architettura finale

```text
cattura → DSP Rust → hop frame
                        │
                 ExperienceEngine (per hop, clock di cattura)
                 ├─ … memoria, narrativa, planner, fisica, risonanza, morfologia, WorldEngine   (invariati)
                 ├─ AdaptiveMusicCalibration → CalibrationFrame          accanto al mondo, mai dentro
                 └─ EventStream: impact / drop con `significance`        un solo flusso di eventi
                        │ snapshot, presentato al tempo udito
        ┌───────────────┴───────────────────────────────┐
  laboratorio Solid Dynamics (DEV)                 scena Tunnel (prodotto)
  GeometryState.pulse → env.pulse                  TunnelVisualizer: target dal mondo (com'era)
  SolidPrimitive: eventi → FractureGate            TunnelMotionCoordinator: A · B · C, accenti dagli eventi
  StructuralSystem.step → SolidSystem.solve        uniform degli shader esistenti
    pulsazione → XPBD → fit → carico → gate → shatter
```

Arbitraggio fra consumatori dello stesso evento: nessun livello nuovo. L'evento porta un solo voto
(`significance`), dato una volta a monte; **ogni modulo decide per sé** che cosa farne. Un kick
ordinario (voto ≈ 0–0,5) fa pulsare il solido e gli anelli del Tunnel e non passa né il gate né la
soglia degli accenti. Un drop affidabile fa una pulsazione forte, apre il Tunnel (il rilascio è del
mondo) e, se il gate passa (confidenza, cooldown, budget), rompe il solido. Gli effetti non si
moltiplicano fra loro: ciascuno è limitato nel proprio modulo (`PULSE_LIMIT`, quota di link per
evento, un accento alla volta, cessione di B a C).

## 4. Differenze di comportamento

| | Prima | Dopo |
|---|---|---|
| Corpo del prodotto / materiale Legacy | — | **identico bit per bit** (hash di una traiettoria di 25 s con colpo e torsione, tre solidi, fratture e ricomposizioni comprese: uguale a `d27cb24`) |
| Laboratorio Solid Dynamics, all'apertura | corpo Legacy, frattura per carico | corpo **Rigid**, frattura su **eventi** (Legacy a un clic) |
| Cubo su `buildDrop` | deformato 7–18 %, distrutto a 22 s | deviazione ≤ 0,02 %, pulsazione ± 5–6 %, una frattura al drop (2 pezzi), intero a 38 s |
| Stesso colpo sul corpo | deviazione di picco 4,9–6,6 % della taglia | 0,45–0,6 % (ritenzione 0,9: un decimo) |
| Frammenti | tenuti dai soli link, spinti link per link | tengono la forma della propria parte (0,05–0,07 %), pulsano entro il 6 % |
| Strumento *Fracture test* su Rigid | — | una frattura attraverso il gate; su Legacy è il colpo di prima |
| Eventi `impact` / `drop` | forza, confidenza, peso strutturale | + `significance` |
| Snapshot Experience | — | + `calibration` |
| `GeometryState` | — | + `pulse` (0 senza calibrazione; nessuna primitiva del prodotto lo legge) |
| Mondo, stato, intenti, show | — | **identici** (verificato con la calibrazione spenta: uguali all'ultimo bit) |
| Tunnel (preset) | ogni trasformazione per conto suo | **Balanced**; `balance: 0` è il Tunnel di prima, con gli stessi uniform |
| Tunnel su `buildDrop` | velocità: 12 inversioni/s; torsione 24; anelli 12 | 0; 1,4; 0,2. Distanza −0,7 %. Anelli dei bassi identici |
| UI cinematica, impostazioni, scene nel registry | — | invariate |

Il cambio visibile nel prodotto è **uno**: il Tunnel è Balanced. Tutto il resto del prodotto dà gli
stessi numeri.

## 5. Test

### Eseguiti

| Controllo | Esito |
|---|---|
| `npm run check` (typecheck, ESLint, Vitest, build di produzione) | **esito 0**: typecheck e ESLint puliti; **587 test passati, 1 saltato come prima, 70 file** (542 → 587: + 45); build di produzione riuscita. Il bundle principale non contiene codice dei solidi (resta nel chunk lazy della diagnostica); contiene il coordinatore del Tunnel |
| `npm run replay` | 2 passati, 1 saltato come prima |
| `cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline` | 67 test passati, 0 falliti (il core Rust non è toccato) |
| Traiettoria Legacy contro `d27cb24` (hash, una tantum, non nella suite) | identica per tetraedro, cubo, icosaedro |
| Browser DEV, GPU reale: laboratorio | nessun errore né warning; 60,0 fps, p99 16,7 ms, 0 frame lunghi; frattura al drop, ricomposizione; pannelli, profili, strumenti, calibrazione on/off, uscita e rientro |
| Browser DEV, GPU reale: Tunnel com'era / Balanced | nessun errore; 60,0 fps entrambi; misure al §6 |

Copertura rispetto ai test richiesti:

| Richiesto | Dove | Esito |
|---|---|---|
| **9.1** cubo intero per 60 s di audio ritmico; tetraedro e icosaedro stabili | `SolidRigid` «stays whole and itself through a minute…» (ritmo sintetico a 124 BPM, accoppiamento × 3) | passa |
| pulsazione mai oltre ± 6 % | stesso test (scala misurata ogni 4 passi) + dimostrazione `buildDrop` (ogni frame) | passa |
| deviazione dalla forma entro soglia | < 0,5 % in quel test; < 0,2 % nell'apertura di `buildDrop` | passa |
| nessun collasso, NaN, infinito; celle orientate | stesso test (`inverted` = 0 a ogni passo, volumi > 0, stato finito) + override fuori scala | passa |
| centro di massa fermo senza forze esterne | «is free to move and turn…»: < 10⁻⁴ unità in 20 s di pulsazione | passa (il mezzo ha sempre un drag minimo: la quantità di moto residua è < 5 % di quella interna) |
| risposta a impulsi e torsione; recupero | «is visibly more stable…»: residuo 0,06–0,14 a ρ = 0,9, monotòno in ρ, recupero < 0,1 s, deviazione finale < 10⁻⁵ | passa |
| **9.2** nessuna frattura in silenzio, né per transienti ordinari | «nothing breaks by itself…»: silenzio, colpo forte, mondo caotico per 20 s, 120 attacchi ordinari | passa |
| frattura controllata su eventi validi; cooldown | «an event that passes breaks the body along one plane…», «the cooldown holds…», test del gate | passa |
| identità, massa, continuità di posizione e velocità | stesso test (identità e massa uguali; nel passo della frattura nessuno spostamento oltre la propria velocità, nessun salto di velocità > 0,3 u/s) | passa |
| frammenti rigidi che non collassano | «a piece that can hold a shape…»: < 4 % in 10 s, contro > 3 × nei pezzi Legacy | passa |
| ricomposizione senza teleport; fallimenti gestiti | «finds itself again…» + dimostrazione (mai oltre `V_MAX` per passo; < 0,1 unità per frame) | passa, con un limite: l'innesto di una cerniera resta rapido (§8) |
| **9.3** silenzio, rumore basso, periodico, transienti forti, dinamica, compresso, salti di livello, cambi brano, cambio sorgente | `AdaptiveCalibration.test.ts` (frame sintetici e segnali attraverso WASM) | passa |
| **9.4** frame rate diversi, camera finita, torsione limitata, aperture smussate, transizioni, nessun accumulo, decadimento, risposta musicale | `regimes.test.ts` «Tunnel: balanced motion» | passa (30 / 60 / 120 / 144 fps entro 3 ‰) |

### Falliti

Nessuno nello stato consegnato. Durante il lavoro i test hanno fatto correggere: una frattura nei
primi secondi di un brano (ora nulla spicca finché il brano è in `stabilizing`); accenti che tornano
ogni poche battute votati come eventi (ora dimenticati su 64 attacchi); pezzi che rientravano in
forma di scatto (ora a passo limitato); un corpo già a pezzi rotto ancora (budget sul 60 % dei link).

### Non eseguiti

| Controllo | Perché | Che cosa manca |
|---|---|---|
| **9.5 musica reale catturata dalla sorgente di sistema** | nessun contenuto audio di prova autorizzato in questo ambiente; l'app desktop non è stata avviata | tutta la matrice sotto |
| Percezione visiva del movimento, a occhio, nel tempo | solo fotogrammi e numeri | giudizio su leggibilità del Tunnel, stabilità percepita del corpo, quando una frattura «ha senso» |
| App desktop (Tauri, WebKitGTK / WebView2), Windows | non avviata | le stesse prove del browser |
| Microfono | non usato (mette le cuffie Bluetooth dell'utente in modalità headset) | — |
| Tempo GPU | `EXT_disjoint_timer_query` non disponibile in questo percorso headless | costo GPU dei pass (il coordinatore e il calibratore non ne aggiungono) |
| 1080p, hardware più debole, limite di potenza | non provati | — |
| Memoria e allocazioni nel browser | non misurate | vedi §6: per costruzione, non per misura |

**Matrice di validazione su audio reale (pendente)**: da eseguire con l'app desktop, sorgente
*System*, contenuti di cui si hanno i diritti, niente nel repository.

| Genere / situazione | Laboratorio (Rigid, cubo): che cosa guardare | Tunnel: che cosa guardare | Calibrazione: che cosa leggere |
|---|---|---|---|
| ambient | intero e calmo; nessuna frattura | nessuna apertura per piccole tensioni | carattere basso, scala < 0,75 |
| techno | pulsa col kick; fratture rare, ai cambi di sezione | viaggio continuo, anelli col kick | carattere alto; gain ≈ 1 |
| hard techno / hardstyle | non si rompe a ogni kick | non sfarfalla | compresso: `range` < 10 LU, energia non stirata |
| psytrance | idem, con bassi continui | torsione leggibile | — |
| rock | fratture solo su stacchi veri | — | attacchi irregolari: quanti spiccano? |
| brano vocale | la voce non rompe | — | bassi poco attivi: pulsazione piccola |
| classica | dinamica ampia: un fortissimo dopo un pianissimo | — | `range` > 15 LU; nessun gain estremo nei pianissimo |
| parlato | nessuna frattura | corridoio | — |
| silenzio e rumore ambientale | fermo | corridoio | `waiting`, gain 1 |
| cambio brano con e senza pausa; cambio di volume di sistema; cambio dispositivo | nessuna frattura al primo colpo del nuovo brano | — | `epoch`, `stability`, rientro in 2 s |

## 6. Benchmark prima / dopo

Regola seguita: confrontabile è solo ciò che è misurato **nella stessa sessione**. La baseline
registrata all'inizio (macchina a 3,1 GHz) e la corsa finale (4,4 GHz) non lo sono: la differenza fra
le due era della macchina. Il confronto valido è questo: `d27cb24` in un worktree e l'albero di
lavoro, alternati due volte, `VITEST_MAX_WORKERS=1 npx vitest run src/bench`.

| Misura (p50 / p95 / p99) | Prima · 1 | Dopo · 1 | Prima · 2 | Dopo · 2 |
|---|---|---|---|---|
| Experience + planner + fisica per hop, 60 fps (ms) | 0,033 / 0,060 / 0,084 | 0,037 / 0,065 / 0,093 | 0,035 / 0,060 / 0,088 | 0,036 / 0,068 / 0,119 |
| Experience per hop, percorso browser 48 kHz (ms) | 0,031 / 0,048 / 0,065 | 0,033 / 0,049 / 0,069 | 0,032 / 0,047 / 0,064 | 0,036 / 0,073 / 0,115 |
| Pompa WASM per risveglio, 48 kHz (ms) | 0,703 / 1,201 / 1,568 | 0,707 / 1,204 / 1,605 | 0,721 / 1,234 / 1,801 | 0,794 / 1,587 / 2,312 |
| Passo solido, tetraedro Legacy (µs) | 13,9 / 47,8 / 73,0 | 14,9 / 79,4 / 105,7 | 15,6 / 47,9 / 77,7 | 15,1 / 53,2 / 75,8 |
| Passo solido, cubo Legacy (µs) | 21,9 / 50,1 / 67,9 | 22,4 / 46,8 / 68,4 | 24,2 / 37,4 / 61,2 | 24,1 / 69,6 / 80,8 |
| Passo solido, icosaedro Legacy (µs) | 32,1 / 46,0 / 60,6 | 33,2 / 49,5 / 65,3 | 35,3 / 44,7 / 55,0 | 35,2 / 46,3 / 56,5 |
| Passo solido, 4 icosaedri Legacy (µs) | 139,6 / 286,9 / 384,6 | 125,8 / 162,5 / 193,9 | 135,9 / 153,5 / 187,2 | 137,0 / 153,9 / 182,7 |

Lettura:

- **Experience per hop: + 0,002–0,004 ms al p50** (≈ + 6–10 %), coerente con il costo isolato del
  calibratore (0,71 µs) più la copia nello snapshot. È il costo dichiarato della calibrazione; a
  188 hop al secondo sono ≈ 0,5 ms di CPU al secondo, su un thread che ne spende 6–7 % per il DSP.
- **Passo solido Legacy: nessuna differenza misurabile** al p50 (entro ± 5–10 % fra corse, in
  entrambe le direzioni). p95 e p99 oscillano con il carico più della differenza cercata.
- La seconda corsa «dopo» ha code più alte anche nella pompa WASM, che il lavoro non tocca: è la
  macchina, non il codice.
- Nessun miglioramento prestazionale è dichiarato: non ce n'è.

Costi nuovi (stessa sessione, [response-benchmark.json](response-benchmark.json),
[solid-dynamics-benchmark.json](solid-dynamics-benchmark.json)):

| | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|
| Calibratore, per hop (µs) | 0,71 | 0,78 | 1,00 | 3,5 |
| Calibratore, per attacco valutato (µs) | 0,04 | 0,06 | 0,07 | 0,3 |
| Tunnel: target + legge dell'architettura (µs per frame) | 0,40 | 0,44 | 0,53 | 1,8 |
| Tunnel: lo stesso, coordinato (µs per frame) | 1,59 | 1,72 | 2,27 | 3,5 |
| Passo solido, cubo Rigid (µs) · Legacy nella stessa corsa | 24,4 · 23,8 | 32,4 · 48,1 | 41,1 · 73,3 | 399 · 346 |
| Passo solido, icosaedro Rigid · Legacy | 36,4 · 35,4 | 48,6 · 47,1 | 58,0 · 56,6 | 422 · 389 |
| Passo solido, 4 icosaedri Rigid · Legacy | 139 · 133 | 156 · 154 | 198 · 201 | 416 · 367 |

Nel browser, GPU reale (Chromium headless, Intel UHD):

| | FPS | frame p50 / p95 / p99 | frame > 33 ms | Altro |
|---|---:|---|---:|---|
| Laboratorio Rigid, 1672 × 941, High, 49 s | 60,0 | 16,7 / 16,7 / 16,7 ms | 0 | 20 draw call; passo solido 0,03–0,04 ms per frame; picco 8,3 ms all'apertura |
| Laboratorio Legacy, stessa sessione, 12 s | 60,0 | 16,7 / 16,7 / 16,7 ms | 0 | passo solido 0,02 ms |
| Tunnel com'era, 1280 × 720, Low, 2 × 36 s | 60,0 | 16,7 / 16,7 / 16,7 ms | 0 | — |
| Tunnel Balanced, alternato, 2 × 36 s | 60,0 | 16,7 / 16,7 / 16,7 ms | 0 | — |
| Ingresso nel laboratorio / uscita | | 181 ms / 83 ms | | non confrontato con la baseline (non misurata prima) |

Ciò che **non** è stato misurato: tempo CPU del frame nel browser prima / dopo (a 60 fps bloccati
dal vsync le due versioni sono indistinguibili; il costo aggiunto stimato dai benchmark è ≈ 1 µs per
frame per il Tunnel e ≈ 0,1 ms al secondo per la calibrazione); tempo GPU; memoria; draw call del
Tunnel (il coordinatore scrive solo uniform: non può cambiarli, ma non è stato contato).

**Memoria e allocazioni** (per costruzione, non per misura): ogni array nuovo è allocato una volta
alla taglia dei pool (per il laboratorio, 48 elementi e 128 link: ≈ 4 kB in tutto); la calibrazione
aggiunge una ventina di scalari a ciascuno dei 256 snapshot dell'anello; il coordinatore due
oggetti. Nel frame loop nulla alloca. Un'eccezione, dichiarata: a ogni **frattura da evento** (al
più una ogni 4 s) `shatter` crea un piccolo generatore (`Rng`) per corpo.

## 7. Regressioni rilevate

| Regressione | Stato |
|---|---|
| Experience per hop + 6–10 % (+ 2–4 µs) | accettata: è il calibratore, giustificato dalla funzione; disattivarlo (`enabled = false`) non lo toglie del tutto (le letture non calibrate restano) |
| Il Tunnel risponde 0,2–0,6 s più tardi su viaggio e torsione | voluta: è la continuità; `balance` la dosa |
| Test di indipendenza dal frame rate del Tunnel: da 1 ‰ a 3 ‰ in Balanced | accettata e dichiarata; a `balance: 0` resta 1 ‰ |
| Il laboratorio apre su un corpo diverso (Rigid) | voluta; i test del laboratorio che descrivono il corpo di prima ora scelgono Legacy esplicitamente |
| Pannelli del cockpit: *Damping*, *Resonance coupling* e *Fracture strength* spostati in Material e Fracture | voluta, per non duplicare i controlli |

Nessuna regressione funzionale trovata nelle parti non toccate (i 542 test preesistenti passano;
due sono stati parametrizzati per girare sia «com'era» sia Balanced, uno è fissato su «com'era»,
tre del laboratorio scelgono Legacy esplicitamente).

## 8. Limitazioni residue

1. **Nulla è stato validato su musica reale né a occhio.** Tutte le costanti (soglia e cooldown del
   gate, shock, spinta che separa, riferimento e carattere della calibrazione, tempi e soglie del
   coordinatore) sono tarate su `buildDrop`, `beat124`, `synthPop` e simili.
2. **Frammenti piccoli**: con 4, 8, 12 vertici un taglio lascia spesso vertici soli e catene, che
   non hanno una forma da tenere. Frammenti volumetrici veri chiedono solidi suddivisi.
3. **Ricomposizione**: non garantita (come prima); quando due facce si richiudono, la cerniera fra
   loro si innesta in fretta (fino a ~5 u/s per qualche frame). Continuo, sotto `V_MAX`, non lento.
4. **Significance**: dipende dalla `power` che l'Experience dà agli impatti; su un beat sintetico
   del tutto regolare 2–3 attacchi su ~90 in 20 s spiccano lo stesso, e possono rompere il corpo
   (nel laboratorio, su `beat124`, una frattura nei primi 40 s; su `synthPop` una a ~30 s). Con musica reale va guardato.
5. **Calibrazione fuori dal mondo**: per il vincolo su Spectrum. Oggi la usano il laboratorio e gli
   accenti del Tunnel; le altre scene rispondono come prima.
6. **Nessuna collisione** fra pezzi e fra corpi.
7. **Un gate per sistema**: con più corpi il cooldown è comune.
8. **Nessuna impostazione utente** per Balanced: è nel preset; il confronto è negli strumenti DEV.
9. Conversione ritenzione → rigidezza esatta a 0,9, più morbida del nominale ai valori bassi.

## 9. Raccomandazioni per la prossima iterazione

1. **Occhi e musica reale**, per prima cosa: la matrice del §5 nel laboratorio e sul Tunnel, con
   il selettore *Tunnel: com'era / Balanced* e *Material: Legacy / Rigid* sullo stesso brano.
   Decidere lì soglia e cooldown del gate e i tempi del coordinatore.
2. Se Balanced convince: un'impostazione utente (o per mood) al posto del solo preset, e lo stesso
   coordinamento per Particle Field e Vector Field, che hanno la stessa struttura (funzione pura
   del mondo + età degli eventi).
3. **Solidi suddivisi** (più celle per corpo) per frammenti volumetrici, con frattura lungo i
   confini fra celle: il gate e `shatter` non cambiano.
4. Innesto graduale delle cerniere quando una superficie si richiude.
5. Portare la `significance` dove oggi si usa la forza grezza degli impatti (luce del rig,
   `FlashGuard`), una scena alla volta e mai dentro il World Engine.
6. Tempo GPU e memoria nel cockpit dove la piattaforma lo consente; prova a 7 W.
