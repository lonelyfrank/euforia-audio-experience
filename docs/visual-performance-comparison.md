# Visual Performance Comparison — 15 ottobre 2026

Confronto della baseline grafica `2e7024c` con le quattro correzioni su
`audit/visual-fidelity`. I report indicano rispettivamente `2e7024c` e `2b14e66`.
I benchmark storici restano conservati nei loro documenti.

## Metodo

`scripts/visual-performance-browser.mjs`: applicazione reale, sorgente **fake buildDrop**,
worker WASM, RAF reale; pagina nuova per scena/qualità, viewport 1280×720, DPR 1, palette
e preset di prodotto, direzione manuale, riflessione spenta, qualità fissa. Attesa fino
a 16 s uditi, poi sei secondi di campionamento. Le 21 condizioni coprono Spectrum,
Terrain, i quattro Worlds nuovi e Matter Field nelle tre qualità. Gli altri sistemi
hanno contatori GPU e immagini nelle 48 corse deterministiche, **non** una comparazione
di FPS live dedicata.

GPU: ANGLE / Mesa Intel UHD Graphics CML GT2, OpenGL ES 3.2, Chromium headless. Risoluzioni
effettive 640×360 / 960×540 / 1280×720. Nessun test CPU o altro browser di questa campagna
in parallelo alle misure live. Il desktop e applicazioni dell'utente restano attivi:
**macchina non isolata**, frequenze/temperatura non fissate. Una sola corsa per condizione
non fornisce intervalli di confidenza né prova una piccola variazione percentuale.

- FPS = frame / somma degli intervalli RAF grezzi; p50/p95/p99 per rango superiore.
- CPU source / layers / composite dai confini diagnostici esistenti del renderer.
  Include aggiornamento e sottomissione; il DSP nel worker non è attribuito alla GPU.
- GPU da `EXT_disjoint_timer_query_webgl2`, lettura differita, coda limitata a otto query,
  campioni disjoint scartati. Quantili CPU/GPU non sono coppie sullo stesso frame.
- Draw, triangoli, punti, linee, geometrie, texture e programmi includono tutti i pass
  (`renderer.info.autoReset=false`). Non sono una misura delle primitive distinguibili
  nell'immagine. I triangoli includono anche fullscreen pass e postprocessing.
- Heap JS del browser, non VRAM; `solid ms` è il contatore filtrato del componente,
  non un profiler separato per ogni vincolo XPBD.

Dati grezzi: [prima](visual-fidelity/performance-before.json.gz),
[dopo](visual-fidelity/performance-after.json.gz).
Tutti i quantili, contatori e valori heap sono nel
[confronto JSON](visual-fidelity/performance-comparison.json).

Riproduzione (con Playwright/Chromium già disponibili, nessuna nuova dipendenza):

```sh
PLAYWRIGHT_MODULE=/percorso/playwright-core/index.mjs \
CHROMIUM_PATH=/percorso/chrome FIDELITY_OUTPUT=/tmp/euforia-performance \
node scripts/visual-performance-browser.mjs
node scripts/visual-performance-summary.mjs \
  /tmp/euforia-performance-before/performance.json \
  /tmp/euforia-performance-after/performance.json \
  /tmp/euforia-performance-comparison.json
```

## Misure live

