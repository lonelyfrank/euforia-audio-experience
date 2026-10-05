//! Harmonic/percussive split by median filtering (Fitzgerald 2010), causal:
//! a bin's harmonic estimate is its median over the last HISTORY hops (steady
//! partials survive, attacks don't), its percussive estimate the median over
//! neighbouring bins in the current hop (broadband attacks survive, partials
//! don't). Soft (Wiener) masks give each bin's share. The harmonic estimate
//! lags by about half the history (≈ 50 ms), so it suits the slow readings
//! (how percussive a passage is), not onset timing.

use crate::follow::{power_db, Follower};

/// Analyses in the time median (the split runs every 4 hops: ≈ 107 ms at 48 kHz).
const HISTORY: usize = 5;
/// Bins on each side in the frequency median.
const SPREAD: usize = 8;
/// Upper frequency of the split (Hz): above it there is little to gain for the cost.
const MAX_HZ: f32 = 11_000.0;
/// Region edges (Hz) of the per-region shares.
const EDGES: [f32; 4] = [30.0, 250.0, 2000.0, MAX_HZ];
const SHARE_TAU: f32 = 0.08;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct HpssReading {
    /// Share of the power that is percussive, 0..1: whole range and low / mid / high regions.
    pub percussive: f32,
    pub percussive_low: f32,
    pub percussive_mid: f32,
    pub percussive_high: f32,
    pub harmonic_db: f32,
    pub percussive_db: f32,
    pub harmonic_share: f32,
    pub percussive_share: f32,
    pub residual_share: f32,
}

pub struct Hpss {
    bins: usize,
    history: Vec<f32>,
    index: usize,
    filled: usize,
    scratch: Vec<f32>,
    edges: [usize; 4],
    shares: [Follower; 4],
}

impl Hpss {
    pub fn new(sample_rate: f32, fft_size: usize) -> Self {
        let bin_hz = sample_rate / fft_size as f32;
        let bins = ((MAX_HZ.min(sample_rate / 2.0) / bin_hz) as usize).min(fft_size / 2);
        Self {
            bins,
            history: vec![0.0; bins * HISTORY],
            index: 0,
            filled: 0,
            scratch: vec![0.0; HISTORY.max(2 * SPREAD + 1)],
            edges: EDGES.map(|hz| ((hz / bin_hz) as usize).clamp(1, bins)),
            shares: [Follower::symmetric(SHARE_TAU, 0.0); 4],
        }
    }

    /// One hop: `power` per FFT bin (at least `bins` long).
    pub fn hop(&mut self, power: &[f32], dt: f32) -> HpssReading {
        let bins = self.bins;
        self.history[self.index * bins..(self.index + 1) * bins].copy_from_slice(&power[..bins]);
        self.index = (self.index + 1) % HISTORY;
        self.filled = (self.filled + 1).min(HISTORY);

        let mut residual_total = 0.0f32;
        let mut clean_h = 0.0f32;
        let mut clean_p = 0.0f32;
        let mut harmonic_total = 0.0f32;
        let mut percussive_total = 0.0f32;
        let mut region = [(0.0f32, 0.0f32); 3];
        for k in self.edges[0]..self.edges[3] {
            let h = {
                let s = &mut self.scratch[..self.filled];
                for (j, v) in s.iter_mut().enumerate() {
                    *v = self.history[j * bins + k];
                }
                median(s)
            };
            let p = {
                let (lo, hi) = (k.saturating_sub(SPREAD), (k + SPREAD + 1).min(bins));
                let s = &mut self.scratch[..hi - lo];
                s.copy_from_slice(&power[lo..hi]);
                median(s)
            };
            // Wiener masks (power²) split the bin's actual power.
            let (h2, p2) = (h * h, p * p);
            let total = h2 + p2;
            if total <= 0.0 {
                continue;
            }
            let (hp, pp) = (power[k] * h2 / total, power[k] * p2 / total);
            // Ambiguous bins go to residual; clean shares + residual conserve power.
            let residual = 2.0 * hp.min(pp);
            residual_total += residual;
            clean_h += hp - residual * 0.5;
            clean_p += pp - residual * 0.5;
            harmonic_total += hp;
            percussive_total += pp;
            let r = if k < self.edges[1] {
                0
            } else if k < self.edges[2] {
                1
            } else {
                2
            };
            region[r].0 += hp;
            region[r].1 += pp;
        }
        let share = |h: f32, p: f32| if h + p > 1e-12 { p / (h + p) } else { 0.0 };
        HpssReading {
            percussive: self.shares[0].update(share(harmonic_total, percussive_total), dt),
            percussive_low: self.shares[1].update(share(region[0].0, region[0].1), dt),
            percussive_mid: self.shares[2].update(share(region[1].0, region[1].1), dt),
            percussive_high: self.shares[3].update(share(region[2].0, region[2].1), dt),
            harmonic_share: clean_h / (harmonic_total + percussive_total).max(1e-12),
            percussive_share: clean_p / (harmonic_total + percussive_total).max(1e-12),
            residual_share: residual_total / (harmonic_total + percussive_total).max(1e-12),
            harmonic_db: power_db(harmonic_total),
            percussive_db: power_db(percussive_total),
        }
    }
}

/// Median of a small slice (reorders it); allocation-free.
fn median(values: &mut [f32]) -> f32 {
    let mid = values.len() / 2;
    *values.select_nth_unstable_by(mid, f32::total_cmp).1
}
