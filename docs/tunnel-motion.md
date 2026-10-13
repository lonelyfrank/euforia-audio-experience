# Tunnel Motion Coordinator — Balanced

Data: 11 ottobre 2026. La scena Tunnel resta quella descritta in
[physical-scenes](physical-scenes.md): una vista del mondo condiviso, la cui architettura
(`tunnelTopology`) è una funzione pura di `WorldView`. Il coordinatore non la sostituisce: decide
**quanto di ciascuna trasformazione si vede adesso**.

> Ogni trasformazione del Tunnel risponde al mondo per conto suo, e da sola è giusta. Insieme, tutte
> al massimo, non si leggono più. Coordinare non è togliere.

```text
WorldView, VisualResponse, MusicContext, ModulationState
        │
        ▼
TunnelVisualizer.update      ogni target, dal mondo com'è (il Tunnel com'era: nulla è cambiato qui)
        │  raw: TunnelMotion + tunnelTopology
        ▼
TunnelMotionCoordinator.step  A · moto primario     continuo: seguito, mai trattenuto da B o C
                              B · risposta secondaria  i medi e la forma seguono, e cedono a C
                              C · eventi speciali    la parete si apre solo se il mondo tira davvero
        │  motion, topology                           o un evento spicca; uno alla volta
        ▼
uniform degli shader esistenti   (nessuno shader, nessuna geometria, nessun pass in più)
```

## 1. Moduli

| File | Ruolo |
|---|---|
| `src/visualizers/tunnel/motion.ts` | **nuovo**: `TunnelMotionCoordinator`, `TunnelMotion` (i target di un frame), `tunnelLab` (interruttore DEV) |
| `…/tunnel/topology.ts` | la legge dell'architettura esposta con ingressi espliciti (`architecture`, `crackOf`); `tunnelTopology` è la stessa legge sul mondo com'è, e dà gli stessi numeri |
| `…/tunnel/TunnelVisualizer.ts` | calcola i target come prima, li passa al coordinatore, scrive gli uniform |
| `…/tunnel/preset.json` | `balance: 1` (versione 4) |
| `visualizers/regimes.test.ts`, `grammar.test.ts`, `bench/response.bench.test.ts` | test e benchmark |
| `visualizers/shared/motion.ts` | dal 13 ottobre: `RateFollower`, `HysteresisGate`, `AccentGate`, `follow`. Sono i follower, il cancello e gli accenti di questo coordinatore, estratti perché li usa anche Generative Terrain; i tre livelli, le quote di cessione e tutte le costanti restano in `motion.ts` |
| `…/tunnel/preservation.test.ts` | digest di ogni numero del coordinatore e della scena su una sessione di 30 s, registrati prima dell'estrazione: il Tunnel è identico bit per bit ([music-response](music-response.md) §6, §11) |

Non c'è una seconda simulazione del Tunnel, nessuna scena nuova, nessun planner, nessun bus: gli
accenti leggono lo stesso `EventStream` di tutti, con un `EventCursor`.

## 2. Balanced e Legacy

`TunnelParams.balance` (0 … 1, nel preset: 1). A 0 la scena **non chiama il coordinatore**: gli
uniform sono quelli di prima, con le stesse espressioni (i test della scena «com'era» girano così e
passano invariati). Fra 0 e 1 ciò che si vede sta fra i due. In sviluppo `tunnelLab.balance`
sostituisce quello del preset: **Experiment Controls → Tunnel: preset / Balanced / com'era**, per
confrontare sullo stesso suono; torna al preset uscendo dagli strumenti. La UI cinematica non è
toccata.

## 3. I tre livelli

### A — Moto primario

| Che cosa | Legge |
|---|---|
| avanzamento | la velocità del mondo, seguita su 0,2 s; il viaggio del frame è l'**integrale esatto** di quella risposta, quindi la distanza percorsa è quella del mondo |
| rotazione (roll, fase della sezione) | idem, 0,3 s |
| campo visivo | seguito su 0,6 s |

Un kick dà al mondo un salto di velocità: il Tunnel ora lo prende come uno slancio. Nulla di A cede
a B o a C: l'avanzamento resta dominante. Nessun moto proprio: senza mondo che si muove, non si
muove.

