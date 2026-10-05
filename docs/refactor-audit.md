# Audit preliminare Experience Engine — 5 ottobre 2026

Audit eseguito prima delle modifiche al codice. Letti README, AGENTS, scheda
tecnica, experience-engine, visual-director e musical-semantics; verificati i
produttori PCM, Analyzer Rust, ABI, decoder, Timing, interprete, regie e Layer.

## Risultati

- Il DSP Rust possiede già FFT stereo 2048, FFT armonica 8192 ogni 8 hop,
  loudness K-weighted 400 ms/3 s, HPSS causale ogni 4 hop, PLL e struttura.
  Non occorrono una seconda CQT indipendente né una seconda HPSS.
- La FFT conserva complessi L/R ma esporta solo larghezza/correlazione;
  mancano una vista percettiva, fase temporale, residuo e proiezione per nota.
- Il browser perde lo stereo nel worklet; il desktop analizza prima del
  downmix. Il contratto grafico mono può restare senza imporre mono al DSP.
- WASM e bridge nativo ripiegano tutti i frame di un batch nell'ultimo.
  Questa ottimizzazione è incompatibile con memoria causale invariabile al
  batching: serve una cadenza di pubblicazione definita dal clock audio.
- TS e Rust duplicano centroide, livelli, ritmo e sezioni. TS produce però
  waveform allineata, voci YIN e spettro AGC che Rust non offre. Si conserva
  il contratto grafico; la nuova narrativa ha un solo produttore, Rust→TS.
- MusicContext mescola memoria delle forme delle voci e euristiche narrative;
  ShowDirector sceglie look per tipo di sezione, non per ricorrenza effettiva,
  e usa un prior di genere. La nuova regia deve leggere evidenze e intenti.
- Il metro 4/4 è incorporato in beat, structure, Timing e ShowDirector.
  Un metro incerto deve disabilitare la semantica di battuta, non il beat.
- Dynamics offre già molle esatte, follower e impulsi, con clock audio,
  coda limitata e FlashGuard condiviso. Va riusato per i parametri; modi e
  propagazione richiedono stato fisico aggiuntivo, non DSP nelle scene.
- GPU: tre slot, quattro ingressi composti, sei layer temporanei; qualità
  da RAF. Nessuna misura nuova di GPU o cattura reale è disponibile nell'audit.
- Test: Vitest (DSP WASM reale, TS, mock renderer), Rust unit/integration,
  corpus sintetico e opzionale annotato; shader mock ≠ compilazione GPU.

## Decisioni architetturali per l'intervento

1. Estendere il produttore Rust riusando FFT/HPSS/loudness, esportare misure
   fisiche e percettive attraverso il layout generato. Finestre brevi per
   transienti, medie per timbro/ERB, lunga condivisa per chroma e note.
2. Pubblicare snapshot a cadenza audio deterministica, conservare tutti gli
   onset/beat; decodifica con consumer sincrono e pool limitati. Presentare
   stato narrativo e fisico sul tempo percepito, inclusi delay e reset.
3. ExperienceEngine possiede memoria multiscala, ricorrenza e narrativa;
   ExperiencePlanner decide intenti/contrasto; ShowDirector decide scene;
   VisualDirector traduce la grammatica nelle capacità della scena.
4. Separare energia da complessità e usare un budget di entropia temporale.
   Mood rimane carattere interpolato, distinto dalla narrativa.
5. Primitive modali e onde condivise, scena Resonant Field di riferimento;
   migrare le sei scene tramite il Director e il contratto semantico comune.
6. Nessuna nuova dipendenza necessaria. Misurare CPU per batch e percentili;
   qualità DSP indipendente dalla GPU, conservando sempre hop e ritmo.

Questo documento registra l'audit e le decisioni iniziali, non certifica
l'implementazione: esiti, deviazioni e limiti sono nei documenti finali.
