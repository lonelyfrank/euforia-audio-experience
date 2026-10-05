> Nota, 5 ottobre 2026: questo documento descrive la semantica del percorso
> grafico storico. La narrativa corrente è in [experience-planner.md](experience-planner.md);
> la migrazione delle scene è descritta in [visual-director.md](visual-director.md).

# Semantica musicale e grammatica delle scene

> Documento di una fase precedente: misure e scelte sotto riportate appartengono alla data della verifica.
> Per la pipeline attuale (Rust/WASM, Timing, ShowDirector, Rig e moduli estratti) leggere
> [README](../README.md) e [scheda tecnica](technical-overview.md).


## Audit della pipeline preesistente

La cattura PCM (nativa, browser o sintetica) alimenta un solo `AudioAnalyzer`; `VisualResponse` e il suo `MusicContext` interpretano il risultato. Le scene ricevono entrambi. Nessuna FFT nelle scene, nessuna soglia musicale nei preset.

| Feature | Produzione e memoria preesistente |
|---|---|
| volume / bass | RMS su 20 ms; bass filtrato a 250 Hz. DynamicRange in dB, curva 1.8, attack 4–24 ms / release 20–240 ms da Smoothing |
| lowMid / mid / highMid / treble / energy | Hann FFT 2048 (42.7 ms a 48 kHz); potenza media delle bande, stessa normalizzazione e smoothing |
| normalizzazione | peak −3 dB/s, floor 1.5/6 s, media/deviazione 1.5 s; vista assoluta e relativa 50/50. Sensitivity restringe il range |
| spectrum / waveform | 128 bin log, tilt 3 dB/ottava, finestra 42 dB, top −4 dB/s; waveform 1024 con zero crossing e peak follower 3 s |
| beat / onset / beatPulse | kick sotto 120 Hz su 10 ms, riferimento 350 ms, soglia adattiva 3 dB/45%, refractory 200 ms; pulse tau 125 ms |
| BPM / confidence | autocorrelazione 6 s a 100 Hz, aggiornata ogni 500 ms; supporto dei colpi al tempo previsto, fino a 4 beat mancanti |
| flux low/mid/high | aumento dei bin rispetto a 60 ms, fondo del flux 500 ms, massimo recente 2 s |
| voci | finestra 4096, filtri e YIN decimato; forma di ciclo 128 punti, fino a 24 cicli mediati, smoothing 60 ms |
| presence | noise floor −75…−48 dB, apprendimento +5 dB/s su segnali stabili; isteresi +8/+4 dB, hold 300 ms, attack 25 ms/release 1.1 s |
| audibility L/M/H | dB grezzi rispetto al livello recente (−1.5 dB/s), fade tra −18 e −42 dB; hold 120 ms fino a circa un beat per le parti percussive, moltiplicato per presence |
| weight / flow / detail / shimmer / impact / density | ruoli pesati per quota spettrale; attack/release 40/350, 120/450, 15/90, 0/70, 0/160, 300/900 ms |
| motion | flux delle tre regioni, follower 120 ms/1.2 s |
| openness | copertura dello spectrum sopra 0.15, sfumata da energy; 1.5/4 s |
| tension | massimo tra build e texture rumorosa × intensità; prima 0.6/2 s |
| trace | memoria degli impact, attack immediato/release 1.1 s |
| MusicContext | intensità di sezione 2/4 s su loudness assoluta; build da follower 1.5/6 s di intensità e brightness; drop relativo al ritorno del sub dopo sezione quieta/build, cooldown 8 s, decay 1.2 s |
| stato | silent/calm/rising/active/peak/falling, isteresi, conferma 0.8 s, durata minima 2.5 s (silenzio 0.3 s) |

Problemi individuati: trend e metadati di stato non esposti; drop/build/percussione congelati nel silenzio; trace usato anche come massa; drop spesso ridotto a flash; travel legato principalmente ai beat; echo Spectrum cancellati dall'audibility corrente anziché conservare quella dell'evento.

## Contratto temporale aggiornato