### B — Risposta secondaria

Un registro, un tipo di moto.

| Registro | Che cosa muove | In Balanced |
|---|---|---|
| bassi | pressione sul raggio, anelli mandati giù per il Tunnel | **intatti** (il raggio solo tenuto fra 0,7 e 1,4 × quello del corridoio) |
| bassi | profondità della sezione | seguita su 0,2 s; cede a C fino al 35 % |
| bassi (nota) | numero di lobi della sezione | seguito su 1,2 s: segue le note senza sfarfallare con loro |
| medi | torsione | seguita su 0,6 s, entro ± 0,028 giri per unità; cede a C fino al 60 % |
| medi | curvatura | seguita su 0,8 s; cede fino al 50 % |
| medi | ovale della sezione, linee del lead | seguiti su 0,2 s; l'ovale cede fino al 50 % |
| medi (nota) | cicli delle linee del lead | seguiti su 1,2 s |
| alti | griglia fine, corrugazione, scintille | **intatti** |
| — | luce della parete | **intatta** |
| — | campo modale nella parete (waveguide) | cede fino al 40 % |

### C — Eventi speciali

Ciò che la parete legge del mondo (tensione 0,3 s, disordine 0,5 s, rotazione 0,5 s) entra nella
**stessa legge** dell'architettura, con tre differenze:

| | Com'era | Balanced |
|---|---|---|
| apertura della parete | continua con tensione e disordine: una tensione che oscilla apre e chiude la parete con sé | **cancello con isteresi**: si apre quando la spinta a rompersi passa 0,30, si richiude solo sotto 0,12; 0,6 s per aprirsi, 1,4 s per chiudersi |
| impatti | ogni impatto forte tiene aperti gli anelli per 0,35 s | solo un evento che **spicca** (`significance` ≥ 0,7), non prima di 2 s dal precedente; dura 0,5 s; nessuno accanto a un rilascio che sta passando |
| verso degli anelli | il segno della rotazione, di colpo | passa per lo zero (`spin / (|spin| + 0,12)`) |

Il rilascio (fronte, forza, struttura che lascia: `Reorganization`) è un fatto del mondo e non è
coordinato: la topologia continua a reagire agli eventi musicali come prima.

## 4. Motion budget

Non una somma tenuta costante: una priorità.

```text
occupancy = unit(0,9 · max(gap anelli / 0,36, gap pannelli / 0,28, lift / 0,2) + 0,5 · rilascio)
```

Mentre C occupa il quadro, le parti invasive di B cedono in proporzione (tabella sopra) e il roll
della camera fino al 50 %. I bassi tengono tutta la loro risposta, l'avanzamento non è toccato, e
nulla è mai azzerato. L'attenuazione usa l'occupazione di metà frame, così il quadro è lo stesso a
ogni frame rate.

## 5. Continuità e stato

Lo stato del coordinatore è una dozzina di scalari: i follower, il cancello, l'età dell'ultimo
accento. Ogni follower è la risposta **esatta** a un ingresso tenuto per il frame; il cancello è una
rampa; gli accenti sono età di eventi datati sul clock audio. Quindi:

