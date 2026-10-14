# Music Response Consolidation & Generative World Foundation

Data: 13 ottobre 2026. Branch `music-response-terrain`, sopra `workspace-lab-reliability`
(`a08fb85`), che a sua volta sta su `main` (`181870c`). Nessun push, nessun merge.

Refactor evolutivo: **nessun secondo DSP, nessun secondo beat tracker, nessun secondo predittore,
nessun World Engine parallelo, nessuna scena tolta o sostituita, UI cinematica non toccata**. Il core
Rust e il wire non sono modificati (`wire::VERSION` invariata, WASM invariato).

| | |
|---|---|
| Che cosa c'è di nuovo | la spiegazione misurata di come il Tunnel traduce la musica in moto (§3–4); i follower del suo coordinatore resi condivisi senza cambiarne un bit (§6); il conto di ciò che il motore si aspetta e di che cosa ne è stato (§5); una scena nuova, [Generative Terrain](generative-terrain.md); un difetto reale di consegna degli eventi corretto (§2.1); misure di moto e di ritardo nel workspace esistente (§9) |
| Che cosa **non** è cambiato | Infinite Tunnel (digest bit per bit, §7), Spectrum e le altre scene di riferimento, il mondo, il rilevamento del drop, la calibrazione, i corpi rigidi, il workspace, lo schema dei report |
| Che cosa resta da fare a chi ha orecchie e occhi | la validazione con musica reale (§12) e una decisione sul momento del `drop` (§2.4) |

## 1. Commit

| Commit | Che cosa |
|---|---|
| `a179060` | Event stream: nulla va perso quando il momento udito arretra |
| `79f1e04` | Shared motion: follower, cancello e accenti del Tunnel, fuori dal suo coordinatore (Tunnel identico bit per bit) |
| `97c43ca` | Anticipation: il conto di ciò che il motore si aspetta e di che cosa ne è stato |
| `3563f09` | Generative Terrain |
| `87471e8` | Test: i test di calibrazione hanno il tempo che serve su una macchina lenta |
| `e34e04d` | Diagnostica: ritardo degli attacchi e moto di ogni scena nel registry; costo delle parti nuove |
| ultimo | Documentazione (questo documento, [generative-terrain](generative-terrain.md), [world-transitions](world-transitions.md)) |

Baseline dei test (`a08fb85`, `npm run check` su questa macchina, sotto carico): 610 superati, 1
saltato (preesistente), **2 falliti per timeout** in `AdaptiveCalibration.test.ts` (5 s superati su
una CPU limitata in potenza; da soli passano 14 su 14). Sono i 612 dichiarati dall'intervento
precedente: non un difetto del codice, ma un test lento su questa macchina.

## 2. Criticità riscontrate

### 2.1 Eventi persi quando il momento udito arretra — **corretto**

`EventStream.forEachHeard` consegna a ogni consumatore gli eventi già uditi che non ha ancora visto.
Il cursore ricordava «il tempo più avanzato udito» e «l'ultimo arrivo»: se il momento udito
**arretra** (latenza di uscita alzata dall'utente o dalla calibrazione automatica, mappa dei clock
ristimata), gli eventi che arrivano mentre il momento udito recupera stanno *prima* del tempo del
cursore e venivano segnati come visti senza essere mai consegnati. Li perdeva ogni consumatore: luce
degli impatti (`RigController`), fronti d'onda (`WaveField`), accenti del Tunnel, cancello di
frattura dei solidi, timeline diagnostica. Con una latenza alzata di 150 ms: 150 ms di eventi, una
volta.

Ora il cursore tiene, per gli arrivi successivi all'arretramento, fin dove il momento udito è
tornato: nulla è perso e nulla di ciò che era già stato mostrato è mostrato di nuovo (test in
`ExperienceEngine.test.ts`, fallito prima della correzione). Resta un caso limite dichiarato: due
arretramenti uno dentro l'altro, con eventi nella sovrapposizione.

### 2.2 Tensione di fondo nella musica stabile — misurato, non cambiato

Riprodotti nel percorso reale (WASM → Experience → World) i segnali di prova: con un groove stabile
(`beat124`), un pad o un arrangiamento pop il potenziale del mondo **non sta a zero**: si assesta a
0,18–0,25, perché l'evidenza di build (`likelyBuild × predictionConfidence`) non è mai nulla. Un
build vero lo porta a 0,40–0,59. Il contrasto dell'anticipazione è quindi circa **0,25 → 0,5**, non
0 → 1. Conseguenze: nel Tunnel la sezione è sempre un po' poligonale (`facet = 1,5 × tensione` ≈
0,35) e la spinta è sempre trattenuta del 7 %. È parte dell'aspetto attuale: non l'ho toccato. Il
terreno ne tiene conto (le terrazze cominciano oltre 0,2).

### 2.3 Il coordinatore non aveva misure nel registry — **corretto**

I numeri del coordinatore (velocità mostrata, occupazione, apertura, accenti presi e rifiutati)
erano solo nell'overlay. Ora sono metriche (`scene.infinite-tunnel.*`, DEV), accanto a quelle del
terreno (`primitive.terrain.ground.debug.*`): registrabili ed esportabili con gli strumenti di prima.

