//! A bank of comb-filter resonators over the onset function (after Scheirer,
//! 1998), one per candidate tempo between MIN_BPM and MAX_BPM, run on the whole
//! onset function and on its low region (the bass names the beat). Each one feeds
//! its output back one beat period later, so it rings when the onsets repeat
//! at its period; the one with the most energy names the tempo. Octave errors
//! are handled explicitly: a candidate's score also counts its double and
//! half periods, and when the double-time or half-time resonator holds most
//! of its energy the faster/slower reading is taken only if it beats the
//! current one clearly. It keeps ringing for a while when onsets go missing,
//! which is what the beat tracker needs to hold the grid through gaps.
//!
//! Experimental: off by default (see `AnalyzerOptions::resonators`), until a
//! corpus comparison shows it helps.

use crate::rhythm::{MAX_BPM, MIN_BPM};

/// Tempo step between resonators (relative): ~1%.
const STEP: f32 = 1.01;
/// Half-life (s) of a resonator's ringing.
const HALF_LIFE: f32 = 2.5;
/// Time constant (s) of each resonator's energy.
const ENERGY_TAU: f32 = 1.5;
/// Tempo prior: log-normal around this BPM, width in octaves.
const PRIOR_BPM: f32 = 120.0;
const PRIOR_OCTAVES: f32 = 1.2;
/// Weights of the double- and half-period resonators in a candidate's score.
const DOUBLE_WEIGHT: f32 = 0.5;
const HALF_WEIGHT: f32 = 0.25;
/// The reading changes octave only when the other octave scores this much better.
const OCTAVE_MARGIN: f32 = 1.25;

struct Resonator {
    /// Period in hops (fractional).
    period: f32,
    feedback: f32,
    /// Delay lines of the whole onset function and of its low region.
    line: Vec<f32>,
    line_low: Vec<f32>,
    index: usize,
    energy: f32,
    energy_low: f32,
}

impl Resonator {
    fn step(&mut self, x: f32, x_low: f32, energy_k: f32) {
        let len = self.line.len();
        let whole = self.period.floor() as usize;
        let frac = self.period - whole as f32;
        let (a, b) = ((self.index + len - whole) % len, (self.index + len - whole - 1) % len);
        // Output one period ago (linear interpolation in the delay line).
        let delayed = self.line[a] * (1.0 - frac) + self.line[b] * frac;
        let delayed_low = self.line_low[a] * (1.0 - frac) + self.line_low[b] * frac;
        let y = self.feedback * delayed + (1.0 - self.feedback) * x;
        let y_low = self.feedback * delayed_low + (1.0 - self.feedback) * x_low;
        self.index = (self.index + 1) % len;
        self.line[self.index] = y;
        self.line_low[self.index] = y_low;
        self.energy += (y * y - self.energy) * energy_k;
        self.energy_low += (y_low * y_low - self.energy_low) * energy_k;
    }

    fn total(&self) -> f32 {
        self.energy + self.energy_low
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ResonatorReading {
    pub bpm: f32,
    /// 0..1: how much the winning resonator stands out from the bank.
    pub confidence: f32,
}

pub struct ResonatorBank {
    hop_seconds: f32,
    resonators: Vec<Resonator>,
    mean: f32,
    mean_low: f32,
    energy_k: f32,
    current: Option<usize>,
    reading: ResonatorReading,
}

impl ResonatorBank {
    pub fn new(hop_seconds: f32) -> Self {
        let rate = 1.0 / hop_seconds;
        let mut resonators = Vec::new();
        let mut bpm = MIN_BPM;
        while bpm <= MAX_BPM {
            let period = 60.0 / bpm * rate;
            resonators.push(Resonator {
                period,
                feedback: 0.5f32.powf(period / (HALF_LIFE * rate)),
                line: vec![0.0; period.ceil() as usize + 2],
                line_low: vec![0.0; period.ceil() as usize + 2],
                index: 0,
                energy: 0.0,
                energy_low: 0.0,
            });
            bpm *= STEP;
        }
        Self { hop_seconds, resonators, mean: 0.0, mean_low: 0.0, energy_k: 1.0 - (-hop_seconds / ENERGY_TAU).exp(), current: None, reading: ResonatorReading::default() }
    }

    fn bpm_of(&self, i: usize) -> f32 {
        60.0 / (self.resonators[i].period * self.hop_seconds)
    }

    /// The resonator nearest to `bpm`, if within the bank.
    fn nearest(&self, bpm: f32) -> Option<usize> {
        if !(MIN_BPM..=MAX_BPM * 1.001).contains(&bpm) {
            return None;
        }
        let i = ((bpm / MIN_BPM).ln() / STEP.ln()).round() as usize;
        (i < self.resonators.len()).then_some(i)
    }

    fn score(&self, i: usize) -> f32 {
        let bpm = self.bpm_of(i);
        let energy = |b: f32| self.nearest(b).map_or(0.0, |j| self.resonators[j].total());
        let prior = (-0.5 * ((bpm / PRIOR_BPM).log2() / PRIOR_OCTAVES).powi(2)).exp();
        (self.resonators[i].total() + DOUBLE_WEIGHT * energy(bpm / 2.0) + HALF_WEIGHT * energy(bpm * 2.0)) * prior
    }

    /// One hop of the onset function and of its low region (0..1); `silent` lets the bank decay.
    pub fn hop(&mut self, odf: f32, low: f32, silent: bool) -> ResonatorReading {
        // Centre the inputs on their running means, so the bank rings on the pattern, not the level.
        self.mean += (odf - self.mean) * self.energy_k;
        self.mean_low += (low - self.mean_low) * self.energy_k;
        let (x, x_low) = if silent { (0.0, 0.0) } else { (odf - self.mean, low - self.mean_low) };
        for r in &mut self.resonators {
            r.step(x, x_low, self.energy_k);
        }
        let n = self.resonators.len();
        let best = (0..n).max_by(|&a, &b| self.score(a).total_cmp(&self.score(b))).unwrap_or(0);
        // Octave hysteresis: keep the current reading unless the new one, at another octave, wins clearly.
        let chosen = match self.current {
            Some(c) if c != best => {
                let ratio = self.bpm_of(best) / self.bpm_of(c);
                let other_octave = (ratio.log2().round().abs() >= 1.0) && (ratio.log2() - ratio.log2().round()).abs() < 0.05;
                if other_octave && self.score(best) < self.score(c) * OCTAVE_MARGIN { c } else { best }
            }
            _ => best,
        };
        self.current = Some(chosen);
        let total: f32 = self.resonators.iter().map(Resonator::total).sum();
        let mean = total / n as f32;
        let peak = self.resonators[chosen].total();
        // Peak-to-mean ratio of the bank mapped to 0..1 (a flat bank: no tempo).
        let contrast = if mean > 1e-9 { peak / mean } else { 0.0 };
        self.reading = ResonatorReading { bpm: self.bpm_of(chosen), confidence: ((contrast - 1.5) / 3.0).clamp(0.0, 1.0) };
        self.reading
    }
}
