# Generative Worlds: moto del mondo, ambienti procedurali, ecosistemi musicali

Data: 15 ottobre 2026. Branch `generative-worlds` da `scene-taxonomy-worlds` (`80206a7`), **non pushato**.
Brief: «Generative Worlds Expansion — Hybrid World Motion, Procedural Environments & Musical Ecosystems».
Tutto deterministico e con audio live: nessuna traccia precaricata, nessuna rete, nessun modello generativo,
nessun secondo WorldEngine, DSP, beat tracker, solver o registry.

<!-- COMMITS -->

## 1. Stato iniziale (audit)

Il branch di partenza conteneva già ciò che il brief chiede di verificare prima (§0):

| Area | Trovato | Uso in questa espansione |
|---|---|---|
| Tassonomia | `category` obbligatoria nel registry (`particles`/`worlds`/`spectrum`), menu Scene → famiglia → scena, `scenesOf`/`categoryOf` | Le nuove scene sono `category: 'worlds'` con un `order` dopo il Terrain: compaiono da sole nell'anello Worlds |
| Composizione | `VisualWorld` + `WorldRecipe` (slot di primitive, budget, presenza) + `RecipeVisualizer` | Bastano: nessun livello di composizione nuovo. Aggiunto solo un campo opzionale `camera` alla recipe |
| Camera | `Observer` condiviso (inerzia, orbita come quota del giro del mondo) per le recipe Particles; il Tunnel ha il suo coordinatore; il Terrain tiene la camera ferma e fa scorrere il suolo | Il contratto nuovo affianca l'`Observer`, non lo sostituisce; Tunnel e Terrain invariati |
| Emersione | `EmergenceField` (pool fisso, ciclo dormant → … → recycle, cue, `FractureGate`), legge GLSL/TS ancorata a `terrainHeight` | Riutilizzata per i monoliti (posizionamento "pianura", forme, landmark: tutto spento di default) |
| Solidi | `SolidSystem` dentro `StructuralSystem`, popolazioni (`SolidPrimitive` + `population`) solo DEV | Riutilizzati per Fractured Expanse, la prima scena di prodotto fatta di solidi |
| Cue musicali | `snapshot.cues`: anticipazione, previsione, accento, frase, rilascio **udito** | Ogni azione irreversibile dei mondi nuovi agisce solo su `release` confermati |

Baseline prima di toccare il codice: typecheck e lint verdi; `vitest` 88 file, 739 test passati, 5 falliti, 1 saltato.
I cinque falliti erano quattro benchmark e un timeout di `AnalysisHost` con la CPU limitata a 10 W (batteria in
scarica); ripetuti da soli con un worker passano tutti (744 + 1 saltato). Core Rust non toccato.

<!-- REST -->
