//! The per-hop measurement record, and its flat export (a list of named f64
//! fields) for hosts across a boundary: Tauri IPC, WebAssembly, other engines.

use crate::harmony::PARTIALS;

/// Number of energy bands.
pub const BANDS: usize = 8;
/// Band edges (Hz): sub, bass, low-mid, mid, high-mid, presence, brilliance, air.
pub const BAND_EDGES: [f32; BANDS + 1] = [20.0, 60.0, 250.0, 500.0, 2000.0, 4000.0, 6000.0, 12000.0, 20000.0];

/// Measurements over the analysis window ending at `sample`. Levels are in dB
/// (≈ dBFS of the band's mean square) or LUFS; `*_rel` values are 0..1
/// relative to the recent history of the same measure; every group carries a
/// 0..1 confidence (0 = do not use, e.g. in silence or before warm-up).
#[derive(Clone, Copy, Debug, PartialEq)]
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
    /// Harmonic/percussive split (median filtering every 4 hops, ≈ 50 ms lag on the harmonic side):
    /// percussive share of the power, 0..1, overall and per region; levels of both parts.
    pub percussive: f32,
    pub percussive_low: f32,
    pub percussive_mid: f32,
    pub percussive_high: f32,
    pub harmonic_db: f32,
    pub percussive_db: f32,

    // Rhythm.
    /// Onset detection function, 0..1 (weighted per-region flux, each region relative to its recent strongest).
    pub onset_strength: f32,
    /// Onsets per second over the last couple of seconds.
    pub onset_density: f32,
    /// Strongest periodicity of the onsets (BPM), 0 while unknown; octave errors are possible here.
    pub tempo_bpm: f32,
    pub tempo_confidence: f32,
    /// Experimental resonator bank (only with `AnalyzerOptions::resonators`; 0 otherwise).
    pub resonator_bpm: f32,
    pub resonator_confidence: f32,
    /// Tracked beat grid (PLL): tempo, position in the beat and in the bar (0 = on the beat / downbeat).
    pub beat_bpm: f32,
    pub beat_phase: f32,
    pub bar_phase: f32,
    pub beat_confidence: f32,
    pub downbeat_confidence: f32,
    /// Predicted time (s, capture clock) of the next beat; 0 while not tracking.
    pub next_beat_time: f64,

    // Structure (decided at beat granularity; see `structure`).
    /// Current section: 0 intro, 1 build, 2 drop, 3 break, 4 outro.
    pub section: u8,
    pub section_id: u32,
    /// Whole bars since the section started.
    pub section_bars: u32,
    /// Id of an earlier section the current one repeats (same kind, similar second bar), or -1.
    pub section_return: i32,
    pub bar_index: u64,
    /// Bar within the phrase and phrase length (bars, confidence-weighted horizon).
    pub phrase_bar: u32,
    pub phrase_bars: u32,
    /// Predicted capture time (s) of the next phrase boundary; 0 while unknown.
    pub next_phrase_time: f64,
    /// 0..1: how new the last first-beat-of-a-bar sounded against the bars before.
    pub novelty: f32,
    /// Similarity (0..1) of the last bar to the bars 4, 8 and 16 bars earlier.
    pub similarity: [f32; 3],
    /// 0..1: in a build, how close the end of the phrase (the likely drop) is.
    pub drop_expected: f32,
    pub structure_confidence: f32,

    // Harmony.
    /// Pitch classes C, C#, … B (0..1, the strongest at 1).
    pub chroma: [f32; 12],
    pub chroma_confidence: f32,
    /// Estimated key: 0–11 = C … B major, 12–23 = C … B minor, -1 while unknown.
    pub key: i8,
    pub key_confidence: f32,

    // Stereo.
    /// 0 mono … 1 all side (out of phase).
    pub width: f32,
    /// -1 opposite … 1 identical channels.
    pub correlation: f32,
    /// Per band: -1 left … 1 right.
    pub band_pan: [f32; BANDS],
    // Physical/perceptual model. Normalized descriptors are evidence, not probabilities.
    pub rms: f32,
    pub peak: f32,
    pub crest: f32,
    pub entropy: f32,
    pub complexity: f32,
    pub spectral_crest: f32,
    pub spread_hz: f32,
    pub erb: [f32; 24],
    pub perceived_brightness: f32,
    pub low_weight: f32,
    pub sharpness: f32,
    pub phase_coherence: f32,
    pub phase_deviation: f32,
    pub complex_change: f32,
    pub phase_velocity: f32,
    pub instantaneous_hz: f32,
    pub harmonicity: f32,
    pub inharmonicity: f32,
    pub pitch_salience: f32,
    pub roughness: f32,
    /// Log-frequency projection, MIDI 36..107 (C2..B7), maximum normalized.
    pub pitch_bins: [f32; 72],
    pub harmonic_share: f32,
    pub percussive_share: f32,
    pub residual_share: f32,
    pub band_flux: [f32; BANDS],
    pub band_attack: [f32; BANDS],
    pub band_decay: [f32; BANDS],
    pub band_activity: [f32; BANDS],
    pub band_transient: [f32; BANDS],
    pub short_transient: f32,
    /// Relaxing loudness extrema, not standardized EBU LRA.
    pub loudness_range: f32,
    pub left_energy: f32,
    pub right_energy: f32,
    pub mid_energy: f32,
    pub side_energy: f32,
    pub balance: f32,
    pub spatial_movement: f32,
    pub expansion_trend: f32,
    pub inter_channel_phase: f32,
    pub inter_channel_coherence: f32,
    /// 0 unknown, otherwise estimated beats per bar; not a time signature denominator.
    pub meter: u8,
    pub meter_confidence: f32,
    /// 0 high, 1 medium, 2 low. Only slow feature rates change.
    pub dsp_quality: u8,
    pub stereo_confidence: f32,
    // Context (online normalization 2.0; see `context`).
    /// Adaptive noise floor per band (dB) and the band's activity above it (0..1).
    pub band_floor_db: [f32; BANDS],
    pub band_level: [f32; BANDS],
    /// Online P10 / P50 / P90 / P95 of the momentary loudness while sounding (LUFS-like).
    pub loudness_quantiles: [f32; 4],
    /// Momentary loudness placed between P10 and P95 (0..1): relative, robust to single peaks.
    pub loudness_position: f32,
    /// Smoothed first derivatives (per second) of slow descriptors.
    pub brightness_slope: f32,
    pub entropy_slope: f32,
    pub complexity_slope: f32,
    pub harmonicity_slope: f32,
    /// Predicted capture time (s) of the next downbeat; 0 while not tracking. A forecast, not an event:
    /// weigh it by `downbeat_confidence` (and `meter_confidence`; with meter 0 the grid's fallback grouping is used).
    pub next_downbeat_time: f64,
    // Partials (see `harmony`): the strongest spectral peaks of the long window, loudest first.
    /// Frequency (Hz, interpolated); 0 = no partial in this slot. Slots are ordered by level, not tracked:
    /// the same partial can change slot between analyses.
    pub partial_hz: [f32; PARTIALS],
    /// Level relative to the loudest partial, scaled by how tonal and present the sound is (0..1).
    pub partial_level: [f32; PARTIALS],
    /// -1 left … 1 right at the partial's bin (0 for mono).
    pub partial_pan: [f32; PARTIALS],
    /// Phase (rad) of the left channel against the right at the partial; 0 for mono or centred sound.
    pub partial_phase: [f32; PARTIALS],
}

