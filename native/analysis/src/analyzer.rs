//! The live analyzer: interleaved samples in, one `FeatureFrame` per hop out.

use crate::acoustic::Acoustic;
use crate::beat::BeatTracker;
use crate::context::{next_downbeat, Context};
use crate::fft::Fft;
use crate::follow::{power_db, Follower, Relative};
use crate::frame::{FeatureFrame, BANDS, BAND_EDGES};
use crate::harmony::{Harmony, CHROMA_EVERY, CHROMA_SIZE};
use crate::hpss::{Hpss, HpssReading};
use crate::loudness::Loudness;
use crate::presence::Presence;
use crate::resonators::ResonatorBank;
use crate::rhythm::Rhythm;
use crate::structure::Structure;
use crate::Event;
use crate::SILENCE_DB;

pub const SHORT_SIZE: usize = 512;

/// Samples between two analyses (≈ 5.3 ms at 48 kHz): the time resolution of every event.
pub const HOP: usize = 256;
/// Analysis window (≈ 43 ms at 48 kHz).
pub const FFT_SIZE: usize = 2048;

/// Hops between two harmonic/percussive splits.
const HPSS_EVERY: u64 = 4;
/// Samples kept per channel (the chroma window, the longest one).
const RING: usize = CHROMA_SIZE;
/// Peak below which the window is digitally silent.
const SILENCE_PEAK: f32 = 1e-4;
/// A sample at or above this magnitude counts as clipped.
const CLIP_LEVEL: f32 = 0.999;
/// Clipped samples per hop that read as fully clipping; how long clipping is held (s).
const CLIP_FULL: f32 = 3.0;
const CLIP_HOLD: f32 = 1.0;
/// Memory (s) the band levels are related to.
const BAND_HISTORY: f32 = 4.0;
/// Memory (s) of the song's loudness range.
const LOUDNESS_HISTORY: f32 = 20.0;
/// Per-bin running level (s) transients are measured against.
const FLUX_BIN_TAU: f32 = 0.06;
/// Flux region edges (Hz): low | mid | high.
const FLUX_EDGES: [f32; 4] = [30.0, 250.0, 2000.0, 16000.0];
/// Spectral flatness range (Hz) and the flatness of white noise (Hann, Rayleigh bins), read as "fully noisy".
const FLATNESS_RANGE: (f32, f32) = (250.0, 8000.0);
const NOISE_FLATNESS: f32 = 0.56;
/// Centroid / rolloff range (Hz).
const SHAPE_RANGE: (f32, f32) = (20.0, 16000.0);
const STEREO_TAU: f32 = 0.15;
/// Minimum power (linear, per bin) used in logs.
const TINY: f32 = 1e-12;

/// Optional parts of the analysis.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AnalyzerOptions {
    /// Experimental: a resonator bank gives the beat tracker its tempo and confidence
    /// instead of the autocorrelation estimate. Off until a corpus comparison justifies it.
    pub resonators: bool,
}

pub struct Analyzer {
    options: AnalyzerOptions,
    resonators: Option<ResonatorBank>,
    sample_rate: f32,
    channels: usize,
    /// Rings of the last RING samples of the left and right (or only) channel.
    /// The main analysis reads the newest FFT_SIZE, the chroma all of them.
    left: Vec<f32>,
    right: Vec<f32>,
    write: usize,
    since_hop: usize,
    sample: u64,
    hop_clipped: u32,
    hops: u64,

    fft: Fft,
    window: Vec<f32>,
    power_scale: f32,
    a: Vec<f32>,
    b: Vec<f32>,
    spec_l: Vec<(f32, f32)>,
    spec_r: Vec<(f32, f32)>,
    /// Power per bin, mean of the channels.
    power: Vec<f32>,
    bin_level: Vec<f32>,
    bin_level_ready: bool,
    bin_hz: f32,
    band_bins: [(usize, usize); BANDS],
    flux_bins: [(usize, usize); 3],
    flatness_bins: (usize, usize),
    shape_bins: (usize, usize),

    band_rel: [Relative; BANDS],
    loudness: Loudness,
    loudness_rel: Relative,
    presence: Presence,
    clipping: Follower,
    width: Follower,
    correlation: Follower,
    pan: [Follower; BANDS],
    rhythm: Rhythm,
    beats: BeatTracker,
    structure: Structure,
    harmony: Harmony,
    hpss: Hpss,
    split: HpssReading,

