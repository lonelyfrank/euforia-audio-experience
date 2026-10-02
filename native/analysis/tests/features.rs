use spectrum_analysis::{Analyzer, FeatureFrame, BANDS, HOP};

const SR: f32 = 48_000.0;
const TAU: f32 = std::f32::consts::TAU;

/// Runs `seconds` of a stereo signal `f(t) -> (l, r)` and returns every frame.
fn run(seconds: f32, mut f: impl FnMut(f32) -> (f32, f32)) -> Vec<FeatureFrame> {
    let mut analyzer = Analyzer::new(SR, 2);
    let n = (seconds * SR) as usize;
    let mut samples = Vec::with_capacity(n * 2);
    for i in 0..n {
        let (l, r) = f(i as f32 / SR);
        samples.push(l);
        samples.push(r);
    }
    let mut frames = Vec::new();
    // Push in uneven chunks, as a capture callback would.
    for chunk in samples.chunks(2 * 441) {
        analyzer.push(chunk, |frame| frames.push(*frame));
    }
    frames
}

fn sine(hz: f32, amplitude: f32) -> impl FnMut(f32) -> (f32, f32) {
    move |t| {
        let x = amplitude * (TAU * hz * t).sin();
        (x, x)
    }
}

/// Deterministic white noise in -1..1.
fn noise(seed: u32) -> impl FnMut() -> f32 {
    let mut state = seed;
    move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state as f32 / u32::MAX as f32 * 2.0 - 1.0
    }
}

fn last(frames: &[FeatureFrame]) -> &FeatureFrame {
    frames.last().unwrap()
}

fn loudest_band(frame: &FeatureFrame) -> usize {
    (0..BANDS).max_by(|&a, &b| frame.band_db[a].total_cmp(&frame.band_db[b])).unwrap()
}

#[test]
fn frames_are_stamped_with_the_capture_clock() {
    let frames = run(1.0, sine(440.0, 0.3));
    assert_eq!(frames.len(), (SR as usize) / HOP);
    for (i, frame) in frames.iter().enumerate() {
        assert_eq!(frame.sample, ((i + 1) * HOP) as u64);
        assert!((frame.time - frame.sample as f64 / f64::from(SR)).abs() < 1e-12);
    }
}

#[test]
fn tones_land_in_their_band() {
    for (hz, band) in [(40.0, 0), (120.0, 1), (350.0, 2), (1000.0, 3), (3000.0, 4), (5000.0, 5), (8000.0, 6), (15000.0, 7)] {
        let frames = run(1.0, sine(hz, 0.5));
        assert_eq!(loudest_band(last(&frames)), band, "{hz} Hz");
    }
}

#[test]
fn band_level_reads_the_mean_square() {
    // A 0.5 sine has a mean square of 0.125 (≈ -9 dB).
    let frames = run(1.0, sine(1000.0, 0.5));
    let db = last(&frames).band_db[3];
    assert!((db - 10.0 * 0.125f32.log10()).abs() < 0.5, "{db}");
}

#[test]
fn centroid_and_flatness_describe_the_timbre() {
    let low = run(1.0, sine(200.0, 0.5));
    let high = run(1.0, sine(4000.0, 0.5));
    assert!((last(&low).centroid_hz - 200.0).abs() < 30.0);
    assert!((last(&high).centroid_hz - 4000.0).abs() < 100.0);
    assert!(last(&low).flatness < 0.1);
    let mut white = noise(7);
    let noisy = run(1.0, move |_| {
        let x = 0.3 * white();
        (x, x)
    });
    assert!(last(&noisy).flatness > 0.7, "{}", last(&noisy).flatness);
    assert!(last(&noisy).rolloff_hz > 10_000.0);
}

#[test]
fn flux_rises_on_attacks_not_on_steady_sound() {
    // A burst every 0.5 s: flux spikes at each onset, stays low in the steady tone.
    let frames = run(2.0, |t| {
        let x = if (t % 0.5) < 0.25 { 0.5 * (TAU * 600.0 * t).sin() } else { 0.0 };
        (x, x)
    });
    let at = |seconds: f32| &frames[(seconds * SR) as usize / HOP];
    assert!(at(1.005).flux > 1.0, "onset flux {}", at(1.005).flux);
    assert!(at(1.2).flux < 0.2, "steady flux {}", at(1.2).flux);
    let steady = run(1.0, sine(600.0, 0.5));
    assert!(last(&steady).flux < 0.1);
}

#[test]
fn stereo_width_correlation_and_pan() {
    let mono = run(1.0, sine(500.0, 0.5));
    assert!(last(&mono).correlation > 0.99);
    assert!(last(&mono).width < 0.01);
    let left = run(1.0, |t| (0.5 * (TAU * 500.0 * t).sin(), 0.0));
    assert!(last(&left).band_pan[3] < -0.99);
    let inverted = run(1.0, |t| {
        let x = 0.5 * (TAU * 500.0 * t).sin();
        (x, -x)
    });
    assert!(last(&inverted).correlation < -0.99);
    assert!(last(&inverted).width > 0.99);
    assert!(last(&inverted).stereo_confidence > 0.9);
}

