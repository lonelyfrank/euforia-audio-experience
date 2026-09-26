//! Diagnostic tool: lists devices and prints the live level of a capture.
//!
//!   cargo run -p audio-capture --example probe -- system      # loopback (Windows/macOS)
//!   cargo run -p audio-capture --example probe -- microphone

use std::sync::{Arc, Mutex};
use std::time::Duration;

use audio_capture::CaptureSource;

fn main() {
    let source = match std::env::args().nth(1).as_deref() {
        Some("microphone") | Some("mic") => CaptureSource::Microphone,
        _ => CaptureSource::System,
    };

    match audio_capture::list_devices(source) {
        Ok(devices) => {
            println!("{source:?} devices:");
            for d in devices {
                println!("  {} {}  [{}]", if d.is_default { "*" } else { " " }, d.name, d.id);
            }
        }
        Err(e) => println!("cannot list devices: {e}"),
    }

    let level = Arc::new(Mutex::new((0usize, 0f32)));
    let sink = Arc::clone(&level);
    let result = audio_capture::start(
        source,
        None,
        move |samples| {
            let mut guard = sink.lock().unwrap();
            guard.0 += samples.len();
            guard.1 = guard.1.max(samples.iter().fold(0f32, |m, s| m.max(s.abs())));
        },
        |error| eprintln!("stream error: {error}"),
    );
    let (capture, info) = match result {
        Ok(ok) => ok,
        Err(e) => {
            eprintln!("capture failed: {e}");
            std::process::exit(1);
        }
    };
    println!("capturing '{}' at {} Hz, {} ch", info.device_name, info.sample_rate, info.channels);

    for _ in 0..5 {
        std::thread::sleep(Duration::from_secs(1));
        let (count, peak) = std::mem::take(&mut *level.lock().unwrap());
        let bar = "#".repeat((peak * 40.0).round() as usize);
        println!("{count:>6} samples/s  peak {peak:.3} {bar}");
    }
    capture.stop();
}