Vedi `MusicContextFrame`: i trend confrontano medie esponenziali su 1.5 e 6 secondi, con output −1…1 e inizializzazione sul primo campione (nessun falso crescendo all'avvio). `energyTrend` usa loudness assoluta per non perdere i crescendo nell'AGC; `densityTrend` usa copertura spettrale. Nessuna history FFT aggiunta. Stato, confidence, età e stato precedente appartengono a VisualResponse. Build e drop restano quelli di MusicContext.

`stateAge` è in secondi e `stateConfidence` misura quanto a lungo le evidenze concordano con lo stato impegnato, non una probabilità statistica. `previousState` cambia solo dopo una transizione confermata. Si conservano i sei nomi esistenti: `calm` include intro/ambient, `active` groove/attività stabile, `rising` build, `peak` sezioni intense, `falling` riduzione/breakdown dopo un picco. Nessuna classificazione di genere e nessuna stima inventata del confine di frase. Le scene usano segnali continui, non salti dell'enum.

I trend non sono nuove misure del segnale: `energyTrend` segue la loudness già disponibile, `motionTrend` motion, `densityTrend` la copertura usata per openness, gli altri due le rispettive macro feature. La precedente derivata privata dello stato è stata sostituita con il trend condiviso. `recentPeak` e `recentDrop` decadono in 20/12 s, senza salvare FFT. Il clock dei beat si ferma in assenza sonora; percussività, build e drop continuano a decadere. Un cambio sorgente o una nuova canzone azzera l'evidenza della sezione, conservando lo stile appreso delle voci e il noise floor.

Build combina crescita di intensità/brightness con attività transiente/percussione alta: un tono semplicemente più forte non basta. Drop richiede una memoria quiet/build, un ritorno relativo del sub, un attacco low reale, sostegno ritmico o un build consolidato, e una nuova sezione abbastanza forte rispetto alla canzone. Warmup 6 s, cooldown 8 s, pulse con tau 1.2 s. Nessun secondo `dropPulse`: il contratto resta `music.drop`.

## Matrice delle funzioni visive

| Feature | Galaxy | Tunnel | Particle Field | Liquid | Spectrum | Oscilloscope |
|---|---|---|---|---|---|---|
| Bass | massa/compressione del core | pressione/deformazione parete | massa e inerzia shell interne | displacement lento dei layer bassi | core della voce bassa | CH2 e peso del tratto |
| Mid | forma e swirl delle braccia | curvatura/torsione | traiettorie e vortice | correnti/interferenze | orbita lead | CH3 |
| High | scintillazione delle stelle esterne | griglia fine/scintille | particelle leggere periferiche | ripple/glint superficiale | dettaglio e scintille esterne | luminosità del segnale |
| Motion | velocità spin/drift | velocità di avanzamento | velocità del flusso | velocità delle correnti | rotazione/propagazione echi | scorrimento voci |
| Openness | raggio del sistema | ampiezza tunnel | dispersione shell | separazione verticale layer | raggio e distanza echi | distanza canali |
| Tension | spirali compresse/avvolte | chiusura e torsione progressiva | clustering ordinato sulle shell | restringimento e flusso laminare | concentrazione degli echi | compressione verticale/stepping voci |
| Trace | onde storiche dei kick | anelli storici nelle pareti | anelli di memoria | tracce per banda e fosfori | spettro + audibilità storica per eco | vera persistenza dei fosfori |
| Impact / drop | onda dal core verso il bordo con luce locale | fronte di pressione, apertura/accelerazione | espulsione radiale e riassestamento | shock largo e libertà delle correnti | fronte sonar verso l'esterno | breve overdrive e maggiore persistenza |

Openness non cambia più la densità emessa delle particelle o la frequenza degli echi; trace non cambia più la massa di Galaxy/Particles/Spectrum. Non ci sono nuovi colori fissi: tutte le tinte derivano dalle palette Halo. Non si aggiungono controlli utente o soglie nei preset.

In silenzio i moti integrati si fermano con l'audibilità; le geometrie possono assestarsi con il decay macro e gli eventi già emessi possono terminare. Il compositing conserva una piccola quota di trace/drop dopo il taglio del segnale live, per non cancellare i fosfori e gli echi. Spectrum salva l'audibilità di ogni eco e la fa decadere separatamente. Oscilloscope converte il damping dei fosfori da riferimento 60 Hz a `dt` reale; Liquid fa lo stesso quando il pass è attivo.

## Riproduzione e validazione

Solo in sviluppo: `npm run dev`, aprire `http://127.0.0.1:1420/?debug` oppure Shift+D. L'overlay mostra dB del noise floor, presenza, audibilità per regione, ruoli, state/confidence/age/previous, cinque trend firmati, memorie di picco/drop, beat/onset/BPM. La history di loudness/presence/motion/openness/tension campiona a 20 Hz in 200 celle: dieci secondi a qualunque frame rate. Non entra nel bundle di produzione.

| Scenario | Segnale / intervallo | Cosa verificare in tutte le scene |
|---|---|---|
| silence | `silence` | nessun travel, spin o agitazione residua; decay degli eventi |
| soft ambient | `pad` | quiete relativa e forma sostenuta |
| steady beat | `beat124` | moto regolare e impatti separati |
| bass-heavy | `bassPulse`, `sawBass` | peso interno senza scintille spurie |
| bright percussion | `hats` | dettaglio rapido periferico senza massa |
| build/drop | `buildDrop`: 0–10 ambient, 10–18 build, 18–32 groove | accumulo e una release principale, non flash su ogni beat |
| breakdown/rebuild | `breakdown`: 0–12 denso, 12–20 rarefatto, 20–28 build, 28–40 ritorno | contrasto tra picco, spazio vuoto e ritorno |
| fade/hard cut | `fadeCut`: fade 4–8, restart 9, cut 11 (ciclo 12 s) | dissolvenza progressiva, taglio entro il hold ritmico, ritorno immediato |
| start/stop | `startStop`: silence 0–4, groove 4–12, silence 12–16, groove 16–24 | ripartenza senza attendere stato o BPM |
| noise floor | `noiseMusic`: hiss 0–8, musica+hiss 8–20, hiss 20–28; `hum` | il fondo appreso non mantiene attivo il moto |
| crescendo | `crescendo`: guadagno −32→−6 dB in 12 s, plateau fino a 24 | energyTrend positivo durante crescita, verso zero al plateau |

I generatori usano seed fisso, clock in campioni e buffer riusati. Gli scenari combinati non resettano l'analizzatore tra le sezioni; selezionare un altro segnale dall'overlay equivale invece a cambiare sorgente.

Test automatici: `npm run check`. I test PCM attraversano l'analizzatore reale, quelli di stato sollecitano soglie e durate, quelli di grammatica controllano gli effetti geometrici/persistenza e la quiete delle sei scene. Un test di uniform non sostituisce la compilazione GLSL: verificare anche in browser.

## Performance

Nessuna dipendenza o pass GPU aggiunto. Cinque trend hanno ciascuno due scalari di memoria; Spectrum aggiunge nove vettori di audibilità e nove costanti di decay. Gli aggiornamenti riusano oggetti, array, texture e uniform. Le onde di release aggiungono algebra locale agli shader esistenti, senza ulteriori iterazioni per particella o pixel; numero di particelle, segmenti, echi e quality ladder invariati. Solo l'overlay di sviluppo conserva una history temporale addizionale, limitata a 5×200 float.

## Esito della verifica (29 settembre 2026)

- Chromium headless, WebGL su Intel UHD (Mesa/ANGLE), viewport 1280×720: le sei scene renderizzate nei dieci scenari della matrice, nessun errore JavaScript/GLSL. Controllati gli screenshot di build e drop, mantenendo forme e palette distinguibili; Spectrum resta un ring continuo e Scope conserva i tre canali.
- Verificati cambio qualità Low/Medium/High, completamento del crossfade e reflection on/off. Overlay aperto separatamente con Shift+D; assente dalla normale schermata.
- Report e 60 screenshot della sessione in `/tmp/halo-semantics/` (artefatti temporanei, non necessari all'app).
- `cargo check --workspace --offline` passa usando il sysroot di sviluppo già disponibile per ALSA/GTK/WebKit. Nessun file Rust o provider di cattura modificato. La cattura WASAPI su hardware Windows non è stata eseguita in questa sessione.

- `npm run check`: 58 test (8 file), typecheck, lint e build frontend. Il groove resta `active` anche quando l'intensità relativa si assesta in basso; un plateau di volume non genera build/drop.
- Misura RAF del loop reale (audio sintetico, analisi, rendering), senza compilazioni concorrenti, dopo warmup: circa 60 FPS in tutte le 18 combinazioni scena × Low/Medium/High a 1280×720, mediana 16.7 ms e p95 16.7–16.8 ms su 90 frame. Scena montata e qualità controllate a ogni cambio; risultati in `/tmp/halo-semantics/performance.json`. È uno smoke test locale, non una garanzia a 1080p/4K o su altre GPU; Auto resta attivo e invariato.
