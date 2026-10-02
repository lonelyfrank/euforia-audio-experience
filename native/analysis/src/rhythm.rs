//! Onsets and tempo from the spectral flux, at hop rate.
//!
//! The onset detection function (ODF) is the per-region flux, each region
//! scaled by its own recent strongest value and weighted towards the low
//! end (kicks carry the beat in most music). Onsets are local peaks of the
//! ODF above an adaptive threshold, so they are reported one hop after the
//! peak. The tempo is the strongest periodicity of the ODF over the last
//! seconds: autocorrelation of the ODF and of its low region alone (the bass
//! carries the meter, so a kick/hat pattern is not read at 1.5 beats),
//! scored over the first multiples of each period, with a mild prior.

use crate::follow::Follower;

/// Seconds of ODF kept for the tempo estimate.
const TEMPO_HISTORY: f32 = 8.0;
/// Seconds of ODF needed before a tempo is reported.
const TEMPO_WARMUP: f32 = 3.0;
const RETEMPO_INTERVAL: f32 = 0.5;
pub const MIN_BPM: f32 = 60.0;
pub const MAX_BPM: f32 = 200.0;
/// Log-normal tempo prior: centre (BPM) and width (octaves).
const PRIOR_BPM: f32 = 120.0;
const PRIOR_OCTAVES: f32 = 1.0;
/// Region weights in the ODF: low, mid, high.
const WEIGHTS: [f32; 3] = [0.5, 0.3, 0.2];
/// Memory (s) of each region's strongest flux, and the smallest value it normalizes by (dB per bin).
const STRONGEST_MEMORY: f32 = 2.0;
const MIN_STRONGEST: f32 = 10.0;
/// Adaptive threshold: running mean (s) of the ODF, multiplier and offset.
const THRESHOLD_TAU: f32 = 0.4;
const THRESHOLD_GAIN: f32 = 1.4;
const THRESHOLD_OFFSET: f32 = 0.1;
/// Refractory period between onsets (s).
const MIN_INTERVAL: f32 = 0.05;
/// Onset density counted over this window (s).
const DENSITY_WINDOW: f32 = 2.0;
/// The analysis window (Hann) weighs the newest samples little, so the flux peaks
/// after the attack: this much (s) is taken off onset timestamps (measured on clicks).
const ODF_LATENCY: f64 = 0.0145;
/// Multiples of a candidate period checked by the tempo comb.
const COMB: usize = 4;
/// Onsets per second below which no tempo is trusted (a held chord's beating is periodic too).
const MIN_DENSITY: f32 = 0.3;
const FULL_DENSITY: f32 = 1.0;

/// An onset (attack) in the signal.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OnsetEvent {
    /// Capture clock of the ODF peak (sample index).
    pub sample: u64,
    pub time: f64,
    /// 0..1, relative to the recent strongest attacks.
    pub strength: f32,
    /// Region carrying most of it: 0 low, 1 mid, 2 high.
    pub region: u8,
}

/// Rhythm readings for the current hop.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RhythmReading {
    /// ODF value, 0..1.
    pub onset_strength: f32,
    /// Onsets per second over the last couple of seconds.
    pub onset_density: f32,
    /// Strongest periodicity (BPM); 0 while unknown.
    pub tempo_bpm: f32,
    /// 0..1: how clearly periodic the onsets are at that tempo.
    pub tempo_confidence: f32,
}

pub struct Rhythm {
    hop_seconds: f32,
    strongest: [f32; 3],
    regions: [f32; 3],
    threshold: Follower,
    previous: [f32; 2],
    previous_regions: [f32; 3],
    since_onset: f32,
    density: f32,
    history: Vec<f32>,
    history_low: Vec<f32>,
    index: usize,
    filled: usize,
    since_retempo: f32,
    scores: Vec<f32>,
    scores_low: Vec<f32>,
    reading: RhythmReading,
}

