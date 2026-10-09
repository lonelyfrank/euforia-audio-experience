//! Live music analysis for Spectrum.
//!
//! Samples go in as they are captured; measurements come out once per hop
//! (`HOP` samples, ≈ 5.3 ms at 48 kHz) as [`FeatureFrame`]s stamped with the
//! capture clock (a sample index), never with a rendering clock. Every few
//! hops a [`SceneFrame`] follows: what the scenes draw (levels, display
//! spectrum, waveform, voices), measured on the same clock. The crate
//! has no dependencies, no I/O and no rendering: the desktop app runs it on
//! the audio capture thread, the browser build runs it as WebAssembly, and
//! other hosts (e.g. a game) can embed it as a library.
//!
//! ```
//! use spectrum_analysis::{Analyzer, Event, HOP};
//! let mut analyzer = Analyzer::new(48_000.0, 2);
//! let silence = vec![0.0f32; HOP * 2 * 4];
//! let mut frames = 0;
//! analyzer.push(&silence, |event| {
//!     if let Event::Frame(frame) = event {
//!         assert!(frame.silent);
//!         frames += 1;
//!     }
//! });
//! assert_eq!(frames, 4);
//! ```

mod acoustic;
mod analyzer;
mod beat;
mod context;
mod fft;
mod follow;
mod frame;
mod harmony;
mod hpss;
mod loudness;
mod meter;
mod presence;
mod resonators;
mod rhythm;
mod scene;
mod structure;
pub mod wire;

pub use analyzer::{Analyzer, AnalyzerOptions, FFT_SIZE, HOP};
pub use beat::{BeatEvent, BEATS_PER_BAR};
pub use context::QUANTILES;
pub use frame::{FeatureFrame, Field, BANDS, BAND_EDGES};
pub use harmony::PARTIALS;
pub use loudness::SILENT_LUFS;
pub use rhythm::{OnsetEvent, MAX_BPM, MIN_BPM};
pub use scene::{SceneFrame, SCENE_FFT, SCENE_RATE, SHAPE_SIZE, SPECTRUM_BINS, VOICE_WINDOW, WAVEFORM_SIZE};
pub use structure::{SectionEvent, SectionKind};

/// What the analyzer reports, in time order.
#[derive(Clone, Copy, Debug)]
pub enum Event<'a> {
    /// The measurements of one hop (borrowed: copy what you keep).
    Frame(&'a FeatureFrame),
    /// An attack, stamped at its peak (reported one hop later).
    Onset(OnsetEvent),
    /// A beat of the tracked grid, stamped at its predicted time (reported in the hop that reaches it).
    Beat(BeatEvent),
    /// A section change, stamped at the downbeat it starts on (reported a beat later).
    Section(SectionEvent),
    /// The scenes' graphic analysis (borrowed), every few hops, right after the frame of its hop.
    Scene(&'a SceneFrame),
}

/// Level reported for silence (dB).
pub const SILENCE_DB: f32 = -96.0;
