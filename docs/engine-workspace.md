# Euforia Engine Workspace

10 ottobre 2026. Refactor della sola interfaccia tecnica sul commit iniziale
`6af452b279738a1ccc33f1f95b4271b036200542`. Spectrum, DSP, wire, WASM, shader,
algoritmi, regia e impostazioni cinematiche non sono modificati.

11 ottobre 2026 (su `dedfa4c`): il workspace è una postazione a **tre colonne** —
navigazione, viewport live, inspector contestuale. Nulla resta sotto il viewport;
vedi [Tre colonne](#tre-colonne-e-inspector-contestuale). Anche questo intervento
tocca solo `diagnostics/workspace/`, i due adattatori DEV (`DebugOverlay`,
`EngineCockpit`) e lo script di verifica.

11 ottobre 2026, sera: la postazione prende l'aspetto del **cockpit** del design system
«Euforia Engine» (token, Geist, pannelli, tile, grafici) e Shift+D diventa la vista
Audio & Analysis a pannelli; vedi [Cockpit](#cockpit-design-system-euforia-engine).
Solo presentazione: nessun file sotto `src/audio/`, `src/world/`, `native/`, `src-tauri/`.

## Uso e accesso

- **Shift+D** apre Audio & Analysis; **Shift+E** apre Laboratories e avvia Structural Lab
  (o il laboratorio già in corso; `?engine=solid` e **Avvia Solid Dynamics** aprono l'altro);
  **Shift+G** apre Diagnostics & Reports. Una scorciatoia diversa cambia vista; quella
  della vista già selezionata chiude tutto. Esc o Chiudi fanno lo stesso.
- La sidebar cambia solo la vista: entrare in Laboratories con un click non avvia
  automaticamente una simulazione. Usare **Avvia Structural Lab** o **Avvia Solid Dynamics**:
  ne gira uno alla volta (ciascuno fissa il mondo del viewport), e avviare l'altro termina il
  primo e ne ripristina il pin. Un laboratorio già attivo resta visibile nel viewport anche
  consultando un'altra sezione.
- **Termina laboratorio / Termina esperimento** ripristina pinning, forma Matter,
  isolamento e override senza chiudere il workspace. I segnali di test cambiano
  l'unico AudioEngine e vengono ripristinati all'uscita; nessuna impostazione salvata.
- REC nell'header o nel pannello controlla lo stesso controller. Il cambio vista non
  interrompe REC, replay, baseline o query GPU. Freeze congela solo il pannello metriche;
  le card e il viewport continuano live. Pausa acquisizione non ferma il motore.
- Overview espone stato reale, clock, DSP, layer e invarianti; gli eventi recenti sono
  nella timeline dell'inspector. Il selettore di dominio permette di approfondire anche
  Physics e Geometry dalle sezioni World e Matter. Detailed abilita gli array del registry.
- `?engine`, `?debug`, `?diagnostics` mantengono gli ingressi; priorità in presenza
  di più parametri: diagnostics, engine, debug. `?matter=` / `?primitives=` aprono
  Audio in DEV e applicano gli esperimenti nello stesso lifecycle.
- La sidebar passa fra 232–262 e 52 px senza cambiare selezione. **Inspector** (header)
  ripiega e riapre la colonna destra; **⤢** la allarga per tabelle, report e grafici a
  due colonne; **Espandi viewport** lascia il solo viewport (non è il fullscreen
  cinematografico). Lo stato delle colonne è mantenuto fino al dispose dell'app, mai
  scritto nello storage. Una scorciatoia (Shift+D/E/G) riporta sempre la postazione
  intera: viewport e inspector della vista richiesta, anche se erano stati ripiegati.
- I blocchi dell'inspector si piegano con un click sul titolo; un blocco piegato non
  viene aggiornato né disegnato.
- Input, textarea, select e contenteditable, anche dentro Shadow DOM, escludono le
  scorciatoie tecniche. I pulsanti mantengono l'attivazione nativa da tastiera.

In **release**, come prima, il pacchetto diagnostico viene caricato solo con
`?diagnostics` o **Ctrl+Alt+Shift+D**. Dopo il caricamento, Shift+G apre/chiude il workspace.
Sono disponibili osservazione, registrazione, query GPU, readback esplicito, replay e report.
Non vengono importati DevelopmentTools, cockpit e grafici DEV; Shift+D/E, selettori
sintetici live, Matter pin, isolamento e azioni strutturali non sono esposti. Il replay
sintetico offline resta distinto dalla cattura live. Il vecchio titolo DEV della dashboard
in release è stato eliminato.

## Cockpit (design system Euforia Engine)

Riferimento: l'artifact «Euforia Engine» (README, `HANDOFF.md`, `tokens.json`, kit `eu-*` e gli
otto mockup 1672 × 941). Di quella consegna sono fatti i passi 1–2 (token, shell, primitive) e,
del passo 4, **Audio & Analysis**; le altre viste hanno la nuova pelle (token, pannelli, tile,
colori dei grafici) ma la struttura di prima. Sostituisce il tema neutro derivato da Sensei
Learning descritto sotto, che resta come storia dell'inventario.

- **Token** (`workspace.css`, sempre sotto `.euforia-workspace`): `--ws-bg` `#070918`, `--ws-panel`
  `#0b0d23`, `--ws-raised` `#11142f`, `--ws-border` `#22254b`, `--ws-accent` `#9b7bff` (violet),
  più `--ws-accent-strong`, `--ws-electric`, `--ws-cyan`, `--ws-magenta`, `--ws-green`,
  `--ws-warning` (amber), `--ws-orange`, `--ws-red`, `--ws-focus`, `--ws-dim`. Raggi 12 / 8 / 6,
  gap fra pannelli 10 px. Carattere Geist (già distribuito con l'app), numeri tabulari.
  `TONE` (`components.ts`) dà gli stessi token al codice; i canvas (`DebugOverlay`, plot del
  registry) usano gli stessi valori come letterali. Shadow DOM e cockpit strutturale ereditano i token.
- **Shell**: barra da 50 px con marchio, chip `WORKSPACE`, tre pill (LIVE/REC · sorgente ·
  stato della cattura: sempre una parola, mai solo un colore) e `REC`, `Inspector`,
  `Diagnostics`, `Chiudi`. Navigazione 232–262 px (52 ripiegata) con le icone del kit e la
  voce attiva a contorno violet + glow. Inspector 430–470 px (largo 560–760).
  `Settings` del mockup non c'è: il workspace non scrive impostazioni.
- **Primitive** (`components.ts`, `charts.ts`, `icons.ts`; DOM vanilla con `h()`): `panel`
  (ripiegabile dall'intestazione) e `fixedPanel`, `tile` (valore + unità + sparkline o barra),
  `meter`, `legend`, `liveBadge`; grafici SVG `sparkline`, `lineChart`, `barChart`,
  `waveChart`. La geometria è in funzioni pure (`tracePoints`, `traceRange`, `barsPath`,
  `wavePoints`), provate in `charts.test.ts`. Gli SVG si stirano con l'host
  (`preserveAspectRatio="none"`, tratto non scalato): nessun canvas da dimensionare, nessun
  testo da misurare, un attributo scritto per grafico a ogni tick.
- **Engine — Live Analytics** (in tutte le viste): le stesse sei misure del registry di prima,
  ora tile con la traccia degli ultimi 10 s. `Unavailable` e `≈` invariati; il tooltip porta
  `method · clock`.
- **Audio & Analysis** (`AudioAnalysis.ts`, solo DEV): Audio Spectrum (barre violet → blue,
  assi in Hz, confini 250 Hz / 2 kHz, Balance L/M/H), Frequency Bands (Bass orange, Low Mid
  amber, Mid green, High Mid blue, Treble violet), Rhythm & Tempo · Onset Analysis · Loudness,
  Spectral Features (Centroid, Flux, Spread, Roll-off), History (10 s), Musical State
  (stato, canzone, noise floor, pace, Variation) e le liste Levels & Beat, Transients &
  Texture, Section Trends, Sonic Roles, Music Context. Sono **le stesse letture** che prima
  stavano sul canvas di `DebugOverlay` (ora solo Experience, World, Matter), più alcune già
  pubblicate che prima comparivano solo in Experience o non comparivano: centroid, spread e
  roll-off, `transient` e `spectralFlux` di `MusicState`, `onsetDensity`, LUFS momentary/short
  e tonalità del frame Rust. Nulla è misurato o deciso nella vista.
- **Sotto il viewport** (`.ws-deck`, 150 px, solo DEV): `Audio Input` (sorgente in uso — in
  sola lettura —, dispositivo, Input Level in dB, forma d'onda) e `Live Input` (BPM, Key,
  Energy, traccia dell'energia). Ha la stessa altezza in tutte le viste: cambiare sezione
  continua a non ridimensionare il renderer. Esce con «Espandi viewport» e nelle finestre
  sotto 860 px di larghezza o 640 px di altezza. È la sola cosa sotto il viewport, e rovescia
  la regola «nulla sotto il viewport» della mattina perché il design la chiede.
- **Tracce**: `Trace` (`charts.ts`) è un anello di 50 campioni, 10 s a 5 Hz, di valori che il
  workspace già mostra: la history di prima (loudness, presence, motion, openness, tension,
  uscita da `DebugOverlay`) con altri canali per sparkline e tile. Presentazione soltanto:
  nessun collector, nessuna sonda nel motore; si azzerano al cambio sessione e continuano a
  essere campionate anche con l'inspector chiuso.
- **Aggiornamento**: un pannello ripiegato o fuori vista (IntersectionObserver per pannello)
  non viene aggiornato; i `meter` scrivono solo quando cambiano i due decimali mostrati, e
  muovono una `transform`, non una larghezza. Resta un layout per tick.

Elementi dei mockup **non costruiti**, perché senza un produttore reale nel repository o
perché modificherebbero il motore (elenco in `HANDOFF.md`): miniature delle scene e «Add
Scene», selettori Log Scale / FFT, zoom del viewport, scelta della sorgente dal cockpit,
`Settings`, health score, Test Run History, A/B, preset di qualità, editor di cue, controlli
di gravità/collisione, strumenti di geometria. L'asse dello spettro è 0…1 (com'è
`AudioFrame.spectrum`), non in dB. Le viste Overview, Experience, World, Matter, Rendering,
Diagnostics e Laboratories non seguono ancora il loro mockup pannello per pannello.

## Riferimento di design e inventario

Letti dal repository corrente [Sensei Learning](https://github.com/lonelyfrank/sensei-learning/tree/master/src):
App.jsx, Sidebar.jsx, NavItem.jsx, TitleBar.jsx, Home.jsx, Progress.jsx, Settings.jsx,
ThemeContext.jsx e index.css. Riferimento: shell verticale, navigazione da 220/52 px,
header da 40 px (qui 48 per i controlli live), spaziature 8/16/28 px, titoli moderati,
card con raggi 8–12 px, bordi discreti, tema Dark `#1a1a1a / #242424 / #2e2e2e`.
Il bulge animato, loghi, asset, dipendenze React e funzionalità di apprendimento non
sono trasferiti. Token `--ws-*` limitati alla shell; tipografia sans, numeri tabulari.

Inventariati App, RenderEngine, Layer, UI, controller/store/types, registry, probes,
replay, i tre pannelli e registerLaboratory/pinning. Tutte le funzionalità originali
sono riusate, con questa distribuzione:

| Origine | Funzionalità | Nuova vista | Componente | Stato |
|---|---|---|---|---|
| Cockpit | Moduli Structures, Resonance, Environment, Diagnostics | Laboratories | EngineCockpit incorporato | Migrato |
| Cockpit | Registro temporaneo, selezione mondo, pinning | Laboratories / viewport condiviso | EngineCockpit | Migrato; ripristina anche il pin precedente |
| Cockpit | Everything, particles, nodes, edges, polygon, surface, fragments | Laboratories | Selettori struttura | Migrato |
| Cockpit | Triangolo, quadrato, pentagono, esagono | Laboratories | Selettore lati | Migrato |
| Cockpit | Coherence, temperature, fracture, bond, resonance/environment coupling, reset | Laboratories | Inspector Experiment | Migrato; numero override attive |
| Cockpit | Seed, Form, Strike, Scatter | Laboratories | Azioni strutturali | Migrato |
| Cockpit | Ruoli, lifecycle, legami, frammenti, energia, costi, riparazioni | Laboratories | Inspector Observation | Migrato, celle DOM riusate |
| Cockpit | Barre macro/meso/micro, campi, topologia | Laboratories | Resonance / Environment | Migrato |
| Cockpit | Sei tracce strutturali, contatori rendering | Laboratories | Grafico e Diagnostics | Migrato a 5 Hz, 30 s limitati |
| Cockpit | Link Input/Analysis/World/Matter/Geometry/Recipes/Render | Sidebar e dominio Geometry | EngineWorkspace / registry | Sostituiti da navigazione reale |
| Tutti | Segnali sintetici, ritorno alla sorgente live | Audio, Experience, World, Matter, Laboratories | DevelopmentTools | Unificato, temporaneo |
| Debug | Bande, livelli, beat, transienti, texture, spectrum e bilanci | Audio | DebugOverlay incorporato | Migrato; waveform letta da AudioFrame aggiunta |
| Debug | Ruoli sonori, contesto musicale, trend e history | Audio | Grafici e registry | Migrato, history 10 s a 5 Hz |
| Debug | Regia, modulazione, Dynamics, cue, Show log e slot | Experience | Grafici esistenti | Migrato |
| Debug | Rust analysis, confidence, tonalità, tempo, trasporto, latenze | Audio registry / Experience approfondimento | Registry e grafici | Migrato |
| Debug | Memoria, prediction, planner, intenti, eventi e acoustic ERB | Experience | Grafici / registry / timeline | Migrato |
| Debug | World, forze e adattatore | World | Grafici / registry World e Physics | Migrato |
| Debug | Morfologia, VisualMaterial, forme e contatori materia | Matter | Grafici / registry | Migrato |
| Debug | Geometry traits, recipe, primitive, campi, budget | Matter / dominio Geometry | Grafici / registry | Migrato |
| Debug | Pin auto/particles/wave/harmonic, query primitive | Matter / controlli Experiment | DevelopmentTools | Migrato; ripristino all'uscita |
| Debug | Shift+T CSV WorldTrace | Tutte le viste DEV aperte | Shortcut controller | Migrato; richiede REC come prima |
| Dashboard | Otto domini, gruppi per sorgente, unità, timestamp, metodo, unavailable/estimated | Tutte / Diagnostics | DiagnosticsDashboard incorporata | Migrato |
| Dashboard | REC, pausa, freeze, reset, Detailed 10 Hz | Tutte | Stesso DiagnosticsController | Migrato |
| Dashboard | Query GPU opt-in, supporto estensione, readback materia 1 Hz | Tutte | Probes originali | Migrato |
| Dashboard | Isolamento primitive e reset | Inspector DEV | Stesso controller | Migrato; non esposto in release |
| Dashboard | Parità Matter/Tracer e download | Inspector DEV | Adattatore al renderer esistente | Migrato; nessun secondo renderer |
| Dashboard | Plot storico, sezione flowAt, timeline ultimi 15 eventi | Tutte | Grafici originali | Migrato; nessuna nuova FFT |
| Dashboard | Replay scenario, FPS, batch, start/pause/stop | Diagnostics | Worker originale | Migrato; continua cambiando vista |
| Dashboard | Baseline in memoria/import JSON, compare, ritorno live | Diagnostics | Report state originale | Migrato |
| Dashboard | Export JSON/CSV/Markdown e log/errori/progresso | Diagnostics | ReportExporter originale | Migrato, schema 1 invariato |

## Tre colonne e inspector contestuale

```text
┌ header 50 px: Euforia Engine · LIVE · sorgente · stato · REC · Inspector · Diagnostics · Chiudi ┐
├ nav 232–262/52 px ┬ viewport: titolo + stage originale ┬ inspector 430–470 px (⇄ 560–760) ┤
│ 8 sezioni         │ deck 150 px (solo DEV)             │ scroll proprio                    │
└───────────────────┴────────────────────────────────────┴───────────────────────────────────┘
```

| Nodo | Proprietario | Colonna | Note |
|---|---|---|---|
| `.ws-sidebar` | EngineWorkspace | sinistra | Navigazione invariata, un solo routing (`select`) |
| `.ws-heading`, `.ws-preview` (stage + etichetta scena · buffer) | EngineWorkspace | centro | `flex:1`: nessuna altezza fissa, non scorre |
| `.ws-deck` (Audio Input, Live Input) | EngineWorkspace → AudioAnalysis | centro, sotto il viewport | 150 px in ogni vista, solo DEV |
| Pannello `Engine — Live Analytics` | EngineWorkspace | inspector | Sei misure del registry con traccia a 10 s, in tutte le viste |
| Pannelli Audio & Analysis (`.ws-audio`) | DevelopmentTools → AudioAnalysis | inspector | Solo in Audio; DOM + SVG, nessun canvas |
| `Engine overview` | Overview | inspector | Solo in Overview |
| Grafici della vista (`.ws-debug`, un canvas) | DevelopmentTools → DebugOverlay | inspector | Experience, World, Matter; stesso canvas, blocco rinominato |
| `Experiment` (segnale, forma Matter, avvio/termine lab) | DevelopmentTools | inspector | Viste con grafici e Laboratories |
| Structural Lab (`.ws-lab-grid`: moduli, ispettore, tracce) | DevelopmentTools → EngineCockpit | inspector | Impilati; affiancati con inspector largo |
| Solid Dynamics (`.ws-lab-grid.ws-solid`: sette pannelli) | DevelopmentTools → SolidCockpit | inspector | Stessi `panel` / `tile` / `meter` / grafici SVG del cockpit; a coppie con inspector largo ([solid-dynamics](solid-dynamics.md) §10) |
| Registry, controlli, replay, report, timeline (shadow DOM) | DiagnosticsDashboard | inspector | Dominio della vista; replay e report solo in Diagnostics |

Contenuto per vista: **Audio** (Shift+D) livelli, bande, beat/onset, bilancio, spettro,
waveform, history, ruoli e contesto, poi registry audio (cattura, pipeline DSP, clock,
latenze) ed eventi; **Experience** regia, modulazione, analisi Rust, timing, Dynamics,
show, snapshot Experience (memoria, previsione, piano, intenti, eventi), ERB;
**World** energia, campi, forze, adattatore, registry World/Physics; **Matter** morfologia,
materiale, scena, primitive, campi, registry Matter/Geometry; **Rendering** card e registry
render (pacing, CPU, GPU dove misurabile, draw call, memoria, layer, qualità);
**Laboratories** (Shift+E) Experiment, cockpit strutturale, registry Matter;
**Diagnostics** (Shift+G) registry, REC/pausa/freeze, query GPU, replay, baseline,
compare, import/export. Sono le stesse misure di prima: nessun dato nuovo o simulato;
ciò che non è leggibile resta `Unavailable`.

Larghezze: le colonne cambiano **a scatti**, mai con una transizione (un'animazione di
larghezza ridimensionerebbe i target a ogni frame). Sotto 1100 px la navigazione si
riduce alle icone; sotto 860 px l'inspector si sovrappone al viewport invece di
comprimerlo, e si ripiega con lo stesso pulsante senza ridimensionare il renderer.
`nextLayout` (`components.ts`) è l'unica funzione che decide l'effetto di ogni comando.

Grafici (Experience, World, Matter; Audio ha i suoi pannelli, vedi Cockpit): `DebugOverlay` non è più un canvas fisso da 636 px. È largo quanto il suo
host in pixel CSS (larghezza letta dal suo ResizeObserver, mai dal layout durante il
disegno); le letture scorrono su quante righe servono (`packRows`) e le coppie di
barre stanno su una colonna, o due con inspector largo (`columnsFor`, soglia 520 px).
Il canvas cresce fino all'altezza che la vista richiede a quella larghezza e non si
restringe sotto una riga andata a capo. Le letture sono quelle di prima, nello stesso
ordine per blocco. La history (10 s a 5 Hz) è ora di `AudioAnalysis`, campionata a ogni
tick anche quando nulla è disegnato (`sample` distinto da `refresh`).

## Architettura e lifecycle

```mermaid
flowchart TD
  App -->|lazy| Install[installDiagnostics]
  Install --> Controller[DiagnosticsController unico]
  Install --> Workspace[EngineWorkspace: navigazione e lifecycle]
  Workspace --> Stage[app-stage originale nel viewport]
  Workspace --> Overview
  Workspace --> Dashboard[DiagnosticsDashboard: registry, replay, report]
  Workspace -->|solo DEV| Tools[DevelopmentTools]
  Tools --> Debug[Grafici Audio / Experience / World / Matter]
  Tools --> Lab[EngineCockpit: inspector strutturali]
  Controller --> Probes[RendererProbe / PresentationProbe / EngineProbes]
  Stage --> Renderer[RenderEngine e WebGLRenderer originali]
  Renderer --> Probes
```

All'apertura un commento segnaposto conserva la posizione DOM della stage; la stessa
stage viene montata nel viewport, senza cloni del canvas. Il ResizeObserver già del
RenderEngine vede le dimensioni del suo stesso container e aggiorna target, camera,
view offset e composer col percorso originale, che scarta dimensioni identiche.
I cambi modulo non muovono la stage e non chiamano pinScene. Cambiano il layout solo
sidebar, inspector (aperto/chiuso/largo), viewport espanso e la finestra: un resize
del renderer per ciascun passo, nessuno fra un passo e l'altro (verificato contando le
chiamate). Nessuna animazione di width che ridimensioni i target a ogni frame. Le sovrapposizioni cinematiche sono nascoste
soltanto sotto `.ws-preview`, senza cambiare i loro stili o impostazioni globali.

Alla chiusura: timer cancellato, grafici/observer disconnessi, worker replay terminato,
lab ritirato, override ripristinate, lease diagnostici rilasciati, stage rimessa al
segnaposto e focus restituito. Anche il DOM dei pannelli viene sganciato, evitando
che un riferimento al contenitore chiuso trattenga controlli e report. Il solo
listener di routing resta fino al dispose dell'app; non campiona nulla a workspace
chiuso. `installDiagnostics` protegge anche la risoluzione tardiva dell'import DEV.

Il controller mantiene un lease del workspace oltre a quelli degli adattatori:
nessun intervallo senza osservatore quando si cambia vista, nessuna ricreazione del
registry e nessuna interruzione della registrazione. Un unico timer UI **5 Hz** aggiorna
card e pannelli. A ogni tick vengono disegnati prima i canvas, poi scritto il DOM: il
testo su canvas risolve lo stile del suo elemento, e dopo le scritture sarebbe un
passaggio di stile (e, dentro un container query, di layout) a metà refresh — per
questo l'inspector largo è una regola sull'attributo della shell e non un
`@container`. Risultato: un layout per tick in ogni vista. Con l'inspector chiuso o
il viewport espanso card, Overview, grafici e dashboard non vengono aggiornati. Il motore conserva il suo RAF originale. Detailed riguarda la raccolta
10 Hz, non il disegno DOM. Buffer limitati: controller 120 campioni, eventi 256, timeline
15, debug 10 s, struttura 30 s. Le history UI si azzerano al cambio sessione.

I grafici debug sono montati alla prima visita utile e sospesi nelle altre sezioni
(o fuori vista tramite IntersectionObserver); i controlli strutturali si montano
solo avviando il lab. La dashboard conserva le righe metriche anche tornando a un dominio già visitato
(cache DOM limitata agli otto domini, sempre riferita agli oggetti dello stesso registry), il confronto prima
scrittura, IntersectionObserver e containment per riga. Le miniature sono grafici
2D; il solo canvas WebGL è quello originale.

Parità Matter/Tracer conserva gli scenari numerici originali, con un parametro
opzionale per usare il renderer dell'app e senza disporlo. Sono prove esplicite e
sincrone, fuori dal frame loop, con simulazione **di test** transitoria e readback:
non sono misure dell'overhead live e non vanno avviate durante un benchmark. Il
comando diretto `runParity()` / `runTracerParity()` da console mantiene il vecchio
comportamento standalone. Nessuna legge di simulazione modificata.

## Verifiche e riproduzione

`npm run check` include le regressioni di routing tastiera. I test browser sono
separati dai mock, usano il renderer reale e il segnale sintetico live:

```sh
npm run dev
# Playwright è uno strumento esterno, non una nuova dipendenza di produzione.
PLAYWRIGHT_MODULE=/percorso/playwright-core/index.mjs \
CHROMIUM_PATH=/percorso/chrome node scripts/workspace-browser.mjs
```

Il test verifica la postazione a tre colonne su Shift+D (ordine e larghezze delle
colonne, viewport ≥ 70% dell'altezza utile sopra il solo deck da 150 px, tile/pannelli
audio/registry nell'inspector, pannelli in vista senza scorrere, spettro e forma d'onda
disegnati dal frame live e diversi un secondo dopo, sorgente in uso, Geist caricato, liste
di livelli su due colonne nell'inspector largo, grafici canvas di Experience/World/Matter
alla dimensione mostrata, nessun overflow orizzontale), inspector ripiegato/largo/viewport solo con nodi, scroll
e larghezza conservati, un resize del renderer per passo e zero cambiando sezione,
sovrapposizione sotto 860 px, risorse GPU (`renderer.info`), sessione audio, mondo e
scena invariati dopo sei riaperture; inoltre: shortcut/toggle, canvas e renderer identici, REC fra sezioni,
freeze/pausa, import baseline, compare, export nei tre formati, select in Shadow DOM,
formazione/override del lab, uscita e pinning, replay attraverso i cambi vista,
resize a 1024×768 / 1400×900 / 1920×1080, sidebar, sei riaperture, ripristino del
controller e del DOM cinematografico. I report vengono salvati in `/tmp` o nel
percorso indicato da `WORKSPACE_OUTPUT`.

Per l'overhead usare `WORKSPACE_MODE=after`; per la versione precedente servita a
un'altra porta usare `WORKSPACE_MODE=before WORKSPACE_URL=http://127.0.0.1:1422`.
Lo script fissa il container render a **960×540 CSS px** (buffer effettivo **480×270**
con il profilo Low corrente), qualità Low, Spectrum,
segnale beat124, finestra 1400×900, attesa 2 s e campione 6 s per caso. I casi lab
usano Structural Lab e devono essere confrontati soltanto fra loro. CPU da CDP
(TaskDuration/ScriptDuration), intervalli da un osservatore RAF esterno al prodotto,
heap JS da CDP. L'osservatore del benchmark è identico nei due casi.

Risultati e limiti delle prove della sessione sono riportati sotto; non sono una
certificazione di performance su ogni WebView o hardware. Non eseguiti cattura
microfono/system reale, ascolto su musica reale o app Tauri. Le dipendenze native
sono verificate separatamente; il browser non prova il routing audio desktop.

## Risultati · cockpit (11 ottobre 2026, sera)

Stesso host e stesso metodo della tabella sotto (Chromium headless, WebGL2 reale, container
960×540, Low, Spectrum, beat124, 2 s + 6 s per caso), **un solo run** su questo albero,
macchina non isolata: vale come controllo di regressione, non come confronto.

| Vista | p95 / p99 ms | Jank >25 ms | CPU ms/s | Layout / 6 s |
|---|---:|---:|---:|---:|
| closed (controllo) | 16.67 / 16.67 | 0 | 110 | 0 |
| overview | 16.67 / 16.67 | 0 | 133 | 30 |
| audio | 16.67 / 16.67 | 0 | 163 | 30 |
| audio, liste di livelli in vista | 16.67 / 16.67 | 0 | 159 | 30 |
| diagnostics | 16.67 / 16.67 | 0 | 102 | 30 |
| REC | 16.67 / 16.67 | 0 | 96 | 30 |
| laboratories | 16.67 / 16.67 | 0 | 139 | 30 |
| lab con override | 16.67 / 16.67 | 0 | 136 | 30 |
| 30 cambi sezione in 6 s | 16.67 / 16.67 | 0 | 246 | 97 |

Un layout per tick in ogni vista, pacing invariato. Audio è ora la vista stabile più cara:
circa +50 ms/s sul controllo chiuso (5% di un core), dove il canvas della mattina stava
nella banda di rumore del controllo (105–177 ms/s). Il tempo di script è quello del
controllo (78 contro 73 ms/s): la differenza è stile, layout e paint di pannelli e SVG.
Non è stata ripetuta né alternata con l'albero precedente, quindi è un'indicazione.
Dopo chiusura e GC: 18,2 MiB e 298 nodi (243 all'avvio di quel run): i nodi in più sono le
icone SVG dei pulsanti che il workspace conserva fra un'apertura e l'altra; observer e
intervalli tornano ai valori iniziali (asserito dal test di accettazione).

- `VITEST_MAX_WORKERS=2 npm run check`: typecheck, ESLint, **511 pass, 1 skip preesistente,
  64 file**, build di produzione. Nuove regressioni in `charts.test.ts` (ordine dell'anello, tracce che si riempiono, clamp, barre, forma d'onda).
- Browser DEV, WebGL reale: accettazione completa sul codice finale, nessun errore JS.
- Browser release (`vite build` + `vite preview`): nulla caricato finché non richiesto, Shift+D
  inerte, Ctrl+Alt+Shift+D apre il cockpit su Diagnostics senza deck, pannelli audio né
  Laboratories (sette voci), viewport a tutta altezza, Esc chiude, Shift+G riapre e richiude.
- Schermate guardate: Audio a 1672×941 (anche scorrendo l'inspector), 1400×900 (anche
  inspector largo), 1280×720 con navigazione ripiegata, 1024×768; le altre sette viste a
  1672×941. **Non eseguiti**: app Tauri / WebKitGTK (il layout usa grid, flex, media query,
  SVG inline e `scrollbar-gutter`), cattura system reale, musica reale, Windows/WebView2,
  confronto pixel per pixel con i mockup, schermi ad alta densità, modalità parità.

## Risultati · tre colonne (11 ottobre 2026)

Stesso host, limite di potenza 51 W, macchina non isolata; Chromium headless con
contesto WebGL2 reale (ANGLE GL/EGL). Dati: [engine-workspace-inspector-benchmark.json](engine-workspace-inspector-benchmark.json).
Stesso script (`after`) contro `dedfa4c` e contro questo albero, serviti in parallelo,
run alternati; container di render fissato a 960×540 CSS px (buffer 480×270), Low,
Spectrum, beat124. CPU = attività del main thread in ms/s per ciascun run.

| Vista | Prima · p95 / p99 ms | Prima · CPU ms/s | Prima · layout / 6 s | Dopo · p95 / p99 ms | Dopo · CPU ms/s | Dopo · layout / 6 s |
|---|---:|---:|---:|---:|---:|---:|
| closed (controllo) | 16.67 / 16.67 | 105 · 177 · 108 | 0 | 16.67 / 16.67 | 109 · 158 | 0 |
| overview | 16.67 / 16.67 | 111 · 155 · 114 | 27 | 16.67 / 16.67 | 119 · 140 | 27 |
| audio | 16.67 / 16.67 | 121 · 114 · 115 | 30 | 16.67 / 16.67 | 111 · 125 | 27 |
| audio, grafici in vista | 16.67 / 16.67 | 117 · 108 · 109 | 30 | 16.67 / 16.67 | 125 · 115 | 28 |
| diagnostics | 16.67 / 16.67 | 123 · 102 · 100 | 28 | 16.67 / 16.67 | 135 · 109 | 28 |
| REC | 16.67 / 16.67 | 118 · 107 · 100 | 28 | 16.67 / 16.67 | 124 · 115 | 28 |
| laboratories | 16.67 / 16.67 | 176 · 159 · 149 | 60 | 16.67 / 16.67 | 178 · 172 | 30 |
| lab con override | 16.67 / 16.67 | 152 · 140 · 121 | 60 | 16.67 / 16.67 | 169 · 165 | 30 |
| 30 cambi sezione in 6 s | 16.67 / 16.67 | 283 · 255 · 243 | 77 | 16.67 / 16.67 | 301 · 295 | 66–77 |

Lettura onesta: il pacing dei frame è identico (un solo run «dopo» ha due frame oltre
25 ms durante i 30 cambi, 0,8%). Il controllo a workspace chiuso, che è lo stesso
codice nei due alberi, oscilla fra 105 e 177 ms/s: differenze di CPU sotto quella
banda non sono attribuibili. Dove c'è una tendenza (diagnostics, REC, laboratorio:
+10…30 ms/s, 1–3% di un core) è coerente con il fatto che ora registry e tabelle sono
in vista accanto alla scena invece che sotto la piega, quindi vengono scritti e
dipinti. I layout sono uno per tick ovunque; nel laboratorio si sono dimezzati
(le larghezze dei canvas vengono lette prima delle scritture). Dopo chiusura e GC:
18,4 MiB e 255 nodi (prima 18,4 MiB e 306), observer e intervalli ai valori iniziali.
Una prima versione usava un container query per l'inspector largo e mostrava ~1,7
layout per tick nelle viste con grafici: misurata, spiegata e rimossa (vedi Architettura).

Verifiche di questo intervento:

- `VITEST_MAX_WORKERS=2 npm run check`: typecheck, ESLint, **505 pass, 1 skip
  preesistente, 63 file**, build di produzione. Nuove regressioni: riduttore delle
  colonne (`components.test.ts`) e layout dei grafici (`chartLayout.test.ts`).
- Browser DEV, WebGL reale: accettazione completa (23 controlli, nessun errore JS),
  eseguita sul codice finale. Parità sul renderer condiviso ripetuta: Matter medio
  2,426·10⁻⁵ / massimo 1,146·10⁻⁴, Tracer 1,066·10⁻⁵ / 1,459·10⁻⁴, un solo contesto WebGL.
- Browser release (`vite build` + `vite preview`): nulla caricato finché non richiesto,
  Ctrl+Alt+Shift+D apre le tre colonne su Diagnostics, nessun controllo DEV, Shift+D/E
  inerti, Shift+G ed Esc chiudono e riaprono, un solo canvas WebGL prima e dopo.
- `pkg-config --exists webkit2gtk-4.1 alsa`: riuscito. **Non eseguiti**: app Tauri /
  WebKitGTK (il layout usa solo grid, flex e media query), cattura system reale,
  musica reale, Windows/WebView2, soak di ore, schermi ad alta densità. Il core Rust
  non è toccato e i suoi test non sono stati ripetuti.
- Schermate guardate: tutte le otto viste a 1400×900, Audio anche a 1024×768, 800×700
  e 1920×1080, inspector largo in Audio e Laboratories. Le altre combinazioni sono
  coperte solo dai controlli geometrici dello script.

## Risultati della sessione del 10 ottobre (layout precedente, a colonna unica)

Host Fedora 44, i7-10510U; Chromium headless con contesto WebGL2 effettivo, non mock.
Dati integrali e metodo: [engine-workspace-benchmark.json](engine-workspace-benchmark.json).
CPU indica millisecondi di attività del main thread per secondo; heap è JS in MiB.
Il costo DSP del worker e la memoria driver/GPU non sono inclusi.

| Versione / vista | Frame medio ms | p95 ms | p99 ms | Jank >25 ms | CPU ms/s | Heap MiB |
|---|---:|---:|---:|---:|---:|---:|
| Prima · closed | 16.76 | 16.67 | 16.67 | 0.56% | 150.9 | 20.8 |
| Prima · audio-legacy | 17.91 | 33.33 | 33.33 | 7.46% | 557.7 | 22.3 |
| Prima · diagnostics-legacy | 17.59 | 16.67 | 33.33 | 4.99% | 342.2 | 17.8 |
| Prima · lab-legacy | 16.85 | 16.67 | 33.33 | 1.13% | 343.6 | 22.6 |
| Workspace · closed | 16.67 | 16.67 | 16.67 | 0.00% | 158.7 | 20.9 |
| Workspace · overview | 16.67 | 16.67 | 16.67 | 0.00% | 130.0 | 20.9 |
| Workspace · audio | 16.67 | 16.67 | 16.67 | 0.00% | 119.1 | 25.7 |
| Workspace · audio-charts-visible | 16.67 | 16.67 | 16.67 | 0.00% | 106.8 | 19.3 |
| Workspace · diagnostics | 16.67 | 16.67 | 16.67 | 0.00% | 109.3 | 18.8 |
| Workspace · diagnostics-collapsed | 16.67 | 16.67 | 16.67 | 0.00% | 111.8 | 18.8 |
| Workspace · REC | 16.67 | 16.67 | 16.67 | 0.00% | 111.6 | 20.5 |
| Workspace · laboratories | 16.67 | 16.67 | 16.67 | 0.00% | 179.6 | 20.7 |
| Workspace · lab-override | 16.67 | 16.67 | 16.67 | 0.00% | 136.8 | 24.3 |
| Workspace · rapid-navigation | 16.67 | 16.67 | 16.67 | 0.00% | 247.8 | 22.2 |
| Workspace · closed-again | 16.67 | 16.67 | 16.67 | 0.00% | 88.1 | 22.5 |

Le viste stabili e il burst di 30 cambi hanno mantenuto p95/p99 ≈16,67 ms nel run
finale. Una prova intermedia, prima del riuso delle righe per dominio, aveva rilevato
p95 33,33 / p99 50 ms durante quel burst: è stata la ragione dell'ottimizzazione,
non una modifica al frame loop. Non si deduce un guadagno percentuale affidabile
dai tempi CPU: anche la baseline chiusa cambia durante warm-up e carico macchina.
Servono run alternati più lunghi e hardware isolato per una stima causale dell'overhead;
non si dichiarano prestazioni a 1080p, High, WebView o con cattura reale.

Dopo la chiusura e GC esplicita: **17,86 MiB**, **228 nodi** (221 all'inizio): uno snapshot di heap/DOM dopo aver visitato
moduli e scene aggiuntivi, non una prova assoluta di assenza di leak. Nel test di accettazione
i contatori di observer e intervalli tornano esattamente ai valori iniziali, anche
dopo sei riaperture. I due observer e due intervalli rimasti erano già presenti prima dell'apertura;
il workspace non conserva timer. La misura
di heap e i contatori non sostituiscono un soak test di molte ore.

Verifiche eseguite:

- `VITEST_MAX_WORKERS=2 npm run check`: **498 pass, 1 skip preesistente, 62 file**;
  typecheck, ESLint e build di produzione. Il parallelismo predefinito aveva causato
  un timeout AnalysisHost e, in un'altra prova, il superamento del limite sintetico
  di carico DSP a 96 kHz (0,699 contro 0,5). Ridotta solo la concorrenza del runner:
  nessuna soglia, timeout o logica DSP modificata.
- Core Rust offline: **66 test + 1 doctest**, tutti riusciti; nessuna modifica DSP/WASM.
- Browser DEV: routing e toggle, input Shadow DOM, canvas/renderer/scena conservati,
  stesso nodo metrico tornando al dominio, REC, freeze/pausa, baseline, export,
  replay, laboratorio, pinning e override, tre dimensioni desktop, collapse,
  riaperture e rilascio observer/intervalli. Nessun errore JS.
- Browser release: caricamento lazy, assenza controlli DEV, Shift+D/E inattive,
  Shift+G riapre dopo il primo accesso, un solo canvas.
- Parità sul renderer condiviso: Matter errore medio **2,426·10⁻⁵**, massimo
  **1,146·10⁻⁴**; Tracer medio **1,066·10⁻⁵**, massimo **1,459·10⁻⁴**. Entrambe passano
  la soglia originale 10⁻³; durante entrambe viene creato **un solo contesto WebGL**.
- `pkg-config --exists webkit2gtk-4.1 alsa`: riuscito nella verifica corrente.
  Non avviata l'app Tauri; nessuna nuova prova system/microfono reale o musica reale.
- `git diff --check`: pulito. Nessun commit o push.