#[test]
fn mono_input_has_no_stereo_confidence() {
    let mut analyzer = Analyzer::new(SR, 1);
    let samples: Vec<f32> = (0..SR as usize).map(|i| 0.5 * (TAU * 500.0 * i as f32 / SR).sin()).collect();
    let mut last = FeatureFrame::default();
    analyzer.push(&samples, |f| last = *f);
    assert_eq!(last.stereo_confidence, 0.0);
    assert!(last.presence > 0.9);
}

#[test]
fn loudness_is_calibrated() {
    // BS.1770: a 997 Hz sine at -20 dBFS peak in both channels reads about -20 LUFS (+3 for two channels, -3 for the sine's RMS).
    let frames = run(4.0, sine(997.0, 0.1));
    let f = last(&frames);
    assert!((f.loudness_momentary + 20.0).abs() < 1.0, "{}", f.loudness_momentary);
    assert!((f.loudness_short + 20.0).abs() < 1.0, "{}", f.loudness_short);
}

#[test]
fn loudness_derivatives_follow_a_crescendo() {
    // Steady for 2 s, then +12 dB over 2 s.
    let frames = run(4.0, |t| {
        let gain = if t < 2.0 { 0.05 } else { 0.05 * 10f32.powf(0.6 * (t - 2.0) / 2.0 * 1.0) };
        let x = gain * (TAU * 800.0 * t).sin();
        (x, x)
    });
    let at = |seconds: f32| &frames[(seconds * SR) as usize / HOP - 1];
    assert!(at(1.9).loudness_slope.abs() < 0.5, "steady slope {}", at(1.9).loudness_slope);
    let rising = at(3.5).loudness_slope;
    assert!((3.0..9.0).contains(&rising), "rising slope {rising} LU/s (≈ 6 expected)");
}

#[test]
fn clipping_is_detected_and_held() {
    let frames = run(2.0, |t| {
        let x = if t < 1.0 { (1.5 * (TAU * 200.0 * t).sin()).clamp(-1.0, 1.0) } else { 0.3 * (TAU * 200.0 * t).sin() };
        (x, x)
    });
    let at = |seconds: f32| &frames[(seconds * SR) as usize / HOP - 1];
    assert!(at(0.9).clipping > 0.9);
    assert!(at(1.3).clipping > 0.4, "held {}", at(1.3).clipping);
    assert!(at(1.99).clipping < 0.5);
}

#[test]
fn silence_and_presence() {
    let silent = run(1.0, |_| (0.0, 0.0));
    let f = last(&silent);
    assert!(f.silent && !f.sounding && f.presence == 0.0);
    assert!(f.band_db.iter().all(|db| *db <= -95.0));
    assert_eq!(f.energy_confidence, 0.0);
    let mut white = noise(3);
    // A steady -60 dB hiss is learned as the noise floor and stops counting as sound.
    let hiss = run(8.0, move |_| {
        let x = 0.0017 * white();
        (x, x)
    });
    assert!(last(&hiss).presence < 0.05, "hiss presence {}", last(&hiss).presence);
    let tone = run(1.0, sine(440.0, 0.3));
    assert!(last(&tone).sounding && last(&tone).presence > 0.99);
}

#[test]
fn band_levels_are_relative_to_their_history() {
    // Quiet for 3 s, then 12 dB louder: the relative level jumps up, then settles back towards the middle.
    let frames = run(12.0, |t| {
        let gain = if t < 3.0 { 0.05 } else { 0.2 };
        let x = gain * (TAU * 1000.0 * t).sin();
        (x, x)
    });
    let at = |seconds: f32| &frames[(seconds * SR) as usize / HOP - 1];
    assert!(at(3.1).band_rel[3] > 0.9);
    assert!(at(11.9).band_rel[3] < 0.7);
    assert!(at(11.9).energy_confidence > 0.9);
}

#[test]
fn same_input_same_frames() {
    let a = run(1.0, sine(300.0, 0.4));
    let b = run(1.0, sine(300.0, 0.4));
    assert_eq!(a, b);
}

#[test]
fn every_value_is_finite() {
    let mut white = noise(11);
    let frames = run(2.0, move |t| {
        let x = if t < 0.5 { 0.0 } else if t < 1.0 { white() } else { (TAU * 50.0 * t).sin() };
        (x, -x * 0.5)
    });
    let mut out = vec![0.0; FeatureFrame::SIZE];
    for frame in &frames {
        frame.export(&mut out);
        assert!(out.iter().all(|v| v.is_finite()), "{frame:?}");
    }
}
