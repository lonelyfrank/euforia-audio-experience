use spectrum_analysis::{Analyzer, Event, FeatureFrame, OnsetEvent, HOP};

const SR: f32 = 48_000.0;
const TAU: f32 = std::f32::consts::TAU;

struct Run {
    frames: Vec<FeatureFrame>,
    onsets: Vec<OnsetEvent>,
}

fn run(seconds: f32, f: impl Fn(f32) -> f32) -> Run {
    let mut analyzer = Analyzer::new(SR, 2);
    let n = (seconds * SR) as usize;
    let samples: Vec<f32> = (0..n).flat_map(|i| {
        let x = f(i as f32 / SR);
        [x, x]
    }).collect();
    let mut out = Run { frames: Vec::new(), onsets: Vec::new() };
    for chunk in samples.chunks(2 * 480) {
        analyzer.push(chunk, |event| match event {
            Event::Frame(frame) => out.frames.push(*frame),
            Event::Onset(onset) => out.onsets.push(onset),
        });
    }
    out
}

/// Deterministic noise in -1..1 from a time (so signals stay pure functions of t).
fn hash_noise(t: f32) -> f32 {
    let x = (t * SR) as u32;
    let mut h = x.wrapping_mul(0x9E37_79B9) ^ 0x85EB_CA6B;
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^= h >> 12;
    h as f32 / u32::MAX as f32 * 2.0 - 1.0
}

fn kick(pos: f32) -> f32 {
    if pos < 0.0 {
        return 0.0;
    }
    let pitch = 50.0 + 100.0 * (-pos * 30.0).exp();
    (TAU * pitch * pos).sin() * (-pos * 9.0).exp() * 0.8
}

fn hat(pos: f32, t: f32) -> f32 {
    if pos < 0.0 {
        return 0.0;
    }
    hash_noise(t) * (-pos * 60.0).exp() * 0.25
}

/// Four-on-the-floor kick with off-beat hats.
fn groove(bpm: f32) -> impl Fn(f32) -> f32 {
    move |t| {
        let beat = 60.0 / bpm;
        let pos = t % beat;
        kick(pos) + hat((t + beat / 2.0) % beat, t)
    }
}

fn click(bpm: f32) -> impl Fn(f32) -> f32 {
    move |t| {
        let pos = t % (60.0 / bpm);
        if pos < 0.004 { 0.7 * (TAU * 1500.0 * t).sin() } else { 0.0 }
    }
}

#[test]
fn onsets_land_on_the_clicks() {
    let bpm = 120.0;
    let r = run(10.0, click(bpm));
    let period = 60.0 / bpm as f64;
    // After warm-up every click is found once, within one hop of its start.
    let late: Vec<_> = r.onsets.iter().filter(|o| o.time > 1.75).collect();
    assert_eq!(late.len(), 16, "{:?}", late.iter().map(|o| o.time).collect::<Vec<_>>());
    for onset in late {
        let error = onset.time - (onset.time / period).round() * period;
        assert!(error.abs() < HOP as f64 / f64::from(SR), "onset {:.4} off by {:.4} s", onset.time, error);
    }
}

#[test]
fn tempo_of_steady_grooves() {
    for bpm in [90.0f32, 120.0, 128.0, 140.0] {
        let r = run(10.0, groove(bpm));
        let f = r.frames.last().unwrap();
        assert!((f.tempo_bpm - bpm).abs() < 1.5, "{bpm}: measured {}", f.tempo_bpm);
        assert!(f.tempo_confidence > 0.5, "{bpm}: confidence {}", f.tempo_confidence);
    }
}

#[test]
fn fast_tempo_is_found_up_to_an_octave() {
    // 174 BPM may read as 87 (half time) before the beat tracker resolves the octave.
    let r = run(10.0, groove(174.0));
    let measured = r.frames.last().unwrap().tempo_bpm;
    assert!((measured - 174.0).abs() < 2.0 || (measured - 87.0).abs() < 1.5, "measured {measured}");
}

#[test]
fn onset_density_counts_attacks() {
    let sparse = run(6.0, click(60.0));
    let busy = run(6.0, groove(128.0)); // kick + hat: ~4.3 attacks/s
    let d1 = sparse.frames.last().unwrap().onset_density;
    let d2 = busy.frames.last().unwrap().onset_density;
    assert!((0.7..1.3).contains(&d1), "sparse {d1}");
    assert!((3.4..5.0).contains(&d2), "busy {d2}");
}

#[test]
fn a_held_chord_has_no_tempo() {
    let r = run(8.0, |t| 0.2 * ((TAU * 220.0 * t).sin() + (TAU * 277.2 * t).sin() + (TAU * 329.6 * t).sin()));
    let f = r.frames.last().unwrap();
    assert!(f.tempo_confidence < 0.1, "confidence {}", f.tempo_confidence);
    assert!(r.onsets.iter().filter(|o| o.time > 1.0).count() == 0);
}

#[test]
fn silence_has_no_rhythm() {
    let r = run(4.0, |_| 0.0);
    assert!(r.onsets.is_empty());
    let f = r.frames.last().unwrap();
    assert_eq!(f.tempo_confidence, 0.0);
    assert_eq!(f.onset_density, 0.0);
}
