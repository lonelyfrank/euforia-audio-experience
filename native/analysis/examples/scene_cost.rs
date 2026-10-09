//! How much of the analysis is the scenes' graphic side: the same signal with the scene analysis at its
//! default cadence, at every hop, and (nearly) never.
//!
//! `cargo run --release -p spectrum-analysis --example scene_cost`

use std::time::Instant;

use spectrum_analysis::{Analyzer, Event};

fn run(rate: f32, every: u32, seconds: usize) -> (f64, usize) {
    let mut analyzer = Analyzer::new(rate, 2);
    analyzer.set_scene(1.0, 0.5, every);
    let frames = rate as usize * seconds;
    // A groove with pitched content: a 55 Hz saw bass, a 440 Hz lead, a kick every half second, hiss.
    let mut seed = 1u32;
    let samples: Vec<f32> = (0..frames)
        .flat_map(|i| {
            let t = i as f32 / rate;
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = (seed >> 8) as f32 / 8388608.0 - 1.0;
            let beat = t % 0.5;
            let kick = (std::f32::consts::TAU * 55.0 * beat).sin() * (-beat * 18.0).exp();
            let bass = ((t * 55.0) % 1.0) * 2.0 - 1.0;
            let lead = (std::f32::consts::TAU * 440.0 * t).sin();
            let v = 0.5 * kick + 0.2 * bass + 0.15 * lead + 0.02 * noise;
            [v, v * 0.9]
        })
        .collect();
    let mut scenes = 0;
    let started = Instant::now();
    for chunk in samples.chunks(960) {
        analyzer.push(chunk, |event| {
            if let Event::Scene(_) = event {
                scenes += 1;
            }
        });
    }
    (started.elapsed().as_secs_f64() / seconds as f64, scenes)
}

fn main() {
    for rate in [48_000.0f32, 96_000.0] {
        let seconds = 20;
        let (none, _) = run(rate, u32::MAX, seconds);
        let (default, scenes) = run(rate, 0, seconds);
        let (every_hop, hops) = run(rate, 1, seconds);
        let per_scene = (default - none) * seconds as f64 / scenes as f64;
        println!(
            "{rate} Hz: music {:.2} % of a core; + scenes at the default cadence {:.2} % ({:.0} µs per scene frame, {:.1} per second); at every hop {:.2} % ({} per second)",
            none * 100.0,
            (default - none) * 100.0,
            per_scene * 1e6,
            scenes as f64 / seconds as f64,
            (every_hop - none) * 100.0,
            hops / seconds,
        );
    }
}