    acoustic: Acoustic,
    context: Context,
    quality: u8,
    short_fft: Fft,
    short_a: Vec<f32>,
    short_b: Vec<f32>,
    short_l: Vec<(f32, f32)>,
    short_r: Vec<(f32, f32)>,
    short_window: Vec<f32>,
    short_previous: Vec<f32>,
    frame: FeatureFrame,
}

impl Analyzer {
    /// `channels`: interleaved channels pushed (1 = mono; with more, the first two are left/right).
    pub fn new(sample_rate: f32, channels: usize) -> Self {
        Self::with_options(sample_rate, channels, AnalyzerOptions::default())
    }

    pub fn with_options(sample_rate: f32, channels: usize, options: AnalyzerOptions) -> Self {
        let channels = channels.max(1);
        let bins = FFT_SIZE / 2 + 1;
        let window: Vec<f32> = (0..FFT_SIZE)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE - 1) as f32).cos())
            .collect();
        let window_energy: f32 = window.iter().map(|w| w * w).sum();
        let bin_hz = sample_rate / FFT_SIZE as f32;
        let bin = |hz: f32| ((hz / bin_hz).round() as usize).clamp(1, bins - 1);
        let range = |from: f32, to: f32| (bin(from), bin(to).max(bin(from) + 1));
        Self {
            options,
            resonators: options.resonators.then(|| ResonatorBank::new(HOP as f32 / sample_rate)),
            sample_rate,
            channels,
            left: vec![0.0; RING],
            right: vec![0.0; RING],
            write: 0,
            since_hop: 0,
            sample: 0,
            hop_clipped: 0,
            hops: 0,
            fft: Fft::new(FFT_SIZE),
            window,
            // One-sided bin powers → mean square of the signal (Parseval with the window's energy).
            power_scale: 2.0 / (FFT_SIZE as f32 * window_energy),
            a: vec![0.0; FFT_SIZE],
            b: vec![0.0; FFT_SIZE],
            spec_l: vec![(0.0, 0.0); bins],
            spec_r: vec![(0.0, 0.0); bins],
            power: vec![0.0; bins],
            bin_level: vec![SILENCE_DB; bins],
            bin_level_ready: false,
            bin_hz,
            band_bins: std::array::from_fn(|i| range(BAND_EDGES[i], BAND_EDGES[i + 1].min(sample_rate / 2.0))),
            flux_bins: std::array::from_fn(|i| range(FLUX_EDGES[i], FLUX_EDGES[i + 1].min(sample_rate / 2.0))),
            flatness_bins: range(FLATNESS_RANGE.0, FLATNESS_RANGE.1),
            shape_bins: range(SHAPE_RANGE.0, SHAPE_RANGE.1.min(sample_rate / 2.0)),
            band_rel: [Relative::new(BAND_HISTORY); BANDS],
            loudness: Loudness::new(sample_rate, channels, HOP),
            loudness_rel: Relative::new(LOUDNESS_HISTORY),
            presence: Presence::default(),
            clipping: Follower::new(0.0, CLIP_HOLD, 0.0),
            width: Follower::symmetric(STEREO_TAU, 0.0),
            correlation: Follower::symmetric(STEREO_TAU, 1.0),
            pan: [Follower::symmetric(STEREO_TAU, 0.0); BANDS],
            rhythm: Rhythm::new(HOP as f32 / sample_rate),
            beats: BeatTracker::default(),
            structure: Structure::default(),
            harmony: Harmony::new(sample_rate),
            hpss: Hpss::new(sample_rate, FFT_SIZE),
            split: HpssReading::default(),
            acoustic: Acoustic::new(sample_rate, FFT_SIZE),
            context: Context::default(),
            quality: 0,
            short_fft: Fft::new(SHORT_SIZE),
            short_a: vec![0.0; SHORT_SIZE],
            short_b: vec![0.0; SHORT_SIZE],
            short_l: vec![(0.0, 0.0); SHORT_SIZE / 2 + 1],
            short_r: vec![(0.0, 0.0); SHORT_SIZE / 2 + 1],
            short_window: (0..SHORT_SIZE)
                .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (SHORT_SIZE - 1) as f32).cos())
                .collect(),
            short_previous: vec![0.0; SHORT_SIZE / 2 + 1],
            frame: FeatureFrame { key: -1, ..FeatureFrame::default() },
        }
    }

    /// Quality changes only slow feature rates; hop, short attacks and beat tracking stay intact.
    pub fn set_quality(&mut self, quality: u8) {
        self.quality = quality.min(2);
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    /// Samples (frames) analysed so far: the capture clock.
    pub fn samples(&self) -> u64 {
        self.sample
    }

    /// The latest frame (also passed to `on_frame` when it is produced).
    pub fn frame(&self) -> &FeatureFrame {
        &self.frame
    }

    /// Feeds interleaved samples (any count; a trailing partial frame is ignored)
    /// and reports events in time order: for each completed hop, the onset
    /// found at the previous hop (if any), the beat predicted inside the hop
    /// (if any), then the hop's `FeatureFrame`.
    /// Allocation-free.
    pub fn push(&mut self, interleaved: &[f32], mut on_event: impl FnMut(Event)) {
        let channels = self.channels;
        for frame in interleaved.chunks_exact(channels) {
            let l = frame[0];
            let r = if channels > 1 { frame[1] } else { l };
            self.left[self.write] = l;
            self.right[self.write] = r;
            self.write = (self.write + 1) % RING;
            if frame.iter().any(|x| x.abs() >= CLIP_LEVEL) {
                self.hop_clipped += 1;
            }
            self.loudness.sample(frame);
            self.sample += 1;
            self.since_hop += 1;
            if self.since_hop == HOP {
                self.since_hop = 0;
                self.analyze();
                let f = &self.frame;
                let (reading, onset) = self.rhythm.hop(
                    [f.flux_low, f.flux_mid, f.flux_high],
                    f.silent || !f.sounding,
                    f.sample,
                    self.sample_rate,
                    HOP,
                );
                let (time, sample_rate) = (f.time, self.sample_rate);
                let quiet = f.silent || !f.sounding;
                let presence = f.presence;
                // The tracker's tempo: the autocorrelation estimate, or the resonator bank when enabled.
                let (tempo_bpm, tempo_confidence) = match &mut self.resonators {
                    Some(bank) => {
                        let r = bank.hop(reading.onset_strength, reading.onset_low, quiet);
                        self.frame.resonator_bpm = r.bpm;
                        self.frame.resonator_confidence = r.confidence * presence;
                        (r.bpm, r.confidence)
                    }
                    None => (reading.tempo_bpm, reading.tempo_confidence),
                };
                self.beats.tempo(tempo_bpm, tempo_confidence * presence, time);
                let f = &self.frame;
                if let Some(onset) = onset {
                    // Accents are judged on the absolute low-end level (a flux rise is relative,
                    // so a loud kick's tail would make the next hit look weaker, not the loud one stronger).
                    let low = (10f32.powf(f.band_db[0] / 10.0) + 10f32.powf(f.band_db[1] / 10.0)).sqrt();
                    self.beats.onset(&onset, low, tempo_bpm);
                    on_event(Event::Onset(onset));
                }
                if let Some(beat) = self.beats.hop(time, sample_rate) {
                    on_event(Event::Beat(beat));
                    if let Some(section) = self.structure.beat(&beat, &self.frame, sample_rate, false) {
                        on_event(Event::Section(section));
                    }
                }
                if let Some(section) = self.structure.hop(&self.frame, sample_rate) {
                    on_event(Event::Section(section));
                }
                let s = self.structure.reading();
                let grid = self.beats.reading();
                let f = &mut self.frame;
                f.meter = grid.meter;
                f.meter_confidence = grid.meter_confidence;
                f.beat_bpm = grid.bpm;
                f.beat_phase = grid.beat_phase;
                f.bar_phase = grid.bar_phase;
                f.beat_confidence = grid.confidence;
                f.downbeat_confidence = grid.downbeat_confidence;
                f.next_beat_time = grid.next_beat;
                // The grid's grouping: the published meter, or the internal fallback it phases bars with.
                let grouping = if grid.meter > 0 { grid.meter } else { crate::BEATS_PER_BAR as u8 };
                f.next_downbeat_time = next_downbeat(grid.next_beat, grid.bpm, grid.bar_phase, grouping);
                f.section = s.section;
                f.section_id = s.section_id;
                f.section_bars = s.section_bars;
                f.section_return = s.section_return;
                f.bar_index = s.bar_index;
                f.phrase_bar = s.phrase_bar;
                f.phrase_bars = s.phrase_bars;
                f.next_phrase_time = s.next_phrase_time;
                f.novelty = s.novelty;
                f.similarity = s.similarity;
                f.drop_expected = s.drop_expected;
                f.structure_confidence = s.confidence;
                f.onset_strength = reading.onset_strength;
                f.onset_density = reading.onset_density;
                f.tempo_bpm = reading.tempo_bpm;
                f.tempo_confidence = reading.tempo_confidence * f.presence;
                on_event(Event::Frame(&self.frame));
            }
        }
    }

    /// Forgets the signal (a new source); the learned noise floors are kept.
    pub fn reset(&mut self) {
        let floor = self.presence.floor;
        let mut context = std::mem::take(&mut self.context);
        context.reset();
        *self = Self::with_options(self.sample_rate, self.channels, self.options);
        self.presence.floor = floor;
        self.context = context;
    }

    fn analyze(&mut self) {
        let dt = HOP as f32 / self.sample_rate;
        let slow = 1u64 << self.quality;
        // Short stereo window: no cancellation for opposite-phase material.
        for i in 0..SHORT_SIZE {
            let at = (self.write + RING - SHORT_SIZE + i) % RING;
            self.short_a[i] = self.left[at] * self.short_window[i];
            self.short_b[i] = self.right[at] * self.short_window[i];
        }
        self.short_fft.stereo(&self.short_a, &self.short_b, &mut self.short_l, &mut self.short_r);
        let (mut rise, mut sum) = (0.0f32, 0.0f32);
        for k in 1..SHORT_SIZE / 2 + 1 {
            let (a, b) = self.short_l[k];
            let (c, d) = self.short_r[k];
            let mag = (a * a + b * b + c * c + d * d).sqrt();
            rise += (mag - self.short_previous[k]).max(0.0);
            sum += mag;
            self.short_previous[k] = mag;
        }
        self.frame.short_transient = if self.hops > 1 && sum > 1e-4 { (rise / sum).min(1.0) } else { 0.0 };
        // The newest FFT_SIZE samples, oldest first: at most two contiguous runs of the ring.
        let start = (self.write + RING - FFT_SIZE) % RING;
        let first = (RING - start).min(FFT_SIZE);
        let mut peak = 0.0f32;
        let mut square = 0.0f32;
        for (run, (from, len)) in [(start, first), (0, FFT_SIZE - first)].into_iter().enumerate() {
            let at = if run == 0 { 0 } else { first };
            let (left, right) = (&self.left[from..from + len], &self.right[from..from + len]);
            let window = &self.window[at..at + len];
            for ((((a, b), l), r), w) in
                self.a[at..at + len].iter_mut().zip(&mut self.b[at..at + len]).zip(left).zip(right).zip(window)
            {
                peak = peak.max(l.abs()).max(r.abs());
                square += 0.5 * (l * l + r * r);
                *a = l * w;
                *b = r * w;
            }
        }
        self.fft.stereo(&self.a, &self.b, &mut self.spec_l, &mut self.spec_r);
        for (k, p) in self.power.iter_mut().enumerate() {
            // Mean of the channels' powers: what is heard, even for out-of-phase content.
            let ((lr, li), (rr, ri)) = (self.spec_l[k], self.spec_r[k]);
            *p = 0.5 * (lr * lr + li * li + rr * rr + ri * ri) * self.power_scale;
        }

        let f = &mut self.frame;
        f.sample = self.sample;
        f.time = self.sample as f64 / f64::from(self.sample_rate);
        f.silent = peak < SILENCE_PEAK;
        f.peak = peak;
        f.rms = (square / FFT_SIZE as f32).sqrt();
        f.crest = if f.rms > 1e-6 { peak / f.rms } else { 0.0 };
        f.dsp_quality = self.quality;

        // Quality: presence against the noise floor, clipping.
        let total: f32 = self.power[self.shape_bins.0..self.shape_bins.1].iter().sum();
        let mix_db = if f.silent { SILENCE_DB } else { power_db(total) };
        f.presence = self.presence.update(mix_db, f.silent, dt);
        f.sounding = self.presence.open;
        f.noise_floor_db = self.presence.floor;
        f.clipping = self.clipping.update((self.hop_clipped as f32 / CLIP_FULL).min(1.0), dt);
        self.hop_clipped = 0;
        let sounding = f.sounding;

        // Energy.
        for (i, &(from, to)) in self.band_bins.iter().enumerate() {
            let db = if f.silent { SILENCE_DB } else { power_db(self.power[from..to].iter().sum()) };
            f.band_db[i] = db;
            f.band_rel[i] = if sounding { self.band_rel[i].update(db, dt) } else { 0.0 };
        }
        let ready = self.band_rel.iter().map(Relative::ready).sum::<f32>() / BANDS as f32;
        f.energy_confidence = f.presence * ready;
        let loud = self.loudness.hop(dt);
        f.loudness_momentary = loud.momentary;
        f.loudness_short = loud.short;
        f.loudness_long = loud.long;
        f.loudness_slope = loud.slope;
        f.loudness_curvature = loud.curvature;
        f.loudness_rel = if sounding { self.loudness_rel.update(loud.momentary, dt) } else { 0.0 };

        // Timbre.
        let (from, to) = self.shape_bins;
        let (mut sum, mut weighted) = (0.0f32, 0.0f32);
        for k in from..to {
            sum += self.power[k];
            weighted += self.power[k] * k as f32 * self.bin_hz;
        }
        if sum > TINY && !f.silent {
            f.centroid_hz = weighted / sum;
            let mut cumulative = 0.0;
            for k in from..to {
                cumulative += self.power[k];
                if cumulative >= 0.85 * sum {
                    f.rolloff_hz = k as f32 * self.bin_hz;
                    break;
                }
            }
        } else {
            f.centroid_hz = 0.0;
            f.rolloff_hz = 0.0;
        }
        let (from, to) = self.flatness_bins;
        let (mut log_sum, mut lin_sum) = (0.0f32, 0.0f32);
        for k in from..to {
            let p = self.power[k].max(TINY);
            log_sum += p.ln();
            lin_sum += p;
        }
        let n = (to - from) as f32;
        f.flatness =
            if f.silent { 0.0 } else { ((log_sum / n).exp() / (lin_sum / n) / NOISE_FLATNESS).clamp(0.0, 1.0) };
        self.measure_flux(dt);
        self.hops += 1;
        // The split feeds slow readings only: every few hops is enough.
        if self.hops % (HPSS_EVERY * slow) == 0 {
            self.split = self.hpss.hop(&self.power, (HPSS_EVERY * slow) as f32 * dt);
        }
        let split = self.split;
        let f = &mut self.frame;
        f.timbre_confidence = f.presence;
        let quiet = f.silent || !f.sounding;
        f.percussive = if quiet { 0.0 } else { split.percussive };
        f.percussive_low = if quiet { 0.0 } else { split.percussive_low };
        f.percussive_mid = if quiet { 0.0 } else { split.percussive_mid };
        f.percussive_high = if quiet { 0.0 } else { split.percussive_high };
        f.harmonic_share = if quiet { 0.0 } else { split.harmonic_share };
        f.percussive_share = if quiet { 0.0 } else { split.percussive_share };
        f.residual_share = if quiet { 0.0 } else { split.residual_share };
        f.harmonic_db = split.harmonic_db;
        f.percussive_db = split.percussive_db;

        // Harmony, every few hops on the longer window.
        if self.hops % (CHROMA_EVERY as u64 * slow) == 0 {
            let tonal = if f.silent { 0.0 } else { f.presence * (1.0 - f.flatness) };
            let (left, right, write) = (&self.left, &self.right, self.write);
            let at = |i: usize| {
                let j = (write + i) % RING;
                (left[j], right[j])
            };
            let h = self.harmony.analyze(at, tonal, dt * (CHROMA_EVERY as u64 * slow) as f32);
            let f = &mut self.frame;
            f.pitch_bins = h.pitch_bins;
            f.harmonicity = h.harmonicity * tonal;
            f.inharmonicity = h.inharmonicity * tonal;
            f.pitch_salience = h.pitch_salience * tonal;
            f.roughness = h.roughness * f.presence;
            f.partial_hz = h.partial_hz;
            f.partial_level = h.partial_level.map(|level| level * tonal);
            f.partial_pan = h.partial_pan;
            f.partial_phase = h.partial_phase;
            f.chroma = h.chroma;
            f.chroma_confidence = h.chroma_confidence;
            f.key = h.key;
            f.key_confidence = h.key_confidence;
        }
        let f = &mut self.frame;

        // Stereo.
        if self.channels > 1 && !f.silent {
            let (mut el, mut er, mut cross, mut imaginary) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
            for (i, &(from, to)) in self.band_bins.iter().enumerate() {
                let (mut bl, mut br) = (0.0f32, 0.0f32);
                for k in from..to {
                    let ((lr, li), (rr, ri)) = (self.spec_l[k], self.spec_r[k]);
                    bl += lr * lr + li * li;
                    br += rr * rr + ri * ri;
                    cross += lr * rr + li * ri;
                    imaginary += li * rr - lr * ri;
                }
                el += bl;
                er += br;
                let pan = if bl + br > TINY { (br - bl) / (br + bl) } else { 0.0 };
                f.band_pan[i] = self.pan[i].update(pan, dt);
            }
            let correlation = if el * er > TINY * TINY { (cross / (el * er).sqrt()).clamp(-1.0, 1.0) } else { 1.0 };
            let (mid, side) = ((el + er + 2.0 * cross) / 4.0, (el + er - 2.0 * cross) / 4.0);
            let width = if mid + side > TINY { (side / (mid + side)).clamp(0.0, 1.0) } else { 0.0 };
            f.left_energy = el * self.power_scale;
            f.right_energy = er * self.power_scale;
            f.mid_energy = mid.max(0.0) * self.power_scale;
            f.side_energy = side.max(0.0) * self.power_scale;
            f.balance = (er - el) / (el + er).max(TINY);
            f.inter_channel_phase = imaginary.atan2(cross);
            f.inter_channel_coherence = if el * er > TINY {
                ((cross * cross + imaginary * imaginary) / (el * er)).sqrt().min(1.0)
            } else {
                0.0
            };
            f.correlation = self.correlation.update(correlation, dt);
            f.width = self.width.update(width, dt);
            f.stereo_confidence = f.presence;
        } else {
            f.stereo_confidence = 0.0;
            f.left_energy = if f.silent { 0.0 } else { total };
            f.right_energy = f.left_energy;
            f.mid_energy = f.left_energy;
            f.side_energy = 0.0;
            f.balance = 0.0;
            f.inter_channel_phase = 0.0;
            f.inter_channel_coherence = if f.silent { 0.0 } else { 1.0 };
            if f.silent {
                f.width = self.width.update(0.0, dt);
                f.correlation = self.correlation.update(1.0, dt);
            }
            if self.channels == 1 {
                f.correlation = 1.0;
                f.width = 0.0;
                f.band_pan = [0.0; BANDS];
            }
        }
        if self.hops % (4 * slow) == 0 {
            self.acoustic.analyze(&self.power, &self.spec_l, self.bin_hz, dt * (4 * slow) as f32, &mut self.frame);
        }
        // Every hop: cheap, and the floors and percentiles must not depend on the DSP quality.
        self.context.hop(&mut self.frame, dt);
    }

    /// Spectral flux: how far each bin rises above its own ~60 ms running level (dB), averaged per region.
    fn measure_flux(&mut self, dt: f32) {
        let f = &mut self.frame;
        let k_follow = 1.0 - (-dt / FLUX_BIN_TAU).exp();
        let mut regions = [0.0f32; 3];
        let (lo, hi) = (self.flux_bins[0].0, self.flux_bins[2].1);
        for k in lo..hi {
            let db = power_db(self.power[k].max(TINY));
            if !self.bin_level_ready {
                self.bin_level[k] = db;
                continue;
            }
            let rise = (db - self.bin_level[k]).max(0.0);
            self.bin_level[k] += (db - self.bin_level[k]) * k_follow;
            let region = if k < self.flux_bins[1].0 {
                0
            } else if k < self.flux_bins[2].0 {
                1
            } else {
                2
            };
            if db > SILENCE_DB + 1.0 {
                regions[region] += rise;
            }
        }
        self.bin_level_ready = true;
        let count = |(from, to): (usize, usize)| (to - from).max(1) as f32;
        f.flux_low = regions[0] / count(self.flux_bins[0]);
        f.flux_mid = regions[1] / count(self.flux_bins[1]);
        f.flux_high = regions[2] / count(self.flux_bins[2]);
        f.flux = (regions[0] + regions[1] + regions[2]) / (hi - lo).max(1) as f32;
        if f.silent {
            f.flux = 0.0;
            f.flux_low = 0.0;
            f.flux_mid = 0.0;
            f.flux_high = 0.0;
        }
    }
}
