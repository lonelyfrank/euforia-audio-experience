# Experience engine: decisions and measurements

Working notes of the live "lighting director" engine (analysis → timing →
structure → dynamics → director → renderer). Each phase adds its decisions
and what was measured; what could not be verified is said explicitly.

## Phase 2b — Resonator bank for the tempo (experimental, off)

`AnalyzerOptions { resonators: true }` replaces the beat tracker's tempo
source (autocorrelation of the onset function, every 0.5 s) with a bank of
comb-filter resonators (Scheirer 1998) between 60 and 200 BPM in ~1% steps,
run on the whole onset function and on its low region, with explicit octave
scoring (double/half periods) and octave hysteresis. The PLL is unchanged:
the bank only gives it a tempo and a confidence; the tracker now lets go of
the grid only when the tempo source has lost confidence too, so a ringing
bank holds the grid through gaps.

A/B on synthetic grooves (`cargo run -p spectrum-analysis --release --example tempo_ab`,
2026-10-02). Lock = first of 4 consecutive beats within 30 ms of a true beat
at ±2% tempo; tempo and phase errors after 10 s.

| case | lock (s) default | lock (s) resonators | phase (ms) default | phase (ms) resonators |
|---|---|---|---|---|
| groove 75 | 6.40 | 11.18 | 2.2 | 8.6 |
| groove 90 | 8.00 | 3.98 | 1.8 | 3.6 |
| groove 120 | 5.00 | 3.99 | 3.1 | 3.7 |
| groove 128 | 6.57 | 3.73 | 3.0 | 4.2 |
| groove 140 | 4.72 | 3.84 | 3.5 | 4.3 |
| groove 174 | 4.49 | 4.12 | 4.1 | 4.9 |
| 120 → 126 at 12 s | 5.00 | 3.99 | 18.4 | 19.1 |
| 120, 4 s break | 5.00 | 3.99 | 2.6 | 3.0 |

Tempo errors are ≤ 0.12% in both; both keep all 8 beats through the break.
The bank locks about 1–4 s sooner in 7 of 8 cases but is slower at 75 BPM
and its phase error is 0.4–6 ms higher (its tempo is quantized to 1% steps;
the PLL absorbs most of it). **Decision: off by default.** It is turned on
only if the corpus comparison (GiantSteps / Harmonix replayed through the
loopback, same harness) shows a measurable gain. Not run yet: the corpus
audio is not available here (Harmonix does not distribute audio).

## Phase 3 — Live structure

`native/analysis/src/structure.rs`, reported as `Event::Section` (stamped at
the downbeat a section starts on) and as frame fields (section, bars, phrase
position and predicted next phrase boundary, novelty, similarity to 4/8/16
bars before, `section_return`, `drop_expected`, genre priors).

- Features are averaged per beat: level (mean power, from the 43 ms bands —
  the 400 ms momentary loudness smeared each beat into the previous one),
  spectral shape relative to the level, centroid, flatness, percussive
  shares, onset density, chroma, mean onset function.
- A change is decided one beat after a downbeat, comparing that first beat
  with the first beats of the 4 bars before (same metric position: an accent
  on the one is not novelty). Large jumps are boundaries whatever the
  novelty statistics say; subtle ones need novelty > 2σ.
- Rules: drop = energy up with the low end back *and present* (sub band
  within 16 dB of the level; snare bodies at ~190 Hz must not read as bass);
  build = low end gone while attacks keep coming (instantaneous onset
  function, not the 2 s density), without an energy collapse; break = energy
  down with fewer attacks, or an energy collapse; outro = a slow fade over 8
  bars after at least 32. Sections last ≥ 4 bars (a build ≥ 2).
- A drop or cut on a beat that is not the one moves the bar onto it (the
  downbeat accent is often lost in a break).
- Returns: a section's second bar against the second bars of earlier
  sections of the same kind (the first still carries the previous section
  in its smoothed features); similarity scaled by the song's own novelty.
- Without a trusted grid, free 0.5 s beats keep the structure moving at low
  confidence and only ≥ 6 dB changes count. No decision before 5 whole bars
  of sound.
- Genre priors (four-on-the-floor, drum and bass, hip-hop, band, ambient,
  acoustic): fuzzy evidence from tempo, density, tonality and percussion,
  learned over ~16 bars (from tempo, grid confidence, onset density and
  tonality — not the harmonic/percussive share, which is a share of power and
  stays low in any mix with sustained pads or bass); they set the phrase length (8/16 in electronic
  music, 4 in ambient/acoustic) and how eagerly builds are read.