- stesso quadro a 30, 60, 120 e 144 fps (entro 3 ‰ di ogni uniform; il Tunnel com'era: 1 ‰);
- in un mondo a riposo tutto decade e **si ferma** (un follower a meno di 10⁻⁵ dal proprio obiettivo
  è arrivato): dopo 30 s gap, forma, torsione e rilascio sono < 10⁻⁶, e non si muovono più;
- senza clock, o in una nuova sessione, ciò che si stava seguendo è lasciato subito: il corridoio;
- una scena montata durante una dissolvenza prende al primo frame il moto del mondo così com'è;
- nessuna rotazione si accumula senza limite (torsione limitata, roll = seno di una fase).

## 6. Misure

### Su GPU reale

Chromium headless, ANGLE su Intel UHD (CML GT2), 1280 × 720, Low, segnale `buildDrop`, 36 s, lo
stesso segnale riavviato per ogni corsa, due corse alternate per modo (le due coppie coincidono
entro il 2 %):

| | Com'era | Balanced |
|---|---:|---:|
| FPS · frame p50 / p95 / p99 | 60,0 · 16,7 / 16,7 / 16,7 ms | 60,0 · 16,7 / 16,7 / 16,7 ms |
| frame oltre 33 ms | 0 | 0 |
| distanza percorsa | 117,1 | 116,3 (−0,7 %) |
| velocità: variazione media al secondo · inversioni al secondo | 6,33 · 12,4 | 0,66 · 0 |
| torsione: variazione · inversioni | 0,0099 · 23,8 | 0,0016 · 1,35 |
| curvatura: variazione · inversioni · massimo | 0,247 · 5,9 · 1,86 | 0,109 · 0,28 · 1,48 |
| apertura degli anelli: variazione · inversioni | 0,090 · 12,1 | 0,018 · 0,19 |
| pannelli che si staccano (lift): inversioni | 5,4 | 0,14 |
| verso degli anelli (shear): inversioni | 2,2 | 0,14 |
| lobi della sezione: variazione · inversioni | 1,6–2,0 · 5,7–8,9 | 0,39–0,44 · 0,33 |
| **anelli dei bassi** (`uRing`): variazione · inversioni | 0,144 · 18,7 | 0,143 · 18,7 |

L'avanzamento è lo stesso, la risposta dei bassi è la stessa, e ciò che cambiava forma dieci-venti
volte al secondo ora lo fa meno di una volta. Nessun errore né warning degli shader.

### Costo

`bench/response.bench.test.ts`: 1,59 µs per frame (p50; p99 2,3) contro 0,40 µs per i soli target e
la legge dell'architettura: il coordinatore aggiunge **≈ 1,2 µs per frame** di CPU. Nessuna
allocazione, nessun draw call, nessun buffer.

## 7. Verifica

`regimes.test.ts`, 9 test nuovi (più i test della scena, che ora girano «com'era» e Balanced):

- il viaggio resta del mondo ed è continuo (stessa distanza entro il 2 %, variazione di velocità
  fra frame sotto il 40 %); si ferma quando il mondo si ferma;
- la parete non si apre per una tensione che oscilla sotto soglia (0 aperture contro > 20
  inversioni), si apre in più di mezzo secondo e mai in un frame, resta aperta se la spinta oscilla
  attorno alla soglia, si richiude in molti frame;
- un kick ordinario muove la parete come pulsazione e non come architettura; un evento che spicca
  apre gli anelli, uno alla volta (cooldown), mai accanto a un rilascio;
- mentre la parete è aperta torsione, curvatura, ovale e waveguide cedono; raggio, anelli, griglia
  fine, corrugazione, scintille e luce sono identici al Tunnel com'era;
- torsione limitata e senza salti (il verso degli anelli non scatta quando la rotazione cambia
  segno); finito e limitato per ogni mondo, anche rotto, e per ogni `dt`;
- lobi e cicli seguono le note senza sfarfallare;
- lo stesso a 30, 60, 120, 144 fps; a riposo in silenzio; corridoio senza clock; interruttore DEV;
- il coordinatore da solo: a metà sta a metà; non alloca.

**Non verificato**: la leggibilità **a occhio** e con musica reale, che è il criterio vero di questo
lavoro. I numeri dicono che il moto è più continuo e meno frequente; non dicono che è più bello.

## 8. Limiti noti

- **Costanti tarate su segnali sintetici**: tempi dei follower, soglie del cancello, quote di cessione.
- **Il Tunnel risponde un poco più tardi**: 0,2 s sul viaggio, 0,6 s sulla torsione. È il prezzo
  della continuità; `balance` fra 0 e 1 lo dosa.
- **La chiusura della parete segue il mondo**: se la tensione cade di colpo (un rilascio), la
  parete si chiude nei tempi dei follower (≈ 0,4 s), non in 1,4 s.
- **Il roll della camera non riparte a una nuova sessione** (com'era): la sua fase continua.
- Nessuna impostazione utente: Balanced è nel preset; il confronto è solo negli strumenti DEV.
