# Halo

Visualizzatore musicale desktop in tempo reale, ispirato ai visualizer di Windows Media Player, Winamp e MilkDrop, ricostruito con tecnologie moderne (Tauri, Rust, TypeScript, Three.js, GLSL). "Halo" è il nome provvisorio.

L'app **non dipende da nessun player**: cattura l'audio che il computer sta riproducendo (Spotify, YouTube, VLC, giochi…) e lo trasforma in una scena a tutto schermo.

```
SYSTEM AUDIO → AUDIO CAPTURE → AUDIO ANALYSIS → MUSIC INTERPRETER → VISUAL DIRECTOR → REAL-TIME VISUALIZER
```

> Il visualizer è l'interfaccia. Oltre alla scena si vedono solo le informazioni sulla sorgente, a sinistra, e un pulsante circolare in basso al centro. Tutto il resto compare quando serve e si richiude da solo.

La UI implementa il **design system Halo** (token, componenti, le 8 fasi del mockup *Screens → AppPhases*).

---

## Funzionalità

- Cattura dell'audio di sistema su **Windows** (WASAPI loopback) e **Linux** (monitor PipeWire/PulseAudio); microfono su tutte le piattaforme
- Un file audio trascinato sulla finestra viene riprodotto e visualizzato; in modalità browser c'è anche un segnale di test sintetico
- Analisi centralizzata: FFT, 5 bande, energia spettrale, waveform, onset, beat detection, stima BPM
- 8 mood e 5 modalità Experience componibili con scena e palette; direzione Auto opzionale con isteresi
- 6 scene su GPU: **Infinite Tunnel**, **Spectrum**, **Particle Field**, **Galaxy**, **Liquid**, **Oscilloscope**
- Composizione Halo: cielo con alone e stelle, **pavimento riflettente** con increspature, linea d'orizzonte, **crossfade di 0,9 s** tra le scene
- 4 preset di colore (**Nebula**, **Aurora**, **Ember**, **Mono**) che ricolorano scena e accento della UI
- Qualità Auto / Low / Medium / High, fullscreen, auto-hide di controlli e cursore
- Impostazioni persistenti, riconnessione automatica se il dispositivo si scollega

## Interfaccia

Tutta la UI dipende da tre valori: quale menu è aperto (`root`, `scene`, `audio`, `presets`, `direction`, `mood`, `experience`, `quality` oppure nessuno), se il pannello Settings è aperto e se l'app è in idle.

| # | Fase | Cosa si vede |
|---|---|---|
| 01 | Idle | Scena, now playing, core chiuso |
| 02 | Control active | Il core sale e si apre la ruota: Scene, Audio, Palette, Settings, Direction, Fullscreen |
| 03 | Scene | Anello delle 6 scene |
| 04 | Audio | Arco con System Audio e Microphone |
| 05 | Presets | Arco con le 4 palette |
| 06 | Direction | Mood, Experience, Auto e Quality (Auto / Low / Medium / High) |
| 07 | Settings | Pannello sopra il core |
| 08 | Auto-hide | Solo la scena; now playing attenuato, niente cursore |

- **Core**: apre la ruota. In un sub-ring torna alla ruota, con il pannello aperto lo chiude. Pulsa con l'audio.
- **Nei sub-ring** la scelta si applica subito e l'anello resta aperto, così si possono confrontare le opzioni.
- La ruota si chiude con un secondo click sul core, un click fuori, `Esc` o dopo 6 s di inattività.
- L'auto-hide scatta dopo 3, 5 o 10 s (impostabile); qualsiasi movimento del mouse o tasto riporta la UI.
- **Direction**: Mood (Euphoria, Dream, Dark, Pulse, Chaos, Ethereal, Melancholy, Focus), Experience (Ambient, Immersive, Reactive, Cinematic, Minimal), Auto. Una scelta manuale disattiva Auto.
- **Settings**: Mood intensity (0–1), Sensitivity, Smoothing, Beat response, Track info (Always / Dim / Hidden), Hide controls after, Hide cursor when idle, **Audio delay**.
- **Audio delay** (0–400 ms) ritarda l'analisi per compensare la latenza dell'uscita: l'audio di sistema viene catturato prima di arrivare alle cuffie, e con cuffie Bluetooth le immagini anticiperebbero il suono di 150–250 ms. Si regola a orecchio finché gli impulsi coincidono con la cassa.

