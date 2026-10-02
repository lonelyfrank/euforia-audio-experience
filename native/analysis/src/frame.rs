//! The per-hop measurement record, and its flat export (a list of named f64
//! fields) for hosts across a boundary: Tauri IPC, WebAssembly, other engines.

/// Number of energy bands.
pub const BANDS: usize = 8;
/// Band edges (Hz): sub, bass, low-mid, mid, high-mid, presence, brilliance, air.
pub const BAND_EDGES: [f32; BANDS + 1] = [20.0, 60.0, 250.0, 500.0, 2000.0, 4000.0, 6000.0, 12000.0, 20000.0];

/// Measurements over the analysis window ending at `sample`. Levels are in dB
/// (≈ dBFS of the band's mean square) or LUFS; `*_rel` values are 0..1
/// relative to the recent history of the same measure; every group carries a
/// 0..1 confidence (0 = do not use, e.g. in silence or before warm-up).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FeatureFrame {
    /// Capture clock: index of the sample right after the newest one analysed.
    pub sample: u64,
    /// `sample / sample_rate`, in seconds since the analysis started.
    pub time: f64,

    // Signal quality.
    /// 0..1: sound is really there (above the learned noise floor), fast attack, slow release.
    pub presence: f32,
    /// Hysteresis gate behind `presence`.
    pub sounding: bool,
    /// Digital silence in the analysis window.
    pub silent: bool,
    /// Learned noise floor of the input (dB).
    pub noise_floor_db: f32,
    /// 0..1: recent clipping (samples at full scale), held about a second.
    pub clipping: f32,

    // Energy.
    pub band_db: [f32; BANDS],
    pub band_rel: [f32; BANDS],
    pub energy_confidence: f32,
    /// BS.1770 loudness (no gating): 400 ms, 3 s, ~30 s follower.
    pub loudness_momentary: f32,
    pub loudness_short: f32,
    pub loudness_long: f32,
    /// First and second derivative of the (lightly smoothed) momentary loudness: LU/s, LU/s².
    pub loudness_slope: f32,
    pub loudness_curvature: f32,
    /// Momentary loudness relative to the recent history of the song (0..1).
    pub loudness_rel: f32,

    // Timbre (mean of the channels' power spectra).
    pub centroid_hz: f32,
    /// Frequency below which 85% of the power lies.
    pub rolloff_hz: f32,
    /// Spectral flatness 250 Hz–8 kHz: 0 tonal … 1 noise-like.
    pub flatness: f32,
    /// Spectral flux: mean rise (dB per bin) above each bin's ~60 ms running level; whole band and per region.
    pub flux: f32,
    pub flux_low: f32,
    pub flux_mid: f32,
    pub flux_high: f32,
    pub timbre_confidence: f32,

    // Rhythm.
    /// Onset detection function, 0..1 (weighted per-region flux, each region relative to its recent strongest).
    pub onset_strength: f32,
    /// Onsets per second over the last couple of seconds.
    pub onset_density: f32,
    /// Strongest periodicity of the onsets (BPM), 0 while unknown; octave errors are possible here.
    pub tempo_bpm: f32,
    pub tempo_confidence: f32,

    // Stereo.
    /// 0 mono … 1 all side (out of phase).
    pub width: f32,
    /// -1 opposite … 1 identical channels.
    pub correlation: f32,
    /// Per band: -1 left … 1 right.
    pub band_pan: [f32; BANDS],
    pub stereo_confidence: f32,
}

/// Values that can be written as consecutive f64 slots.
pub trait Field {
    const LEN: usize;
    fn put(&self, out: &mut [f64]);
}

impl Field for f32 {
    const LEN: usize = 1;
    fn put(&self, out: &mut [f64]) {
        out[0] = f64::from(*self);
    }
}

impl Field for f64 {
    const LEN: usize = 1;
    fn put(&self, out: &mut [f64]) {
        out[0] = *self;
    }
}

impl Field for u64 {
    const LEN: usize = 1;
    fn put(&self, out: &mut [f64]) {
        // Exact up to 2^53 samples (≈ 6000 years at 48 kHz).
        out[0] = *self as f64;
    }
}

impl Field for bool {
    const LEN: usize = 1;
    fn put(&self, out: &mut [f64]) {
        out[0] = if *self { 1.0 } else { 0.0 };
    }
}

impl<const N: usize> Field for [f32; N] {
    const LEN: usize = N;
    fn put(&self, out: &mut [f64]) {
        for (o, v) in out.iter_mut().zip(self) {
            *o = f64::from(*v);
        }
    }
}

macro_rules! layout {
    ($ty:ident { $($name:ident: $t:ty),* $(,)? }) => {
        impl $ty {
            /// Field names and lengths, in export order.
            pub const LAYOUT: &'static [(&'static str, usize)] = &[$((stringify!($name), <$t as Field>::LEN)),*];
            /// Number of f64 slots written by `export`.
            pub const SIZE: usize = 0 $(+ <$t as Field>::LEN)*;

            /// Writes the frame as `SIZE` f64 values in `LAYOUT` order.
            pub fn export(&self, out: &mut [f64]) {
                let mut i = 0;
                $(
                    self.$name.put(&mut out[i..i + <$t as Field>::LEN]);
                    i += <$t as Field>::LEN;
                )*
                debug_assert_eq!(i, Self::SIZE);
            }
        }
    };
}

layout!(FeatureFrame {
    sample: u64,
    time: f64,
    presence: f32,
    sounding: bool,
    silent: bool,
    noise_floor_db: f32,
    clipping: f32,
    band_db: [f32; BANDS],
    band_rel: [f32; BANDS],
    energy_confidence: f32,
    loudness_momentary: f32,
    loudness_short: f32,
    loudness_long: f32,
    loudness_slope: f32,
    loudness_curvature: f32,
    loudness_rel: f32,
    centroid_hz: f32,
    rolloff_hz: f32,
    flatness: f32,
    flux: f32,
    flux_low: f32,
    flux_mid: f32,
    flux_high: f32,
    timbre_confidence: f32,
    onset_strength: f32,
    onset_density: f32,
    tempo_bpm: f32,
    tempo_confidence: f32,
    width: f32,
    correlation: f32,
    band_pan: [f32; BANDS],
    stereo_confidence: f32,
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_follows_the_layout() {
        let frame = FeatureFrame { sample: 4096, time: 1.5, presence: 0.25, band_db: [-1.0; BANDS], stereo_confidence: 0.75, ..Default::default() };
        let mut out = vec![f64::NAN; FeatureFrame::SIZE];
        frame.export(&mut out);
        let at = |name: &str| {
            let mut i = 0;
            for (n, len) in FeatureFrame::LAYOUT {
                if *n == name {
                    return i;
                }
                i += len;
            }
            panic!("no field {name}");
        };
        assert_eq!(out[at("sample")], 4096.0);
        assert_eq!(out[at("time")], 1.5);
        assert_eq!(out[at("presence")], 0.25);
        assert_eq!(out[at("band_db") + 7], -1.0);
        assert_eq!(out[FeatureFrame::SIZE - 1], 0.75);
        assert!(out.iter().all(|v| v.is_finite()));
    }
}
