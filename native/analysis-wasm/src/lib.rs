//! WebAssembly entry points for `spectrum-analysis`.
//!
//! A plain C ABI over linear memory, no bindings generator: the host writes
//! interleaved samples into the buffer returned by `sa_input`, calls
//! `sa_push`, and reads the records (see `spectrum_analysis::wire`) from
//! `sa_output`. One push reports every onset and beat in order and the
//! latest frame last; `sa_frames_skipped` says how many frames were folded.

use spectrum_analysis::wire::{self, MAX_RECORD};
use spectrum_analysis::{Analyzer, Event, HOP};

pub struct Host {
    analyzer: Analyzer,
    input: Vec<f32>,
    output: Vec<f64>,
    record: Vec<f64>,
    last_frame: Vec<f64>,
    skipped: u32,
}

/// Creates an analyzer; `capacity`: interleaved samples per push at most.
#[no_mangle]
pub extern "C" fn sa_new(sample_rate: f32, channels: u32, capacity: u32) -> *mut Host {
    let channels = channels.max(1) as usize;
    let capacity = capacity as usize;
    // Every hop of a push can bring an onset and a beat; one frame is kept.
    let hops = capacity / channels / HOP + 2;
    let host = Host {
        analyzer: Analyzer::new(sample_rate, channels),
        input: vec![0.0; capacity],
        output: vec![0.0; hops * (wire::ONSET_RECORD + wire::BEAT_RECORD) + wire::FRAME_RECORD],
        record: vec![0.0; MAX_RECORD],
        last_frame: vec![0.0; wire::FRAME_RECORD],
        skipped: 0,
    };
    Box::into_raw(Box::new(host))
}

/// # Safety
/// `host` must come from `sa_new` and not have been freed.
#[no_mangle]
pub unsafe extern "C" fn sa_free(host: *mut Host) {
    if !host.is_null() {
        drop(Box::from_raw(host));
    }
}

/// # Safety
/// `host` must come from `sa_new`.
#[no_mangle]
pub unsafe extern "C" fn sa_input(host: *mut Host) -> *mut f32 {
    (*host).input.as_mut_ptr()
}

/// # Safety
/// `host` must come from `sa_new`.
#[no_mangle]
pub unsafe extern "C" fn sa_output(host: *const Host) -> *const f64 {
    (*host).output.as_ptr()
}

/// Length (f64 values) of the output buffer.
/// # Safety
/// `host` must come from `sa_new`.
#[no_mangle]
pub unsafe extern "C" fn sa_output_capacity(host: *const Host) -> u32 {
    (*host).output.len() as u32
}

/// Frames produced by the last push but not reported (only the latest is).
/// # Safety
/// `host` must come from `sa_new`.
#[no_mangle]
pub unsafe extern "C" fn sa_frames_skipped(host: *const Host) -> u32 {
    (*host).skipped
}

/// Analyses the first `count` values of the input buffer; returns how many f64 were written to the output.
/// # Safety
/// `host` must come from `sa_new`; `count` must not exceed its capacity.
#[no_mangle]
pub unsafe extern "C" fn sa_push(host: *mut Host, count: u32) -> u32 {
    let host = &mut *host;
    let Host { analyzer, input, output, record, last_frame, skipped } = host;
    let count = (count as usize).min(input.len());
    let mut written = 0;
    let mut frames = 0u32;
    analyzer.push(&input[..count], |event| {
        if let Event::Frame(_) = event {
            frames += 1;
            wire::encode(&event, last_frame);
            return;
        }
        let n = wire::encode(&event, record);
        if written + n + wire::FRAME_RECORD <= output.len() {
            output[written..written + n].copy_from_slice(&record[..n]);
            written += n;
        }
    });
    if frames > 0 {
        output[written..written + wire::FRAME_RECORD].copy_from_slice(last_frame);
        written += wire::FRAME_RECORD;
    }
    *skipped = frames.saturating_sub(1);
    written as u32
}

/// Forgets the signal (new source); the learned noise floor is kept.
/// # Safety
/// `host` must come from `sa_new`.
#[no_mangle]
pub unsafe extern "C" fn sa_reset(host: *mut Host) {
    (*host).analyzer.reset();
}
