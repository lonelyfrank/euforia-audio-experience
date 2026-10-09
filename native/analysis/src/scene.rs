//! The scenes' graphic analysis: levels, display spectrum, waveform, transients
//! and the two voices (bass line, lead) that the scenes draw.
//!
//! It is a port of the TypeScript `AudioAnalyzer` (which ran on the frame loop
//! and stays in the frontend as the reference): the same operations in the same
//! order, in f64 with f32 storage where the original stored in a
//! `Float32Array`, so both give the same numbers for the same windows. It runs
//! at a fixed cadence on the capture clock (every `every` hops, ≈ 60 Hz by
//! default) instead of once per rendered frame, and shares the analyzer's
//! sample clock, hop boundaries and event stream.
//!
//! Its spectrum is the mono mix in f64 (the musical analysis keeps its stereo
//! f32 spectra): one extra 2048-point transform per scene frame, which is what
//! keeps it comparable with the reference to the last digit.

use std::f64::consts::PI;

use crate::frame::{layout, Field};
use crate::HOP;

/// Analysis window of the scene spectrum.
pub const SCENE_FFT: usize = 2048;
pub const SPECTRUM_BINS: usize = 128;
pub const WAVEFORM_SIZE: usize = 1024;
/// Samples the voice trackers look at (low bass notes need about two periods).
pub const VOICE_WINDOW: usize = 4096;
/// Samples per cycle shape.
pub const SHAPE_SIZE: usize = 128;
/// Scene frames per second aimed at when the host does not choose a cadence.
pub const SCENE_RATE: f32 = 60.0;

const SILENCE_DB: f64 = -96.0;
const MIN_FREQ: f64 = 30.0;
const MAX_FREQ: f64 = 16000.0;
/// Display tilt (dB/octave around 1 kHz), dB window below the tracked top, and how fast the top falls (dB/s).
const SPECTRUM_TILT: f64 = 3.0;
const SPECTRUM_RANGE: f64 = 42.0;
const SPECTRUM_TOP_FALL: f64 = 4.0;
/// >1 expands dynamics after normalization so hits stand out.
const CONTRAST: f64 = 1.8;
const SILENCE_PEAK: f64 = 1e-4;
const FLUX_REGIONS: [f64; 4] = [30.0, 250.0, 2000.0, 16000.0];
const FLUX_BIN_TAU: f64 = 0.06;
const FLUX_LEVEL_TAU: f64 = 0.5;
const MIN_FLUX_DB: f64 = 5.0;
const FLUX_MEMORY: f64 = 2.0;
const NOISE_FLATNESS: f64 = 0.56;
const FLATNESS_FROM: f64 = 250.0;
const FLATNESS_TO: f64 = 8000.0;
const LOUDNESS_RANGE_DB: f64 = 60.0;
const BASS_CUTOFF: f64 = 250.0;
const KICK_CUTOFF: f64 = 120.0;
const BASS_WINDOW: f64 = 0.02;
const KICK_WINDOW: f64 = 0.01;
const VOLUME_WINDOW: f64 = 0.02;
/// Band edges (Hz) of lowMid, mid, highMid, treble.
const BANDS: [(f64, f64); 4] = [(250.0, 500.0), (500.0, 2000.0), (2000.0, 4000.0), (4000.0, 16000.0)];

const BASS_VOICE: VoiceConfig =
    VoiceConfig { high_pass: 30.0, low_pass: 600.0, min_pitch: 40.0, max_pitch: 300.0, decimation: 4, max_window: 600 };
const LEAD_VOICE: VoiceConfig = VoiceConfig {
    high_pass: 180.0,
    low_pass: 5000.0,
    min_pitch: 180.0,
    max_pitch: 1400.0,
    decimation: 2,
    max_window: 1024,
};

/// One scene frame: what the frontend's `AudioFrame` carries, measured over the
/// windows ending at `sample`. Levels are 0..1 unless named `*_db` / `*_hz`.
#[derive(Clone, Debug, PartialEq)]
pub struct SceneFrame {
    /// Capture clock: index of the sample right after the newest one analysed.
    pub sample: u64,
    pub silent: bool,
    pub centroid_hz: f64,
    pub rolloff_hz: f64,
    pub spread_hz: f64,
    pub rms: f64,
    pub volume: f64,
    pub peak: f64,
    pub bass: f64,
    pub low_mid: f64,
    pub mid: f64,
    pub high_mid: f64,
    pub treble: f64,
    pub energy: f64,
    /// True only on the frame where the kick tracker fired.
    pub beat: bool,
    pub beat_pulse: f64,
    pub onset: f64,
    pub bpm: f64,
    pub tempo_confidence: f64,
    pub beat_phase: f64,
    pub low_flux: f64,
    pub mid_flux: f64,
    pub high_flux: f64,
    pub flatness: f64,
    pub loudness: f64,
    pub low_db: f64,
    pub mid_db: f64,
    pub high_db: f64,
    pub bass_pitch: f64,
    pub bass_clarity: f64,
    pub lead_pitch: f64,
    pub lead_clarity: f64,
    pub spectrum: [f32; SPECTRUM_BINS],
    pub waveform: [f32; WAVEFORM_SIZE],
    pub bass_shape: [f32; SHAPE_SIZE],
    pub lead_shape: [f32; SHAPE_SIZE],
}

layout!(SceneFrame {
    sample: u64,
    silent: bool,
    centroid_hz: f64,
    rolloff_hz: f64,
    spread_hz: f64,
    rms: f64,
    volume: f64,
    peak: f64,
    bass: f64,
    low_mid: f64,
    mid: f64,
    high_mid: f64,
    treble: f64,
    energy: f64,
    beat: bool,
    beat_pulse: f64,
    onset: f64,
    bpm: f64,
    tempo_confidence: f64,
    beat_phase: f64,
    low_flux: f64,
    mid_flux: f64,
    high_flux: f64,
    flatness: f64,
    loudness: f64,
    low_db: f64,
    mid_db: f64,
    high_db: f64,
    bass_pitch: f64,
    bass_clarity: f64,
    lead_pitch: f64,
    lead_clarity: f64,
    spectrum: [f32; SPECTRUM_BINS],
    waveform: [f32; WAVEFORM_SIZE],
    bass_shape: [f32; SHAPE_SIZE],
    lead_shape: [f32; SHAPE_SIZE],
});

impl SceneFrame {
    fn new() -> Self {
        // Until a voice is heard, a sine.
        let sine: [f32; SHAPE_SIZE] = std::array::from_fn(|i| (2.0 * PI * i as f64 / SHAPE_SIZE as f64).sin() as f32);
        Self {
            sample: 0,
            silent: true,
            centroid_hz: 0.0,
            rolloff_hz: 0.0,
            spread_hz: 0.0,
            rms: 0.0,
            volume: 0.0,
            peak: 0.0,
            bass: 0.0,
            low_mid: 0.0,
            mid: 0.0,
            high_mid: 0.0,
            treble: 0.0,
            energy: 0.0,
            beat: false,
            beat_pulse: 0.0,
            onset: 0.0,
            bpm: 0.0,
            tempo_confidence: 0.0,
            beat_phase: 0.0,
            low_flux: 0.0,
            mid_flux: 0.0,
            high_flux: 0.0,
            flatness: 0.0,
            loudness: 0.0,
            low_db: SILENCE_DB,
            mid_db: SILENCE_DB,
            high_db: SILENCE_DB,
            bass_pitch: 0.0,
            bass_clarity: 0.0,
            lead_pitch: 0.0,
            lead_clarity: 0.0,
            spectrum: [0.0; SPECTRUM_BINS],
            waveform: [0.0; WAVEFORM_SIZE],
            bass_shape: sine,
            lead_shape: sine,
        }
    }
}

