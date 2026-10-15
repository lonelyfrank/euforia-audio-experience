# Music Reactivity Report — 15 ottobre 2026

La campagna usa il DSP WASM reale con segnali sintetici esistenti. Non comprende ascolto
né cattura di musica reale. Il percorso e i limiti del replay sono nel
[Visual Fidelity Audit](visual-fidelity-audit.md); eventi, cue, pose e parametri sono nei
report compressi in `visual-fidelity/`.

## Eventi e risposta strutturale

Il drop del generatore `buildDrop` comincia a **18,000 s**. A 30 fps:

| Dato | Timestamp audio | Primo snapshot udito che lo presenta |
|---|---:|---:|
| `prepare`, previsto | 16,890667 s | 16,900000 s |
| `release`, confermato | 18,002271 s | 18,033333 s |
| `accent`, osservato | 18,757333 s | 18,766667 s |
| `phrase`, osservata | 20,634667 s | 20,666667 s |

Il release ha confidenza 1 e strength 0,7796. Il ritardo di presentazione del cue rispetto
al suo timestamp è **31,1 ms**, entro un frame a 30 fps. Non è una latenza audio→fotone:
il replay impone 100 ms di ritardo di presentazione, usa un clock ideale e non misura
cattura, dispositivo audio, scansione del monitor o quando un osservatore percepisce il moto.

Le immagini di Fractured Expanse a 16,9 s uditi mostrano corpi chiusi; a 18,2 s mostrano
frammenti. Nel campione Medium i link passano da 114 a 68, le facce da 76 a 28 e le celle
da 15 a 0, con un solo evento di frattura. La geometria conserva 52 vertici: la rottura
libera i legami. Il numero `pieces` del debug aggregato non equivale al numero totale dei
corpi visibili. Non è dimostrata la ricomposizione completa sotto eccitazione continua.

Le emergenze di Terrain passano a tre strutture in frattura dopo lo stesso release.
La sola previsione a 16,9 s non le rompe. Monolith Desert non frattura: conserva il suo
carattere di crescita e landmark. La prima pianura viene seminata entro il budget normale
quando comincia il viaggio; non è un burst da una previsione.

## Limite musicale preservato

Gli eventi storici `Experience.drop` cadono a **16,000 s e 20,160 s**, non al drop del
generatore. È il problema già descritto in `music-response.md` §2.4–2.5. Tunnel e le risposte
del suolo/mare che leggono `WorldState.releaseTime` possono quindi reagire a questi istanti.
I cue strutturali confermati restano distinti. Non è stato modificato il predittore, il
World Engine o il rilevatore per far coincidere artificialmente questo singolo segnale.

## Tempi appropriati e limiti di osservazione

Prove GPU supplementari, tutte senza errori JS/GLSL:

- **Silenzio**, tutte le 16 scene Low, 2 e 8 s: energia e velocità del mondo zero,
  nessun cue, nessuna struttura/albero nuovo e nessuna frattura. Le immagini mostrano
  solo il fondale. Non sono pixel-identiche: il fondale si assesta, come l'Observer
  delle recipe Particles. Il flusso contiene una `phraseBoundary` a 7,525 s anche in
  silenzio; non produce cue né energia. È evidenza da distinguere dall'assenza di ogni evento.
- **Start/stop**, sei Worlds Low, 3 / 11 / 15,9 / 22 s: nessun cue durante l'intera
  sequenza, nessuna frattura o burst alla ripresa. Nella pausa di quattro secondi il
  moto si attenua, non si azzera istantaneamente (Tunnel: velocità 3,48→0,082);
  questo è il decadimento del mondo e dei follower esistenti.
