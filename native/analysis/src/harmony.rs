//! Chroma (12 pitch classes) and an estimated key.
//!
//! A longer FFT (CHROMA_SIZE) resolves semitones down to the bass range. Each
//! bin's amplitude is shared between the two nearest pitch classes; the
//! chroma is normalized to its maximum. The key is the best correlation of a
//! slow chroma memory with the Krumhansl–Kessler major/minor profiles; it
//! changes only after another key has led for a while.

use crate::fft::Fft;
use crate::follow::Follower;

/// FFT size of the chroma analysis (≈ 170 ms at 48 kHz, ≈ 5.9 Hz per bin).
pub const CHROMA_SIZE: usize = 8192;
/// Hops between two chroma analyses.
pub const CHROMA_EVERY: usize = 4;
const FROM_HZ: f32 = 55.0;
const TO_HZ: f32 = 5000.0;
const CHROMA_TAU: f32 = 0.15;
/// Memory (s) of the chroma the key is estimated from.
const KEY_MEMORY: f32 = 8.0;
/// Seconds another key must lead before it is reported.
const KEY_HOLD: f32 = 4.0;
/// Smoothing (s) of the key confidence: the margin swings with each chord of a progression.
const KEY_CONFIDENCE_TAU: f32 = 2.0;

/// Krumhansl–Kessler key profiles (C major, C minor).
const MAJOR: [f32; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR: [f32; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct HarmonyReading {
    /// Pitch classes C, C#, … B; 0..1, the strongest at 1.
    pub chroma: [f32; 12],
    pub chroma_confidence: f32,
    /// 0–11 = C … B major, 12–23 = C … B minor; -1 while unknown.
    pub key: i8,
    pub key_confidence: f32,
}

pub struct Harmony {
    fft: Fft,
    window: Vec<f32>,
    a: Vec<f32>,
    b: Vec<f32>,
    spec_a: Vec<(f32, f32)>,
    spec_b: Vec<(f32, f32)>,
    /// Per bin: lower pitch class and the share going to it (the rest goes to the next class).
    classes: Vec<(u8, f32)>,
    from: usize,
    to: usize,
    raw: [f32; 12],
    chroma: [Follower; 12],
    memory: [Follower; 12],
    candidate: i8,
    candidate_for: f32,
    key_confidence: Follower,
    reading: HarmonyReading,
}

impl Harmony {
    pub fn new(sample_rate: f32) -> Self {
        let bins = CHROMA_SIZE / 2 + 1;
        let bin_hz = sample_rate / CHROMA_SIZE as f32;
        let classes = (0..bins)
            .map(|k| {
                let hz = k as f32 * bin_hz;
                if hz <= 0.0 {
                    return (0, 1.0);
                }
                // Semitones from C (MIDI 60 = C4 → class 0).
                let semis = 12.0 * (hz / 440.0).log2() + 69.0;
                let lower = semis.floor();
                (lower.rem_euclid(12.0) as u8, 1.0 - (semis - lower))
            })
            .collect();
        Self {
            fft: Fft::new(CHROMA_SIZE),
            window: (0..CHROMA_SIZE).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (CHROMA_SIZE - 1) as f32).cos()).collect(),
            a: vec![0.0; CHROMA_SIZE],
            b: vec![0.0; CHROMA_SIZE],
            spec_a: vec![(0.0, 0.0); bins],
            spec_b: vec![(0.0, 0.0); bins],
            classes,
            from: ((FROM_HZ / bin_hz).ceil() as usize).max(1),
            to: ((TO_HZ / bin_hz).floor() as usize).min(bins - 1),
            raw: [0.0; 12],
            chroma: [Follower::symmetric(CHROMA_TAU, 0.0); 12],
            memory: [Follower::symmetric(KEY_MEMORY, 0.0); 12],
            candidate: -1,
            candidate_for: 0.0,
            key_confidence: Follower::symmetric(KEY_CONFIDENCE_TAU, 0.0),
            reading: HarmonyReading { key: -1, ..Default::default() },
        }
    }

    /// Analyses the newest CHROMA_SIZE samples of both channels (oldest first, read through `at`).
    /// `dt`: time since the previous analysis; `tonal` 0..1: how tonal and present the sound is.
    pub fn analyze(&mut self, at: impl Fn(usize) -> (f32, f32), tonal: f32, dt: f32) -> HarmonyReading {
        for i in 0..CHROMA_SIZE {
            let (l, r) = at(i);
            self.a[i] = l * self.window[i];
            self.b[i] = r * self.window[i];
        }
        self.fft.stereo(&self.a, &self.b, &mut self.spec_a, &mut self.spec_b);
        self.raw = [0.0; 12];
        for k in self.from..=self.to {
            let ((ar, ai), (br, bi)) = (self.spec_a[k], self.spec_b[k]);
            let amplitude = (0.5 * (ar * ar + ai * ai + br * br + bi * bi)).sqrt();
            let (class, share) = self.classes[k];
            self.raw[class as usize] += amplitude * share;
            self.raw[(class as usize + 1) % 12] += amplitude * (1.0 - share);
        }
        let top = self.raw.iter().cloned().fold(0.0f32, f32::max);
        let r = &mut self.reading;
        for c in 0..12 {
            let value = if top > 1e-9 { self.raw[c] / top } else { 0.0 };
            r.chroma[c] = self.chroma[c].update(value, dt);
            if tonal > 0.05 {
                // The key memory only learns from tonal, present sound, in proportion.
                let target = self.memory[c].value + (value - self.memory[c].value) * tonal;
                self.memory[c].update(target, dt);
            }
        }
        // A flat chroma (noise, many voices) says little about pitch.
        let mean = r.chroma.iter().sum::<f32>() / 12.0;
        r.chroma_confidence = tonal * (1.0 - mean).clamp(0.0, 1.0);
        self.estimate_key(dt);
        self.reading
    }

    fn estimate_key(&mut self, dt: f32) {
        let memory: [f32; 12] = std::array::from_fn(|c| self.memory[c].value);
        if memory.iter().sum::<f32>() < 1e-3 {
            return;
        }
        let mut scores = [0.0f32; 24];
        for (key, score) in scores.iter_mut().enumerate() {
            let (profile, tonic) = if key < 12 { (&MAJOR, key) } else { (&MINOR, key - 12) };
            *score = correlation(&memory, |c| profile[(c + 12 - tonic) % 12]);
        }
        let best = (0..24).max_by(|&a, &b| scores[a].total_cmp(&scores[b])).unwrap_or(0);
        let best_score = scores[best];
        // The relative key shares the same notes: the margin is taken over every other key.
        let relative = if best < 12 { 12 + (best + 9) % 12 } else { (best - 12 + 3) % 12 };
        let second = (0..24).filter(|&k| k != best && k != relative).map(|k| scores[k]).fold(f32::MIN, f32::max);
        let best = best as i8;
        let r = &mut self.reading;
        if best == r.key {
            self.candidate_for = 0.0;
        } else {
            if best != self.candidate {
                self.candidate = best;
                self.candidate_for = 0.0;
            }
            self.candidate_for += dt;
            if r.key < 0 || self.candidate_for >= KEY_HOLD {
                r.key = best;
                self.candidate_for = 0.0;
            }
        }
        // Margin over the runner-up and the strength of the correlation itself.
        // Neighbouring keys (a fifth apart) share six of seven notes: margins of 0.05–0.1 are already clear.
        let margin = ((best_score - second) / 0.08).clamp(0.0, 1.0);
        let fit = ((best_score - 0.3) / 0.5).clamp(0.0, 1.0);
        // Enough tonal content is a gate, not a scale: a chord with harmonics is not less of a key.
        let tonal = ((r.chroma_confidence - 0.1) / 0.3).clamp(0.0, 1.0);
        r.key_confidence = self.key_confidence.update(margin.max(0.3) * fit * tonal, dt);
    }
}

/// Pearson correlation between a chroma and a profile given as a function of the pitch class.
fn correlation(chroma: &[f32; 12], profile: impl Fn(usize) -> f32) -> f32 {
    let mx = chroma.iter().sum::<f32>() / 12.0;
    let my = (0..12).map(&profile).sum::<f32>() / 12.0;
    let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
    for c in 0..12 {
        let (x, y) = (chroma[c] - mx, profile(c) - my);
        sxy += x * y;
        sxx += x * x;
        syy += y * y;
    }
    if sxx * syy > 0.0 { sxy / (sxx * syy).sqrt() } else { 0.0 }
}