struct Band {
    from: usize,
    to: usize,
    range: DynamicRange,
}

#[derive(Clone, Copy)]
struct Flux {
    from: usize,
    to: usize,
    level: f64,
    strongest: f64,
}

/// The scene analysis of one capture. Fed one mono sample per captured frame
/// and told about every hop of the analyzer; allocation-free after construction.
pub struct Scene {
    sample_rate: f64,
    /// Hops between two scene frames, how many more a loaded DSP waits, and how many passed since the last one.
    every: u32,
    stretch: u32,
    since: u32,
    sensitivity: f64,
    smoothing: f64,
    /// The newest VOICE_WINDOW mono samples.
    ring: Vec<f32>,
    write: usize,
    /// The same, oldest first (filled for each frame).
    samples: Vec<f32>,
    time: f64,

    fft: Fft,
    window: Vec<f32>,
    windowed: Vec<f32>,
    magnitudes: Vec<f32>,
    /// Per FFT bin power in dB.
    bin_db: Vec<f32>,
    tilt: Vec<f32>,
    spectrum_from: Vec<f32>,
    spectrum_to: Vec<f32>,
    spectrum_levels: Vec<f32>,
    power_scale: f64,
    bands: [Band; 4],
    energy_from: usize,
    energy_to: usize,
    bin_average: Vec<f32>,
    bin_average_ready: bool,
    flux: [Flux; 3],
    flatness_from: usize,
    flatness_to: usize,
    bass_voice: VoiceTracker,
    lead_voice: VoiceTracker,
    smoother: Smoother,
    bass_range: DynamicRange,
    volume_range: DynamicRange,
    energy_range: DynamicRange,
    spectrum_top: f64,
    waveform_peak: PeakTracker,
    beats: BeatDetector,
    frame: SceneFrame,
}

impl Scene {
    pub fn new(sample_rate: f32) -> Self {
        let sample_rate = f64::from(sample_rate);
        let mut window = vec![0.0f32; SCENE_FFT];
        let mut window_sum = 0.0f64;
        for (i, w) in window.iter_mut().enumerate() {
            *w = (0.5 - 0.5 * ((2.0 * PI * i as f64) / (SCENE_FFT - 1) as f64).cos()) as f32;
            window_sum += f64::from(*w);
        }
        let half = SCENE_FFT / 2;
        let mut scene = Self {
            sample_rate,
            every: default_every(sample_rate as f32),
            stretch: 0,
            since: 0,
            sensitivity: 1.0,
            smoothing: 0.5,
            ring: vec![0.0; VOICE_WINDOW],
            write: 0,
            samples: vec![0.0; VOICE_WINDOW],
            time: 0.0,
            fft: Fft::new(SCENE_FFT),
            window,
            windowed: vec![0.0; SCENE_FFT],
            magnitudes: vec![0.0; half],
            bin_db: vec![0.0; half],
            tilt: vec![0.0; half],
            spectrum_from: vec![0.0; SPECTRUM_BINS],
            spectrum_to: vec![0.0; SPECTRUM_BINS],
            spectrum_levels: vec![0.0; SPECTRUM_BINS],
            power_scale: (2.0 / window_sum) * (2.0 / window_sum),
            bands: std::array::from_fn(|_| Band { from: 0, to: 0, range: DynamicRange::new() }),
            energy_from: 1,
            energy_to: 1,
            bin_average: vec![0.0; half],
            bin_average_ready: false,
            flux: [Flux { from: 0, to: 0, level: 0.0, strongest: MIN_FLUX_DB }; 3],
            flatness_from: 1,
            flatness_to: 1,
            bass_voice: VoiceTracker::new(BASS_VOICE, VOICE_WINDOW, sample_rate),
            lead_voice: VoiceTracker::new(LEAD_VOICE, VOICE_WINDOW, sample_rate),
            smoother: Smoother::default(),
            bass_range: DynamicRange::new(),
            volume_range: DynamicRange::new(),
            energy_range: DynamicRange::new(),
            spectrum_top: f64::NEG_INFINITY,
            waveform_peak: PeakTracker::new(0.003, 3.0),
            beats: BeatDetector::new(),
            frame: SceneFrame::new(),
        };
        scene.configure_frequency_map();
        scene
    }

    /// The user's reactivity (>1 reaches the maximum sooner) and smoothing (0 raw … 1 very smooth), and the
    /// cadence in hops (0 keeps the default of about `SCENE_RATE` frames per second). They apply from the next frame.
    pub fn configure(&mut self, sensitivity: f64, smoothing: f64, every: u32) {
        self.sensitivity = sensitivity;
        self.smoothing = smoothing;
        self.every = if every == 0 { default_every(self.sample_rate as f32) } else { every };
    }

    /// DSP quality (0 high … 2 low): an overloaded host draws the scenes' analysis less often (three
    /// quarters, then half the frames). Its time constants are in seconds, so only the picture's cadence changes.
    pub fn set_quality(&mut self, quality: u8) {
        self.stretch = match quality {
            0 => 0,
            1 => self.every.div_ceil(3),
            _ => self.every,
        };
    }

    /// Hops between two scene frames.
    pub fn every(&self) -> u32 {
        self.every + self.stretch
    }

    /// The latest frame.
    pub fn frame(&self) -> &SceneFrame {
        &self.frame
    }

    /// One captured frame, mixed to mono.
    #[inline]
    pub fn sample(&mut self, mono: f32) {
        self.ring[self.write] = mono;
        self.write = (self.write + 1) % VOICE_WINDOW;
    }

    /// A hop of the analyzer ended at `sample`; true when it produced a new scene frame.
    pub fn hop(&mut self, sample: u64) -> bool {
        self.since += 1;
        if self.since < self.every + self.stretch {
            return false;
        }
        let dt = f64::from(self.since) * HOP as f64 / self.sample_rate;
        self.since = 0;
        // Oldest first: the ring from its write position.
        let (head, tail) = self.ring.split_at(self.write);
        self.samples[..tail.len()].copy_from_slice(tail);
        self.samples[tail.len()..].copy_from_slice(head);
        self.analyze(dt);
        self.frame.sample = sample;
        true
    }

