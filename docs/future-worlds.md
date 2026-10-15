# Mondi futuri: Harmonic Cathedral e Gravitational Abyss

Data: 15 ottobre 2026. **Solo progetto**: nessuna scena, nessun placeholder nel menu, nessun codice. Il brief
«Generative Worlds Expansion» (§7) chiede di prepararli senza implementarli. Entrambi si costruiscono con ciò che
esiste dopo questa espansione ([generative-worlds](generative-worlds.md)): `WorldRecipe` + `RigCamera`, i profili di
locomozione, le leggi scritte in GLSL e in TS, i cue musicali e la cognizione.

## Harmonic Cathedral

**Identità.** Un'architettura geometrica che cresce con la struttura della musica: navate, archi, pilastri e
rosoni costruiti per battute e frasi. La musica non la fa pulsare: la *edifica*, e quando si ripete la ritrova.

**Camera.** Hover + Orbit leggero: osservatore quasi fermo al centro della navata, che si gira lentamente con il
mondo (`Orbit.share` piccolo, `carry` zero) e alza lo sguardo verso ciò che cresce (`Hover.rise`, `reframe` sul
pezzo appena aggiunto).

**Grammatica.**

| Musica | Architettura | Da dove |
|---|---|---|
| battuta (downbeat con confidenza) | un modulo (una campata: due pilastri e un arco) | `cognition.clock` via cue — oggi i cue espongono `phrase`, non il downbeat: aggiungere un cue `bar` osservato, solo con `downbeatConfidence` ≥ soglia, mai un 4/4 presunto |
| frase | una navata chiusa (n campate), poi una nuova direzione (transetto) | cue `phrase` |
| ricorrenza (`repetition`, pattern) | il modulo costruito sulla stessa configurazione si riaccende invece di aggiungerne uno nuovo | la memoria tipizzata di Resonant Forest (firma di sei tratti), riusata |
| armonia (`tonalShape`, `harmonicity` della morfologia) | proporzioni: archi a tutto sesto per suoni armonici, ogivali per suoni duri | `GeometryState` |
| rilascio udito | il rosone si apre (una figura polare: lo slot `surface` di Spectral Shell come rosone) | cue `release` confermato |
| breakdown | le campate più vecchie si spengono e restano come linee | fase `breakdown` |

**Riuso.** Moduli come istanze di un template (come `emergenceLaw`: pezzi rigidi, un anello per pezzo), posati su un
reticolo fisso del pavimento; una "legge della cattedrale" in GLSL e TS (posizione di un vertice di un modulo da
indice di campata, fase di costruzione, proporzione). Nessuna fisica: crescere è una funzione pura dell'età del
modulo sul tempo della musica. Pool fisso (≤ 64 campate), un draw call per spigoli e uno per facce.

**Rischi.** Senza downbeat affidabile la cattedrale non deve costruire per battute: fallback per frasi o per tempo
vissuto del groove. Va validato con musica reale prima di qualsiasi altra cosa.

## Gravitational Abyss

**Identità.** Uno spazio senza fondo con nuclei, orbite e campi: materia che cade verso centri di massa, solidi
sospesi che girano, la profondità come protagonista.

**Camera.** Orbit + Drift: l'osservatore gira attorno al nucleo dominante (`Orbit.focus` sul nucleo più massivo) e
deriva lentamente verso il basso lungo l'asse dell'abisso (un `Drift` sull'asse verticale invece che laterale:
estendere il profilo con un asse configurabile, oggi è solo x).

**Grammatica.**

| Musica | Abisso | Da dove |
|---|---|---|
| bassi (pressione) | la massa dei nuclei: pozzi più profondi | `WorldView.pressure` → i `wells` di Particle Field (`render-systems/fields/wells.ts`) |
| groove | il periodo delle orbite (la materia gira con il mondo: `dTurn`) | `WorldView` |
| tensione accumulata | i nuclei si avvicinano (spirale) | `forces.charge` / `potential` |
| rilascio udito | i nuclei si fondono o si separano; un fronte radiale | cue `release`, `WaveField` |
| alti | scie e particelle sottili | traccianti (`FieldTracerPrimitive`) |

**Riuso.** Il campo vettoriale e i traccianti di Vector Field (con pozzi centrati sui nuclei), `SolidPrimitive` per i
pochi solidi sospesi (come Fractured Expanse), `ShockwavePrimitive` per i fronti. Le orbite non hanno tempo proprio:
l'angolo di un corpo è una quota del giro del mondo, come l'Orbit della camera.

**Rischi.** Costo GPU dei traccianti sulla iGPU (Vector Field a High non tiene i 60 fps a 720p): a Low solo nuclei e
linee. Non è una copia di Vector Field solo se la camera e la topologia (abisso verticale, più nuclei) lo rendono un
luogo; altrimenti non va fatto.

## Ordine proposto

1. Validare con musica reale i quattro mondi di questa espansione (checklist in [generative-worlds](generative-worlds.md)).
2. Harmonic Cathedral, dopo un cue `bar` osservato e validato.
3. Gravitational Abyss, dopo aver esteso `Drift` con un asse e misurato i traccianti a Low.