### Tastiera e accessibilità

| Tasto | Azione |
|---|---|
| `Esc` | Chiude ruota e pannello; se è già tutto chiuso, esce dal fullscreen |
| `F11` / `F` | Fullscreen |
| `←` / `→` | Scena precedente / successiva (con la ruota chiusa) |
| `Spazio` | Pausa dell'animazione |
| Frecce, `Home`, `End` | Dentro la ruota: spostano il focus tra gli item |

Il core ha `aria-expanded` e un'etichetta che cambia in base allo stato; la ruota usa `role="menu"`, il pannello `role="dialog"` con focus trap e toggle `role="switch"`. L'anello di focus appare solo con `:focus-visible`. Con `prefers-reduced-motion` le transizioni della UI diventano istantanee.

## Architettura

```
 Audio Source            (speaker in loopback, microfono, file, generatore)
      │
      ▼
 AudioCaptureProvider    NativeAudioCapture · BrowserMicrophoneCapture · FileAudioProvider · FakeAudioProvider
      │  campioni PCM mono (pull, una volta per frame)
      ▼
 AudioAnalyzer           FFT 2048 · bande · AGC · smoothing · BeatDetector
      │
      ▼
 AudioFrame              misure normalizzate + RMS/Hz/dB, array riusati
      │
      ▼
 MusicInterpreter        ruoli + MusicContext + memoria della dinamica
      │ MusicState
      ▼
 VisualDirector          mood + Experience + capacità/matrice della scena
      │ ModulationState
      ▼
 Visualizer registry     auto-discovery + preset + palette
      │
      ▼
 RenderEngine            un layer per scena (post-processing proprio) → crossfade
      │                  → composizione Halo (cielo, pavimento riflettente, orizzonte)
      ▼
 Canvas                  sotto la UI Halo (now playing, dock, pannello)
```

Principi:

- **I visualizer non conoscono la sorgente audio**: ricevono `AudioFrame`, ruoli diretti, `ModulationState` e i colori della palette.
- **La sorgente audio non conosce i visualizer**: un provider espone solo `readSamples()`.
- **Un solo analizzatore**: nessun visualizer fa FFT per conto suo.
- **Il render engine non conosce l'audio engine** né la UI: riceve una callback `frameSource(dt)`.
- **Il loop di rendering non alloca**: buffer e oggetti Three.js vengono riusati tra i frame.

### Stack

| Livello | Tecnologia | Motivo |
|---|---|---|
| Desktop shell | **Tauri 2** | Binario leggero, WebView di sistema, backend Rust per il codice nativo |
| Cattura audio | **Rust + cpal 0.18** | WASAPI loopback su Windows senza workaround; stessa API per il microfono su tutte le piattaforme |
| Trasporto | Tauri `Channel` con payload binario | PCM `f32` little-endian, senza serializzazione JSON |
| Frontend | **TypeScript + Vite**, DOM vanilla | UI piccola: nessun framework necessario |
| Rendering | **Three.js** (WebGL2) + shader GLSL | Particelle, tunnel, galassia e onde calcolati sulla GPU; bloom e composizione in post-processing |
| Font | Geist (via `@fontsource-variable/geist`) | Incluso nel bundle: funziona offline e rispetta la CSP |

### Composizione del frame

1. Ogni scena disegna nel proprio render target, con il suo bloom.
2. Durante un cambio scena i due target vengono miscelati linearmente per 0,9 s.
3. Il pass finale (`renderer/compositeShader.ts`) aggiunge fondo, alone e stelle sopra l'orizzonte (al 47% dell'altezza), riflette il cielo sotto l'orizzonte con increspature sinusoidali, scurisce verso il basso e disegna la linea d'orizzonte.
4. La camera di ogni scena viene decentrata con `setViewOffset`, così il centro della scena cade al 52% × 38% della finestra.

