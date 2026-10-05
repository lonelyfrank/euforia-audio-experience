//! Shared spectral descriptors. ERB projection uses the existing power spectrum;
//! phase prediction uses its complex bins. No FFT and no allocation here.
use crate::follow::power_db;
use crate::{FeatureFrame, BANDS};

pub struct Acoustic {
    erb_map: Vec<(usize, f32)>,
    phase: Vec<f32>,
    delta: Vec<f32>,
    magnitude: Vec<f32>,
    previous_dt: f32,
    ready: u32,
    bands: [f32; BANDS],
    previous_width: f32,
    previous_balance: f32,
    range_low: f32,
    range_high: f32,
    range_ready: bool,
}

fn wrap(x: f32) -> f32 {
    (x + std::f32::consts::PI).rem_euclid(std::f32::consts::TAU) - std::f32::consts::PI
}

impl Acoustic {
    pub fn new(sr: f32, size: usize) -> Self {
        let erb = |hz: f32| 21.4 * (1.0 + 0.00437 * hz).log10();
        let top = erb((sr / 2.0).min(16000.0));
        let bins = size / 2 + 1;
        Self {
            erb_map: (0..bins)
                .map(|k| {
                    let x = (erb(k as f32 * sr / size as f32) / top * 23.0).clamp(0.0, 23.0);
                    (x.floor() as usize, x.fract())
                })
                .collect(),
            phase: vec![0.0; bins],
            delta: vec![0.0; bins],
            magnitude: vec![0.0; bins],
            previous_dt: 0.0,
            ready: 0,
            bands: [-96.0; BANDS],
            previous_width: 0.0,
            previous_balance: 0.0,
            range_low: -70.0,
            range_high: -70.0,
            range_ready: false,
        }
    }

