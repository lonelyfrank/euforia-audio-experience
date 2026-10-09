# Contratto delle metriche

Ogni valore esportato contiene `id`, `domain`, `value`, `unit`, `timestamp`, `clock`,
`source`, `status`, `method`, `lowerIsBetter`. Il registro effettivo è il catalogo
macchina leggibile del report JSON; gli id dinamici mantengono i nomi originali del
produttore. NaN/Infinity, timestamp invalidi e assenza del produttore diventano
`null`/`unavailable`, mai zero. Meter 0 e previsioni con tempo ≤0 sono sconosciuti.

## Frequenza, precisione e costo comuni

Basic 5 Hz, Detailed 10 Hz; UI 5 Hz; readback ≤1 Hz. Copie numeriche di sola lettura,
nessun nuovo DSP. Numeri JS f64; vettori f32/f64 mantengono la precisione originaria,
anche se lo store li conserva in f64. `model unit` significa il coefficiente numerico
nativo descritto nel modulo produttore, non una quantità SI. Il metodo `producer value`
è una lettura diretta: non somma, normalizza o ricalibra le feature.
I campi `*Confidence` restano evidenze del motore, non probabilità calibrate.
Le metriche non presenti nella scena corrente restano indisponibili.

| Famiglia / id | Definizione e metodo | Unità / clock | Disponibilità, limite e costo |
|---|---|---|---|
| `audio.<campo>` | Tutti gli scalari di `FRAME_FIELDS` dal decoder Rust; nessuna derivazione | capture, al tempo dell'ultimo hop | sorgente running + clock pronto + almeno un hop; copia O(numero feature) |
| `audio.<vettore>[i]` | `bandDb`, `bandRel`, `bandFloorDb`, `bandLevel`, `erb`, `chroma`, `pitchBins`, `bandPan`, `bandFlux/Attack/Decay/Activity/Transient`, `partialHz/Level/Pan/Phase`, `similarity`, `loudnessQuantiles` | unità originarie, capture | solo Detailed; slot parziali ordinati per livello, non identità tracciate |
| `capture.sampleRate` | sampleRate del provider attivo | Hz, render | indisponibile se non running |
| `capture.frames` | ultimo indice `AnalysisFrame.sample` | sample frames, render | avanzamento analizzato; non totale consegnato dal driver |
| `capture.hops` | `AnalysisDecoder.frames` | hop, render | contatore della sessione |
| `capture.channels/hardwareBuffer/batchCpuMs` | non esposti dal contratto comune | count/ms, render | sempre null; non dedotti dal downmix |
| `pipeline.load` | RealtimeStats.load, DSP work / audio time smussato | ratio, render, estimated | browser; non tempo di un singolo batch |
| `pipeline.quality` | tier DSP, distinto da qualità GPU | tier, render | browser |
| `pipeline.backlog/lost/filled` | coda/perdite/riempimenti del trasporto PCM | sample frames, render | browser |
| `pipeline.pending/dropped` | valori wire in staging / scartati | f64 values, render | non frame audio |
| `pipeline.dspAge` | età del campione più recente all'uscita del DSP | s, render | include attesa; non CPU time |
| `pipeline.transfer` | tempo worker → main smussato | s, render, estimated | scheduling incluso |
| `pipeline.batches` | batch ricevuti | batch, render | browser |
| `clock.analysis` | tempo dell'ultimo hop | s capture | non tempo della UI |
| `clock.captureHost` | ClockSync.toHost(analysis.time) | s host/render, estimated | offset stimato |
| `clock.heard` | Timing.heardTime | s audio, estimated | tempo di cattura che si presume udito |
| `clock.presentationHost` | Timing.presentTime | s presentation, estimated | host + render latency stimata |
| `clock.renderHost` | timestamp RAF /1000 | s render | clock monotono host |
| `latency.configuredOutput` | compensazione configurata | s render | parametro, non misura fisica |
| `latency.renderEstimate` | frame medio × renderFrames | s render, estimated | non scan-out misurato |
| `latency.analysisLead` | heardTime − analysis.time | s render, estimated | positivo: mondo estrapolato |
| `latency.physical` | richiede calibrazione esterna | s | null |
| `experience.<campo>` | scalari ExperienceState dello snapshot già presentato | audio/state.time, model unit salvo tempi | narrativa/trajectory/silenceKind sono labels testuali; non ricalcolate |
| `plan.<campo>` | piano già scelto da ExperiencePlanner | audio/state.time; finestre/horizon in s | currentIntent/nextIntent sono labels |
| `morphology.<campo>` | SoundMorphology per hop nello snapshot | audio, model unit | nessun classificatore |
| `intent.<nome>` | strength × confidence | 0..1, audio/intent.time | nomi dell'intento originale |
| `intentConfidence.<nome>` | confidence originale | 0..1, audio | distinta dalla forza pesata |
| `world.<campo>` | scalari WorldState al tempo udito | audio/world.time | corpo persistente e rilascio/impulso; -Infinity iniziale diventa null |
| `world.kinetic/elastic/stored/wave/energy` | bookkeeping del motore | unità visuali, estimated | modello fenomenologico, non joule |
| `world.inputEnergy/dissipation/angularMomentum` | quantità non definite/esposte | unavailable | nessuna falsa conservazione |
| `forces.<campo>` | WorldForces tenute sullo step | audio/world.time | legge immutata; i target non sono forze assolute |
| `physics.<campo>` | PhysicsFrame già presentato | audio/physics.time | displacement, velocity, energy, damping, activeResonators, waveActivity; modes/waves in Detailed |
| `resonance.<campo>` | ResonanceFrame multiscala | audio/state.time | macro/meso/micro solo in Detailed; nessun nuovo DSP |
| `field.<campo>` | campi condivisi SpatialFields della recipe corrente | audio/frame.time, model unit | forza/flusso/coefficiente secondo il produttore; non vettore totale di ogni elemento |
| `geometry.<campo>` | tutti i tratti di GeometryState del mapper | audio/frame.time | lettura per frame, non nuove misure musicali |
| `visualWorld.<campo>` | debug: budget, ceiling, present, primitives, elements, vertices, fields, waves, decay | audio/frame.time | conteggi del protagonista, non renderer globale |
| `primitive.<recipe>.<slot>.presence/target` | Envelope.value e target | 0..1, audio | presenza estetica non equivale a topologia |
| `…cost` | slot.cost o 1; base fuori budget = 0 | quota di budget, audio | recipe originale, nessun registro duplicato |
| `…elements/vertices` | elementi e vertici montati | count, audio | non pixel visibili dopo discard |
| `…debug.<campo>` | metriche originali della primitiva | unità native, audio | `sim ms` è CPU submit smussato, non GPU |
| `…targetBits/pingPong/stateTextures` | precisione, indice target, quattro attachment dello stato | bits/component, index, count; audio | Matter/Tracer GPU |
| `…stateBytes` | elements × RGBA × 4 texture × byte/componente | bytes, estimated | esclude seed texture, render pass, driver e padding |
| `structural.<campo>` | statistiche StructuralSystem: elementi, legami, fratture, loop, ordine, temperatura, stress, cinetica, passi, CPU | audio/frame.time, unità originali | solo recipe con WirePolygon; vere statistiche, nessuna classificazione visiva |
| `sample.<recipe>.<slot>.count/invalid` | texel letti e non finiti | count, audio/frame.time | readback esplicito, prefix ≤256, full-float |
| `sample.<recipe>.<slot>.x/y/z/dispersion` | media posizione e sqrt(media distanza² dal baricentro) | vu, audio | solo campione valido, non densità globale |
| `sample.<recipe>.<slot>.speed/maxSpeed` | media/massimo norma velocità | vu/s, audio | solo campione |
| `sample.<recipe>.<slot>.kinetic` | media(v²/2), massa convenzionale 1 | vu²/s², audio | non energia fisica assoluta |
| `render.calls/triangles/points/lines` | renderer.info su tutto il frame | count, render | include simulazioni e composizione |
| `render.geometries/textures` | renderer.info.memory | count, render | numero risorse, non byte GPU |
| `frame.instant/mean/p95/p99` | intervallo reale RAF; finestra 300, percentile nearest-rank | ms, render | include stalli, distinto dal campione QualityController |
| `fps.instant/mean` | 1000 / intervallo o media intervalli | fps, render | non media aritmetica dei reciproci |
| `cpu.source` | durata frameSource | ms render | analisi grafica TS, decode, rig; esclude DSP worker |
| `cpu.renderSubmit` | fine frame − fine frameSource | ms render | scene + submission CPU, non GPU |
| `gpu.frame` | timer query completata /1e6 | ms render | frame precedente non identificato, async; unavailable su disjoint/no extension |
| `render.layers/crossfades/configuredPasses` | risorse montate e pass abilitati | count render | pass configurati anche di layer non disegnati; non chiamate GL |
| `render.width/height/pixelRatio` | canvas drawing buffer / renderer pixel ratio | px / ratio, render | risoluzione effettiva |
| `budget.maxUnits/targetFrame/frameRatio` | MAX_UNITS[tier], 1000/TARGET_FPS, mean/target | unità fixture, ms, ratio | diagnostica non prende decisioni di qualità |
| `render.gpuMemoryTotal/renderTargetsTotal/actuallyVisibleParticles` | non esposti in modo completo | unavailable | null |
| `diagnostics.collection/ui/readback` | durata CPU dell'operazione | ms render | collection/UI: operazione precedente; readback: attuale |
| `diagnostics.bufferBytes` | byteLength dei buffer numerici | bytes render | esclude DOM, oggetti, WorldTrace e runtime |