## Avvio

### Requisiti

- Node.js ≥ 20, npm
- Rust stable (≥ 1.85)
- Dipendenze di sistema di Tauri: <https://v2.tauri.app/start/prerequisites/>
  - **Windows**: Microsoft C++ Build Tools, WebView2 (già presente su Windows 10/11)
  - **Linux (Fedora)**: `sudo dnf install webkit2gtk4.1-devel libsoup3-devel javascriptcoregtk4.1-devel alsa-lib-devel librsvg2-devel`
  - **Linux (Debian/Ubuntu)**: `sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libasound2-dev librsvg2-dev`

### Comandi

```bash
npm install

npm run desktop:dev      # app desktop (Tauri) con hot reload
npm run desktop:build    # installer / bundle di produzione

npm run dev              # solo frontend nel browser (segnale di test, file, microfono)
npm run check            # typecheck + lint + test + build del frontend
```

In modalità browser (`npm run dev`) "System Audio" non è disponibile: la sorgente di default è il segnale di test sintetico. Il microfono passa da `getUserMedia` e un file si può trascinare sulla finestra. È utile per sviluppare le scene senza compilare la parte Rust.

### Diagnostica della cattura nativa

```bash
cargo run -p audio-capture --example probe -- system       # loopback (Windows/macOS) o monitor (Linux)
cargo run -p audio-capture --example probe -- microphone
```

Elenca i dispositivi e stampa per 5 secondi campioni/s e picco del segnale catturato.

## Struttura delle cartelle

```
src/
  app/              App (controller e macchina a stati della UI), scorciatoie da tastiera
  audio/
    AudioEngine.ts  provider attivo + analizzatore
    capture/        AudioCaptureProvider e implementazioni
    analysis/       AudioAnalyzer, FFT, BeatDetector, smoothing/AGC, misure spettrali
    interpretation/ MusicInterpreter (entry point), DynamicsMemory
    visual-response/ ruoli, presenza, memoria sezioni e voci; alias VisualResponse compatibile
  director/         mood, Experience, matrice, VisualDirector, AutoDirection
  renderer/         RenderEngine (layer, crossfade, loop), composizione Halo, qualità
  visualizers/
    registry.ts     auto-discovery delle scene
    palettes.ts     i 4 preset di colore
    shared/         BaseVisualizer, dispose, defineVisualizer
    tunnel/ spectrum/ particle-field/ galaxy/ liquid/ oscilloscope/
                    index.ts + <Nome>Visualizer.ts + preset.json
  ui/               Dial (core + ruota), NowPlaying, SettingsPanel, icone, tokens.css, halo.css
  stores/           store osservabile, impostazioni persistenti
  platform/         differenze desktop/browser (fullscreen, disponibilità delle sorgenti)
  types/            AudioFrame, Visualizer, preset, qualità
native/
  audio-capture/    crate Rust: API di cattura platform-agnostic
    src/platform.rs selezione dei dispositivi per piattaforma (loopback su Windows/macOS, monitor su Linux)
    src/capture.rs  thread di cattura, downmix, consegna a chunk
src-tauri/          shell desktop: comandi Tauri, streaming verso il WebView
public/
```

Nota: la proposta iniziale prevedeva due crate separati, `native/windows-audio` e `native/linux-audio`. Con cpal la differenza tra piattaforme si riduce alla **scelta del dispositivo**, quindi c'è un solo crate e il codice specifico sta in `platform.rs`. Su Linux cpal usa il suo host PulseAudio, scritto interamente in Rust e compatibile con PipeWire, che non richiede librerie di sistema aggiuntive.

### Design token

`src/ui/tokens.css` contiene i token del design system Halo come custom property (`--void`, `--glass`, `--accent-live`, `--core-size`, `--dur-expand`, …). La UI usa sempre i token, mai valori copiati. `--accent-live` viene riscritto sullo stage con la prima tinta del preset attivo.

