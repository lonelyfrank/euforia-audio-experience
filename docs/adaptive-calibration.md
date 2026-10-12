# Adaptive Music Calibration

Data: 11 ottobre 2026. Quanto forte l'audio che si sta davvero catturando deve muovere ciò che gli
risponde. In tempo reale, senza conoscere il brano, senza file, rete o modelli: statistica
deterministica sulle misure che il DSP già esporta.

> **Non è la calibrazione di sincronia** (`app/calibration/CalibrationView`, ritardo audio → video).
> Quella misura *quando* un suono è udito; questa *quanta risposta* merita. Non cambia un tempo, un
> beat, né un valore del DSP o del mondo. `CalibrationView` non è stata toccata.

```text
cattura → DSP (Rust) → hop frame ─→ AdaptiveMusicCalibration ─→ CalibrationFrame ─→ consumatori
                                    (per hop, sul clock di cattura)   (nello snapshot Experience,
                                                                       presentato al tempo udito)
```

## 1. Audit: che cosa esisteva già

| Già disponibile | Dove | Uso |
|---|---|---|
| noise floor appreso | `AnalysisFrame.noiseFloorDb` (`presence.rs`) | tetto del gain: un ingresso debole si alza solo per quanto sta sopra il rumore |
| percentili online del loudness momentaneo (P10, P50, P90, P95) | `loudnessQuantiles` (`context.rs`) | i riferimenti del brano li **seguono**, non li ricalcolano |
| ogni banda contro i propri ultimi 4 s | `bandRel` (`follow.rs`, `Relative`) | attività relativa di bassi, medi, alti |
| ogni banda sopra il proprio floor | `bandLevel`, `bandFloorDb` | porta: una banda assente non conta; lettura non calibrata |
| quanto è affidabile l'energia | `energyConfidence` | qualità di ciò che si impara |
| densità degli attacchi, quota percussiva | `onsetDensity`, `percussiveShare` | carattere del brano |
| forza degli impatti | `ExperienceEngine` (`power` degli eventi `impact`) | ciò che viene valutato |
| silenzi, pause, salti del clock | `ExperienceEngine.ingest`, `presence`, `silent` | continuità |

Quindi **nessuna seconda FFT, nessuna rianalisi di PCM o spettro**: il DSP dà il momento e la
finestra media; qui si aggiungono la finestra lunga (che cosa è un brano nel suo insieme), quanto
se ne sa, e i limiti.

Non duplica `MusicContext`: quello vive sul frame grafico (`AudioFrame`) e serve le scene con
sezioni, tempo e variazione; questo vive sul flusso degli hop come morfologia, risonanza e mondo, e
nessuna sua uscita ripete una di quelle (la confidenza del ritmo resta `state.rhythmConfidence`).

## 2. Dove sta

`src/experience/AdaptiveCalibration.ts`, classe `AdaptiveMusicCalibration`, posseduta da
`ExperienceEngine` (`engine.calibration`): un `update(frame, dt)` per hop, uno snapshot copiato con
gli altri, presentato al tempo udito. Sta **accanto** al World Engine, non dentro: nessuna forza
del mondo la legge.

> Scelta obbligata: la scena **Spectrum** legge `WorldView`, e il suo significato non si cambia.
> Con la calibrazione dentro `WorldEngine.setForces` ogni scena, Spectrum compresa, avrebbe
> risposto diversamente. Provato: con la calibrazione spenta, mondo, stato ed eventi sono uguali
> all'ultimo bit (`AdaptiveCalibration.test.ts`).

Consumatori in questa iterazione: il laboratorio Solid Dynamics (pulsazione, gate di frattura) e il
coordinatore del Tunnel (accenti). `engine.calibration.enabled = false` la riduce alla lettura non
calibrata: è il confronto del laboratorio, e il comportamento di prima.

Costo: 0,71 µs per hop (p50; p99 1,0), 0,04 µs per attacco valutato; le statistiche lente si
aggiornano ogni 8 hop. Nessuna allocazione.

## 3. Finestre

| Finestra | Che cosa | Chi la tiene |
|---|---|---|
| breve | livello del momento (400 ms), ultimo attacco (150 ms) | DSP; `transient` |
| media | percentili del loudness (secondi → un minuto), storia delle bande (4 s) | DSP |
| lunga | riferimenti consolidati P10 / P50 / P95, carattere, gain | la calibrazione |

I riferimenti consolidati seguono i percentili del DSP con una costante di tempo che **cresce con
ciò che si sa**: `τ = 1,2 s + (24 s − 1,2 s) · confidence · stability`. All'inizio seguono subito;
a brano noto si muovono lentamente.

## 4. Apprendimento

La fase segue l'**evidenza**: secondi di suono, ciascuno pesato per la sua qualità
(`presence · (0,4 + 0,6 · energyConfidence)`). Mai il tempo trascorso.