    fn analyze(&mut self, dt: f64) {
        let sample_rate = self.sample_rate;
        let sensitivity = self.sensitivity;
        self.time += dt;
        let time = self.time;
        self.smoother.configure(self.smoothing, dt);
        let smoother = self.smoother;
        let samples = &self.samples[VOICE_WINDOW - SCENE_FFT..];

        // Time domain: peak, loudness and the low-frequency envelopes.
        let mut peak = 0.0f64;
        for i in 0..SCENE_FFT {
            let a = f64::from(samples[i]).abs();
            if a > peak {
                peak = a;
            }
            self.windowed[i] = (f64::from(samples[i]) * f64::from(self.window[i])) as f32;
        }
        let silent = peak < SILENCE_PEAK;
        let f = &mut self.frame;
        f.peak = peak.min(1.0);
        f.silent = silent;
        let volume_db = mean_square_db(samples, js_round(VOLUME_WINDOW * sample_rate));
        f.rms = if silent { 0.0 } else { 10f64.powf(volume_db / 10.0).sqrt() };
        let bass_db = lowpass_energy_db(samples, BASS_CUTOFF, sample_rate, js_round(BASS_WINDOW * sample_rate));
        let kick_db = lowpass_energy_db(samples, KICK_CUTOFF, sample_rate, js_round(KICK_WINDOW * sample_rate));
        f.volume = smoother.apply(f.volume, shape(self.volume_range.normalize(volume_db, dt, sensitivity)));
        f.loudness = smoother.apply(f.loudness, clamp01(1.0 + volume_db / LOUDNESS_RANGE_DB));
        f.bass = smoother.apply(f.bass, shape(self.bass_range.normalize(bass_db, dt, sensitivity)));

        // Frequency domain: per-bin power in dB, bands and total energy.
        self.fft.magnitudes(&self.windowed, &mut self.magnitudes);
        let scale = self.power_scale;
        for i in 1..self.bin_db.len() {
            let m = f64::from(self.magnitudes[i]);
            self.bin_db[i] = (10.0 * (m * m * scale + 1e-20).log10()) as f32;
        }
        let mut levels = [0.0f64; 4];
        for (level, band) in levels.iter_mut().zip(&mut self.bands) {
            let db = band_power_db(&self.magnitudes, band.from, band.to, scale);
            *level = shape(band.range.normalize(db, dt, sensitivity));
        }
        f.low_mid = smoother.apply(f.low_mid, levels[0]);
        f.mid = smoother.apply(f.mid, levels[1]);
        f.high_mid = smoother.apply(f.high_mid, levels[2]);
        f.treble = smoother.apply(f.treble, levels[3]);
        let energy_db = band_power_db(&self.magnitudes, self.energy_from, self.energy_to, scale);
        // Raw region levels (the regions of the transients): they follow fades and cuts as they happen.
        let region = |r: usize| {
            let Flux { from, to, .. } = self.flux[r];
            band_power_db(&self.magnitudes, from, to, scale) + 10.0 * ((to - from).max(1) as f64).log10()
        };
        f.low_db = if silent { SILENCE_DB } else { bass_db.max(SILENCE_DB) };
        f.mid_db = if silent { SILENCE_DB } else { region(1).max(SILENCE_DB) };
        f.high_db = if silent { SILENCE_DB } else { region(2).max(SILENCE_DB) };
        f.energy = smoother.apply(f.energy, shape(self.energy_range.normalize(energy_db, dt, sensitivity)));

        self.measure_spectral_shape(silent);
        self.update_spectrum(dt, sensitivity);
        self.update_waveform(dt);
        self.update_flux(dt, silent);
        let flatness = if silent { 0.0 } else { self.measure_flatness() };
        self.frame.flatness = smoother.apply(self.frame.flatness, flatness);
        if !silent {
            VoiceTracker::isolate(&mut self.bass_voice, &mut self.lead_voice, &self.samples);
        }
        self.bass_voice.update(dt, silent, &mut self.frame.bass_shape);
        self.lead_voice.update(dt, silent, &mut self.frame.lead_shape);

        self.beats.update(kick_db, silent, time, dt);
        let f = &mut self.frame;
        f.bass_pitch = self.bass_voice.pitch;
        f.bass_clarity = self.bass_voice.clarity;
        f.lead_pitch = self.lead_voice.pitch;
        f.lead_clarity = self.lead_voice.clarity;
        f.beat = self.beats.beat;
        f.beat_pulse = self.beats.pulse;
        f.onset = self.beats.onset;
        f.bpm = self.beats.bpm;
        f.tempo_confidence = self.beats.confidence;
        f.beat_phase = self.beats.phase(time);
    }

    /// Centroid, spread and 85% rolloff, power weighted over 20 Hz–16 kHz (no display tilt).
    fn measure_spectral_shape(&mut self, silent: bool) {
        let bin_hz = self.sample_rate / SCENE_FFT as f64;
        let magnitudes = &self.magnitudes;
        let from = ((20.0 / bin_hz).ceil() as usize).max(1);
        let to = magnitudes.len().min((16000.0 / bin_hz).floor() as usize + 1);
        let (mut power, mut first, mut second) = (0.0f64, 0.0f64, 0.0f64);
        for i in from..to {
            let m = f64::from(magnitudes[i]);
            let p = m * m;
            let hz = i as f64 * bin_hz;
            power += p;
            first += p * hz;
            second += p * hz * hz;
        }
        let f = &mut self.frame;
        if silent || power < 1e-20 {
            f.centroid_hz = 0.0;
            f.rolloff_hz = 0.0;
            f.spread_hz = 0.0;
            return;
        }
        f.centroid_hz = first / power;
        f.spread_hz = (second / power - f.centroid_hz * f.centroid_hz).max(0.0).sqrt();
        let mut cumulative = 0.0f64;
        for i in from..to {
            let m = f64::from(magnitudes[i]);
            cumulative += m * m;
            if cumulative >= power * 0.85 {
                f.rolloff_hz = i as f64 * bin_hz;
                break;
            }
        }
    }

    fn update_spectrum(&mut self, dt: f64, sensitivity: f64) {
        // The loudest (tilted) bin sets the top of the displayed window; it falls back slowly.
        let mut top = SILENCE_DB;
        for b in 0..SPECTRUM_BINS {
            self.spectrum_levels[b] = self.bin_level(b) as f32;
            let level = f64::from(self.spectrum_levels[b]);
            if level > top {
                top = level;
            }
        }
        self.spectrum_top = top.max(self.spectrum_top - SPECTRUM_TOP_FALL * dt);
        let range = SPECTRUM_RANGE / sensitivity.max(0.1);
        let bottom = self.spectrum_top - range;
        let silent = self.spectrum_top <= SILENCE_DB;
        let smoother = self.smoother;
        for b in 0..SPECTRUM_BINS {
            let v = (f64::from(self.spectrum_levels[b]) - bottom) / range;
            let target = if silent { 0.0 } else { shape(if v < 0.0 { 0.0 } else if v > 1.0 { 1.0 } else { v }) };
            self.frame.spectrum[b] = smoother.apply(f64::from(self.frame.spectrum[b]), target) as f32;
        }
    }

    /// Tilted dB level of one log-spaced display bin.
    fn bin_level(&self, b: usize) -> f64 {
        let (bin_db, tilt) = (&self.bin_db, &self.tilt);
        let from = f64::from(self.spectrum_from[b]);
        let to = f64::from(self.spectrum_to[b]);
        if to - from < 1.0 {
            // Narrower than one FFT bin: interpolate.
            let i = from.floor() as usize;
            let next = (i + 1).min(bin_db.len() - 1);
            let t = from - i as f64;
            return f64::from(bin_db[i]) * (1.0 - t) + f64::from(bin_db[next]) * t + f64::from(tilt[i]);
        }
        let mut value = f64::NEG_INFINITY;
        let mut i = from.floor() as usize;
        while (i as f64) < to {
            value = value.max(f64::from(bin_db[i]) + f64::from(tilt[i]));
            i += 1;
        }
        value
    }

