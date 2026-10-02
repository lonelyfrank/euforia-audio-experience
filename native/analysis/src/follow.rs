//! Small time-based followers. All take `dt` in seconds, so behaviour does not
//! depend on the hop size or on how often the host pushes samples.

/// One-pole follower with separate attack and release time constants (s).
#[derive(Clone, Copy, Debug)]
pub struct Follower {
    pub value: f32,
    attack: f32,
    release: f32,
}

impl Follower {
    pub fn new(attack: f32, release: f32, value: f32) -> Self {
        Self { value, attack, release }
    }

    pub fn symmetric(tau: f32, value: f32) -> Self {
        Self::new(tau, tau, value)
    }

    pub fn update(&mut self, target: f32, dt: f32) -> f32 {
        let tau = if target > self.value { self.attack } else { self.release };
        self.value = if tau <= 0.0 { target } else { self.value + (target - self.value) * (1.0 - (-dt / tau).exp()) };
        self.value
    }

    pub fn reset(&mut self, value: f32) {
        self.value = value;
    }
}

/// Places a level (dB) relative to its own recent history: 0.5 at the recent
/// mean, ±0.5 about two mean deviations away. Scale-free, so a quiet and a
/// loud recording read alike; `ready` grows to 1 over the first `tau` seconds.
#[derive(Clone, Copy, Debug)]
pub struct Relative {
    mean: f32,
    deviation: f32,
    tau: f32,
    seen: f32,
}

impl Relative {
    /// Smallest deviation (dB) used, so a perfectly steady level does not swing on tiny noise.
    const MIN_DEVIATION: f32 = 1.5;

    pub fn new(tau: f32) -> Self {
        Self { mean: f32::NAN, deviation: 3.0, tau, seen: 0.0 }
    }

    pub fn update(&mut self, db: f32, dt: f32) -> f32 {
        if self.mean.is_nan() {
            self.mean = db;
        }
        let k = 1.0 - (-dt / self.tau).exp();
        self.mean += (db - self.mean) * k;
        self.deviation += ((db - self.mean).abs() - self.deviation) * k;
        self.seen = (self.seen + dt).min(self.tau);
        let spread = self.deviation.max(Self::MIN_DEVIATION) * 4.0;
        (0.5 + (db - self.mean) / spread).clamp(0.0, 1.0)
    }

    /// 0..1: how much history the value is based on.
    pub fn ready(&self) -> f32 {
        self.seen / self.tau
    }
}

/// Power (mean square) to dB, floored at `SILENCE_DB`.
pub fn power_db(power: f32) -> f32 {
    if power <= 1e-12 {
        crate::SILENCE_DB
    } else {
        (10.0 * power.log10()).max(crate::SILENCE_DB)
    }
}