## AudioFrame

Prodotto una volta per frame da `AudioAnalyzer` (`src/types/audio.ts`):

| Campo | Range | Descrizione |
|---|---|---|
| `volume` | 0..1 | RMS con auto-gain e smoothing |
| `peak` | 0..1 | Picco istantaneo (senza auto-gain) |
| `bass` | 0..1 | 20–250 Hz |
| `lowMid` | 0..1 | 250–500 Hz |
| `mid` | 0..1 | 500–2000 Hz |
| `highMid` | 0..1 | 2–4 kHz |
| `treble` | 0..1 | 4–16 kHz |
| `energy` | 0..1 | Energia spettrale totale |
| `spectrum` | `Float32Array(128)` | Spettro logaritmico 30 Hz–16 kHz, 0..1 |
| `waveform` | `Float32Array(1024)` | Campioni −1..1, allineati allo zero-crossing |
| `beat` | boolean | `true` solo nel frame in cui viene rilevato un beat (sempre `false` con Beat response spento) |
| `beatPulse` | 0..1 | Impulso che salta a 1 sul beat e decade (0 con Beat response spento) |
| `onset` | 0..1 | Intensità dello spectral flux |
| `bpm` | number | Stima del tempo (0 finché non è nota) |

Come vengono calcolati:

1. **Bassi, cassa e volume** nel dominio del tempo, su finestre brevi per ridurre il ritardo: bassi = passa-basso a 250 Hz su 20 ms, cassa = passa-basso a 120 Hz su 10 ms, volume = RMS su 20 ms.
2. **Medi, acuti ed energia** dalla FFT (finestra di Hann su 2048 campioni), come potenza media della banda in dB.
3. **Normalizzazione adattiva** (`DynamicRange`): ogni livello in dB viene mappato in 0..1 mescolando una vista *assoluta* (tra il picco recente e un fondo lento: le sezioni forti risultano più grandi) e una *relativa* (scarto dalla media recente: ogni colpo si vede anche in un mix compresso). Funziona a qualsiasi volume di riproduzione; *Sensitivity* restringe l'intervallo, così i valori arrivano prima a 1.
4. Curva di contrasto e **smoothing** attack/release indipendente dal frame rate: la salita è quasi istantanea, la discesa segue *Smoothing*.
5. **Beat tracking** in due stadi. Gli *onset* sono salite della cassa sopra la sua media che superano una soglia adattiva: sono immediati ma rumorosi, perché anche le note di basso ne producono. Il *tempo* si ricava dall'autocorrelazione degli onset degli ultimi 6 s, con preferenza intorno a 120 BPM. Un beat viene emesso quando un onset cade vicino al beat previsto, che corregge anche la fase; se un colpo manca (un break) il tracker tiene il tempo fino a 4 battute. Prima di agganciare un tempo, gli onset vengono riportati direttamente come beat.

Misure su segnali di prova (mix realistici a 90, 124 e 174 BPM, anche a −26 dB): 100% dei colpi rilevati, precisione 86–95%, ritardo 11–17 ms, BPM entro ±3. Con un basso più forte della cassa il tracker può agganciarsi al levare: resta a tempo, ma sfasato di mezza battuta.

Gli array appartengono all'analizzatore e vengono riusati: i visualizer non devono conservarli tra un frame e l'altro né modificarli.

Le misure fisiche aggiuntive `rms`, `centroidHz`, `rolloffHz` (85% della potenza) e `spreadHz` sono indipendenti dall’AGC dello spettro grafico. Le tre misure spettrali riusano la FFT esistente su 20 Hz–16 kHz.

## Interpretazione musicale nel tempo

`MusicInterpreter` (alias compatibile `VisualResponse`) trasforma `AudioFrame` in ruoli condivisi: bassi → peso, medi → forma/flow, alti → dettaglio, impatti → eventi. Presence e audibilità per regione distinguono il segnale dal noise floor appreso e seguono fade/tagli.

