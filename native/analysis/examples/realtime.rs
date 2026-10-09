//! Measures how much faster than real time the analysis runs on this machine:
//! 60 s of a synthetic stereo groove (kick, hats, chords), pushed in 10 ms chunks.
//!
//!     cargo run -p spectrum-analysis --release --example realtime

use spectrum_analysis::{Analyzer, Event};
use std::time::Instant;

fn main() {
    let sr = 48_000.0f32;
    let seconds = 60.0;
    let quality = std::env::args().nth(1).and_then(|s| s.parse::<u8>().ok()).unwrap_or(0);
    let tau = std::f32::consts::TAU;
    let mut state = 1u32;
    let samples: Vec<f32> = (0..(seconds * sr) as usize)
        .flat_map(|i| {
            let t = i as f32 / sr;
            let pos = t % 0.5;
            let kick = (tau * (50.0 + 100.0 * (-pos * 30.0).exp()) * pos).sin() * (-pos * 9.0).exp() * 0.6;
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let hat = (state as f32 / u32::MAX as f32 - 0.5) * (-((t + 0.25) % 0.5) * 60.0).exp() * 0.3;
            let chord = [220.0, 277.2, 329.6].iter().map(|f| (tau * f * t).sin()).sum::<f32>() * 0.08;
            [kick + hat + chord, kick + hat * 0.6 + chord * 0.9]
        })
        .collect();
    let mut analyzer = Analyzer::new(sr, 2);
    analyzer.set_quality(quality);
    let mut costs = Vec::with_capacity(6000);
    let (mut frames, mut beats) = (0, 0);
    let start = Instant::now();
    for chunk in samples.chunks(2 * 480) {
        let batch_start = Instant::now();
        analyzer.push(chunk, |event| match event {
            Event::Frame(_) => frames += 1,
            Event::Beat(_) => beats += 1,
            Event::Onset(_) => {}
            Event::Section(_) | Event::Scene(_) => {}
        });
        costs.push(batch_start.elapsed().as_secs_f64() * 1000.0);
    }
    let elapsed = start.elapsed().as_secs_f64();
    costs.sort_by(f64::total_cmp);
    println!("quality {quality}: batch p50/p95/p99 {:.3}/{:.3}/{:.3} ms", costs[3000], costs[5700], costs[5940]);
    println!(
        "{seconds} s of stereo audio in {:.3} s: {:.0}x real time ({:.1}% of one core), {frames} frames, {beats} beats",
        elapsed,
        f64::from(seconds) / elapsed,
        100.0 * elapsed / f64::from(seconds)
    );
}
