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
  learned over ~16 bars; they set the phrase length (8/16 in electronic
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