impl Default for FeatureFrame {
    fn default() -> Self {
        // All members are numeric scalars, bools or arrays of floats; zero is valid.
        Self {
            sample: 0,
            time: 0.0,
            presence: 0.0,
            sounding: false,
            silent: false,
            noise_floor_db: 0.0,
            clipping: 0.0,
            band_db: [0.0; BANDS],
            band_rel: [0.0; BANDS],
            energy_confidence: 0.0,
            loudness_momentary: 0.0,
            loudness_short: 0.0,
            loudness_long: 0.0,
            loudness_slope: 0.0,
            loudness_curvature: 0.0,
            loudness_rel: 0.0,
            centroid_hz: 0.0,
            rolloff_hz: 0.0,
            flatness: 0.0,
            flux: 0.0,
            flux_low: 0.0,
            flux_mid: 0.0,
            flux_high: 0.0,
            timbre_confidence: 0.0,
            percussive: 0.0,
            percussive_low: 0.0,
            percussive_mid: 0.0,
            percussive_high: 0.0,
            harmonic_db: 0.0,
            percussive_db: 0.0,
            onset_strength: 0.0,
            onset_density: 0.0,
            tempo_bpm: 0.0,
            tempo_confidence: 0.0,
            resonator_bpm: 0.0,
            resonator_confidence: 0.0,
            beat_bpm: 0.0,
            beat_phase: 0.0,
            bar_phase: 0.0,
            beat_confidence: 0.0,
            downbeat_confidence: 0.0,
            next_beat_time: 0.0,
            section: 0,
            section_id: 0,
            section_bars: 0,
            section_return: 0,
            bar_index: 0,
            phrase_bar: 0,
            phrase_bars: 0,
            next_phrase_time: 0.0,
            novelty: 0.0,
            similarity: [0.0; 3],
            drop_expected: 0.0,
            structure_confidence: 0.0,
            chroma: [0.0; 12],
            chroma_confidence: 0.0,
            key: 0,
            key_confidence: 0.0,
            width: 0.0,
            correlation: 0.0,
            band_pan: [0.0; BANDS],
            rms: 0.0,
            peak: 0.0,
            crest: 0.0,
            entropy: 0.0,
            complexity: 0.0,
            spectral_crest: 0.0,
            spread_hz: 0.0,
            erb: [0.0; 24],
            perceived_brightness: 0.0,
            low_weight: 0.0,
            sharpness: 0.0,
            phase_coherence: 0.0,
            phase_deviation: 0.0,
            complex_change: 0.0,
            phase_velocity: 0.0,
            instantaneous_hz: 0.0,
            harmonicity: 0.0,
            inharmonicity: 0.0,
            pitch_salience: 0.0,
            roughness: 0.0,
            pitch_bins: [0.0; 72],
            harmonic_share: 0.0,
            percussive_share: 0.0,
            residual_share: 0.0,
            band_flux: [0.0; BANDS],
            band_attack: [0.0; BANDS],
            band_decay: [0.0; BANDS],
            band_activity: [0.0; BANDS],
            band_transient: [0.0; BANDS],
            short_transient: 0.0,
            loudness_range: 0.0,
            left_energy: 0.0,
            right_energy: 0.0,
            mid_energy: 0.0,
            side_energy: 0.0,
            balance: 0.0,
            spatial_movement: 0.0,
            expansion_trend: 0.0,
            inter_channel_phase: 0.0,
            inter_channel_coherence: 0.0,
            meter: 0,
            meter_confidence: 0.0,
            dsp_quality: 0,
            stereo_confidence: 0.0,
            band_floor_db: [0.0; BANDS],
            band_level: [0.0; BANDS],
            loudness_quantiles: [0.0; 4],
            loudness_position: 0.0,
            brightness_slope: 0.0,
            entropy_slope: 0.0,
            complexity_slope: 0.0,
            harmonicity_slope: 0.0,
            next_downbeat_time: 0.0,
            partial_hz: [0.0; PARTIALS],
            partial_level: [0.0; PARTIALS],
            partial_pan: [0.0; PARTIALS],
            partial_phase: [0.0; PARTIALS],
        }
    }
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

impl Field for u8 {
    const LEN: usize = 1;
    fn put(&self, out: &mut [f64]) {
        out[0] = f64::from(*self);
    }
}

impl Field for u32 {
    const LEN: usize = 1;
    fn put(&self, out: &mut [f64]) {
        out[0] = f64::from(*self);
    }
}

impl Field for i32 {
    const LEN: usize = 1;
    fn put(&self, out: &mut [f64]) {
        out[0] = f64::from(*self);
    }
}

impl Field for i8 {
    const LEN: usize = 1;
    fn put(&self, out: &mut [f64]) {
        out[0] = f64::from(*self);
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

pub(crate) use layout;

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
    percussive: f32,
    percussive_low: f32,
    percussive_mid: f32,
    percussive_high: f32,
    harmonic_db: f32,
    percussive_db: f32,
    onset_strength: f32,
    onset_density: f32,
    tempo_bpm: f32,
    tempo_confidence: f32,
    resonator_bpm: f32,
    resonator_confidence: f32,
    beat_bpm: f32,
    beat_phase: f32,
    bar_phase: f32,
    beat_confidence: f32,
    downbeat_confidence: f32,
    next_beat_time: f64,
    section: u8,
    section_id: u32,
    section_bars: u32,
    section_return: i32,
    bar_index: u64,
    phrase_bar: u32,
    phrase_bars: u32,
    next_phrase_time: f64,
    novelty: f32,
    similarity: [f32; 3],
    drop_expected: f32,
    structure_confidence: f32,
    chroma: [f32; 12],
    chroma_confidence: f32,
    key: i8,
    key_confidence: f32,
    width: f32,
    correlation: f32,
    band_pan: [f32; BANDS],
    rms: f32,
    peak: f32,
    crest: f32,
    entropy: f32,
    complexity: f32,
    spectral_crest: f32,
    spread_hz: f32,
    erb: [f32; 24],
    perceived_brightness: f32,
    low_weight: f32,
    sharpness: f32,
    phase_coherence: f32,
    phase_deviation: f32,
    complex_change: f32,
    phase_velocity: f32,
    instantaneous_hz: f32,
    harmonicity: f32,
    inharmonicity: f32,
    pitch_salience: f32,
    roughness: f32,
    pitch_bins: [f32; 72],
    harmonic_share: f32,
    percussive_share: f32,
    residual_share: f32,
    band_flux: [f32; BANDS],
    band_attack: [f32; BANDS],
    band_decay: [f32; BANDS],
    band_activity: [f32; BANDS],
    band_transient: [f32; BANDS],
    short_transient: f32,
    loudness_range: f32,
    left_energy: f32,
    right_energy: f32,
    mid_energy: f32,
    side_energy: f32,
    balance: f32,
    spatial_movement: f32,
    expansion_trend: f32,
    inter_channel_phase: f32,
    inter_channel_coherence: f32,
    meter: u8,
    meter_confidence: f32,
    dsp_quality: u8,
    stereo_confidence: f32,
    band_floor_db: [f32; BANDS],
    band_level: [f32; BANDS],
    loudness_quantiles: [f32; 4],
    loudness_position: f32,
    brightness_slope: f32,
    entropy_slope: f32,
    complexity_slope: f32,
    harmonicity_slope: f32,
    next_downbeat_time: f64,
    partial_hz: [f32; PARTIALS],
    partial_level: [f32; PARTIALS],
    partial_pan: [f32; PARTIALS],
    partial_phase: [f32; PARTIALS],
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_follows_the_layout() {
        let frame = FeatureFrame {
            sample: 4096,
            time: 1.5,
            presence: 0.25,
            band_db: [-1.0; BANDS],
            stereo_confidence: 0.75,
            ..Default::default()
        };
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
        assert_eq!(out[at("stereo_confidence")], 0.75);
        assert!(out.iter().all(|v| v.is_finite()));
    }
}