    pub fn analyze(&mut self, power: &[f32], spectrum: &[(f32, f32)], bin_hz: f32, dt: f32, f: &mut FeatureFrame) {
        let lo = (20.0 / bin_hz).ceil().max(1.0) as usize;
        let hi = ((16000.0 / bin_hz).floor() as usize).min(power.len() - 1);
        let total = power[lo..=hi].iter().sum::<f32>();
        let n = (hi + 1 - lo) as f32;
        let mut entropy = 0.0;
        let mut spread = 0.0;
        let mut top = 0.0f32;
        let mut peaks = 0.0f32;
        let mut deviation = 0.0;
        let mut change = 0.0;
        let mut amplitude_sum = 0.0;
        let mut velocity = 0.0;
        let mut inst = 0.0;
        f.erb.fill(0.0);
        let phase_ready = self.ready >= 2 && (dt - self.previous_dt).abs() < 1e-5;
        for k in lo..=hi {
            let p = power[k];
            let share = p / total.max(1e-20);
            if share > 1e-12 {
                entropy -= share * share.ln();
            }
            spread += share * (k as f32 * bin_hz - f.centroid_hz).powi(2);
            top = top.max(p);
            if k > lo && k < hi && p > power[k - 1] && p > power[k + 1] && p > total * 0.002 {
                peaks += 1.0;
            }
            let (band, fraction) = self.erb_map[k];
            f.erb[band] += p * (1.0 - fraction);
            if band < 23 {
                f.erb[band + 1] += p * fraction;
            }
            let (re, im) = spectrum[k];
            let phi = im.atan2(re);
            let d = wrap(phi - self.phase[k]);
            let expected = std::f32::consts::TAU * k as f32 * bin_hz * dt;
            let amplitude = (re * re + im * im).sqrt();
            let error = wrap(d - self.delta[k]);
            if phase_ready {
                deviation += share * error.abs() / std::f32::consts::PI;
                let old = self.magnitude[k];
                change += (amplitude * amplitude + old * old - 2.0 * amplitude * old * error.cos()).max(0.0).sqrt();
            }
            amplitude_sum += amplitude;
            velocity += share * d / dt;
            inst += share * (k as f32 * bin_hz + wrap(d - expected) / (std::f32::consts::TAU * dt));
            self.phase[k] = phi;
            self.delta[k] = d;
            self.magnitude[k] = amplitude;
        }
        self.ready += 1;
        self.previous_dt = dt;
        let sounding = !f.silent && total > 1e-12;
        f.entropy = if sounding { (entropy / n.ln()).clamp(0.0, 1.0) } else { 0.0 };
        f.complexity = if sounding { (peaks / 24.0).min(1.0) } else { 0.0 };
        f.spectral_crest = if sounding { top / (total / n).max(1e-20) } else { 0.0 };
        f.spread_hz = if sounding { spread.sqrt() } else { 0.0 };
        f.phase_deviation = if sounding && phase_ready { deviation.clamp(0.0, 1.0) } else { 0.0 };
        f.phase_coherence = if sounding && phase_ready { 1.0 - f.phase_deviation } else { 0.0 };
        f.complex_change = if sounding && phase_ready { (change / amplitude_sum.max(1e-12)).min(1.0) } else { 0.0 };
        f.phase_velocity = if sounding { velocity } else { 0.0 };
        f.instantaneous_hz = if sounding { inst.max(0.0) } else { 0.0 };
        let mut weight = 0.0;
        let mut bright = 0.0;
        let mut low = 0.0;
        let mut sharp = 0.0;
        for (b, value) in f.erb.iter_mut().enumerate() {
            // Compressive auditory excitation, relative within this frame, not calibrated sones.
            let excitation = value.max(0.0).powf(0.3);
            weight += excitation;
            bright += excitation * b as f32 / 23.0;
            if b < 7 {
                low += excitation;
            }
            sharp += excitation * (b as f32 / 23.0).powi(3);
            *value = if sounding { ((power_db(*value) + 80.0) / 80.0).clamp(0.0, 1.0) } else { 0.0 };
        }
        f.perceived_brightness = if sounding { bright / weight.max(1e-12) } else { 0.0 };
        f.low_weight = if sounding { low / weight.max(1e-12) } else { 0.0 };
        f.sharpness = if sounding { sharp / weight.max(1e-12) } else { 0.0 };
        let k = 1.0 - (-dt / 0.12).exp();
        for b in 0..BANDS {
            let difference = if self.ready > 1 { f.band_db[b] - self.bands[b] } else { 0.0 };
            let rise = (difference / 12.0).clamp(0.0, 1.0);
            f.band_flux[b] = difference.max(0.0);
            f.band_attack[b] = if sounding { rise } else { 0.0 };
            f.band_decay[b] = (-difference / 12.0).clamp(0.0, 1.0);
            f.band_activity[b] += (rise - f.band_activity[b]) * k;
            f.band_transient[b] = if sounding { rise * (0.5 + 0.5 * f.short_transient) } else { 0.0 };
            self.bands[b] = f.band_db[b];
        }
        f.spatial_movement += (((f.balance - self.previous_balance).abs() / dt).min(1.0) - f.spatial_movement) * k;
        f.expansion_trend += (((f.width - self.previous_width) / dt).clamp(-1.0, 1.0) - f.expansion_trend) * k;
        self.previous_balance = f.balance;
        self.previous_width = f.width;
        if f.loudness_momentary > -65.0 && sounding {
            if !self.range_ready {
                self.range_low = f.loudness_momentary;
                self.range_high = f.loudness_momentary;
                self.range_ready = true;
            }
            let relax = 1.0 - (-dt / 20.0).exp();
            self.range_low =
                (self.range_low + (f.loudness_momentary - self.range_low) * relax).min(f.loudness_momentary);
            self.range_high =
                (self.range_high + (f.loudness_momentary - self.range_high) * relax).max(f.loudness_momentary);
        }
        f.loudness_range = self.range_high - self.range_low;
    }
}