    /// Per-region transients: mean rise of each FFT bin over its own running level (spectral flux, dB),
    /// minus the region's running flux level so steady noise reads 0, normalized by the strongest recent one.
    fn update_flux(&mut self, dt: f64, silent: bool) {
        if !self.bin_average_ready {
            self.bin_average.copy_from_slice(&self.bin_db);
            self.bin_average_ready = true;
        }
        let k = 1.0 - (-dt / FLUX_BIN_TAU).exp();
        let k_level = 1.0 - (-dt / FLUX_LEVEL_TAU).exp();
        let memory = (-dt / FLUX_MEMORY).exp();
        for r in 0..self.flux.len() {
            let f = &mut self.flux[r];
            let mut sum = 0.0f64;
            for i in f.from..f.to {
                let db = f64::from(self.bin_db[i]);
                let rise = db - f64::from(self.bin_average[i]);
                if rise > 0.0 && db > SILENCE_DB {
                    sum += rise;
                }
                self.bin_average[i] = (f64::from(self.bin_average[i]) + rise * k) as f32;
            }
            let flux = sum / (f.to - f.from).max(1) as f64;
            let transient = if silent { 0.0 } else { (flux - f.level).max(0.0) };
            f.level += (flux - f.level) * k_level;
            f.strongest = transient.max(f.strongest * memory).max(MIN_FLUX_DB);
            let value = transient / f.strongest;
            match r {
                0 => self.frame.low_flux = value,
                1 => self.frame.mid_flux = value,
                _ => self.frame.high_flux = value,
            }
        }
    }

    /// Geometric over arithmetic mean power (250 Hz–8 kHz), scaled so white noise reads 1.
    fn measure_flatness(&self) -> f64 {
        let (mut log_sum, mut power_sum) = (0.0f64, 0.0f64);
        let count = (self.flatness_to as f64) - (self.flatness_from as f64);
        for i in self.flatness_from..self.flatness_to {
            log_sum += f64::from(self.bin_db[i]);
            let m = f64::from(self.magnitudes[i]);
            power_sum += m * m * self.power_scale;
        }
        let mean_db = log_sum / count;
        let power_db = 10.0 * (power_sum / count + 1e-20).log10();
        clamp01(10f64.powf((mean_db - power_db) / 10.0) / NOISE_FLATNESS)
    }

    /// Copies a zero-crossing aligned window so oscilloscopes stay stable.
    fn update_waveform(&mut self, dt: f64) {
        let samples = &self.samples[VOICE_WINDOW - SCENE_FFT..];
        let search_end = SCENE_FFT - WAVEFORM_SIZE;
        let search_start = search_end.saturating_sub(512);
        let mut start = search_end;
        let mut i = search_end;
        while i > search_start {
            if samples[i - 1] < 0.0 && samples[i] >= 0.0 {
                start = i;
                break;
            }
            i -= 1;
        }
        let mut peak = 0.0f64;
        for i in 0..WAVEFORM_SIZE {
            peak = peak.max(f64::from(samples[start + i]).abs());
        }
        self.waveform_peak.update(peak, dt);
        let scale = 0.85 / self.waveform_peak.peak;
        for i in 0..WAVEFORM_SIZE {
            let v = f64::from(samples[start + i]) * scale;
            self.frame.waveform[i] = (if v > 1.0 { 1.0 } else if v < -1.0 { -1.0 } else { v }) as f32;
        }
    }

    fn configure_frequency_map(&mut self) {
        let bin_hz = self.sample_rate / SCENE_FFT as f64;
        let last_bin = (SCENE_FFT / 2 - 1) as f64;
        let to_bin = |hz: f64| (hz / bin_hz).max(1.0).min(last_bin);
        for (band, (low, high)) in self.bands.iter_mut().zip(BANDS) {
            band.from = to_bin(low).floor() as usize;
            band.to = (band.from + 1).max(to_bin(high).ceil() as usize);
        }
        self.energy_from = to_bin(20.0).floor() as usize;
        self.energy_to = to_bin(MAX_FREQ).ceil() as usize;
        for (r, f) in self.flux.iter_mut().enumerate() {
            f.from = to_bin(FLUX_REGIONS[r]).floor() as usize;
            f.to = (f.from + 1).max(to_bin(FLUX_REGIONS[r + 1]).ceil() as usize);
        }
        self.flatness_from = to_bin(FLATNESS_FROM).floor() as usize;
        self.flatness_to = to_bin(FLATNESS_TO).ceil() as usize;

        let ratio = MAX_FREQ / MIN_FREQ;
        for b in 0..SPECTRUM_BINS {
            self.spectrum_from[b] = to_bin(MIN_FREQ * ratio.powf(b as f64 / SPECTRUM_BINS as f64)) as f32;
            self.spectrum_to[b] = to_bin(MIN_FREQ * ratio.powf((b + 1) as f64 / SPECTRUM_BINS as f64)) as f32;
        }
        for i in 0..self.tilt.len() {
            let hz = (i as f64 * bin_hz).max(MIN_FREQ);
            self.tilt[i] = (SPECTRUM_TILT * (hz / 1000.0).log2()) as f32;
        }
    }
}

/// Hops between two scene frames for about `SCENE_RATE` of them per second.
fn default_every(sample_rate: f32) -> u32 {
    ((sample_rate / HOP as f32 / SCENE_RATE).round() as u32).max(1)
}

/// `Math.round` for the positive values used here.
fn js_round(x: f64) -> usize {
    (x + 0.5).floor() as usize
}

fn clamp01(x: f64) -> f64 {
    if x < 0.0 {
        0.0
    } else if x > 1.0 {
        1.0
    } else {
        x
    }
}

fn shape(value: f64) -> f64 {
    value.powf(CONTRAST)
}

/// Mean power (dB) of the last `length` samples.
fn mean_square_db(samples: &[f32], length: usize) -> f64 {
    let length = length.min(samples.len());
    let mut sum = 0.0f64;
    for &s in &samples[samples.len() - length..] {
        sum += f64::from(s) * f64::from(s);
    }
    10.0 * (sum / length as f64 + 1e-20).log10()
}

/// Power (dB) of the last `length` samples after a two-pole low-pass. The
/// filter runs over the whole window so it is settled when measuring.
fn lowpass_energy_db(samples: &[f32], cutoff: f64, sample_rate: f64, length: usize) -> f64 {
    let a = ((-2.0 * PI * cutoff) / sample_rate).exp();
    let b = 1.0 - a;
    let (mut y1, mut y2, mut sum) = (0.0f64, 0.0f64, 0.0f64);
    let measure_from = samples.len() as isize - length as isize;
    for (i, &s) in samples.iter().enumerate() {
        y1 = b * f64::from(s) + a * y1;
        y2 = b * y1 + a * y2;
        if i as isize >= measure_from {
            sum += y2 * y2;
        }
    }
    10.0 * (sum / length as f64 + 1e-20).log10()
}

/// Mean power (dB) of FFT bins [from, to).
fn band_power_db(magnitudes: &[f32], from: usize, to: usize, scale: f64) -> f64 {
    let mut sum = 0.0f64;
    for &m in &magnitudes[from..to.max(from)] {
        sum += f64::from(m) * f64::from(m);
    }
    10.0 * ((sum * scale) / to.saturating_sub(from).max(1) as f64 + 1e-20).log10()
}

/// Frame-rate independent attack/release smoothing; `smoothing` is the user-facing 0..1 amount.
#[derive(Clone, Copy, Default)]
struct Smoother {
    attack: f64,
    release: f64,
}

impl Smoother {
    fn configure(&mut self, smoothing: f64, dt: f64) {
        let s = smoothing.max(0.0).min(1.0);
        // Rises are near-instant so hits land on time; falls carry the smoothing.
        let attack_tau = 0.004 + s * 0.02;
        let release_tau = 0.02 + s * 0.22;
        self.attack = 1.0 - (-dt / attack_tau).exp();
        self.release = 1.0 - (-dt / release_tau).exp();
    }