| Scena / qualità | FPS prima→dopo | frame p95/p99 dopo ms | GPU p95 prima→dopo ms | >33 / >50 ms dopo | draw max prima→dopo |
|---|---:|---:|---:|---:|---:|
| spectrum / low | 60.00→60.00 | 16.67 / 16.67 | 1.69→1.67 | 0 / 0 (360) | 2→2 |
| terrain / low | 60.00→60.00 | 16.67 / 16.67 | 1.07→1.05 | 0 / 0 (360) | 4→4 |
| monolith-desert / low | 60.00→60.00 | 16.67 / 16.67 | 0.94→0.98 | 0 / 0 (360) | 4→4 |
| fractured-expanse / low | 60.00→60.00 | 16.67 / 16.67 | 0.88→0.89 | 0 / 0 (360) | 9→9 |
| pulse-ocean / low | 60.00→60.00 | 16.67 / 16.67 | 0.86→0.89 | 0 / 0 (360) | 3→3 |
| resonant-forest / low | 60.00→60.00 | 16.67 / 16.67 | 1.04→1.03 | 0 / 0 (360) | 5→5 |
| matter-field / low | 60.00→60.00 | 16.67 / 16.67 | 1.35→1.37 | 0 / 0 (360) | 8→8 |
| spectrum / medium | 44.34→45.00 | 33.33 / 33.34 | 13.87→14.48 | 90 / 0 (270) | 16→16 |
| terrain / medium | 49.50→50.34 | 33.33 / 33.33 | 11.66→12.06 | 58 / 0 (302) | 19→19 |
| monolith-desert / medium | 47.54→50.67 | 33.33 / 33.33 | 12.40→11.31 | 56 / 0 (304) | 17→19 |
| fractured-expanse / medium | 50.69→53.67 | 33.33 / 33.34 | 10.75→10.28 | 38 / 0 (322) | 24→24 |
| pulse-ocean / medium | 51.34→52.82 | 33.33 / 33.34 | 11.08→10.74 | 43 / 0 (316) | 17→17 |
| resonant-forest / medium | 49.86→52.65 | 33.33 / 33.34 | 12.00→10.96 | 44 / 0 (315) | 19→19 |
| matter-field / medium | 41.33→42.38 | 33.33 / 33.34 | 16.13→15.80 | 106 / 0 (255) | 27→27 |
| spectrum / high | 32.83→33.76 | 33.34 / 50.00 | 22.11→21.49 | 149 / 1 (202) | 16→16 |
| terrain / high | 35.50→36.33 | 33.34 / 33.34 | 19.99→20.05 | 140 / 0 (218) | 19→19 |
| monolith-desert / high | 35.74→35.83 | 33.34 / 33.34 | 19.72→20.14 | 143 / 0 (215) | 19→19 |
| fractured-expanse / high | 38.61→40.83 | 33.33 / 33.34 | 17.49→15.47 | 115 / 0 (245) | 24→24 |
| pulse-ocean / high | 38.00→38.33 | 33.33 / 33.34 | 18.04→19.06 | 130 / 0 (230) | 17→17 |
| resonant-forest / high | 37.40→37.90 | 33.34 / 33.34 | 18.92→18.48 | 133 / 0 (228) | 19→19 |
| matter-field / high | 25.50→26.17 | 50.00 / 50.01 | 32.59→30.51 | 151 / 2 (157) | 28→28 |

## Risorse, avvio e limiti

Tutte le corse Low mantengono **60 fps**, nessun frame oltre 33 ms. Medium resta circa
42–54 fps, High circa 26–41 fps. Non emergono cali di FPS medi rispetto alla baseline
nelle finestre misurate. Questo non prova un'ottimizzazione: migliorano anche scene
pixel-identiche e non modificate. Zero errori del browser e zero query disjoint.

Gli incrementi sono dichiarati: **Monolith Desert High**, CPU layers p95
2,010→2,390 ms e GPU p95 19,72→20,14 ms; Medium aggiunge due draw call (17→19).
Il campo iniziale ora contiene geometria utile, il costo resta nel budget osservato
e il frame rate non cala. Anche Spectrum Medium (GPU p95 13,87→14,48 ms) e Ocean High
(18,04→19,06 ms), entrambi invariati, hanno picchi maggiori: con una sola corsa e macchina
non isolata non si può attribuirli al codice. Non nascondere questi scarti dietro gli FPS.

Le soglie `>33` e `>50` sono applicate ai tempi grezzi: 33,333 ms conta oltre 33;
un valore appena sopra 50 per precisione RAF può contare oltre 50 senza essere un salto
di un ulteriore refresh. I campioni completi permettono di distinguere i due casi.

CPU p95 in High, millisecondi prima→dopo (le altre qualità e p50/p99 sono nel JSON):

| Scena | Source | Layers | Composite |
|---|---:|---:|---:|
| Spectrum | 2,805→2,670 | 1,485→1,675 | 0,195→0,175 |
| Terrain | 2,685→2,420 | 1,865→1,935 | 0,205→0,200 |
| Monolith Desert | 2,645→2,945 | 2,010→2,390 | 0,200→0,220 |
| Fractured Expanse | 2,620→2,405 | 5,085→4,300 | 0,265→0,185 |
| Pulse Ocean | 2,700→2,440 | 1,620→1,580 | 0,185→0,190 |
| Resonant Forest | 2,390→2,335 | 2,185→1,835 | 0,225→0,205 |
| Matter Field | 3,245→2,955 | 2,770→2,515 | 0,215→0,180 |

