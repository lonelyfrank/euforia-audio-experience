//! WebAssembly entry points for `spectrum-analysis`.
//!
//! A plain C ABI over linear memory, no bindings generator: the host writes
//! interleaved samples into the buffer returned by `sa_input`, calls
//! `sa_push`, and reads the records (see `spectrum_analysis::wire`) from
//! `sa_output`. Every hop frame and event is retained, independently of
//! host batch size, so temporal consumers see exactly the same history.

use spectrum_analysis::wire::{self, MAX_RECORD};
use spectrum_analysis::{Analyzer, HOP};

pub struct Host {
    analyzer: Analyzer,
    input: Vec<f32>,
    output: Vec<f64>,
    record: Vec<f64>,
}

/// Creates an analyzer; `capacity`: interleaved samples per push at most.
#[no_mangle]
pub extern "C" fn sa_new(sample_rate: f32, channels: u32, capacity: u32) -> *mut Host {
    let channels = channels.max(1) as usize;
    let capacity = capacity as usize;
    // Worst-case event capacity, including every hop frame.
    let hops = capacity / channels / HOP + 2;
    let host = Host {
        analyzer: Analyzer::new(sample_rate, channels),
        input: vec![0.0; capacity],
        output: vec![0.0; hops * (wire::FRAME_RECORD + wire::ONSET_RECORD + wire::BEAT_RECORD + wire::SECTION_RECORD)],
        record: vec![0.0; MAX_RECORD],
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

/// Analyses the first `count` values of the input buffer; returns how many f64 were written to the output.
/// # Safety
/// `host` must come from `sa_new`; `count` must not exceed its capacity.
#[no_mangle]
pub unsafe extern "C" fn sa_push(host: *mut Host, count: u32) -> u32 {
    let host = &mut *host;
    let Host { analyzer, input, output, record } = host;
    let count = (count as usize).min(input.len());
    let mut written = 0;
    analyzer.push(&input[..count], |event| {
        let n = wire::encode(&event, record);
        if written + n <= output.len() {
            output[written..written + n].copy_from_slice(&record[..n]);
            written += n;
        }
    });
    written as u32
}

/// Forgets the signal (new source); the learned noise floor is kept.
/// # Safety
/// `host` must come from `sa_new`.
#[no_mangle]
pub unsafe extern "C" fn sa_reset(host: *mut Host) {
    (*host).analyzer.reset();
}

/// Sets only slow DSP feature rates (0 high, 1 medium, 2 low).
/// # Safety
/// `host` must come from `sa_new`.
#[no_mangle]
pub unsafe extern "C" fn sa_quality(host: *mut Host, quality: u32) {
    (*host).analyzer.set_quality(quality.min(2) as u8);
}