impl Rhythm {
    pub fn new(hop_seconds: f32) -> Self {
        let len = (TEMPO_HISTORY / hop_seconds).round() as usize;
        let max_lag = Self::lag_for(MIN_BPM, hop_seconds).ceil() as usize * COMB + 2;
        Self {
            hop_seconds,
            strongest: [MIN_STRONGEST; 3],
            regions: [0.0; 3],
            threshold: Follower::symmetric(THRESHOLD_TAU, 0.0),
            previous: [0.0; 2],
            previous_regions: [0.0; 3],
            since_onset: MIN_INTERVAL,
            density: 0.0,
            history: vec![0.0; len],
            history_low: vec![0.0; len],
            index: 0,
            filled: 0,
            since_retempo: 0.0,
            scores: vec![0.0; max_lag + 1],
            scores_low: vec![0.0; max_lag + 1],
            reading: RhythmReading::default(),
        }
    }

    fn lag_for(bpm: f32, hop_seconds: f32) -> f32 {
        60.0 / bpm / hop_seconds
    }

    /// One hop: `flux` = (low, mid, high) region flux in dB per bin; `sample` = capture clock of this hop.
    pub fn hop(&mut self, flux: [f32; 3], silent: bool, sample: u64, sample_rate: f32, hop: usize) -> (RhythmReading, Option<OnsetEvent>) {
        let dt = self.hop_seconds;
        let mut odf = 0.0;
        for r in 0..3 {
            let value = if silent { 0.0 } else { flux[r] };
            self.strongest[r] = (self.strongest[r] * (-dt / STRONGEST_MEMORY).exp()).max(value).max(MIN_STRONGEST);
            self.regions[r] = (value / self.strongest[r]).min(1.0);
            odf += WEIGHTS[r] * self.regions[r];
        }

        // Peak picking on the previous hop: it is a local maximum above the adaptive threshold.
        let [before, peak] = self.previous;
        let threshold = self.threshold.value * THRESHOLD_GAIN + THRESHOLD_OFFSET;
        self.since_onset += dt;
        let mut onset = None;
        if peak > before && peak >= odf && peak > threshold && self.since_onset >= MIN_INTERVAL {
            let region = (0..3).max_by(|&a, &b| (WEIGHTS[a] * self.previous_regions[a]).total_cmp(&(WEIGHTS[b] * self.previous_regions[b]))).unwrap_or(0);
            // Sub-hop peak position (parabola through the three hops), minus the window's latency.
            let curvature = before - 2.0 * peak + odf;
            let offset = if curvature < 0.0 { (0.5 * (before - odf) / curvature).clamp(-0.5, 0.5) } else { 0.0 };
            let peak_sample = sample as f64 - hop as f64 * (1.0 - f64::from(offset));
            let at = (peak_sample - ODF_LATENCY * f64::from(sample_rate)).max(0.0).round() as u64;
            onset = Some(OnsetEvent { sample: at, time: at as f64 / f64::from(sample_rate), strength: peak.min(1.0), region: region as u8 });
            self.since_onset = 0.0;
        }
        self.threshold.update(odf, dt);
        self.previous = [peak, odf];
        self.previous_regions = self.regions;
        self.density = self.density * (-dt / DENSITY_WINDOW).exp() + if onset.is_some() { 1.0 } else { 0.0 };

        self.history[self.index] = odf;
        self.history_low[self.index] = self.regions[0];
        self.index = (self.index + 1) % self.history.len();
        self.filled = (self.filled + 1).min(self.history.len());
        self.since_retempo += dt;
        if self.since_retempo >= RETEMPO_INTERVAL {
            self.since_retempo = 0.0;
            self.estimate_tempo(silent);
        }

        self.reading.onset_strength = odf.min(1.0);
        self.reading.onset_density = self.density / DENSITY_WINDOW;
        (self.reading, onset)
    }