### 2.4 Il `drop` rilevato non coincide con il drop musicale — **misurato, non cambiato: serve una decisione**

Sul segnale `buildDrop` (build di 8 s, drop a 18,0 s e a 50,0 s) l'evento `drop` dell'Experience
Engine — quello che converte il potenziale in moto (`WorldEngine.release`), fa partire il fronte del
Tunnel e ne cambia la configurazione — scatta:

| Drop musicale | `drop` rilevati | Scarto |
|---:|---|---|
| 18,0 s | 16,0 s e 20,2 s | **−2,0 s** e **+2,2 s** |
| 50,0 s | 48,1 s e 52,2 s | **−1,9 s** e **+2,2 s** |

Il motivo è nel codice: un rilascio scatta al primo attacco con novità strutturale dopo che
`releasePotential` ha superato 0,16 (lo supera a metà build), e non può ripetersi prima di 4 s. Qui
il primo arriva dentro il rullo di rullante, 2 s prima del drop; il drop stesso cade dentro i 4 s
di attesa e **non viene preso**; il secondo scatta appena l'attesa finisce. Lo stesso su `breakdown`
(25,3 e 29,5 s per un drop a 28,0 s; 63,6, 67,7 e 71,8 s per uno a 68,0 s: lì il secondo cade a 0,3 s
dal drop).

Che cosa si vede, allora, su questo segnale (§4): durante il build il viaggio **accelera con le
percussioni** (velocità del mondo 1,20 → 1,82 mentre il rullo si infittisce) e la parete si tende;
a 16,0 s un primo rilascio (slancio, fronte); **al drop, a 18,0 s, nessuno slancio**: la velocità
anzi cala (1,82 → 1,44), perché il rullo fitto finisce e il groove ha meno attacchi; a 20,2 s il
secondo rilascio. Preparazione vera, rilascio fuori tempo di ± 2 s.

Con musica reale può andare diversamente, e il meccanismo dice quando: se il primo rilascio cade più
di 4 s prima del drop (build lunghi), il drop è il primo attacco «nuovo» dopo l'attesa e il rilascio
gli cade sopra. Con un build di 8 s no. È plausibile che l'hardstyle provato rientri nel primo caso;
non posso verificarlo.

