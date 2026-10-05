# Modello acustico live

Implementato in `native/analysis`, condiviso dal worker desktop e dal WASM, che nel
browser gira nel worker di analisi (vedi [realtime-analysis](realtime-analysis.md)).
Nessuna analisi preliminare di file è richiesta; il corpus reader è solo uno
strumento di sviluppo. Il modello esporta misure, non giudizi estetici.

## Risoluzioni e frequenze

A 48 kHz, hop 256 = 5,33 ms. Lo stereo complesso usa il packing già presente
in `Fft::stereo`; i ring L/R sono condivisi dalle finestre.

| Vista | Finestra | High | Medium | Low | Utilizzo |
|---|---:|---:|---:|---:|---|
| Transienti | 512 | ogni hop | ogni hop | ogni hop | variazione positiva della magnitudine, senza cancellare il side |
| Spettro / ritmo | 2048 | ogni hop | ogni hop | ogni hop | bande, flux, PLL, stereo, presenza |
| ERB / fase / descrittori | spettro 2048 riusato | 4 hop | 8 hop | 16 hop | 46,9 / 23,4 / 11,7 Hz |
| HPSS | spettro 2048 riusato | 4 hop | 8 hop | 16 hop | carattere H/P/R; non timing degli onset |
| Note / chroma / parziali | 8192 | 8 hop | 16 hop | 32 hop | 23,4 / 11,7 / 5,9 Hz |

Le frequenze cambiano con il sample rate. Low conserva tutte le finestre ma
riduce le elaborazioni lente. Il budget misura lavoro/durata audio: sopra 30%
per 2 s scende di livello; sotto 12% per 30 s recupera. È indipendente dalla
qualità GPU. I benchmark disabilitano l'adattamento per confronti deterministici.

## Misure e significati

- **Fisica:** RMS e peak lineari, crest peak/RMS, potenze delle otto bande.
  Centroide, spread, rolloff 85%, flatness e crest spettrale usano potenze
  senza AGC. Entropia di Shannon normalizzata; complexity conta picchi
  significativi. Non sono sinonimi di loudness.
- **Percezione:** proiezione triangolare in 24 bande ERB-rate, pesi
  precomputati. Brightness/low weight/sharpness sono indici di eccitazione
  compressa, non sones/acum calibrati né una coclea simulata. La scala segue
  il modello di selettività di [Glasberg e Moore](https://pubmed.ncbi.nlm.nih.gov/2228789/).
- **Loudness:** conservato il filtro shelf + high-pass e la somma delle
  potenze per canale: finestre scorrevoli 400 ms e 3 s, riferimento lento e
  livello relativo. Il range nuovo è la distanza tra estremi che rientrano
  in 20 s. Approssimazione ispirata a [BS.1770](https://www.itu.int/rec/R-REC-BS.1770),
  senza gating integrato, true peak o certificazione LUFS/EBU LRA.
- **Fase:** deviazione dalla velocità di fase precedente, concentrazione
  temporale, distanza complessa, velocità aliasata e frequenza istantanea
  approssimata. Si riusano i bin del canale sinistro; l'energia stereo resta
  la media delle potenze. La distanza complessa segue l'idea di
  [Duxbury et al.](https://dafx.de/paper-archive/2003/pdfs/dafx81.pdf), ma non
  sostituisce il detector ritmico validato: qui descrive instabilità.
- **Armonia:** 72 pitch bin MIDI 36–107 dalla stessa FFT 8192 del chroma;
  interpolazione tra note, non CQT esatta. Dodici picchi interpolati in log
  magnitudine alimentano fit armonico, inarmonicità e salience. Roughness
  usa coppie di picchi e la curva parametrica descritta da
  [Sethares](https://sethares.engr.wisc.edu/paperspdf/adaptun2002.pdf).
  Sono indizi del carattere, non trascrizione, riconoscimento di accordi o
  un modello completo di dissonanza polifonica. La risoluzione sotto C2
  resta limitata e i picchi deboli vengono esclusi.
- **H/P/R:** la HPSS causale a mediane temporali/spettrali già presente,
  ispirata a [FitzGerald](https://dafx.de/paper-archive/2010/DAFx10/DerryFitzGerald_DAFx10_P15.pdf),
  mantiene le quote storiche per il ritmo. Le nuove quote sottraggono la
  parte ambigua `2*min(H,P)` e la assegnano al residuo; sommano a uno sul
  segnale presente. Non producono stem né PCM separati.
- **Stereo:** potenze L/R/M/S, width, correlazione, pan, movimento e trend;
  fase/concentrazione del cross-spettro globale. Quest'ultima non equivale
  a una stima per-bin di coherence su molte finestre. Browser mic e test
  trasportano due canali al WASM; solo la vista grafica viene downmixata.
- **Transienti per banda:** flux in dB, attacco/decay normalizzati, attività
  filtrata e forza transiente nelle otto regioni. I transienti brevi hanno
  cadenza hop; le misure per banda seguono il livello DSP.

## Ritmo e trasporto

PLL e onset storici conservano hop e precisione. Ipotesi di accento 3/4/5/7
stimano raggruppamenti di beat con margine e hold; `meter=0` significa
sconosciuto. La confidence del metro misura il margine tra ipotesi; quella del
downbeat misura il contrasto dell’accento all’interno del raggruppamento.
Non viene dedotto il denominatore della notazione. Timing e
ShowDirector non inventano downbeat quando il metro è incerto. Il modello
strutturale mantiene un raggruppamento interno di fallback, non esposto
come battuta affidabile dal planner. Frasi: orizzonte 4/8 battute basato su
confidence, non prior di genere; non è riconoscimento formale della frase.

Il wire resta una sequenza little-endian f64 con tag e layout generato.
Sono rimossi i prior `genre`; aggiunti i campi fisici/percettivi e `dspQuality`.
**ABI cambiata:** frontend, backend e WASM devono essere distribuiti insieme.
Ogni frame hop viene conservato, anche all'interno di batch grandi. Il decoder
chiama un consumer sincrono prima di riutilizzare il frame; il consumer deve
copiare ciò che conserva. Gli eventi mantengono sempre il clock in campioni.

Scelte escluse: CQT separata, banco gammatone, skewness/kurtosis e separazione AI:
aggiungerebbero costo/duplicazione senza una necessità misurata. Il WASM browser non è
più sul main thread: gira in `analysis.worker.ts` con lo stesso DSP.

Contesto (`context.rs`, ogni hop, indipendente dalla qualità DSP): noise floor adattivo e
attività per banda, P10/P50/P90/P95 online della loudness con posizione relativa,
derivate filtrate di brightness/entropia/complessità/armonicità e downbeat previsto.
Dettagli e costanti in [realtime-analysis](realtime-analysis.md). I confronti e i limiti sono in [refactor-report](refactor-report.md).