Tre scale: impact/shimmer in millisecondi, motion/density attorno al secondo, openness/tension e sezioni su più secondi. `MusicContext` conserva tempo, intensità relativa, build/drop e stile delle voci; espone trend firmati di energia, motion, copertura, tensione e apertura, più memoria recente di picchi e drop. Lo stato musicale ha confidence, durata e stato precedente, con isteresi e conferma temporale.

Le sei scene interpretano gli stessi eventi secondo la propria geometria: un drop libera le spirali, apre il tunnel, espelle le particelle, allarga il fluido, emette un fronte sonar o carica i fosfori dell'oscilloscopio. In assenza sonora il moto si ferma e la memoria degli eventi decade.

Architettura, mood/modalità, Director, capacità e istruzioni di estensione: [docs/visual-director.md](docs/visual-director.md).

Audit precedente, costanti temporali, matrice delle scene, segnali deterministici e procedura di verifica: [docs/musical-semantics.md](docs/musical-semantics.md). L'overlay è solo di sviluppo (`?debug` o Shift+D), con dieci secondi di history.

## Aggiungere una scena

1. Crea una cartella `src/visualizers/<nome>/`.
2. Aggiungi `preset.json`:

   ```json
   {
     "name": "My Scene",
     "author": "Tu",
     "version": 1,
     "audio": { "sensitivity": 1, "smoothing": 1 },
     "camera": { "fov": 60, "distance": 10, "drift": 0.3 },
     "bloom": { "strength": 0.8, "radius": 0.5, "threshold": 0.2 },
     "visual": { "count": 1000 }
   }
   ```

   `audio.sensitivity` e `audio.smoothing` sono **moltiplicatori** delle impostazioni dell'utente; `visual` contiene i parametri propri della scena. I colori non stanno nel preset: arrivano dalla palette attiva tramite `setPalette`.

3. Implementa la scena. Estendendo `BaseVisualizer` hai già scena, camera prospettica, resize e dispose:

   ```ts
   import type { AudioFrame } from '../../types/audio';
   import type { PaletteColors, VisualizerContext } from '../../types/visualizer';
   import { BaseVisualizer } from '../shared/BaseVisualizer';

   export interface MyParams { count: number }

   export class MyVisualizer extends BaseVisualizer<MyParams> {
     init(context: VisualizerContext): void {
       // crea mesh e materiali; usa context.quality.density per scalare i conteggi
     }
     setPalette(colors: PaletteColors): void {
       // copia le 3 tinte nei materiali (senza allocare)
     }
     update(frame: AudioFrame, dt: number, time: number): void {
       // solo aggiornamenti: niente allocazioni qui
     }
   }
   ```

4. Esporta la definizione in `index.ts`:

   ```ts
   import { defineVisualizer } from '../shared/defineVisualizer';
   import type { VisualizerPreset } from '../../types/visualizer';
   import preset from './preset.json';
   import { MyVisualizer, type MyParams } from './MyVisualizer';

   export default defineVisualizer<MyParams>({
     id: 'my-scene',
     name: 'My Scene',
     description: 'Una riga di descrizione.',
     icon: 'scene',
     order: 7,
     preset: preset satisfies VisualizerPreset<MyParams>,
     create: (p) => new MyVisualizer(p),
   });
   ```

Non serve registrarla altrove: `registry.ts` trova automaticamente ogni `visualizers/*/index.ts` e la scena compare nell'anello Scene. L'anello principale resta a sei elementi; Mood usa otto posizioni. Verificare spaziatura e leggibilità quando si aggiungono altre voci.

Il contratto completo è in `src/types/visualizer.ts`:

```ts
interface Visualizer {
  readonly scene: Scene;
  readonly camera: Camera;
  init(context: VisualizerContext): void;
  setPalette(colors: PaletteColors): void;
  update(frame: AudioFrame, deltaTime: number, time: number, response: VisualResponseFrame, modulation?: ModulationState): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
```