Measured on synthetic tracks (tests/structure.rs): a 60-bar dance track
(intro, build, drop, break, drop, fading outro) is segmented exactly (each
boundary on its downbeat; the outro is recognised 6 bars into the fade), the
second drop is reported as a return of the first, phrase boundaries are
predicted on the downbeat. Short 32 s cycles after a beatless ambient part:
drops and breaks within 1 bar, builds 2 bars late (the grid only locks once
the build's snare roll has started) — a known limit. Cost: ~1% of a core
more (5.3% total on the throttled i7 at 900 MHz). Not verified: real music
and the corpus (boundary error criterion: ±1 bar on ≥ 60%).

## Phase 4 — Dynamics layer (core + first fixture)

`src/dynamics/` (pure TS, no DOM or rendering). The Director (Phase 5) will
write timed targets and impulses; the renderer reads values every frame.

- Two primitives, kept distinct: **envelopes** (flash, hit) jump to the peak
  at the event's exact time and decay exponentially — evaluated analytically,
  so an impulse is never quantized to a step or a frame and adds no latency;
  **springs** (pulse, swing, glide, drift; ω and ζ in `presets.ts`) use the
  exact solution of the damped oscillator per fixed step (240 Hz by default),
  on absolute multiples of the audio clock, read interpolated between steps.
- Clock: the capture time heard when the frame is seen (`Timing.heardTime`).
  Events are queued sorted; past ones (late reports) take effect at once, an
  envelope then starts at its peak when first seen. A snap zeroes spring
  velocities, holds ζ = 1 for a while and clears envelopes. The layer starts
  over when the capture clock does (a new source).
- First fixture migrated: the Halo composition's halo pulse (`uImpact`).
  `CueScheduler` schedules predicted beats ahead at their exact time
  (weighted by the grid's weight), takes kicks off the grid on the fast path
  (skipping those that are a scheduled beat) and snaps at section changes.

Measured (tests): step responses match theory (critically damped glide/drift:
no overshoot, 90% at 3.89/ω, 2% at 5.83/ω; pulse/swing overshoot e^(−πζ/√(1−ζ²)));
values identical at 60 and 144 fps and with irregular frames; a snap leaves
no trail after one bar. In the browser on the synthetic 124 BPM beat, the
time from a kick being heard to the halo pulse reaching half its peak:

| quality | before (per-frame envelope) | after (Dynamics) |
|---|---|---|
| Low (60 fps) | median 35.2 ms, max 61.5 | median 9.9 ms, max 15.6 |
| High (~30 fps here) | median 72.2 ms, max 85.5 | median 26.4 ms, max 43.4 |

The `hit` preset (60 ms decay) was first used and dropped: at 30 fps a frame
can land after the pulse fell below half, so `flash` (120 ms) is used.

### Director parameters on the Dynamics layer (first batch)

With the audio clock available (`SceneInput.rig`), the per-scene
`VisualDirector` sets spring *targets* on its own Dynamics instance for the
slow, symmetric parameters — expansion and rotation (`glide`), camera
motion, depth, persistence and contrast (`drift`) — and its `impact` is the
rig's timed pulse (predicted beats, kicks), scaled by how much the scene
and mood take transients. Hosts without a clock keep the old envelopes.
Mood fluidity/persistence no longer stretch these six parameters' times:
the type is the Director's choice, the coefficients live in the presets.
The level-tracking parameters (scale, distortion, turbulence, particle
emission, brightness, bloom, visibility) follow audio levels with a fast
attack and a slow release, which neither primitive reproduces. Decision
(user, 2026-10-03): a third primitive, the **follower** (one pole per
direction, fixed step, interpolated, deterministic on the audio clock),
with presets `level` (40/400 ms), `sparkle` (15/250 ms) and `swell`
(250/900 ms). The Director picks each follower's type from how fluid the
mood × experience is (slow tier above 1.7, fast below 0.55, with
hysteresis): e.g. Dream/Ambient scale → `swell`, Chaos/Reactive → `sparkle`.
All 13 continuous parameters are now on the Dynamics layer; `impact` is the
rig's timed pulse.

## Phase 5 — Show director and fixture rig

Decisions (user, 2026-10-04): each **scene is a fixture**; the **palette
stays the user's** (the director only picks which of its three hues leads,
per slot); the three modes **replace Auto** (Direction → Rig: Preset /
Hybrid / Free; a saved Auto setting becomes Hybrid).

- `src/show/ShowDirector.ts` (pure): decides the look (fixtures, lead hue,
  effect, symmetry, brightness ceiling) at section changes, or at phrase
  boundaries after a 16-bar hold (hybrid/free; it was 8 — the phrases in
  between now vary only the colour, see below); movement per bar (sweep,
  fan); impulses on the predicted beat (pulse, chase, mirror accents).
  Returning sections reuse their kind's look. A breath (near blackout via a
  fast `dim` parameter) on the last beat before an expected drop, then a
  snap. Ceilings: drop 1, build 0.7, intro 0.6, outro 0.5, break 0.45;
  supporting fixtures at 45% of the protagonist. No beat effects under a
  0.3 grid weight. Seeded from section, tempo, key, genre and mode; every
  decision logged with why. Preset plays the chosen scene as designed: full
  brightness, its own colours, no effects, no breath; Hybrid keeps the
  chosen scene as protagonist with variations and the automatic mood;
  Free also picks the fixtures (by affinity to the section).
- `src/show/GpuBudget.ts`: fixture cost units from the measured frame rate
  (start at 1, +1 after 10 s at ≥ 57 fps up to Low 3 / Medium 2.2 / High
  1.6, −1 after 2 s under 50 fps, then no increase for 60 s).