- **30 contro 60 fps**, sei Worlds Low, stessi record e istanti: stessi quattro cue
  e timestamp, una frattura confermata in Expanse. Velocità finali vicine (Tunnel
  3,9967 contro 3,9927), ma **non equivalenza della topologia end-to-end**: Terrain
  ha 13 contro 11 strutture a 23,9 s; Expanse 68 contro 69 link e 28 contro 29 facce.
  I test con ingresso tenuto per frame non dimostrano identità quando il campionamento
  del mondo varia. Non correggere questi scarti cambiando il clock o il core musicale
  dentro una scena. La stabilità numerica è osservata; la piena indipendenza dal frame
  rate rimane PARTIAL.
- **Solid Particles DEV**, Matter Field con lo slot esistente a Low/High: corpi,
  materia libera, membrana e filamenti contemporanei. Le immagini distinguono i
  corpi prima e i pezzi dopo il release; non dimostrano ricomposizione o selettività
  per frequenza. La recipe di prodotto resta senza solidi.

Dati: [silenzio](visual-fidelity/silence.json.gz),
[start/stop](visual-fidelity/startstop.json.gz), [60 fps](visual-fidelity/60fps.json.gz),
[coesistenza](visual-fidelity/solids.json.gz). Immagini:
[corpi prima](visual-fidelity/evidence/solid-particles-matter-field-high-17.00.png),
[dopo il release](visual-fidelity/evidence/solid-particles-matter-field-high-18.30.png),
[silenzio](visual-fidelity/evidence/silence-terrain-low-8.00.png).

Non sono stati cambiati follower, attacco/rilascio, inerzia, leggi di movimento o limiti
di pulsazione. I digest di Tunnel e della risposta Terrain e i test a 30/60/144 fps
proteggono queste proprietà sul riferimento CPU. Le immagini a più istanti dimostrano
trasformazioni, non bastano a certificare fluidità percettiva continua o assenza di flicker.

La crescita della foresta può occupare più del tratto iniziale di 24 s: a Medium il
campione finale contiene alberi maturi, a Low prevalgono quelli in crescita. La memoria
selettiva richiede che la cognizione osservi una ripetizione e che esistano alberi con la
firma corrispondente. Non assegnare VERIFIED alla memoria sulla base dei test di matching
o di un aumento di luminosità. Anche la distinzione delle tre scale dell'oceano e dei
regimi particellari resta parziale nei fotogrammi.

## Checklist manuale con musica live — non eseguita

Usare **system** o **microphone**; `fake` serve solo come controllo sintetico. L'app non
importa file. Per ogni prova annotare sorgente, qualità, scena, timestamp udito, cue,
comportamento osservato e contatori; confrontare almeno Low e High senza cambiare preset.

| Materiale | Prova e criterio osservabile |
|---|---|
| Techno | Groove stabile: viaggio continuo, massa del terreno, accenti locali; nessuna frattura sulla sola cassa |
| Hard techno / hardstyle | Build→release: preparazione distinta dalla rottura; solidi ancora riconoscibili dopo l'accento |
| Psytrance | Bassi rapidi: velocità leggibile, nessun tremolio del paesaggio a ogni transient; flussi volumetrici |
| Melodica | Modi e strutture cambiano con la frase; il ritorno richiama solo gli alberi pertinenti |
| Voce dominante | Medi leggibili senza far collassare solidi o saturare bloom e filamenti |
| Ambient | Onde lente e crescita; nessun viaggio o burst inventato in assenza di evidenza |
| Sezioni poco ritmiche | Nessuna metrica forzata; movimento assestato e nessuna frattura da aspettativa |
| Transizioni molto dinamiche | Breakdown, pausa, ripresa: niente flash da vecchi timestamp, niente conferme retroattive |

Ripetere cambi scena, pausa/ripresa e nuova sessione; controllare una previsione ritirata
senza release. Guardare almeno dieci minuti per mondo sulla GPU integrata, registrando
frame lunghi e risorse. Finché queste prove mancano, i nuovi Worlds restano fuori dalla
regia automatica e la fedeltà musicale complessiva resta **PARTIAL / NOT TESTED**.