`context.addPass(pass, 'pre-bloom' | 'post-bloom')` permette di aggiungere pass di post-processing (l'Oscilloscope lo usa per la persistenza dei fosfori); vengono smaltiti automaticamente quando la scena viene smontata. Riflesso e orizzonte li aggiunge il render engine: la scena deve solo disegnare ciò che sta sopra l'orizzonte.

## Qualità

| Qualità | Risoluzione | Densità geometrica | Bloom |
|---|---|---|---|
| High | 1× devicePixelRatio (max 2) | 100% | sì |
| Medium | 0,75× (DPR max 1,5) | 65% | sì |
| Low | 0,5× (DPR max 1,5) | 35% | no |
| Auto | parte da 1× (DPR max 1,5) | 100% | sì |

**Auto** riduce prima la sola risoluzione a 0,85×, poi passa a Medium, riduce bloom/risoluzione e infine a Low. Soglia di discesa: 3 s sotto 51 fps. Recupera un passo dopo almeno 30 s a 58 fps e cooldown di 60 s. Gli stalli non costituiscono evidenza. I cambi di sola risoluzione non ricreano la scena.

## Supporto piattaforme

| | System audio | Microfono | Stato |
|---|---|---|---|
| **Windows 10/11** | ✅ WASAPI loopback | ✅ | Target principale |
| **Linux** | ✅ sorgente monitor dell'uscita predefinita (PipeWire / PulseAudio) | ✅ PipeWire / PulseAudio (ALSA come fallback) | Verificata su Fedora 44 |
| **macOS** | ⚠️ tramite aggregate device di cpal (macOS 14.6+), non testato | ✅ | Non verificato |
| **Browser** (`npm run dev`) | ❌ | ✅ getUserMedia | Solo sviluppo |

## Limitazioni attuali

- **Metadati del brano**: non vengono ancora letti (su Windows servirebbero i Global System Media Transport Controls, su Linux MPRIS). Il now playing mostra la sorgente: "System Audio" e il nome del dispositivo, "Live input" per il microfono, nome e tempi per un file trascinato.
- **Linux**: "System Audio" registra il monitor dell'uscita predefinita *al momento dell'avvio della cattura*. Se poi si cambia uscita (per esempio dalle cuffie Bluetooth agli altoparlanti), bisogna riselezionare Audio → System Audio. Serve un server PipeWire o PulseAudio: con ALSA puro l'audio di sistema non è disponibile.
- **Windows**: la cattura WASAPI compila ed è verificata staticamente (`cargo check`/`clippy` per `x86_64-pc-windows-msvc`), ma non è ancora stata provata su una macchina Windows reale.
- **Dispositivo audio**: la UI Halo non prevede la scelta del dispositivo, quindi si usa sempre quello predefinito di sistema. Quando il predefinito cambia, cpal lo segue; se la cattura cade, l'app ritenta 5 volte.
- **Palette / Mood / Experience** sono indipendenti. I profili iniziali richiedono ulteriore taratura percettiva su registrazioni reali; Auto non classifica generi o struttura completa dei brani.
- **Fullscreen**: usa la finestra corrente; non c'è ancora la scelta del monitor.
- Il beat tracking si basa sulla cassa: con musica senza percussioni o molto sincopata il tempo può non agganciarsi (restano comunque livelli e onset). La latenza dell'uscita non viene rilevata automaticamente: va impostata con *Audio delay*.
- La qualità Auto misura solo il frame rate, non il tempo GPU.
- Test automatici su analisi, presenza, semantica temporale e grammatica delle scene; la cattura reale WASAPI richiede ancora una verifica su Windows.

## Roadmap

- Metadati del brano (GSMTC su Windows, MPRIS su Linux) e stato "nessun brano"
- Su Linux, seguire automaticamente il cambio di uscita predefinita; verifica su macOS
- Preset specifici per scena e caricamento di preset esterni
- Beat tracking multi-banda (rullante, hi-hat) e stima automatica della latenza dell'uscita
- Estendere i test alla macchina a stati della UI e ai dispositivi audio reali
