//! Online normalization 2.0: the context that separates an absolute reading
//! from its relative meaning. Per-band adaptive noise floor (activity =
//! signal above floor), online loudness percentiles (typical level and peak
//! context without storing history) and smoothed first derivatives of the
//! slow descriptors. O(bands) per hop, no allocation, no FFT.

use crate::frame::{FeatureFrame, BANDS};
use crate::SILENCE_DB;

/// Quantiles of the momentary loudness: P10 (quiet passages), P50 (typical), P90, P95 (peak context).
pub const QUANTILES: [f32; 4] = [0.1, 0.5, 0.9, 0.95];
/// LU/s a quantile estimate may move. Stochastic quantile tracking: the
/// estimate rises by `p` and falls by `1 - p` steps, so it settles where a
/// fraction `p` of the recent readings lie below it. P95 falls at 0.15 LU/s:
/// a loud passage stays the peak context for a minute or so.
const QUANTILE_RATE: f32 = 3.0;
/// Smallest P10–P95 span (LU) used to place a reading: a compressed master is not stretched to full range.
const MIN_SPAN: f32 = 6.0;

/// Band floors start here and follow quiet bands down at once.
const FLOOR_START: f32 = -80.0;
const FLOOR_FALL_TAU: f32 = 0.3;
/// Without detected music, a steady band level is background: the floor rises to it at this rate (dB/s).
const FLOOR_RISE_IDLE: f32 = 6.0;
/// With music, only a steady level within a few dB of the floor may raise it, and slowly,
/// so a sustained pad is never absorbed into the floor.
const FLOOR_RISE_MUSIC: f32 = 0.2;
const FLOOR_NEAR: f32 = 6.0;
const FLOOR_STEADY: f32 = 3.0;
const FLOOR_MAX: f32 = -30.0;
const STEADY_TAU: f32 = 0.5;
/// dB above the floor before a band counts as active, and the span to full activity.
const ACTIVE_FROM: f32 = 3.0;
const ACTIVE_SPAN: f32 = 30.0;

/// Smoothing of a value before differentiation, and of its derivative (s).
const LEVEL_TAU: f32 = 0.25;
const SLOPE_TAU: f32 = 0.5;

/// Smoothed first derivative (units/s) of a value that may update in steps (slow DSP rates).
#[derive(Clone, Copy, Default)]
struct Slope {
    level: f32,
    slope: f32,
    started: bool,
}

impl Slope {
    fn update(&mut self, x: f32, active: bool, dt: f32) -> f32 {
        if !active || !self.started {
            // No sound, no motion: restart from the current value instead of differentiating a gate.
            self.level = x;
            self.slope *= (-dt / SLOPE_TAU).exp();
            self.started = active;
            return self.slope;
        }
        let previous = self.level;
        self.level += (x - self.level) * (1.0 - (-dt / LEVEL_TAU).exp());
        self.slope += ((self.level - previous) / dt - self.slope) * (1.0 - (-dt / SLOPE_TAU).exp());
        self.slope
    }
}

pub struct Context {
    quantiles: [f32; 4],
    quantiles_ready: bool,
    floor: [f32; BANDS],
    steady: [f32; BANDS],
    slopes: [Slope; 4],
}

impl Default for Context {
    fn default() -> Self {
        Self {
            quantiles: [crate::SILENT_LUFS; 4],
            quantiles_ready: false,
            floor: [FLOOR_START; BANDS],
            steady: [SILENCE_DB; BANDS],
            slopes: [Slope::default(); 4],
        }
    }
}

impl Context {
    /// Keeps the learned band floors (the room or device), forgets the music.
    pub fn reset(&mut self) {
        let floor = self.floor;
        *self = Self::default();
        self.floor = floor;
    }

