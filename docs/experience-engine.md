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