## Unità esplicite per campo

`sample` campioni; `*Hz` e sampleRate Hz; noiseFloorDb/bandDb/bandFloorDb/harmonicDb/
percussiveDb dBFS; loudnessMomentary/Short/Long e perceivedLoudness LUFS;
rms/peak frazione full-scale; beatBpm/tempoBpm/resonatorBpm BPM; angle rad;
spin rad/s; torque rad/s²; radius/travel vu; radialVelocity/speed/biasVelocity vu/s;
thrust vu/s²; spinDrag/travelDrag/excitationRate/shimmerRate/charge 1/s;
time, releaseTime, impulseTime, nextBeatTime, nextDownbeatTime, nextPhraseTime,
transitionStart/End, horizon, predictionHorizon, eventTime, silenceDuration secondi.
Gli altri campi conservano le unità del modello documentate nel sorgente; nessuna
conversione in unità fisiche assolute è implicita.

I conteggi `particles`, `tracers`, `nodes`, `links`, `steps`, `elements`, `vertices`,
`primitives`, `present`, `rings`, `filaments`, `bonds`, `loops`, `formed`, `fractures`,
`repairs` e i conteggi espliciti delle primitive usano `count`; `sim ms`, `stepMs`,
`bookMs` usano `ms CPU`. Un campione GPU rimane leggibile fino al campione successivo,
con il proprio timestamp originale (non viene ridatato al refresh UI).

`invariants.nonfinite` conta NaN/Infinity nel mondo e nelle sue forze, escludendo i
sentinella -Infinity dei due eventi mai avvenuti. `invariants.fieldDomain` conta
violazioni dei sette campi 0..1 con tolleranza 1e-9. Sono osservazioni al tempo del
mondo, non correzioni dello stato. Decadimento, silenzio e continuità restano verificati
dai replay e dai test originali del World Engine, senza falsi allarmi su energie
fenomenologiche che possono trasferirsi tra termini.