Non l'ho corretto. Cambiare quando scatta un rilascio cambia il comportamento del Tunnel proprio
nel punto in cui piace, e l'unica evidenza che ho è un segnale sintetico. Va guardato con musica
reale e con le misure nuove (§5: `anticipation.lead`; `dropTimes` nel report del replay). Una
correzione plausibile, da proporre a parte: far scattare il rilascio solo quando il build è *finito*
(il picco di anticipazione è alle spalle: l'evento `buildPeak` esiste già) e i bassi sono rientrati,
così che non possa consumarsi a metà build.

### 2.5 La ripresa dopo una pausa viene letta come un build — misurato, non cambiato

`startStop` non contiene alcun build: 8 s di groove, 4 s di silenzio, e così via. In 50 s il motore
vi rileva **3 `drop`** (a 22,2, 34,4 e 43,1 s: da 3 a 6 s dopo ogni ripresa), perché l'energia che
torna dopo il silenzio è una salita sostenuta. Sono fra i rilasci più piccoli (0,11–0,15; quelli dei
build vanno da 0,13 a 0,36), ma sono falsi eventi: un fronte nel Tunnel e nel terreno, una riorganizzazione. È lo
stesso criterio di §2.4 visto dall'altro lato, e va deciso insieme. Negli scenari non percussivi e
stabili il comportamento è invece pulito: `beat124`, `pad` e `synthPop` danno **0 anticipazioni e 0
rilasci** in 110 s complessivi.

### 2.6 Altre osservazioni

- **Costo del coordinatore dopo l'estrazione**: +0,3 µs per frame reali (chiamate di metodo), più
  0,5 µs che sono un artefatto dell'harness di test (§10.1). Irrilevante su un frame, ma dichiarato.
- **`npm run check` sotto carico** fallisce per timeout due test di calibrazione (§1): preesistente.
- **Step 4 (integrazione nelle scene di riferimento)**: fatta solo per il Tunnel, che ora usa i pezzi
  condivisi. Spectrum non si tocca per regola; Vector Field, Spectral Shell, Matter Field e Spectral
  Matter leggono già lo stesso mondo e gli stessi eventi (§7) e non ho trovato in loro un difetto
  misurabile che giustificasse una modifica alla cieca, senza musica reale e senza occhi.

## 3. Mappa: come il Tunnel traduce la musica in moto

```text
cattura → DSP Rust (hop 5,3 ms) ──► AnalysisFrame · onset · beat · section            [un solo core]
                                          │
                     ExperienceEngine.ingest (per hop, clock di cattura)
   ┌──────────────────────┬───────────────┴──────────────┬─────────────────────────────┐
   │ motion               │ anticipation, likelyBuild    │ attacco (onset > 0,3)       │ releasePotential > 0,16
   │ = attività delle     │ × confidenze                 │ potenza × significance      │ + novità strutturale, ≥ 4 s
   │   bande + densità    │                              │ (AdaptiveCalibration.rate)  │
   ▼ di onset             ▼                              ▼                             ▼
 thrust                 charge ──► potential            impact(): velocità += 0,5·p    release(): potential → moto
 (× 1 − 0,3·potential)  (perde in 8 s)                  raggio, eccitazione            velocità += 2·q, fronte
   └──────────────────────┴───────────── WorldState (corpi + campi, integrazione esatta per hop) ─────────┘
                                          │  snapshot ogni 1/120 s, presentato al tempo UDITO (estrapolato)
                                          ▼
                 VisualDirector → WorldView (guadagni del mood sulle velocità, mai sulle posizioni)
                                          ▼
 TunnelVisualizer.update      ogni target dal mondo: advance = dTravel, raggio = pressione, torsione = spin …
        │ raw + tunnelTopology(view)      (funzione pura: potenziale → spigoli, gola, crepe; rilascio → fronte)
        ▼
 TunnelMotionCoordinator      A viaggio (RateFollower 0,2 s) · B registri · C cancello con isteresi + accenti
        ▼                     (AccentGate: solo eventi con significance ≥ 0,7, uno ogni 2 s)
 uniform degli shader          + RollingTraces (storia delle bande per 8 battute) → anelli che rotolano via
```

Tre strati, tre responsabilità: **l'analisi misura** (Rust), **l'esperienza interpreta e il mondo
integra** (per hop, sul clock audio, senza conoscere scene), **la scena mostra** (per frame, senza
analizzare nulla). Il coordinatore sta nell'ultimo strato: non decide niente di musicale.

## 4. Perché il Tunnel sembra anticipare

Le risposte alle domande del brief, dal codice e dalle misure.

1. **BPM, beat, onset, transienti.** Il BPM e la griglia dei beat **non muovono il Tunnel**: servono
   al clock del regista, agli effetti agganciati al beat (assenti in Preset) e alla confidenza delle
   previsioni. Il moto viene dagli **onset**: la loro densità e l'attività delle bande fanno `motion`
   → spinta; ogni attacco sopra soglia è un `impact` → salto di velocità (+0,5 × potenza) e di
   pressione. `RollingTraces` usa il tempo solo per la lunghezza della storia (8 battute di anelli).
2. **Che cosa determina il comportamento anticipatorio.** Non un evento: una **quantità continua**.
   `anticipation` (salita sostenuta di energia, tensione, complessità, brillantezza) e `likelyBuild`,
   pesate con le loro confidenze, **caricano** il potenziale del mondo (`charge`, fino a 0,3 /s). Il
   potenziale fa quattro cose insieme: dà spigoli alla sezione, stringe il tunnel in lontananza,
   trattiene la spinta (fino al 30 %), abbassa un poco la luce. È il «prepararsi».
3. **Come entra la confidenza.** Moltiplica la carica: una previsione dubbia prepara poco. In più le
   intenzioni del planner pesano `forza × confidenza` (`contract` usa `anticipationConfidence`).
   Nessuna soglia fa scattare un effetto: sotto bassa confidenza la preparazione è solo più piccola.
4. **Accelerazione.** È del mondo: la velocità tende a `1,6 × motion × (1 + 0,6·accelerate) ×
   (1 − 0,3·potential)` con un attrito di 1,1 /s (integrazione in forma chiusa); `decelerate` e
   `suspend` alzano l'attrito; ogni attacco e ogni rilascio aggiungono un salto. Il coordinatore la
   segue su 0,2 s con l'integrale esatto: uno slancio, non uno scatto.
5. **Allineamento geometrico.** `tunnelTopology`: il potenziale rende la sezione un poligono
   (`facet`) e la tira dentro (`throat`); con disordine o torsione la parete si apre in anelli e
   pannelli, ma in Balanced solo attraverso il cancello (0,30 per aprire, 0,12 per chiudere).
6. **Smoothing, easing, interpolazione.** Tre livelli, tutti esatti per un ingresso tenuto nel passo:
   il mondo (molle e attriti in forma chiusa, per hop); la presentazione (lo snapshot più recente già
   udito, **estrapolato** al tempo udito con le stesse forze: è questo che compensa la latenza senza
   guardare avanti); il coordinatore (follower esponenziali esatti, rampe del cancello, età degli
   eventi). Nessun `lerp` per frame: per questo è uguale a 30 e a 144 fps.
7. **Responsabilità.** §3.
8. **Che cosa è riutilizzabile.** §6.
9. **Che cosa resta del Tunnel.** §6.

E la distinzione che il brief chiede di non confondere, sul segnale `buildDrop`:

| | Che cosa è | Quando (drop a 18,0 s) |
|---|---|---|
| **Movimento preparatorio** | il potenziale sale 0,15 → 0,42 (spigoli, gola, spinta trattenuta) e il viaggio accelera con il rullo (1,20 → 1,82) | da ≈ 12 s, con il build |
| **Evento previsto** | nessuno: non esiste un «drop atteso al tempo T». C'è un'evidenza (`likelyRelease`) e, con una griglia sicura, il prossimo confine di frase | — |
| **Evento rilevato** | `drop` dell'Experience Engine | 16,0 s e 20,2 s (§2.4) |
| **Movimento rilasciato** | lo slancio e il fronte di ciascun `drop` rilevato | 16,0 s e 20,2 s, **non** 18,0 s |
| **Falsa previsione** | un'anticipazione che non riceve rilascio: il potenziale perde in 8 s, nessun fronte | su `startStop`: 1 delle 4 aperte scade; ma lì sono falsi anche i rilasci (§2.5) |

Quindi: l'anticipazione del Tunnel è **reale ma non è una previsione del drop**. È una preparazione
proporzionale all'evidenza di un build (tensione nella forma, accelerazione con le percussioni), più
un rilascio che scatta quando ne è stato accumulato abbastanza. Che quel rilascio cada sul drop
dipende dalla forma del brano (§2.4). La qualità percepita viene dalla continuità della
preparazione; il momento del rilascio è il punto debole da verificare.

## 5. Anticipazione condivisa

Il motore distingueva già, ma non lo teneva scritto. `experience/Anticipation.ts`
(`AnticipationLedger`, per hop sul clock di cattura, in ogni snapshot) non predice nulla: legge la
**stessa** carica con cui il mondo viene caricato (`forces.charge / CHARGE_RATE`) e gli stessi
rilasci, e tiene il conto.

| Fase | Quando | Misurato |
|---|---|---|
| `none` | livello < 0,15 | groove stabile, pad, pop: livello massimo 0,17–0,23 |
| `uncertain` | livello ≥ 0,25 | evidenza, non abbastanza per aprire |
| `probable` | livello ≥ 0,45 (tenuta fino a 0,25) | i build: oltre 0,5 per secondi |
| `confirmed` | per 1,6 s dopo un rilascio | — |

Contatori per sessione: `opened`, `confirmed` (con `lead`, i secondi dall'apertura al rilascio),
`expired` (l'evidenza è mancata per 4 s senza rilascio), `unannounced` (rilasci non annunciati). Sono
nel registry diagnostico (`anticipation.*`) e nel report del replay (`anticipationsOpened`, …,
`dropTimes`). Sui segnali di prova, nel percorso reale:

| Segnale | aperte | confermate | scadute | rilasci non annunciati | `drop` |
|---|---:|---:|---:|---:|---:|
| `buildDrop` (70 s, 2 build) | 5 | 4 | 0 | 0 | 4 |
| `breakdown` (84 s, 2 build) | 4 | 4 | 0 | 1 | 5 |
| `crescendo` (50 s) | 5 | 4 | 0 | 0 | 4 |
| `beat124` · `pad` · `synthPop` (110 s) | 0 | 0 | 0 | 0 | 0 |
| `startStop` (50 s, nessun build) | 4 | 2 | 1 | 1 | 3 |

«Confermata» vuol dire che un rilascio è arrivato mentre l'anticipazione era aperta: dice che il
motore è **coerente con sé stesso**, non che il rilascio fosse sul drop (§2.4) né che il build fosse
vero (§2.5). Quel giudizio richiede un brano annotato, o orecchie.

**Le scene non ramificano su questa lettura.** Condividono l'intenzione musicale attraverso il
mondo (il potenziale è una forza), non un'animazione: il Tunnel dà spigoli e si stringe, il terreno
si terrazza e solleva placche, le recipe stringono il raggio dei campi (`radius`) e tendono le
strutture (`GeometryState.tension`), lo Spectral Shell apre i gusci al rilascio. Una falsa
previsione non lascia nulla: provato a livello di motore (`Anticipation.test.ts`: nessun `drop`,
potenziale che solo cala, mai di uno scalino, niente aperto) e di scena (`Terrain.test.ts`).

## 6. Componenti condivisi

`src/visualizers/shared/motion.ts`, usato da due scene reali (Tunnel e Terrain):

| Pezzo | Che cosa fa | Era nel coordinatore come |
|---|---|---|
| `follow`, `ARRIVED` | un valore verso il suo obiettivo, **che arriva** (sotto 10⁻⁵ è lì: a riposo ci si ferma) | funzioni locali |
| `RateFollower` | una velocità seguita su τ, con la distanza esatta del frame | il viaggio e la rotazione (A) |
| `HysteresisGate` | apre oltre una soglia, chiude solo sotto un'altra, con rampe | il cancello della parete (C) |
| `AccentGate` | gli eventi che spiccano (`significance`), uno alla volta, come età | gli accenti (C) |

**Resta del Tunnel**, in `tunnel/motion.ts` e `tunnel/topology.ts`: i tre livelli A / B / C, quali
trasformazioni cedono a quali e di quanto (`YIELD`), l'occupazione, i limiti di torsione e raggio,
tutte le costanti di tempo, la legge dell'architettura (`architecture`, `crackOf`), `RollingTraces`.
Nessuna astrazione «coordinatore generico»: due utilizzatori condividono i pezzi, non la regia.

## 7. Risposta fisica condivisa: le categorie sulle implementazioni reali

Nessuna classe nuova: ogni categoria del brief esiste già, in un solo posto.

| Categoria | Dove vive | Come la leggono le scene |
|---|---|---|
| **Impulse** | `WorldEngine.impact` (quantità di moto ai corpi) + evento `impact` datato con `significance` | Spectrum: risposta immediata della propria geometria; Tunnel: slancio e anelli; Terrain: slancio, anelli sul suolo, placche per gli accenti; recipe: fronti (`WaveField`) |
| **Pressure** | corpo radiale (`radius`, `radialVelocity`) → `WorldView.pressure / surge` | raggio del Tunnel, rilievo del terreno, `fields.radius` e `surge` delle recipe |
| **Tension** | `potential` (carica × confidenza, perdita 8 s) → `WorldView.tension` | spigoli e gola (Tunnel), terrazze e gola (Terrain), `GeometryState.tension`, FOV dell'Observer |
| **Release** | `WorldEngine.release` + `releaseAge / releaseStrength` + `Reorganization` | fronte e nuova struttura (Tunnel, Terrain, Particle Field), `fracture` e gusci (recipe) |
| **Resonance** | `ResonantPhysics` (modi, impulsi), `MultiscaleResonance` → `ResonanceField` | waveguide del Tunnel, membrana di Spectral Shell / Matter Field, materia differenziata |
| **Flow** | `SpatialFields` (vortex, advection, drift, turbulence), `vectorField` | Vector Field (traccianti, linee), materia libera |
| **Attraction / Repulsion** | `SpatialFields.stiffness / gather / clumping`, `wells`, `fieldLaw` | materia delle recipe, pozzi di Particle Field |
| **Cohesion** | `WorldState.coherence`, `fields.cohesion / bond`, `BondSystem` | filamenti, grafo, legami strutturali, solidi |
| **Fracture** | `BondSystem` (carico, fatica), `FractureGate` → `shatter` | Structural / Solid Dynamics (laboratori); nel Tunnel e nel Terrain è topologia, non frattura di legami |

Le scene non dipendono l'una dall'altra: ognuna importa il mondo e, al più, `visualizers/shared`.

### Classi temporali

| Classe | Fenomeni | Costanti esistenti |
|---|---|---|
| **Rapida** | attacchi, kick, hi-hat | impulso istantaneo sul corpo; eccitazione 0,45 s, shimmer 0,18 s; luce degli impatti (FlashGuard); fronti datati; ritardo misurato `latency.impactLate` |
| **Media** | accelerazione, rotazione, deformazione, massa | corpo radiale 0,55 Hz ζ 0,5; attrito del viaggio 1,1 /s e della rotazione 0,6 /s; follower 0,2–0,8 s; disordine 0,4 s su / 2 s giù |
| **Lenta** | build, tensione, organizzazione, spazio | potenziale (perdita 8 s), apertura 4 s, coerenza 1,5 s, budget strutturale 1,6 s / 4 s, cancello 0,6–1,8 s, carattere e gain della calibrazione (decine di secondi) |

Nessuno smoothing è stato aggiunto su un percorso rapido.

### Rigidità e solidi

`visual-engine/structural/` non è toccato: `PULSE_LIMIT = 0,06`, la conversione ritenzione →
rigidezza (`shapeRate`, il 90 % concettuale) e l'unico percorso di frattura (`FractureGate.take` →
`shatter` → `sever`) sono quelli di [rigid-resonant-body](rigid-resonant-body.md);
`SolidRigid.test.ts` e `Solid.test.ts` passano invariati. I limiti dei corpi rigidi **non** sono
applicati al terreno, che è una superficie: lì la distinzione del brief è nella legge — moto del
corpo (viaggio, piega, inclinazione), vibrazione locale (`quake`, fronti), deformazione elastica
(`relief`, `crest`, `ridge`), trasformazione morfologica (terrazze, riorganizzazione), frattura
(placche rigide dietro un cancello) — e nessuna è un rumore sui vertici.

## 8. File

| File | Perché |
|---|---|
| `src/experience/EventStream.ts` | §2.1 |
| `src/visualizers/shared/motion.ts` (+ test) | §6 |
| `src/visualizers/tunnel/motion.ts` | usa i pezzi condivisi; nessun numero cambiato |
| `src/visualizers/tunnel/preservation.test.ts` | digest del Tunnel, registrati prima dell'estrazione |
| `src/experience/Anticipation.ts` (+ test), `ExperienceEngine.ts`, `types.ts` | §5 |
| `src/world/WorldState.ts`, `WorldEngine.ts` | `CHARGE_RATE` ha un nome (stesso valore, stessi bit) |
| `src/visual-engine/primitives/terrain{Law,Motion}.ts`, `TerrainPrimitive.ts`, `src/visualizers/terrain/*` | [Generative Terrain](generative-terrain.md) |
| `src/diagnostics/probes/EngineProbes.ts` | `anticipation.*`, `latency.impactLate`, `scene.<nome>.*` |
| `src/validation/replay.ts` | conto dell'anticipazione e tempi dei drop nel report |
| `src/bench/response.bench.test.ts` | costo del conto e del moto del terreno |
| `docs/`, `README.md`, `AGENTS.md` | documentazione |

Non toccati: `native/`, `src-tauri/`, `src/audio/`, `src/ui/`, `src/app/` (UI cinematica),
`src/visualizers/spectrum/`, `src/visual-engine/structural/`, `src/diagnostics/workspace/`,
lo schema dei report (le metriche nuove sono righe in più del registry, come ogni valore di
produttore).

## 9. Diagnostica

Nessuna dashboard nuova, nessun controllo nuovo. Nel registry esistente (Shift+G, dominio
`experience` / `audio` / `geometry`; REC, export JSON / CSV / Markdown e segmenti invariati):

| Metrica | Che cosa dice | Stato |
|---|---|---|
| `anticipation.level`, `.stored`, `.age`, etichetta `anticipation.phase` | ciò che ci si aspetta adesso | valida (clock audio) |
| `anticipation.opened / confirmed / expired / unannounced`, `.lead` | eventi anticipati, confermati, scaduti, non annunciati; anticipo dell'ultimo confermato | valida |
| `latency.impactLate` | dal momento in cui un attacco è udito al frame che lo mostra | **stimata**: comando, non fotoni |
| `scene.infinite-tunnel.speed / occupancy / aperture / accent / accents / refused / twist` | il moto del Tunnel com'è coordinato | DEV |
| `primitive.terrain.ground.debug.speed / tension / terrace / aperture / lift / accents / refused / release / fronts` | lo stesso per il terreno | DEV |

Già presenti e usate così: BPM (`audio.beatBpm`), confidenza del beat, onset, tensione
(`world.potential`), frame time (p50 / p95 / p99, jank), CPU per fase, GPU (timer query), draw call,
risorse (`render.geometries / textures`), heap, lifecycle (timeline `scene-change`).

**Che cosa non è misurato**: la latenza audio-visiva end-to-end. `latency.physical` resta `null`: il
clock audio e quello dell'host sono mappati (`ClockSync`), ma il momento in cui il fotone esce dallo
schermo non è osservabile; `latency.renderEstimate` è una stima (frame × `renderFrames`), non una
misura.

Confronto riproducibile: stesso segnale di prova riavviato, REC, export; un cambio di scena o di
`tunnelLab.balance` apre un segmento, non azzera.

## 10. Benchmark

### 10.1 CPU sintetica (`bench/response.bench.test.ts`, µs per chiamata, p50 · p95)

Stessa macchina, corse alternate base → lavoro, due volte. Macchina non isolata.

| | `a08fb85` | questo branch |
|---|---:|---:|
| target + legge dell'architettura (Tunnel com'era) | 0,58 · 1,26 | 0,62 · 1,30 |
| **Tunnel Balanced** (coordinatore) | 2,35 · 4,40 | 3,10 · 5,62 |
| conto dell'anticipazione, per hop | — | 0,05 · 0,10 |
| moto del terreno + impacchettamento, per frame | — | 2,70 · 5,08 |

Il coordinatore costa **0,75 µs in più per frame nell'harness**. Con gli stessi pezzi importati come
costanti locali il costo scende a 2,67 µs: circa 0,5 µs sono i getter con cui vitest risolve gli
import (nel bundle di produzione le funzioni sono locali), circa 0,3 µs sono le chiamate di metodo
vere. Su un frame di 16,7 ms è lo 0,002 %. Non l'ho «ottimizzato» piegando il codice per un
benchmark; lo dichiaro.

### 10.2 GPU reale

Chromium headless, ANGLE su Intel UHD (CML GT2), 1280 × 720, vsync, riflesso spento, segnale
`buildDrop` riavviato a ogni corsa, 36 s; base (`a08fb85`) e branch alternati, due volte. Dati
completi in [music-response-benchmark.json](music-response-benchmark.json).

**Low** (il livello a cui questa GPU tiene il frame: è lì che si vede la CPU)

| | Tunnel `a08fb85` | Tunnel, questo branch | Generative Terrain |
|---|---:|---:|---:|
| FPS · frame p50 / p95 / p99 | 60,0 · 16,7 / 16,7 / 16,7 ms | 60,0 · 16,7 / 16,7 / 16,7 ms | 60,0 · 16,7 / 16,7 / 16,7 ms |
| frame oltre 20 ms | 0 | 0 | 0 |
| draw call per frame (composizione inclusa) | 3 | 3 | 3 |
| triangoli · segmenti per frame | 10 753 · 0 | 10 753 · 0 | 7 477 · 11 345 |
| geometrie · texture · programmi | 3 · 3 · 3 | 3 · 3 · 3 | 3 · 3 · 3 |
| distanza percorsa (`uTravel`) | 121,9 – 122,1 | 122,0 – 122,1 | — |
| torsione: variazione /s · inversioni /s | 0,0017 · 1,36 | 0,0017 · 1,36 – 1,42 | — |
| anelli dei bassi: variazione · inversioni | 0,142 – 0,143 · 18,7 – 19,1 | 0,142 – 0,144 · 18,5 – 18,8 | — |
| apertura della parete: variazione · inversioni · massimo | 0,018 · 0,19 · 0,168 | 0,018 · 0,19 · 0,168 | — |
| terreno: velocità massima · terrazze max · placche max · rilascio max | — | — | 13,2 u/s · 0,56 · 0,71 · 0,57 |

Il Tunnel è lo stesso prima e dopo anche su GPU, entro la variabilità fra due corse dello stesso
codice (la sorgente sintetica gira in tempo reale: le corse non sono identiche al bit, i digest di
§11 sì). Il terreno tiene lo stesso frame del Tunnel con meno triangoli.

**High** (solo questo branch): Tunnel 36,2 fps (851 frame su 1 303 oltre 33 ms), Terrain 40,2 fps
(703 su 1 450). A High questa GPU non tiene i 60 fps con **nessuna** delle due: bloom e MSAA (17
draw call per frame) dominano, come già misurato sulle altre scene. Il terreno non è più pesante
del Tunnel. `Auto` scende di livello in entrambi i casi. Non ho una base a High: nessun confronto
prima / dopo lì.

**Cambio ripetuto Tunnel ↔ Terrain** (Low, 66 s, un cambio ogni 6 s, 10 cambi, poi ritorno e GC):

| | prima | dopo |
|---|---:|---:|
| geometrie · texture · programmi | 3 · 3 · 3 | 3 · 3 · 3 |
| listener su window / document · timer | 20 · 2 | 20 · 2 |
| heap JS | 33,9 MB | 34,5 MB |
| FPS · frame oltre 33 ms | | 59,9 · 2 (ai cambi: compilazione dei programmi) |

`requestAnimationFrame`: 1 per frame del motore con entrambe le scene (più quello della misura);
durante i cambi di scena l'interfaccia ne chiede qualcuno in più per le proprie transizioni, in
ugual misura sulla base (Tunnel ↔ Spectrum: 2,2 per frame su base e su branch). Lo heap dopo il
soak Tunnel ↔ Spectrum scende di 0,8 MB su entrambi: ± 1 MB è il rumore del GC, non una crescita.

**Non misurato**: sessioni lunghe (oltre un minuto di soak), Tauri / WebKitGTK, Windows, il
ThinkPad T14 Gen 1 di riferimento (la macchina di sviluppo è un i7-10510U con la stessa classe di
GPU integrata, limitata in potenza), CPU e GPU separate per scena (il timer query è negli strumenti
del workspace; qui ho misurato i frame presentati).

## 11. Test

`npm run check` (typecheck, lint, test, build): **643 superati, 1 saltato (preesistente), 77 file;
build di produzione riuscita**. Erano 610 + 2 timeout alla baseline: i 31 in più sono i test nuovi,
e i due di `AdaptiveCalibration.test.ts` ora hanno il tempo che serve loro su una macchina lenta
(`testTimeout` del solo file, nessun'altra modifica). Core Rust, non toccato:
`cargo test -p spectrum-analysis -p spectrum-analysis-wasm --offline`, 67 superati.
`scripts/workspace-browser.mjs acceptance` (DEV) e `release` (`vite build` + `vite preview`): superati;
in release la scena si monta e si disegna senza errori di console.

Nuovi: `motion.test.ts` (4), `preservation.test.ts` (3), `Anticipation.test.ts` (7),
`Terrain.test.ts` (16), un test dell'event stream. Rispetto all'elenco del brief:

| Richiesta | Dove |
|---|---|
| 1 preservazione del Tunnel | `tunnel/preservation.test.ts`: digest di ogni numero di coordinatore e scena su una sessione di 30 s (60 / 144 fps, balance 1 / 0,5 / 0), registrati **prima** dell'estrazione; `regimes.test.ts` invariato |
| 2–3 eventi anticipati, falsa previsione | `Anticipation.test.ts`, `Terrain.test.ts` |
| 4 NaN / Infinity | `Terrain.test.ts` (mondi rotti, ogni `dt`), `Anticipation.test.ts`, `preservation.test.ts` (un frame rotto) |
| 5 geometrie rigide | `SolidRigid.test.ts`, `Solid.test.ts` invariati; placche rigide in `Terrain.test.ts` |
| 6–8 lifecycle, apertura / chiusura, Tunnel ↔ Terrain | `Terrain.test.ts` (30 cicli, conteggio dei `dispose`) + soak in browser (§10.2) |
| 9 override | `overrides.test.ts` invariato; `scripts/workspace-browser.mjs acceptance` |
| 10–11 listener, loop | `Terrain.test.ts`; in browser: 1 RAF per frame, listener e timer costanti |
| 12 cattura audio | nessun codice di cattura toccato; `AudioEngine.test.ts` invariato |
| 13 memoria | conteggio delle risorse nei 30 cicli; heap prima / dopo il soak (§10.2) |
| 14 DEV / release | build di produzione; `workspace-browser.mjs release` |
| 15 UI cinematica | nessun file di `src/ui/` o di `src/app/` (menu, pannelli) modificato; `menus.test.ts` invariato |

Distinzione: tutto quanto sopra è **automatico** (unitario o su segnali sintetici). Le prove **visive**
sono fotogrammi guardati a Low e High su una Intel UHD. Le prove con **audio reale** non sono state
eseguite (§12).

## 12. Limiti della validazione e checklist audio reale

Non ho accesso ad audio reale né a occhi nel tempo. Tutto è stato provato con segnali sintetici
(`buildDrop`, `breakdown`, `crescendo`, `beat124`, `pad`, `synthPop`, `startStop`) in Chromium
headless su Linux. Non provati: Tauri / WebKitGTK, Windows, microfono (in questa macchina commuta
gli auricolari Bluetooth), hardware diverso dalla Intel UHD, sessioni di ore.

Da fare a mano, con il workspace aperto su **Diagnostics & Reports** e REC attivo. Per ogni scenario:
Infinite Tunnel, poi Generative Terrain, sullo stesso brano; in DEV anche Tunnel «com'era»
(Laboratories → Experiment Controls).

**A — Hardstyle**
- [ ] Cassa regolare: uno slancio per colpo, mai uno scatto; `latency.impactLate` < 1 frame.
- [ ] Build: `anticipation.phase` passa a `probable` **durante** il build, non prima; `world.potential` sale oltre 0,35; il Tunnel prende spigoli, il terreno terrazze.
- [ ] Drop: quando scatta l'evento `drop` rispetto al drop che si sente? (timeline + `anticipation.lead`.) **È il punto di §2.4**: annotare lo scarto.
- [ ] Percussioni crescenti: la velocità cresce con loro (`scene.infinite-tunnel.speed`, `…ground.debug.speed`).
- [ ] Variazioni improvvise (cut, anti-climax): nessun fronte senza rilascio; `expired` sale di 1 e nulla resta aperto.
- [ ] Continuità: nessun salto del terreno, nessun «nuoto» del paesaggio.

**B — Techno**
- [ ] Ritmo ripetitivo per minuti: `anticipation.opened` resta basso (< 1 al minuto); `accents` quasi fermo, `refused` cresce.
- [ ] Energia sostenuta: `world.potential` attorno a 0,2–0,25 (§2.2); il terreno non si terrazza, la parete del Tunnel non si apre.
- [ ] Nessun falso evento vistoso: `unannounced` vicino a 0.

**C — Psytrance**
- [ ] Basso continuo: la pressione non satura (`world.radius` lontano da ± 0,9); il rilievo respira, non resta gonfio.
- [ ] Ritmi sovrapposti: i fronti non si accavallano in un tremito continuo (`fronts` < 8 per la maggior parte del tempo).
- [ ] Evoluzione progressiva e cambi timbrici: terrazze e creste seguono in secondi, non in frame.

**D — Non percussivo (ambient, pause, voce)**
- [ ] `anticipation.opened` resta a 0 o quasi; nessun `drop`.
- [ ] Il viaggio rallenta fin quasi a fermarsi; il terreno resta un paesaggio in penombra.
- [ ] Calibrazione: `calibration.scale` scende verso 0,6; nessun comportamento da hardstyle.

**E — Silenzio e cambio sorgente**
- [ ] Pausa: tutto decade e si ferma (velocità 0, `lift` 0, `terrace` 0); nessun moto dal rumore residuo.
- [ ] Ripresa: nessun fronte «arretrato»; `anticipation` riparte dal conto (non azzerato da una pausa breve).
- [ ] Ripresa dopo una pausa: scatta un `drop` nei secondi successivi senza che ci sia stato un build? (**§2.5**: annotare.)
- [ ] Cambio sorgente (system ↔ fake): nuova sessione; follower lasciati subito; il suolo non salta.
- [ ] Latenza: alzare la compensazione di uscita di 150 ms a musica in corso: nessun impatto perso (§2.1).
- [ ] 30 minuti: `render.geometries / textures`, heap e listener stabili.

## 13. Prossima iterazione

1. **Decidere §2.4** con musica reale (dal 14 ottobre lo scarto è misurato: la [Musical Cognition](musical-cognition.md) confronta ogni `drop` con il rilascio udito, `dropOffset` / `experienceDropsOff` / `experienceDropsUnheard`): se il rilascio cade lontano dal drop, una proposta separata
   sul criterio del rilascio (fine del build + rientro dei bassi), con il Tunnel confrontato prima / dopo.
2. `runTerrainParity()` (GPU ↔ CPU della legge del terreno), come per campi e traccianti.
3. Strutture secondarie del terreno come secondo slot della recipe (guglie istanziate ai bordi della
   valle, con la stessa legge dell'altezza), e spaziatura delle righe a tratti se serve profondità.
4. Terreno come fixture del rig Free, dopo il giudizio a occhio.
5. Anelli del Tunnel dai fronti condivisi (già nel backlog): toglierebbe l'ultima lettura di spettro
   dal suo moto.
6. Portali: [world-transitions](world-transitions.md), solo su autorizzazione.
