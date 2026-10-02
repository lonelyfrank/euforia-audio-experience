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
//! use spectrum_analysis::{Analyzer, HOP};
//! let mut analyzer = Analyzer::new(48_000.0, 2);
//! let silence = vec![0.0f32; HOP * 2 * 4];
//! let mut frames = 0;
//! analyzer.push(&silence, |frame| {
//!     assert!(frame.silent);
//!     frames += 1;
//! });
//! assert_eq!(frames, 4);
//! ```

mod analyzer;
mod fft;
mod follow;
mod frame;
mod loudness;
mod presence;

pub use analyzer::{Analyzer, FFT_SIZE, HOP};
pub use frame::{FeatureFrame, Field, BANDS, BAND_EDGES};
pub use loudness::SILENT_LUFS;

/// Level reported for silence (dB).
pub const SILENCE_DB: f32 = -96.0;