| Fase | Evidenza | Che cosa vale |
|---|---|---|
| `waiting` | nessun suono ancora | tutto a zero, gain 1 |
| `stabilizing` | < 3 s | lettura non calibrata; nessun attacco può spiccare |
| `learning` | 3 – 12 s | la calibrazione entra in proporzione a `confidence` |
| `consolidating` | 12 – 30 s | riferimenti sempre più lenti |
| `adapted` | ≥ 30 s | adattamento graduale |
| `off` | disattivata | lettura non calibrata, dichiarata |

`confidence = evidenza / 30 s`. Su un segnale pieno le fasi cadono a 3, 12 e 30 s; un segnale
debole e incerto (presenza 0,5, qualità 0,3) dopo 40 s è ancora in `learning`. Ogni uscita è, finché
si sa poco, **la lettura non calibrata che sarebbe stata** (`energy` sulla scala dell'Experience,
gain 1, scala 1): il motore non aspetta mai la calibrazione.

## 5. Uscite (`CalibrationFrame`)

| Campo | Significato | Formula |
|---|---|---|
| `phase`, `confidence`, `observed` | stato dell'apprendimento, fiducia 0..1, secondi di suono | §4 |
| `energy` | il livello del momento nel range del brano (0,5 = tipico), sotto la scala del brano | `(0,5 + (L − P50) / max(P95 − P10, 10 LU)) · scale` |
| `low`, `mid`, `high` | attività di bassi (< 250 Hz), medi, alti contro il proprio livello recente | la banda più attiva della regione: `bandRel`, con porta su `bandLevel`; `· scale` |
| `transient` | quanto l'ultimo attacco spiccava; si spegne in 150 ms | §5.1 |
| `range` | dinamica del brano (LU) | `P95 − P10` consolidati |
| `gain` | gain suggerito per chi legge livelli **assoluti** | §5.2, 0,7 … 1,8 |
| `character`, `scale` | quanto il brano spinge per natura; la scala che mette sulle uscite | §5.3, scala 0,6 … 1 |
| `stability` | quanto i riferimenti descrivono ancora ciò che si sente | §6 |
| `epoch` | quante volte i riferimenti sono ripartiti o sono stati messi in dubbio | §6 |

### 5.1 Valutazione degli attacchi (`rate`)

Ogni impatto che l'Experience registra viene valutato contro gli **accenti abituali** del brano, e
il voto è scritto sull'evento (`AudioEvent.significance`, campo nuovo dell'`EventStream` esistente):

```text
tipico   media degli ultimi ~16 attacchi
accento  il più forte di essi, dimenticato su ~64 attacchi (ciò che torna ogni poche battute è abituale)
margine  max(accento − tipico, 0,05, 0,3 · tipico)
voto     0,5 · (forza − tipico) / margine         0 = tipico · 0,5 = un accento abituale · 1 = tanto oltre gli accenti quanto loro oltre il tipico
```

Mai una soglia di livello: lo stesso pattern a un quarto della forza è votato allo stesso modo.
Finché se ne sono sentiti pochi (o il brano è in `stabilizing`) nulla può spiccare: un attacco vale
la propria forza, e mai più di 0,5. Poi viene appreso: un secondo colpo come il primo è abituale.

### 5.2 Gain: normalizzazione limitata

```text
voluto  = energia(−16 LUFS) / energia(P50)              sulla scala dell'Experience, (L + 60) / 54
tetto   = 1 + 0,8 · unit((P50 − noiseFloor − 14 dB) / 18 dB)
gain    → 1 + (clamp(min(voluto, tetto), 0,7, 1,8) − 1) · confidence · guard         al più 0,12 al secondo
```

I due errori da evitare, e che cosa li evita:

| Errore | Limite |
|---|---|
| tutti i brani ugualmente intensi | `energy` si muove nel range **del brano**, mai in meno di 10 LU (un master compresso non viene stirato); la `scale` segue il carattere (un brano calmo arriva più in basso) |
| reagire troppo a un ingresso debole | gain ≤ 1,8, e non oltre ciò che il rumore consente: a 8 dB dal floor non si alza affatto |

Misurato (frame sintetici): la stessa musica a −8 e a −38 LUFS è collocata allo stesso modo (± 0,06
su `energy`); gain 0,95 e 1,4–1,8; a −52 LUFS con floor a −60: gain < 1,05. Un master che si muove
in 3 LU muove `energy` in meno di 0,35; uno da 18 LU in più di 0,6.

### 5.3 Carattere

```text
carattere = 0,5 · attacchi al secondo / 8 + 0,3 · quota percussiva + 0,2 · (1 − range / 20 LU)        seguito su ~18 s
scala     = 0,6 + 0,4 · carattere
```

Non dipende dal livello né dal solo tempo: ambient (0,4 attacchi/s, poco percussivo, 16 LU) →
carattere < 0,2, scala < 0,7; techno (9 attacchi/s, percussiva, compressa) → > 0,7 e > 0,88. Allo
stesso livello il brano calmo ha un'`energy` media più bassa di almeno 0,08.

