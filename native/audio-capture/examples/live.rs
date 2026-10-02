//! Diagnostic tool: captures live audio and prints what the analysis hears,
//! once per second (presence, onsets, beat grid, lost frames).
//!
//!   cargo run -p audio-capture --example live -- system [device-name-part] [seconds]
//!   cargo run -p audio-capture --example live -- microphone

use std::sync::{Arc, Mutex};
use std::time::Duration;

use audio_capture::{Batch, CaptureSource};
use spectrum_analysis::{Analyzer, Event, FeatureFrame};

#[derive(Default)]
struct Second {
    frames: u64,
    gaps: u64,
    onsets: u32,
    beats: Vec<f64>,
    last: Option<FeatureFrame>,
}

fn main() {
    let mut args = std::env::args().skip(1);
    let source = match args.next().as_deref() {
        Some("microphone") | Some("mic") => CaptureSource::Microphone,
        _ => CaptureSource::System,
    };
    let wanted = args.next().filter(|s| !s.is_empty());
    let seconds: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(10);
    let device = wanted.as_ref().and_then(|part| {
        audio_capture::list_devices(source).ok()?.into_iter().find(|d| d.name.contains(part.as_str()) || d.id.contains(part.as_str()))
    });
    if let (Some(part), None) = (&wanted, &device) {
        eprintln!("no {source:?} device matching '{part}'");
        std::process::exit(1);
    }

    let state = Arc::new(Mutex::new(Second::default()));
    let sink = Arc::clone(&state);
    let mut analyzer: Option<Analyzer> = None;
    let result = audio_capture::start(
        source,
        device.as_ref().map(|d| d.id.as_str()),
        move |batch: Batch| {
            let a = analyzer.get_or_insert_with(|| Analyzer::new(batch.sample_rate as f32, batch.channels));
            let mut s = sink.lock().unwrap();
            s.frames += (batch.samples.len() / batch.channels) as u64;
            s.gaps += batch.gap;
            a.push(batch.samples, |event| match event {
                Event::Frame(f) => s.last = Some(*f),
                Event::Onset(_) => s.onsets += 1,
                Event::Section(_) => {}
                Event::Beat(b) => s.beats.push(b.time),
            });
        },
        |error| eprintln!("stream error: {error}"),
    );
    let (capture, info) = result.unwrap_or_else(|e| {
        eprintln!("capture failed: {e}");
        std::process::exit(1);
    });
    println!("capturing '{}' at {} Hz, {} ch", info.device_name, info.sample_rate, info.channels);
    for _ in 0..seconds {
        std::thread::sleep(Duration::from_secs(1));
        let s = std::mem::take(&mut *state.lock().unwrap());
        let Some(f) = s.last else {
            println!("{:>6} frames/s, no analysis yet", s.frames);
            continue;
        };
        let beats: Vec<String> = s.beats.iter().map(|t| format!("{t:.3}")).collect();
        println!(
            "t {:>7.2}  {:>5} fr/s gap {:>4}  presence {:.2}  {:>5.1} LUFS  onsets {:>2}  tempo {:>5.1} ({:.2})  grid {:>5.1} ({:.2})  beats [{}]",
            f.time, s.frames, s.gaps, f.presence, f.loudness_momentary, s.onsets, f.tempo_bpm, f.tempo_confidence, f.beat_bpm, f.beat_confidence, beats.join(" ")
        );
    }
    capture.stop();
}
