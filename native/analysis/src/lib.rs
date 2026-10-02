//! Live music analysis for Spectrum.
//!
//! Samples go in as they are captured; measurements come out once per hop
//! (`HOP` samples, ≈ 5.3 ms at 48 kHz) as [`FeatureFrame`]s stamped with the
//! capture clock (a sample index), never with a rendering clock. The crate
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

mod analyzer;
mod beat;
mod fft;
mod follow;
mod frame;
mod harmony;
mod hpss;
mod loudness;
mod presence;
mod rhythm;
pub mod wire;

pub use analyzer::{Analyzer, FFT_SIZE, HOP};
pub use beat::{BeatEvent, BEATS_PER_BAR};
pub use frame::{FeatureFrame, Field, BANDS, BAND_EDGES};
pub use loudness::SILENT_LUFS;
pub use rhythm::{OnsetEvent, MAX_BPM, MIN_BPM};

/// What the analyzer reports, in time order.
#[derive(Clone, Copy, Debug)]
pub enum Event<'a> {
    /// The measurements of one hop (borrowed: copy what you keep).
    Frame(&'a FeatureFrame),
    /// An attack, stamped at its peak (reported one hop later).
    Onset(OnsetEvent),
    /// A beat of the tracked grid, stamped at its predicted time (reported in the hop that reaches it).
    Beat(BeatEvent),
}

/// Level reported for silence (dB).
pub const SILENCE_DB: f32 = -96.0;