    fn apply(&self, previous: f64, target: f64) -> f64 {
        previous + (target - previous) * if target > previous { self.attack } else { self.release }
    }
}

const MIN_RANGE_DB: f64 = 18.0;
const RELATIVE_WEIGHT: f64 = 0.5;
/// dB per second the peak falls back after a loud passage.
const PEAK_FALL: f64 = 3.0;
/// Floor time constants (s): it follows quiet parts fairly quickly, loud parts slowly.
const FLOOR_DOWN_TAU: f64 = 1.5;
const FLOOR_UP_TAU: f64 = 6.0;
/// Time constant (s) of the running mean/deviation, and the deviation floor (dB).
const RELATIVE_TAU: f64 = 1.5;
const MIN_DEVIATION_DB: f64 = 1.5;

/// Maps a level in dB to 0..1 following the music at any playback volume: half its position between
/// the recent peak and a slow floor, half its distance from the running mean in running deviations.
struct DynamicRange {
    peak: f64,
    floor: f64,
    mean: f64,
    deviation: f64,
}

impl DynamicRange {
    fn new() -> Self {
        Self { peak: f64::NEG_INFINITY, floor: 0.0, mean: 0.0, deviation: 0.0 }
    }

    fn normalize(&mut self, db: f64, dt: f64, sensitivity: f64) -> f64 {
        if db < SILENCE_DB {
            return 0.0;
        }
        if !self.peak.is_finite() {
            self.peak = db;
            self.floor = db - MIN_RANGE_DB;
            self.mean = db;
            self.deviation = MIN_DEVIATION_DB;
        }
        self.peak = db.max(self.peak - PEAK_FALL * dt);
        let tau = if db < self.floor { FLOOR_DOWN_TAU } else { FLOOR_UP_TAU };
        self.floor += (db - self.floor) * (1.0 - (-dt / tau).exp());
        self.floor = self.floor.min(self.peak - MIN_RANGE_DB);
        let absolute = (db - self.floor) / ((self.peak - self.floor) / sensitivity);

        let k = 1.0 - (-dt / RELATIVE_TAU).exp();
        self.mean += (db - self.mean) * k;
        self.deviation += ((db - self.mean).abs() - self.deviation) * k;
        let relative = 0.5 + ((db - self.mean) * sensitivity) / (2.5 * self.deviation.max(MIN_DEVIATION_DB));

        clamp01(absolute * (1.0 - RELATIVE_WEIGHT) + relative * RELATIVE_WEIGHT)
    }
}

/// Slowly decaying peak follower in linear units (auto-scales the waveform); `floor` keeps near-silence quiet.
struct PeakTracker {
    floor: f64,
    decay: f64,
    peak: f64,
}

impl PeakTracker {
    fn new(floor: f64, decay: f64) -> Self {
        Self { floor, decay, peak: floor }
    }

    fn update(&mut self, value: f64, dt: f64) {
        self.peak = value.max(self.floor).max(self.peak * (-dt / self.decay).exp());
    }
}

/// Iterative radix-2 FFT of real input in f64. The twiddles of every stage are stored one stage after
/// the other, so each stage runs over plain slices: the butterflies of a stage do not depend on each
/// other, and the compiler may compute several at once without changing any of them.
struct Fft {
    size: usize,
    re: Vec<f64>,
    im: Vec<f64>,
    cos: Vec<f64>,
    sin: Vec<f64>,
    reverse: Vec<u32>,
}

impl Fft {
    fn new(size: usize) -> Self {
        assert!(size.is_power_of_two() && size >= 2);
        let bits = size.trailing_zeros();
        let (mut cos, mut sin) = (Vec::with_capacity(size), Vec::with_capacity(size));
        let mut len = 2;
        while len <= size {
            let step = size / len;
            for k in 0..len / 2 {
                let angle = (-2.0 * PI * (k * step) as f64) / size as f64;
                cos.push(angle.cos());
                sin.push(angle.sin());
            }
            len <<= 1;
        }
        Self {
            size,
            re: vec![0.0; size],
            im: vec![0.0; size],
            cos,
            sin,
            reverse: (0..size as u32).map(|i| i.reverse_bits() >> (32 - bits)).collect(),
        }
    }

    /// Transforms `input` (already windowed) and writes the magnitudes of the first size/2 bins.
    fn magnitudes(&mut self, input: &[f32], magnitudes: &mut [f32]) {
        let Self { size, re, im, cos, sin, reverse } = self;
        let size = *size;
        im.fill(0.0);
        for (&x, &r) in input[..size].iter().zip(reverse.iter()) {
            re[r as usize] = f64::from(x);
        }
        let mut len = 2;
        let mut twiddles = 0;
        while len <= size {
            let half = len >> 1;
            let (wr, wi) = (&cos[twiddles..twiddles + half], &sin[twiddles..twiddles + half]);
            for (re, im) in re.chunks_exact_mut(len).zip(im.chunks_exact_mut(len)) {
                let (re_a, re_b) = re.split_at_mut(half);
                let (im_a, im_b) = im.split_at_mut(half);
                for k in 0..half {
                    let tr = re_b[k] * wr[k] - im_b[k] * wi[k];
                    let ti = re_b[k] * wi[k] + im_b[k] * wr[k];
                    re_b[k] = re_a[k] - tr;
                    im_b[k] = im_a[k] - ti;
                    re_a[k] += tr;
                    im_a[k] += ti;
                }
            }
            twiddles += half;
            len <<= 1;
        }
        for ((m, &re), &im) in magnitudes.iter_mut().zip(&re[..size >> 1]).zip(&im[..size >> 1]) {
            *m = re.hypot(im) as f32;
        }
    }
}

/// YIN threshold: the first dip of the normalized difference below this is the period.
const YIN_THRESHOLD: f64 = 0.15;
/// Above this (best dip) the band is considered unpitched (noise, chords that do not fuse).
const UNVOICED: f64 = 0.45;
/// Most cycles averaged into the shape.
const MAX_CYCLES: f64 = 24.0;
/// Time constant (s) of the displayed shape following the measured one.
const SHAPE_TAU: f64 = 0.06;
/// Lags whose difference sums run side by side (each one stays a sequential sum).
const LANES: usize = 8;

#[derive(Clone, Copy)]
struct VoiceConfig {
    /// Band kept for this voice (Hz).
    high_pass: f64,
    low_pass: f64,
    /// Pitch search range (Hz).
    min_pitch: f64,
    max_pitch: f64,
    /// Decimation factor after filtering (keeps the pitch search cheap).
    decimation: usize,
    /// Longest YIN integration window, in decimated samples.
    max_window: usize,
}

/// Follows one voice of the mix as an oscilloscope in averaging mode would: the band is isolated, its pitch
/// found (YIN), and the cycles at that period are stacked so what is not in phase with the voice cancels out
/// and the shape of one cycle remains, aligned on its fundamental.
struct VoiceTracker {
    config: VoiceConfig,
    /// The band, decimated, as f64 (exact) for the difference sums.
    buffer: Vec<f64>,
    normalized: Vec<f32>,
    cycle: [f32; SHAPE_SIZE],
    aligned: [f32; SHAPE_SIZE],
    rate: f64,
    min_lag: usize,
    max_lag: usize,
    /// The band-pass: two high-pass sections, then two low-pass ones.
    filter: [Biquad; 4],
    /// cos and sin of 2πi / SHAPE_SIZE.
    turn: [(f64, f64); SHAPE_SIZE],
    pitch: f64,
    clarity: f64,
}