    fn estimate_tempo(&mut self, silent: bool) {
        let n = self.filled;
        if silent || (n as f32) * self.hop_seconds < TEMPO_WARMUP {
            if silent {
                self.reading.tempo_confidence *= 0.5;
            }
            return;
        }
        let max_lag = (self.scores.len() - 1).min(n / 2);
        let start = (self.index + self.history.len() - n) % self.history.len();
        if !autocorrelate(&self.history, start, n, max_lag, &mut self.scores) {
            self.reading.tempo_confidence = 0.0;
            return;
        }
        let has_low = autocorrelate(&self.history_low, start, n, max_lag, &mut self.scores_low);
        let interpolate = |scores: &[f32], lag: f32| {
            let i = lag.floor() as usize;
            let t = lag - i as f32;
            if i + 1 > max_lag {
                0.0
            } else {
                scores[i] * (1.0 - t) + scores[i + 1] * t
            }
        };
        // A real beat period repeats at every multiple; a period that falls between
        // beats (e.g. 1.5 beats, kick against hat) only at some of them.
        let comb = |scores: &[f32], lag: usize| (1..=COMB).map(|m| interpolate(scores, (lag * m) as f32)).sum::<f32>() / COMB as f32;
        let (lo, hi) = (Self::lag_for(MAX_BPM, self.hop_seconds).floor() as usize, Self::lag_for(MIN_BPM, self.hop_seconds).ceil() as usize);
        let (mut best_lag, mut best_score) = (0usize, f32::MIN);
        for lag in lo.max(2)..=hi.min(max_lag) {
            let periodicity = if has_low { 0.5 * (comb(&self.scores, lag) + comb(&self.scores_low, lag)) } else { comb(&self.scores, lag) };
            let bpm = 60.0 / (lag as f32 * self.hop_seconds);
            let prior = (-0.5 * ((bpm / PRIOR_BPM).log2() / PRIOR_OCTAVES).powi(2)).exp();
            let score = periodicity * prior;
            if score > best_score {
                best_score = score;
                best_lag = lag;
            }
        }
        let best_raw = if best_lag > 0 { self.scores[best_lag] } else { 0.0 };
        if best_lag == 0 || best_raw <= 0.05 {
            self.reading.tempo_confidence *= 0.5;
            return;
        }
        // Parabolic refinement for a sub-hop period.
        let (a, b, c) = (self.scores[best_lag - 1], self.scores[best_lag], self.scores[(best_lag + 1).min(max_lag)]);
        let curvature = a - 2.0 * b + c;
        let offset = if curvature < 0.0 { (0.5 * (a - c) / curvature).clamp(-0.5, 0.5) } else { 0.0 };
        self.reading.tempo_bpm = 60.0 / ((best_lag as f32 + offset) * self.hop_seconds);
        // Periodicity (normalized autocorrelation) mapped to 0..1, only with real attacks.
        let attacks = ((self.density / DENSITY_WINDOW - MIN_DENSITY) / (FULL_DENSITY - MIN_DENSITY)).clamp(0.0, 1.0);
        self.reading.tempo_confidence = ((best_raw - 0.1) / 0.4).clamp(0.0, 1.0) * attacks;
    }
}

/// Unbiased normalized autocorrelation of the last `n` values of a ring for lags 1..=max_lag;
/// false when the signal is flat (nothing to correlate).
fn autocorrelate(ring: &[f32], start: usize, n: usize, max_lag: usize, scores: &mut [f32]) -> bool {
    let len = ring.len();
    let at = |i: usize| ring[(start + i) % len];
    let mean = (0..n).map(at).sum::<f32>() / n as f32;
    let energy: f32 = (0..n).map(|i| (at(i) - mean).powi(2)).sum();
    if energy / (n as f32) < 1e-4 {
        return false;
    }
    for lag in 1..=max_lag {
        let mut r = 0.0;
        for i in lag..n {
            r += (at(i) - mean) * (at(i - lag) - mean);
        }
        scores[lag] = r / energy * n as f32 / (n - lag) as f32;
    }
    true

}
