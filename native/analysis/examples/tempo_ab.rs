//! A/B of the beat tracker's tempo source: autocorrelation alone (default) vs
//! the experimental resonator bank, on synthetic grooves with known beats.
//! Metrics: lock time (first time 4 consecutive beats land within 30 ms of a
//! true beat at the right tempo), tempo error and mean phase error after
//! 10 s, and beats kept during a two-bar drum break.
//!
//!     cargo run -p spectrum-analysis --release --example tempo_ab

use spectrum_analysis::{Analyzer, AnalyzerOptions, Event};

const SR: f32 = 48_000.0;
const TAU: f32 = std::f32::consts::TAU;

fn noise(t: f32) -> f32 {
    let mut h = ((t * SR) as u32).wrapping_mul(0x9E37_79B9) ^ 0x85EB_CA6B;
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^= h >> 12;
    h as f32 / u32::MAX as f32 * 2.0 - 1.0
}

fn kick(pos: f32, gain: f32) -> f32 {
    if pos < 0.0 {
        return 0.0;
    }
    (TAU * (50.0 + 100.0 * (-pos * 30.0).exp()) * pos).sin() * (-pos * 9.0).exp() * gain
}

/// A groove at a beat clock `beats(t)` (beats, period); `drums(t)` mutes the drums for breaks.
fn groove(t: f32, beats: f32, period: f32, drums: bool) -> f32 {
    let pos = beats.fract() * period;
    let gain = if (beats.floor() as u32) % 4 == 0 { 0.9 } else { 0.55 };
    let off = (beats + 0.5).fract() * period;
    let pad = 0.05 * ((TAU * 220.0 * t).sin() + (TAU * 330.0 * t).sin());
    if drums { kick(pos, gain) + noise(t) * (-off * 60.0).exp() * 0.2 + pad } else { pad }
}

struct Case {
    name: &'static str,
    seconds: f32,
    /// Beat clock at t: (beats elapsed, period in s).
    clock: Box<dyn Fn(f32) -> (f32, f32)>,
    drums: Box<dyn Fn(f32) -> bool>,
    /// (from, to) of a break, if any.
    gap: Option<(f32, f32)>,
}

fn steady(bpm: f32) -> Box<dyn Fn(f32) -> (f32, f32)> {
    Box::new(move |t| (t * bpm / 60.0, 60.0 / bpm))
}

struct Result {
    lock: Option<f32>,
    tempo_error: f32,
    phase_error_ms: f32,
    gap_beats: usize,
}

fn run(case: &Case, resonators: bool) -> Result {
    let mut analyzer = Analyzer::with_options(SR, 1, AnalyzerOptions { resonators });
    let samples: Vec<f32> = (0..(case.seconds * SR) as usize)
        .map(|i| {
            let t = i as f32 / SR;
            let (beats, period) = (case.clock)(t);
            groove(t, beats, period, (case.drums)(t))
        })
        .collect();
    let mut beats: Vec<(f64, f32)> = Vec::new();
    let mut last_bpm = 0.0;
    for chunk in samples.chunks(480) {
        analyzer.push(chunk, |event| match event {
            Event::Beat(b) => beats.push((b.time, b.bpm)),
            Event::Frame(f) => last_bpm = f.beat_bpm,
            Event::Onset(_) => {}
            Event::Section(_) => {}
        });
    }
    // Distance (s) of a beat to the nearest true beat, and the true period there.
    let truth = |t: f64| {
        let (b, period) = (case.clock)(t as f32);
        let frac = b - b.round();
        (f64::from(frac * period), period)
    };
    let mut lock = None;
    let mut run_length = 0;
    for &(t, bpm) in &beats {
        let (error, period) = truth(t);
        let ok = error.abs() < 0.03 && (bpm / (60.0 / period) - 1.0).abs() < 0.02;
        run_length = if ok { run_length + 1 } else { 0 };
        if run_length == 4 && lock.is_none() {
            lock = Some(t as f32);
        }
    }
    let late: Vec<f64> = beats.iter().filter(|b| b.0 > 10.0).map(|b| truth(b.0).0.abs()).collect();
    let (_, period) = (case.clock)(case.seconds);
    Result {
        lock,
        tempo_error: (last_bpm / (60.0 / period) - 1.0).abs() * 100.0,
        phase_error_ms: if late.is_empty() { f32::NAN } else { (late.iter().sum::<f64>() / late.len() as f64 * 1000.0) as f32 },
        gap_beats: case.gap.map_or(0, |(a, b)| beats.iter().filter(|x| x.0 >= f64::from(a) && x.0 < f64::from(b)).count()),
    }
}

fn main() {
    let always = || Box::new(|_| true) as Box<dyn Fn(f32) -> bool>;
    let cases = vec![
        Case { name: "groove 75", seconds: 20.0, clock: steady(75.0), drums: always(), gap: None },
        Case { name: "groove 90", seconds: 20.0, clock: steady(90.0), drums: always(), gap: None },
        Case { name: "groove 120", seconds: 20.0, clock: steady(120.0), drums: always(), gap: None },
        Case { name: "groove 128", seconds: 20.0, clock: steady(128.0), drums: always(), gap: None },
        Case { name: "groove 140", seconds: 20.0, clock: steady(140.0), drums: always(), gap: None },
        Case { name: "groove 174", seconds: 20.0, clock: steady(174.0), drums: always(), gap: None },
        Case {
            name: "120 -> 126 at 12 s",
            seconds: 28.0,
            clock: Box::new(|t| if t < 12.0 { (t * 2.0, 0.5) } else { (24.0 + (t - 12.0) * 2.1, 60.0 / 126.0) }),
            drums: always(),
            gap: None,
        },
        Case { name: "120, 4 s break", seconds: 24.0, clock: steady(120.0), drums: Box::new(|t| !(10.0..14.0).contains(&t)), gap: Some((10.0, 14.0)) },
    ];
    println!("{:<20} | {:^31} | {:^31}", "", "autocorrelation (default)", "resonator bank");
    println!("{:<20} | {:>6} {:>6} {:>8} {:>7} | {:>6} {:>6} {:>8} {:>7}", "case", "lock s", "tempo%", "phase ms", "gap bt", "lock s", "tempo%", "phase ms", "gap bt");
    for case in &cases {
        let a = run(case, false);
        let b = run(case, true);
        let lock = |r: &Result| r.lock.map_or("never".to_string(), |t| format!("{t:.2}"));
        println!(
            "{:<20} | {:>6} {:>6.2} {:>8.1} {:>7} | {:>6} {:>6.2} {:>8.1} {:>7}",
            case.name, lock(&a), a.tempo_error, a.phase_error_ms, a.gap_beats, lock(&b), b.tempo_error, b.phase_error_ms, b.gap_beats
        );
    }
}