impl VoiceTracker {
    fn new(config: VoiceConfig, window: usize, sample_rate: f64) -> Self {
        let length = window / config.decimation;
        let rate = sample_rate / config.decimation as f64;
        Self {
            config,
            // One spare lane past the end, so the last group of lags reads in bounds.
            buffer: vec![0.0; length + LANES],
            normalized: vec![0.0; length],
            cycle: [0.0; SHAPE_SIZE],
            aligned: [0.0; SHAPE_SIZE],
            rate,
            min_lag: ((rate / config.max_pitch).floor() as usize).max(2),
            max_lag: ((rate / config.min_pitch).ceil() as usize).min(length / 2),
            filter: [
                Biquad::high_pass(config.high_pass, sample_rate),
                Biquad::high_pass(config.high_pass, sample_rate),
                Biquad::low_pass(config.low_pass, sample_rate),
                Biquad::low_pass(config.low_pass, sample_rate),
            ],
            turn: std::array::from_fn(|i| {
                let angle = (2.0 * PI * i as f64) / SHAPE_SIZE as f64;
                (angle.cos(), angle.sin())
            }),
            pitch: 0.0,
            clarity: 0.0,
        }
    }

    fn length(&self) -> usize {
        self.normalized.len()
    }

    /// After `isolate`: finds the pitch and folds the cycles into `shape`, the displayed cycle.
    fn update(&mut self, dt: f64, silent: bool, shape: &mut [f32; SHAPE_SIZE]) {
        if silent {
            self.pitch = 0.0;
            self.clarity = 0.0;
            return;
        }
        let period = self.find_period();
        if period == 0.0 {
            self.pitch = 0.0;
            return;
        }
        self.pitch = self.rate / period;
        self.fold(period);
        let follow = 1.0 - (-dt / SHAPE_TAU).exp();
        for (s, a) in shape.iter_mut().zip(&self.aligned) {
            *s = (f64::from(*s) + (f64::from(*a) - f64::from(*s)) * follow) as f32;
        }
    }

    /// Band-passes (4th order each side) and decimates the newest samples into the `buffer` of two
    /// voices. Both run over the same samples, each from a cleared filter, so they go side by side:
    /// every voice keeps its own operations in its own order, two at a time.
    ///
    /// The four sections of a filter are in series, and a section's output is a long chain of
    /// operations behind its input. So each turn of the loop runs section `s` on sample `i - s`,
    /// on what the section before it produced in the previous turn: the four no longer wait for
    /// each other within a turn. Every section still sees its samples in order from a cleared state.
    fn isolate(a: &mut VoiceTracker, b: &mut VoiceTracker, samples: &[f32]) {
        const SECTIONS: usize = 4;
        let decimation = [a.config.decimation, b.config.decimation];
        let count = a.length() * decimation[0];
        assert!(count == b.length() * decimation[1] && count <= samples.len() && count >= SECTIONS);
        let samples = &samples[samples.len() - count..];
        let filter: [Biquad2; SECTIONS] = std::array::from_fn(|i| Biquad2::pair(&a.filter[i], &b.filter[i]));
        let mut state = [[[0.0f64; 2]; 4]; SECTIONS];
        // What each section produced in the previous turn.
        let mut out = [[0.0f64; 2]; SECTIONS];
        for i in 0..count + SECTIONS - 1 {
            for s in (1..SECTIONS).rev() {
                if i >= s && i - s < count {
                    out[s] = filter[s].run(out[s - 1], &mut state[s]);
                }
            }
            if i < count {
                let x = f64::from(samples[i]);
                out[0] = filter[0].run([x, x], &mut state[0]);
            }
            if i >= SECTIONS - 1 {
                // The last section just finished sample `k`. Stored as the reference stores it (f32),
                // read back exactly.
                let k = i - (SECTIONS - 1);
                if (k + 1) % decimation[0] == 0 {
                    a.buffer[(k + 1) / decimation[0] - 1] = f64::from(out[SECTIONS - 1][0] as f32);
                }
                if (k + 1) % decimation[1] == 0 {
                    b.buffer[(k + 1) / decimation[1] - 1] = f64::from(out[SECTIONS - 1][1] as f32);
                }
            }
        }
    }

    /// YIN on the newest part of the buffer; returns the period in decimated samples (0 = unpitched).
    fn find_period(&mut self) -> f64 {
        let n = self.length();
        let (min_lag, max_lag) = (self.min_lag, self.max_lag);
        let window = self.config.max_window.min(n - max_lag);
        let from = n - window - max_lag;
        let buffer = &self.buffer;
        let cmnd = &mut self.normalized;
        let mut energy = 0.0f64;
        for &x in &buffer[from..n] {
            energy += x * x;
        }
        if energy < 1e-9 {
            self.clarity = 0.0;
            return 0.0;
        }

        // The difference function, LANES lags at a time: each lag is its own sequential sum (the same
        // result as one lag at a time), the lanes only keep the processor busy between two additions.
        let mut running = 0.0f64;
        let mut tau = 1;
        while tau <= max_lag {
            let mut sums = [0.0f64; LANES];
            let base = &buffer[from..from + window];
            let lagged = &buffer[from + tau..from + tau + window + LANES - 1];
            for (j, &x) in base.iter().enumerate() {
                let group = &lagged[j..j + LANES];
                for (sum, &y) in sums.iter_mut().zip(group) {
                    let diff = x - y;
                    *sum += diff * diff;
                }
            }
            for (lane, &sum) in sums.iter().enumerate() {
                let t = tau + lane;
                if t > max_lag {
                    break;
                }
                running += sum;
                cmnd[t] = (if running > 0.0 { (sum * t as f64) / running } else { 1.0 }) as f32;
            }
            tau += LANES;
        }

        let at = |tau: usize| f64::from(cmnd[tau]);
        let mut best = 0;
        let mut tau = min_lag;
        while tau <= max_lag {
            if at(tau) < YIN_THRESHOLD {
                while tau + 1 <= max_lag && at(tau + 1) < at(tau) {
                    tau += 1;
                }
                best = tau;
                break;
            }
            tau += 1;
        }
        if best == 0 {
            // No dip under the threshold: the deepest one, if it is deep enough.
            let mut min = f64::INFINITY;
            for tau in min_lag..=max_lag {
                if at(tau) < min {
                    min = at(tau);
                    best = tau;
                }
            }
        }
        self.clarity = (1.0 - at(best)).min(1.0).max(0.0);
        if at(best) > UNVOICED || best <= min_lag || best >= max_lag {
            return 0.0;
        }
        // Parabolic interpolation of the dip: sub-sample period.
        let (a, b, c) = (at(best - 1), at(best), at(best + 1));
        let curvature = a - 2.0 * b + c;
        if curvature > 0.0 {
            best as f64 + ((0.5 * (a - c)) / curvature).min(0.5).max(-0.5)
        } else {
            best as f64
        }
    }