Risorse massime dopo, High; heap senza GC forzato, quindi non confrontabile come leak:

| Scena | Geometrie / texture / programmi | Triangoli inviati per frame | Heap MiB |
|---|---:|---:|---:|
| Spectrum | 2 / 15 / 11 | 17 | 47,72 |
| Terrain | 5 / 13 / 14 | 22.335 | 41,99 |
| Monolith Desert | 5 / 13 / 14 | 13.175 | 43,53 |
| Fractured Expanse | 8 / 19 / 18 | 89 | 52,33 |
| Pulse Ocean | 3 / 13 / 12 | 30.015 | 42,52 |
| Resonant Forest | 6 / 13 / 15 | 16.815 | 43,24 |
| Matter Field | 9 / 26 / 21 | 22.526 | 50,08 |

Le correzioni non eliminano effetti, non cambiano risoluzione, MSAA, bloom, conteggi
particellari o solver. La semina iniziale del deserto fa comparire prima strutture entro
lo stesso pool: quando prima non c'era geometria visibile può aggiungere draw call.
Il beneficio è la leggibilità documentata, non un aumento promesso di FPS.

Le 48 corse deterministiche contengono un campione di risorse per secondo per tutte le
scene. `mountMs` misura costruzione e attesa di `Layer.ready`: intervallo osservato
19,3–318,9 ms prima, 14,8–387,9 ms dopo. Il replay dopo era concorrente ai test CPU;
questi numeri descrivono le acquisizioni e **non** costituiscono una regressione misurata
del cold start. Non misurano download, avvio dell'app o caricamento a cache vuota.

La prova di [lifecycle](visual-fidelity/lifecycle-final.json) usa lo stesso renderer e
la stessa sessione: 48 visite complete più 32 cambi rapidi. Nessuna crescita GPU oltre
i massimi già osservati nelle visite finali, zero errori. I cambi completi includono
il crossfade di 0,9 s. Nessuna pretesa di certificare leak del driver o stabilità per ore.

La [sessione continuativa](visual-fidelity/soak.json) completa 40 cicli del workspace
in 6,12 minuti su Matter Field Low / `beat124`, con REC, isolamento e laboratori.
Timer, observer, listener globali, sessione e override tornano ai valori iniziali;
GPU stabile ai ritorni (4 geometrie, 11 texture, 9 programmi). Heap dopo GC:
21,03 MiB prima dell'apertura della diagnostica, 23,16–26,00 MiB ai ritorni,
25,97 MiB finale; nodi DOM 242→298, listener DOM 66→81. I pannelli caricati restano
montati. Il test passa per le risorse e il lifecycle che controlla; non certifica
memoria costante, VRAM del driver o tutti i Worlds per dieci minuti ciascuno.

## Coesistenza dei solidi sperimentali

`FIDELITY_SOLIDS=1 FIDELITY_SCENES=matter-field FIDELITY_QUALITIES=low,high` aggiunge
lo slot DEV esistente a runtime. Stesso warmup e finestra di sei secondi, nessun solido
aggiunto alla recipe di prodotto. [Dati live](visual-fidelity/performance-solids.json.gz).

| Qualità | FPS | GPU p95 ms | CPU layers p95 ms | Draw max | Geometrie / texture / programmi |
|---|---:|---:|---:|---:|---:|
| Low | 60,00 | 1,43 | 2,57 | 11 | 10 / 11 / 12 |
| High | 25,07 | 33,97 | 3,99 | 31 | 12 / 26 / 24 |

Il controllo prodotto senza lo slot aveva 60,00 / 26,17 fps e CPU layers p95
inferiore. Il costo aggregato dei solidi è visibile, soprattutto sulla CPU; non si
ottiene gratuitamente la coesistenza. Zero errori. Le immagini dimostrano corpi e
materia insieme, non ricomposizione completa o risonanza individuale percepibile.

I sei Worlds a 30/60 fps mantengono cue e stabilità numerica, ma il percorso completo
non produce topologia identica in Terrain/Expanse: [rapporto musicale](music-reactivity-report.md).
Questa proprietà non si deduce dagli FPS. Lo stesso vale per leggibilità delle foglie,
memoria della foresta, increspature e dettagli tenui a Low.
