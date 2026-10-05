# Memoria, narrativa e grammatica

`ExperienceEngine` è il consumer sincrono degli `AnalysisFrame` Rust. Non legge
RAF né ricalcola FFT. Il clock è `sample/sampleRate`; frame ripetuti non fanno
avanzare la memoria. Regressioni o gap >500 ms azzerano il contesto. Tutti i
contenitori continui sono allocati al mount.

`TemporalMemory` segue energia/complessità/tensione su 0,15 / 2 / 10 / 45 /
180 s. L'ultimo livello è un riferimento lento di sessione, non una registrazione
infinita. Prima del primo suono stabilizzato le medie partono dal valore corrente:
un groove appena avviato non deve sembrare un build. I contatori di pause,
climax/drop e l'uso delle scene durano fino al reset della sessione.

Ogni 500 ms confronta un fingerprint a 24 dimensioni: otto bande relative,
dodici pitch class pesate per confidence, energia, densità onset, entropia e
stereo. Fino a 32 motivi, sostituzione circolare; un ritorno richiede distanza
sufficiente nel tempo (8 s), non soltanto somiglianza con il frame precedente.
La memoria visiva conserva 32 transizioni con scena, tinta e intensità, più
tempi cumulativi d'uso. Palette scelta dall'utente e permutazione dei colori
rimangono concetti distinti.

`ExperienceState` separa energia e complessità; espone ordine/caos, flow,
pressione, risonanza, trend, novelty/familiarity, anticipazione e rilascio.
L'anticipazione è evidenza causale da trend, tensione e densità di attacchi;
non è probabilità calibrata né conoscenza di un drop futuro. Accumula potenziale
solo oltre una soglia di evidenza; un attacco significativo con cambiamento
strutturale può scaricarlo, con cooldown. Il silenzio conserva durata, energia
e tensione precedenti e abruptness; distingue taglio da fade.

La narrativa continua è classificata con hold/isteresi in calm, floating,
building, climax, release, descending e suspended. Mood rimane il carattere:
i suoi sedici assi `Character` si avvicinano in modo continuo all'attractor
Mood × Experience. Non viene aggiunta una pretesa di inferire emozioni o generi.

## Planner

`ExperiencePlanner` genera un orizzonte mobile di 2–8 s, una finestra di
transizione, continuità/contrasto, tetto d'intensità ed entropia desiderata.
La finestra è stabile fino a cambio d'intento o scadenza. È un'intenzione
rivedibile, non un evento audio predetto. Il proxy d'entropia combina energia,
complessità, movimento, impatti e apertura; una memoria di saturazione riduce
intensità e dettaglio per recuperare contrasto. Non misura pixel o entropia GPU.

Quattordici intenti condivisi, indicizzati per nome (`INTENT`): expand, contract, flow, impact, cohere, fragment,
suspend, dissolve, breathe, rotate. Ognuno porta strength, duration, attack,
release, spatial bias, confidence e timestamp. `impact` conserva identità e
ora dell'evento; gli intenti continui aggiornano la loro forza. Questi parametri
sono descrittivi della grammatica; Dynamics mantiene i coefficienti fisici
specifici dei canali.

ShowDirector usa tetto/entropia per intensità e supporti, finestra per la scelta
alle frasi e affinità tra scene per continuità o contrasto. Un ritorno di motivo
può recuperare il look memorizzato; il budget GPU viene riapplicato. Il grafo è
simmetrico e deterministico, derivato da energia, complessità, forma e spazio.
La palette resta dell'utente. Preset continua a mantenere la scena scelta.

## Tempo percepito

La history contiene 256 snapshot di proprietà dell'engine, al massimo 120 Hz:
stato, piano, intenti, fisica e misure acustiche. Nessuna vista di array del
decoder viene conservata. `present(heardTime)` seleziona l'ultimo snapshot non
futuro; copertura >2 s, sufficiente per il delay massimo di 400 ms. Non interpola
eventi semantici e non estrapola musica non ancora catturata. Dati vecchi oltre
500 ms non sono presentati come live. I valori geometrici continuano a essere
filtrati da Dynamics e gli impulsi conservano l'ora audio.

RigController orchestra presentazione, FlashGuard, cue e ShowDirector;
VisualDirector traduce intenti e stato fisico nel carattere di ogni scena.
Gli impatti geometrici non sono attenuati dal limite luminoso. Un nuovo impulso
di luce passa lo stesso FlashGuard di beat/strobe; il rilascio nelle vie luminose
è limitato dall'inviluppo ammesso. Reduce Flashing non cancella onde o momentum.

## Limiti

La ricorrenza è similarità timbrica, non identificazione verse/chorus. I motivi
possono collidere; il limite di 32 impedisce crescita in una sessione infinita.
I look vengono richiamati nelle finestre musicali di decisione, non a ogni
cambio del fingerprint. Il nuovo percorso è autorevole per la narrativa della
regia, mentre MusicContext conserva ancora forme delle voci e fallback grafico.
Le sei scene traducono la grammatica attraverso l'adattatore del Director;
Resonant Field legge direttamente lo stato fisico e gli intenti.

## Previsione, eventi e finestre (5 ottobre 2026, seconda fase)

Ai dieci intenti originari si aggiungono `pulse` (sale verso il beat previsto, con la
sua confidence), `accelerate`/`decelerate` (derivate di energia e complessità) e
`reveal` (novità con apertura crescente). Ogni intento porta la propria confidence e il
Director usa `strength × confidence`. Quando un confine di frase previsto cade
nell'orizzonte con confidence > 0,35 la finestra di transizione si centra su di esso
(`transitionConfidence`); altrimenti resta la finestra stabile basata sull'orizzonte.
Trajectory multiscala, narrativa probabilistica con isteresi, previsione e event stream
sono descritti in [realtime-analysis](realtime-analysis.md).