    /// Stacks the newest cycles at `period` and averages them into one cycle, then aligns it so its
    /// fundamental is a sine starting at phase 0 and normalizes it to -1..1.
    fn fold(&mut self, period: f64) {
        let n = self.length();
        let buffer = &self.buffer;
        let cycles = MAX_CYCLES.min(((n - 2) as f64 / period).floor()) as usize;
        self.cycle = [0.0; SHAPE_SIZE];
        for c in 0..cycles {
            let origin = (n - 1) as f64 - (c + 1) as f64 * period;
            for i in 0..SHAPE_SIZE {
                // Never negative: the oldest cycle starts at or after sample 1.
                let x = origin + (i as f64 * period) / SHAPE_SIZE as f64;
                let at = x as usize;
                let t = x - at as f64;
                self.cycle[i] = (f64::from(self.cycle[i]) + (buffer[at] * (1.0 - t) + buffer[at + 1] * t)) as f32;
            }
        }
        // Remove DC, find the fundamental's phase.
        let mut mean = 0.0f64;
        for &v in &self.cycle {
            mean += f64::from(v);
        }
        mean /= SHAPE_SIZE as f64;
        let (mut re, mut im) = (0.0f64, 0.0f64);
        for i in 0..SHAPE_SIZE {
            self.cycle[i] = (f64::from(self.cycle[i]) - mean) as f32;
            let (cos, sin) = self.turn[i];
            re += f64::from(self.cycle[i]) * cos;
            im += f64::from(self.cycle[i]) * sin;
        }
        // cycle ≈ A·sin(angle + phase): rotate by -phase.
        let shift = (re.atan2(im) / (2.0 * PI)) * SHAPE_SIZE as f64;
        let mut peak = 1e-9f64;
        for i in 0..SHAPE_SIZE {
            let mut x = i as f64 - shift;
            x -= (x / SHAPE_SIZE as f64).floor() * SHAPE_SIZE as f64;
            // 0 ≤ x ≤ SHAPE_SIZE; rounding can land exactly on SHAPE_SIZE: that is index 0 of the next turn.
            let whole = x as usize;
            let j = whole % SHAPE_SIZE;
            let t = x - whole as f64;
            let (a, b) = (f64::from(self.cycle[j]), f64::from(self.cycle[(j + 1) % SHAPE_SIZE]));
            self.aligned[i] = (a * (1.0 - t) + b * t) as f32;
            peak = peak.max(f64::from(self.aligned[i]).abs());
        }
        for v in &mut self.aligned {
            *v = (f64::from(*v) / peak) as f32;
        }
    }
}

/// Second-order Butterworth section (RBJ cookbook), direct form I: its coefficients.
#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Biquad {
    fn low_pass(hz: f64, sample_rate: f64) -> Self {
        let w = (2.0 * PI * hz) / sample_rate;
        let alpha = w.sin() / std::f64::consts::SQRT_2;
        let cos = w.cos();
        let a0 = 1.0 + alpha;
        let b0 = (1.0 - cos) / 2.0 / a0;
        Self { b0, b1: (1.0 - cos) / a0, b2: b0, a1: (-2.0 * cos) / a0, a2: (1.0 - alpha) / a0 }
    }

    fn high_pass(hz: f64, sample_rate: f64) -> Self {
        let w = (2.0 * PI * hz) / sample_rate;
        let alpha = w.sin() / std::f64::consts::SQRT_2;
        let cos = w.cos();
        let a0 = 1.0 + alpha;
        let b0 = (1.0 + cos) / 2.0 / a0;
        Self { b0, b1: -(1.0 + cos) / a0, b2: b0, a1: (-2.0 * cos) / a0, a2: (1.0 - alpha) / a0 }
    }
}

/// Two independent sections run together: lane 0 and lane 1 never mix.
struct Biquad2 {
    b0: [f64; 2],
    b1: [f64; 2],
    b2: [f64; 2],
    a1: [f64; 2],
    a2: [f64; 2],
}

impl Biquad2 {
    fn pair(a: &Biquad, b: &Biquad) -> Self {
        Self { b0: [a.b0, b.b0], b1: [a.b1, b.b1], b2: [a.b2, b.b2], a1: [a.a1, b.a1], a2: [a.a2, b.a2] }
    }

    /// `state`: x1, x2, y1, y2 of each lane.
    #[inline(always)]
    fn run(&self, x: [f64; 2], state: &mut [[f64; 2]; 4]) -> [f64; 2] {
        let [x1, x2, y1, y2] = *state;
        let mut y = [0.0; 2];
        for l in 0..2 {
            let forward = self.b0[l] * x[l] + self.b1[l] * x1[l] + self.b2[l] * x2[l];
            y[l] = forward - self.a1[l] * y1[l] - self.a2[l] * y2[l];
        }
        *state = [x, x1, y, y1];
        y
    }
}

const MIN_ONSET_INTERVAL: f64 = 0.2;
/// Time constant (s) of the running average the kick is compared to.
const AVERAGE_TAU: f64 = 0.35;
/// Smallest rise over the average (dB) that can count as an onset.
const MIN_RISE_DB: f64 = 3.0;
/// Fraction of the recent strongest rise an onset must reach.
const RELATIVE_THRESHOLD: f64 = 0.45;
/// Seconds for the strongest-rise memory to decay by ~63%.
const RISE_MEMORY: f64 = 2.0;
/// Onset-strength history used for the tempo estimate (Hz, values).
const RATE: f64 = 100.0;
const HISTORY: usize = 600;
const MIN_BPM: f64 = 70.0;
const MAX_BPM: f64 = 180.0;
/// Tempo prior: the estimate prefers periods near this BPM (resolves double/half time).
const PREFERRED_BPM: f64 = 120.0;
const RETEMPO_INTERVAL: f64 = 0.5;
/// An onset within this fraction of the period from the prediction is taken as the beat.
const PHASE_WINDOW: f64 = 0.25;
/// How much an accepted onset pulls the phase (0 = ignore, 1 = snap).
const PHASE_CORRECTION: f64 = 0.6;
/// Predicted beats kept without any supporting onset before tracking stops.
const MAX_MISSED: u32 = 4;
const PULSE_DECAY: f64 = 8.0;
const SUPPORT_GAIN: f64 = 0.25;
const SUPPORT_LOSS: f64 = 0.2;
const PERIODICITY_LOW: f64 = 0.1;
const PERIODICITY_HIGH: f64 = 0.35;
/// Onset-strength variance below which the history is considered flat (no rhythm).
const MIN_ONSET_VARIANCE: f64 = 1e-3;

/// The scenes' own kick tracker (the pulse of the core and of the historical scenes): onsets of the kick
/// level over its running average, a tempo from their autocorrelation, and a predicted beat that onsets
/// correct. Independent of the musical beat grid (`BeatTracker`), which is what the show is timed on.
struct BeatDetector {
    beat: bool,
    pulse: f64,
    onset: f64,
    bpm: f64,
    confidence: f64,
    periodicity: f64,
    support: f64,
    scores: Vec<f32>,
    average: f64,
    previous_rise: f64,
    strongest_rise: f64,
    last_onset: f64,
    history: Vec<f32>,
    history_index: usize,
    history_time: f64,
    filled: usize,
    since_retempo: f64,
    period: f64,
    next_beat: f64,
    missed: u32,
}

impl BeatDetector {
    fn new() -> Self {
        Self {
            beat: false,
            pulse: 0.0,
            onset: 0.0,
            bpm: 0.0,
            confidence: 0.0,
            periodicity: 0.0,
            support: 0.0,
            scores: vec![0.0; js_round((60.0 / MIN_BPM) * RATE) + 2],
            average: f64::NAN,
            previous_rise: 0.0,
            strongest_rise: MIN_RISE_DB * 2.0,
            last_onset: -1.0,
            history: vec![0.0; HISTORY],
            history_index: 0,
            history_time: 0.0,
            filled: 0,
            since_retempo: 0.0,
            period: 0.0,
            next_beat: 0.0,
            missed: 0,
        }
    }