## 6. Pause, brani, sorgenti

| Situazione | Come è riconosciuta | Che cosa succede |
|---|---|---|
| pausa breve | silenzio < 2 s | nulla: riferimenti, fiducia e misura degli attacchi restano |
| silenzio prolungato | ≥ 2 s (lo stesso che l'Experience chiama lungo) | riferimenti tenuti; al ritorno `guard` = 0 e risale in 2 s: nulla spicca, il gain torna verso 1 |
| silenzio molto lungo | ≥ 20 s | dubbio: `confidence` ≤ 0,35, `epoch`++, si reimpara in fretta |
| cambio brano senza silenzio | la mediana del DSP a più di 8 LU da quella consolidata | `stability` scende, i riferimenti accelerano; oltre: dubbio, una volta |
| perdita di acquisizione | salto in avanti del clock degli hop | `interrupt()`: stesso brano, stesso dispositivo; i riferimenti restano, `guard` = 0 |
| cambio sorgente / dispositivo | reset di sessione (`ExperienceEngine.reset`), clock che torna indietro | `reset()`: nulla di ciò che si è imparato vale; `epoch`++ |

Misurato: dopo un brano a −32 LUFS, uno a −14 LUFS con kick due volte più forti senza silenzio in
mezzo: rilevato una volta (`epoch` 1), `energy` satura a 1 e non oltre, il gain scende di 0,3 al suo
passo, dopo 4 s i nuovi kick sono abituali (< 0,7), dopo 30 s il livello tipico legge di nuovo
0,35–0,65.

## 7. Sicurezza

Deterministico (stessi hop, stessa uscita); ogni ingresso non finito è gestito (test con NaN, ±∞,
10³⁰ su ogni campo); ogni uscita ha un intervallo esplicito; gain limitato e a passo limitato;
nulla in silenzio (né uscite né voti: `rate` è chiamata solo su impatti reali); nessun tempo
toccato; nulla sul thread di rendering oltre alla copia dello snapshot; nessuna rete.

## 8. Verifica

`AdaptiveCalibration.test.ts`, 14 test.

Su frame sintetici (percentili tracciati con la stessa legge di `context.rs`): fasi per evidenza e
non per tempo; determinismo; limiti con ingressi rotti; silenzio; indipendenza dal livello;
contrasto e master compresso; carattere; pausa breve, silenzio lungo, lunghissimo; cambio brano;
perdita di acquisizione e nuova sorgente; disattivata; valutazione degli attacchi.

Attraverso l'analisi reale (WASM) sui segnali di prova:

| Segnale | Esito |
|---|---|
| `silence`, `hiss`, `hum` | nessun evento che spicca; gain < 1,1; in silenzio tutto a zero, fase `waiting` |
| `beat124`, `beat174`, `kicks`, `beat124` a −26 dB | `consolidating` / `adapted`; negli ultimi 20 s al più 4 attacchi su 100 spiccano, mai due entro 4 s |
| `beat124` a −14 dB | stesso range (± 3 LU), stesso carattere (± 0,1), gain più alto di oltre 0,1 |
| `beat124` a −26 dB | sta così poco sopra il floor appreso dal DSP che non viene alzato più di quello a −14 dB |
| `buildDrop` | il drop spicca; nulla spicca nei primi 6 s |
| `pad` contro `beat174` | carattere e scala più bassi |
| `noise` | range < 10 LU |
| `crescendo`, `startStop`, `noiseMusic`, `breakdown`, `fadeCut` | sempre nei limiti; gain mai più veloce del proprio passo |
| nuova sorgente | `waiting`, fiducia 0, gain 1; la successiva riparte da `stabilizing` |

**Non verificato**: musica reale di qualunque genere; cattura di sistema reale; il comportamento
all'ascolto. La matrice è in [resonant-body-report](resonant-body-report.md) §5.

## 9. Limiti noti

- **Tarata su segnali sintetici.** Riferimento a −16 LUFS, pesi del carattere, margini degli
  attacchi sono punti di partenza.
- **Il voto degli attacchi dipende dalla `power` dell'Experience**, che include potenziale di
  rilascio e novità: su un beat sintetico del tutto regolare 2–3 attacchi su ~90 in 20 s spiccano
  lo stesso (dove l'Experience stessa dà metà potenza in più).
- **Il noise floor del DSP sale fino a −48 dB**: un ingresso molto debole (≈ −45 LUFS) è per il DSP
  vicino al rumore e non viene alzato. È voluto, ma con una sorgente davvero silenziosa e pulita il
  gain resta a 1.
- **Unità miste nel tetto del gain**: LUFS contro dB di potenza (pochi dB di scarto).
- **Nessun consumatore nel mondo**: per il vincolo su Spectrum. Le scene del prodotto che vorranno
  la calibrazione la leggeranno dallo snapshot, come fa il Tunnel.
- Il gain si aggiorna a gradini (ogni 8 hop).