    /// Reads the frame's levels and descriptors of this hop; writes the context fields.
    pub fn hop(&mut self, f: &mut FeatureFrame, dt: f32) {
        let sounding = f.sounding && !f.silent;
        self.floors(f, dt);
        if sounding && f.loudness_momentary > crate::SILENT_LUFS {
            let m = f.loudness_momentary;
            if !self.quantiles_ready {
                self.quantiles = [m; 4];
                self.quantiles_ready = true;
            }
            for (q, p) in self.quantiles.iter_mut().zip(QUANTILES) {
                *q += QUANTILE_RATE * dt * if m > *q { p } else { p - 1.0 };
            }
            // The steps can cross; keep the estimates ordered.
            for i in 1..4 {
                self.quantiles[i] = self.quantiles[i].max(self.quantiles[i - 1]);
            }
        }
        f.loudness_quantiles = self.quantiles;
        let span = (self.quantiles[3] - self.quantiles[0]).max(MIN_SPAN);
        f.loudness_position =
            if sounding && self.quantiles_ready { ((f.loudness_momentary - self.quantiles[0]) / span).clamp(0.0, 1.0) } else { 0.0 };
        f.brightness_slope = self.slopes[0].update(f.perceived_brightness, sounding, dt);
        f.entropy_slope = self.slopes[1].update(f.entropy, sounding, dt);
        f.complexity_slope = self.slopes[2].update(f.complexity, sounding, dt);
        f.harmonicity_slope = self.slopes[3].update(f.harmonicity, sounding, dt);
    }

    fn floors(&mut self, f: &mut FeatureFrame, dt: f32) {
        if f.silent {
            // Digital silence says nothing about the background.
            f.band_floor_db = self.floor;
            f.band_level = [0.0; BANDS];
            return;
        }
        let fall = 1.0 - (-dt / FLOOR_FALL_TAU).exp();
        let k = 1.0 - (-dt / STEADY_TAU).exp();
        for b in 0..BANDS {
            let db = f.band_db[b];
            let steady = &mut self.steady[b];
            *steady = if *steady <= SILENCE_DB { db } else { *steady + (db - *steady) * k };
            let floor = &mut self.floor[b];
            if db < *floor {
                *floor += (db - *floor) * fall;
            } else if (db - *steady).abs() < FLOOR_STEADY {
                let rate = if !f.sounding {
                    FLOOR_RISE_IDLE
                } else if db < *floor + FLOOR_NEAR {
                    FLOOR_RISE_MUSIC
                } else {
                    0.0
                };
                *floor = (*floor + rate * dt).min(db).min(FLOOR_MAX);
            }
            f.band_floor_db[b] = *floor;
            f.band_level[b] = ((db - *floor - ACTIVE_FROM) / ACTIVE_SPAN).clamp(0.0, 1.0);
        }
    }
}

/// Next downbeat on the predicted grid (s, capture clock); 0 while not tracking.
/// `beats_per_bar` is the grouping the grid uses (the internal fallback while the
/// meter is unknown): the forecast is weighted by the downbeat confidence, not gated.
pub fn next_downbeat(next_beat: f64, bpm: f32, bar_phase: f32, beats_per_bar: u8) -> f64 {
    if beats_per_bar == 0 || next_beat <= 0.0 || bpm <= 0.0 {
        return 0.0;
    }
    let m = u32::from(beats_per_bar);
    let current = ((bar_phase.clamp(0.0, 0.9999) * m as f32) as u32).min(m - 1);
    let beats = (m - (current + 1) % m) % m;
    next_beat + f64::from(beats) * 60.0 / f64::from(bpm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_downbeat_counts_the_remaining_beats() {
        // 120 BPM in 4: on beat 2 (bar phase 0.25) the next beat is 3, the downbeat two beats after it.
        assert!((next_downbeat(10.0, 120.0, 0.3, 4) - 11.0).abs() < 1e-9);
        // On the last beat the next beat is the downbeat.
        assert!((next_downbeat(10.0, 120.0, 0.8, 4) - 10.0).abs() < 1e-9);
        // In 3: from the downbeat, two beats to go.
        assert!((next_downbeat(10.0, 120.0, 0.0, 3) - 11.0).abs() < 1e-9);
        assert_eq!(next_downbeat(10.0, 120.0, 0.5, 0), 0.0);
    }
}