    /// `kick_db`: level of the kick band over the last few milliseconds.
    fn update(&mut self, kick_db: f64, silent: bool, time: f64, dt: f64) {
        if self.average.is_nan() {
            self.average = kick_db;
        }
        let rise = if silent { 0.0 } else { (kick_db - self.average).max(0.0) };
        self.average += (kick_db - self.average) * (1.0 - (-dt / AVERAGE_TAU).exp());
        self.strongest_rise = rise.max(self.strongest_rise * (-dt / RISE_MEMORY).exp()).max(MIN_RISE_DB * 2.0);
        self.onset = (rise / self.strongest_rise).min(1.0);

        let threshold = MIN_RISE_DB.max(self.strongest_rise * RELATIVE_THRESHOLD);
        let is_onset = rise > threshold
            && self.previous_rise <= threshold
            && (self.last_onset < 0.0 || time - self.last_onset > MIN_ONSET_INTERVAL);
        self.previous_rise = rise;
        if is_onset {
            self.last_onset = time;
        }

        self.record(self.onset, dt);
        self.since_retempo += dt;
        if self.since_retempo >= RETEMPO_INTERVAL {
            self.since_retempo = 0.0;
            self.estimate_tempo(silent, time);
        }

        self.beat = self.track(is_onset, silent, time);
        self.pulse = if self.beat { 1.0 } else { self.pulse * (-dt * PULSE_DECAY).exp() };
        self.confidence = if self.period == 0.0 {
            0.0
        } else {
            smoothstep(PERIODICITY_LOW, PERIODICITY_HIGH, self.periodicity) * self.support
        };
    }

    /// Position inside the current beat, 0..1 (0 = on the beat); 0 while no tempo is known.
    fn phase(&self, time: f64) -> f64 {
        if self.period == 0.0 {
            return 0.0;
        }
        let p = 1.0 - (self.next_beat - time) / self.period;
        if p < 0.0 {
            0.0
        } else if p > 1.0 {
            p - p.floor()
        } else {
            p
        }
    }

    /// Returns whether a beat falls on this frame.
    fn track(&mut self, is_onset: bool, silent: bool, time: f64) -> bool {
        let period = self.period;
        if period == 0.0 {
            return is_onset;
        }
        if is_onset {
            // Signed distance to the nearest predicted beat (the one just passed or the next).
            let error = time - self.next_beat;
            let nearest = if error < -period / 2.0 { error + period } else { error };
            if nearest.abs() < period * PHASE_WINDOW {
                self.next_beat = time - nearest * (1.0 - PHASE_CORRECTION) + period;
                self.missed = 0;
                self.support += (1.0 - self.support) * SUPPORT_GAIN;
                // Fire unless the predicted beat already fired a moment ago (onset slightly late).
                return error >= 0.0 || nearest <= 0.0;
            }
            return false;
        }
        if time >= self.next_beat {
            // No onset at the predicted time: keep the rhythm going for a while.
            self.next_beat += period;
            self.support *= 1.0 - SUPPORT_LOSS;
            if silent || {
                self.missed += 1;
                self.missed > MAX_MISSED
            } {
                self.period = 0.0;
                self.bpm = 0.0;
                self.support = 0.0;
                return false;
            }
            return true;
        }
        false
    }

    /// Bins since the last beat of the grid (spacing `lag`) that collects the most onset strength.
    fn phase_ago(&self, lag: usize, start: usize, n: usize) -> usize {
        let newest = (start + n - 1) as isize;
        let mut best = 0;
        let mut best_sum = -1.0f64;
        for p in 0..lag {
            let mut sum = 0.0f64;
            let mut i = newest - p as isize;
            while i >= start as isize {
                sum += f64::from(self.history[i as usize % HISTORY]);
                i -= lag as isize;
            }
            if sum > best_sum {
                best_sum = sum;
                best = p;
            }
        }
        best
    }

    /// Writes onset strength into the 100 Hz history, holding it across frame gaps.
    fn record(&mut self, value: f64, dt: f64) {
        self.history_time += dt;
        while self.history_time >= 1.0 / RATE {
            self.history_time -= 1.0 / RATE;
            self.history[self.history_index] = value as f32;
            self.history_index = (self.history_index + 1) % HISTORY;
            self.filled = (self.filled + 1).min(HISTORY);
        }
    }

    fn estimate_tempo(&mut self, silent: bool, time: f64) {
        if silent || (self.filled as f64) < 3.0 * RATE {
            return;
        }
        let n = self.filled;
        let start = (self.history_index + HISTORY - n) % HISTORY;
        let value = |history: &[f32], i: usize| f64::from(history[i % HISTORY]);
        let mut mean = 0.0f64;
        for i in 0..n {
            mean += value(&self.history, start + i);
        }
        mean /= n as f64;
        let mut energy = 0.0f64;
        for i in 0..n {
            let d = value(&self.history, start + i) - mean;
            energy += d * d;
        }
        // Onset strength that barely varies (steady tones, numerical noise) has no rhythm to find.
        if energy / (n as f64) < MIN_ONSET_VARIANCE {
            self.periodicity = 0.0;
            return;
        }

        let min_lag = js_round((60.0 / MAX_BPM) * RATE);
        let max_lag = js_round((60.0 / MIN_BPM) * RATE);
        let mut best_lag = 0;
        let mut best_score = 0.0f64;
        for lag in min_lag - 1..=max_lag + 1 {
            let mut r = 0.0f64;
            for i in lag..n {
                r += (value(&self.history, start + i) - mean) * (value(&self.history, start + i - lag) - mean);
            }
            self.scores[lag] = (r / energy) as f32;
            if lag < min_lag || lag > max_lag {
                continue;
            }
            let bpm = (60.0 * RATE) / lag as f64;
            // Log-normal prior around the preferred tempo.
            let z = (bpm / PREFERRED_BPM).log2() / 0.9;
            let prior = (-0.5 * (z * z)).exp();
            let score = f64::from(self.scores[lag]) * prior;
            if score > best_score {
                best_score = score;
                best_lag = lag;
            }
        }
        // Weak periodicity: no reliable tempo.
        if best_score < 0.08 {
            self.periodicity *= 0.5;
            return;
        }
        self.periodicity = f64::from(self.scores[best_lag]);
        // Parabolic interpolation around the peak: sub-bin lag, so the tempo is not quantized to 10 ms.
        let a = f64::from(self.scores[best_lag - 1]);
        let b = f64::from(self.scores[best_lag]);
        let c = f64::from(self.scores[best_lag + 1]);
        let curvature = a - 2.0 * b + c;
        let offset = if curvature < 0.0 { ((0.5 * (a - c)) / curvature).min(0.5).max(-0.5) } else { 0.0 };
        let period = (best_lag as f64 + offset) / RATE;
        if self.period == 0.0 {
            self.period = period;
            self.next_beat = time - self.phase_ago(best_lag, start, n) as f64 / RATE + period;
            self.missed = 0;
            // Support is earned: only onsets that land on predicted beats raise it.
            self.support = 0.0;
        } else {
            self.period += (period - self.period) * 0.3;
        }
        self.bpm = 60.0 / self.period;
    }
}

fn smoothstep(edge0: f64, edge1: f64, x: f64) -> f64 {
    let t = ((x - edge0) / (edge1 - edge0)).max(0.0).min(1.0);
    t * t * (3.0 - 2.0 * t)
}
