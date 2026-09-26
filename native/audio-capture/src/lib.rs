//! Native audio capture for the visualizer.
//!
//! Exposes a small, platform-agnostic API: start capturing a [`CaptureSource`]
//! and receive mono `f32` chunks through a callback. Platform specifics live
//! in the `platform` module:
//!
//! - **Windows**: system audio is captured with WASAPI loopback on the output
//!   device (via cpal, which enables loopback when an output device is opened
//!   as an input stream).
//! - **Linux**: system audio is the `.monitor` source of the default output,
//!   through cpal's PulseAudio host (works with PipeWire's pulse server).
//! - **macOS**: microphone; loopback is attempted through cpal's CoreAudio
//!   aggregate device (macOS 14.6+), untested.

mod capture;
mod platform;

pub use capture::{start, Capture};
pub use platform::list_devices;

/// What to capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureSource {
    /// Whatever the computer is playing (loopback of the output device).
    System,
    /// An input device.
    Microphone,
}

#[derive(Debug, Clone)]
pub struct DeviceInfo {
    /// Stable identifier, persistable (cpal `DeviceId` string form).
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone)]
pub struct CaptureInfo {
    pub sample_rate: u32,
    pub channels: u16,
    pub device_name: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("{0}")]
    Unsupported(String),
    #[error("audio device not found: {0}")]
    DeviceNotFound(String),
    #[error("no default {0} device available")]
    NoDefaultDevice(&'static str),
    #[error("audio backend error: {0}")]
    Backend(#[from] cpal::Error),
    #[error("capture thread failed to start")]
    ThreadFailed,
}
