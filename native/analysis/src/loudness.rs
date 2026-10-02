//! Loudness after ITU-R BS.1770 (K-weighting, channel power sum, -0.691 dB
//! offset): momentary (400 ms) and short-term (3 s) sliding windows, a long
//! song-level follower, and the first and second time derivatives.
//! No gating: this is a live reading, not a programme-loudness measurement.

use crate::follow::{power_db, Follower};

/// Two cascaded biquads (high shelf + high pass) per channel.
#[derive(Clone, Copy, Default)]
struct Biquad {
    b: [f32; 3],
    a: [f32; 2],
    z: [f32; 2],
}

impl Biquad {
    fn process(&mut self, x: f32) -> f32 {
        // Transposed direct form II.
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[1] * y;
        y
    }

    fn normalized(b: [f64; 3], a: [f64; 3]) -> Self {
        Self {
            b: [(b[0] / a[0]) as f32, (b[1] / a[0]) as f32, (b[2] / a[0]) as f32],
            a: [(a[1] / a[0]) as f32, (a[2] / a[0]) as f32],
            z: [0.0; 2],
        }
    }

    /// BS.1770 stage 1: +4 dB shelf above ~1.5 kHz (head acoustics).
    fn shelf(sample_rate: f64) -> Self {
        let (gain, fc, q) = (4.0f64, 1500.0f64, std::f64::consts::FRAC_1_SQRT_2);
        let a = 10f64.powf(gain / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * fc / sample_rate;
        let (cos, alpha) = (w0.cos(), w0.sin() / (2.0 * q));
        let s = 2.0 * a.sqrt() * alpha;
        Self::normalized(
            [a * ((a + 1.0) + (a - 1.0) * cos + s), -2.0 * a * ((a - 1.0) + (a + 1.0) * cos), a * ((a + 1.0) + (a - 1.0) * cos - s)],
            [(a + 1.0) - (a - 1.0) * cos + s, 2.0 * ((a - 1.0) - (a + 1.0) * cos), (a + 1.0) - (a - 1.0) * cos - s],
        )
    }

    /// BS.1770 stage 2: high pass around 38 Hz (RLB weighting).
    fn high_pass(sample_rate: f64) -> Self {
        let (fc, q) = (38.0f64, 0.5f64);
        let w0 = 2.0 * std::f64::consts::PI * fc / sample_rate;
        let (cos, alpha) = (w0.cos(), w0.sin() / (2.0 * q));
        Self::normalized([(1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0], [1.0 + alpha, -2.0 * cos, 1.0 - alpha])
    }
}

/// Sliding mean of per-hop powers over a fixed number of hops.
struct Window {
    powers: Vec<f64>,
    index: usize,
    filled: usize,
    sum: f64,
}

impl Window {
    fn new(hops: usize) -> Self {
        Self { powers: vec![0.0; hops.max(1)], index: 0, filled: 0, sum: 0.0 }
    }

    fn push(&mut self, power: f64) -> f32 {
        self.sum += power - self.powers[self.index];
        self.powers[self.index] = power;
        self.index = (self.index + 1) % self.powers.len();
        self.filled = (self.filled + 1).min(self.powers.len());
        // Recompute now and then: the running sum drifts with rounding.
        if self.index == 0 {
            self.sum = self.powers.iter().sum();
        }
        (self.sum.max(0.0) / self.filled as f64) as f32
    }

}

/// Output of one hop (LUFS-like values; derivatives in LU/s and LU/s²).
#[derive(Clone, Copy, Debug, Default)]
pub struct LoudnessReading {
    pub momentary: f32,
    pub short: f32,
    pub long: f32,
    pub slope: f32,
    pub curvature: f32,
}

pub struct Loudness {
    filters: Vec<[Biquad; 2]>,
    hop_power: f64,
    hop_count: usize,
    momentary: Window,
    short: Window,
    long: Follower,
    level: Follower,
    slope: Follower,
    curvature: Follower,
    previous_level: f32,
    previous_slope: f32,
    started: bool,
}

/// Loudness reported for silence (LUFS).
pub const SILENT_LUFS: f32 = -70.0;
/// Time constants (s): the level that is differentiated, its slope and curvature, the song-level follower.
const LEVEL_TAU: f32 = 0.25;
const SLOPE_TAU: f32 = 0.5;
const CURVATURE_TAU: f32 = 0.8;
const LONG_TAU: f32 = 30.0;

impl Loudness {
    pub fn new(sample_rate: f32, channels: usize, hop: usize) -> Self {
        let sr = f64::from(sample_rate);
        let hops = |seconds: f32| (seconds * sample_rate / hop as f32).round() as usize;
        Self {
            filters: (0..channels).map(|_| [Biquad::shelf(sr), Biquad::high_pass(sr)]).collect(),
            hop_power: 0.0,
            hop_count: 0,
            momentary: Window::new(hops(0.4)),
            short: Window::new(hops(3.0)),
            long: Follower::symmetric(LONG_TAU, SILENT_LUFS),
            level: Follower::symmetric(LEVEL_TAU, SILENT_LUFS),
            slope: Follower::symmetric(SLOPE_TAU, 0.0),
            curvature: Follower::symmetric(CURVATURE_TAU, 0.0),
            previous_level: SILENT_LUFS,
            previous_slope: 0.0,
            started: false,
        }
    }

    /// Feeds one interleaved frame (one sample per channel).
    pub fn sample(&mut self, frame: &[f32]) {
        for (x, filters) in frame.iter().zip(self.filters.iter_mut()) {
            let [shelf, high_pass] = filters;
            let y = high_pass.process(shelf.process(*x));
            // BS.1770: channel powers are summed (weight 1 for L/R).
            self.hop_power += f64::from(y) * f64::from(y);
        }
        self.hop_count += 1;
    }

    /// Closes the current hop; `dt` is its duration in seconds.
    pub fn hop(&mut self, dt: f32) -> LoudnessReading {
        let power = if self.hop_count > 0 { self.hop_power / self.hop_count as f64 } else { 0.0 };
        self.hop_power = 0.0;
        self.hop_count = 0;
        let lufs = |p: f32| (-0.691 + power_db(p)).max(SILENT_LUFS);
        let momentary = lufs(self.momentary.push(power));
        let short = lufs(self.short.push(power));
        if !self.started && momentary > SILENT_LUFS {
            // Start the followers at the first sound, not from -70: no false crescendo at start-up.
            self.started = true;
            self.long.reset(momentary);
            self.level.reset(momentary);
            self.previous_level = momentary;
        }
        let long = if momentary > SILENT_LUFS { self.long.update(momentary, dt) } else { self.long.value };
        let level = self.level.update(momentary, dt);
        let slope = self.slope.update((level - self.previous_level) / dt, dt);
        let curvature = self.curvature.update((slope - self.previous_slope) / dt, dt);
        self.previous_level = level;
        self.previous_slope = slope;
        LoudnessReading { momentary, short, long, slope, curvature }
    }

}