- Renderer: three slots (crossfade within each), up to four composed
  layers with weight, scale, offset, mirrored pair and strobe; per-slot
  palette hue order. Each slot's parameters are Dynamics channels
  (intensity glide, dim sparkle, size pulse, offset swing, strobe flash).

Measured in the browser (Low, synthetic "ambient → build → drop"): Free
grows to 3 fixtures within ~20 s and stays at 60 fps (p95 16.8 ms); looks
change only at sections/phrases; the second drop and break come back with
their looks. Preset: one scene at full brightness, no effects. Not verified:
real music, High quality with several fixtures on this iGPU (the budget
should keep it to one), the look on Windows/WebView2.

### Completing Phase 5

- **Scene envelopes on the audio clock.** Timed hits (predicted beats,
  kicks) are logged with their audio time (`HitLog`) and handed to scenes
  with the clock (`SceneClock`, a new optional argument of `update`).
  Liquid's shock rings take their age from `now − hit time`
  (`ShockRings`): they start on the hit, not on the frame that noticed a
  rising envelope, and look the same at any frame rate (test at 30/60/144
  fps). Particle Field's count eases exactly. The other per-frame state in
  the scenes is phase integration (`phase += rate·dt`), which is already
  frame-rate independent; no other edge detection on transients remains.
- **Colour at three time scales**, within the user's palette: the look
  picks each fixture's lead hue; each phrase between look changes leans it
  toward its second hue (`tint`, 0–0.35, a glide); beat flashes take its
  accent hue (in the composition, at the layer's own luminance). Preset
  never tints.

## Phase 6 — Safety, bench, measurements

- **Flash guard** (`src/dynamics/FlashGuard.ts`): every light transient of
  the rig — the halo pulse that drives the scenes' impacts, and fixture
  strobes — passes one rate limit on its audio timestamp: flashes at least
  1/3 s apart (≤ 3 per second, WCAG 2.3.1); one too close becomes a
  shimmer under the 10% threshold; fixtures on the same beat (±20 ms) are
  one flash. Settings → Reduce flashing: one per second at half strength.
  Beats up to 180 BPM pass untouched. Not covered: light a scene makes on
  its own from continuous features (e.g. the drop's glow), which is not a
  transient of the rig.
- **Bench** (`npm run bench`, also in `npm test`): grooves at 124 and 174
  BPM → WASM analysis in 10 ms batches → rhythm gate → cue scheduler with
  the guard → Dynamics, read at 30/60/144 fps, perfect clock, no output
  latency.

  | | 30 fps | 60 fps | 144 fps |
  |---|---|---|---|
  | scheduled hit − kick (median / max) | 3.0 / 3.6 ms | 2.7 / 3.8 ms | 2.7 / 3.8 ms |
  | kick → fixture ≥ 50% (median / max), 124 BPM | 18.3 / 34.4 ms | 12.4 / 18.3 ms | 5.4 / 9.2 ms |
  | same at 174 BPM | 21.8 / 36.8 ms | 12.6 / 20.1 ms | 7.4 / 10.8 ms |

  Every kick has a hit within 10 ms (the agreed analysis-side threshold),
  and the fixture is on by the first frame after its hit (≤ 1 frame +
  the hit's error). Across frame rates the values agree to 6·10⁻³ on the
  instants they share: the Dynamics layer is exact for the same events,
  but a predicted beat is scheduled from whichever frame first sees it
  (hit times differ by ≤ 0.8 ms). Preset step responses (1 kHz):

  | type | rise 90% / fall 10% | overshoot | settle 2% |
  |---|---|---|---|
  | flash / hit | 0.277 / 0.139 s (fall) | – | 0.469 / 0.234 s |
  | pulse | 0.123 s | 12.6% | 0.313 s |
  | swing | 0.262 s | 25.4% | 1.119 s |
  | glide / drift | 1.036 / 5.164 s | 0 | 1.551 / 7.741 s |
  | level / sparkle / swell | 0.097 / 0.039 / 0.580 s | 0 | 0.160 / 0.062 / 0.982 s |
- **Overlay**: followers show rise/fall, envelopes their decay (springs
  already showed ω, ζ); the flash guard's limits and count; phrase tints.
- **Corpus tool** (`cargo run -p spectrum-analysis --release --example
  corpus -- <dir>`): streams annotated WAVs as live and scores beat F1
  (±70 ms), median phase, downbeat F1 and sections within ±1 bar against
  the agreed thresholds. No real corpus is available here. On its own
  synthetic corpus (`--synth`: 100/124/174 BPM, intro–build–drop–break–drop,
  16 bars each, a drumless break): beat F1 0.854, phase 5.2 ms, downbeat
  F1 0.775 — and sections only 4/12. Two weaknesses it shows: a drumless
  break reports no section (the grid is lost and structure counts bars on
  the grid), and at 100 and 174 BPM the intro→build and build→drop changes
  of these tracks are missed. Resonators on: beat F1 0.797 (worse), so they
  stay off.
