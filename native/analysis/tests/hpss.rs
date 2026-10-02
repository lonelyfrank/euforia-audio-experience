use spectrum_analysis::{Analyzer, Event, FeatureFrame};

const SR: f32 = 48_000.0;
const TAU: f32 = std::f32::consts::TAU;

fn mean_over(seconds: f32, from: f64, f: impl Fn(f32) -> f32, read: impl Fn(&FeatureFrame) -> f32) -> f32 {
    let mut analyzer = Analyzer::new(SR, 1);
    let samples: Vec<f32> = (0..(seconds * SR) as usize).map(|i| f(i as f32 / SR)).collect();
    let (mut sum, mut n) = (0.0, 0.0);
    analyzer.push(&samples, |event| {
        if let Event::Frame(frame) = event {
            if frame.time > from {
                sum += read(frame);
                n += 1.0;
            }
        }
    });
    sum / n
}

fn noise(t: f32) -> f32 {
    let mut h = ((t * SR) as u32).wrapping_mul(0x9E37_79B9) ^ 0x85EB_CA6B;
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^= h >> 12;
    h as f32 / u32::MAX as f32 * 2.0 - 1.0
}

fn hats(t: f32) -> f32 {
    noise(t) * (-(t % 0.125) * 80.0).exp() * 0.4
}

fn chord(t: f32) -> f32 {
    [220.0, 277.2, 329.6].iter().map(|f| (TAU * f * t).sin()).sum::<f32>() * 0.15
}

#[test]
fn hats_are_percussive() {
    // Noise (a hat's tail) is as wide in time as in frequency and splits about evenly,
    // so averaged over every frame hats read a little under one half; a chord far less.
    let p = mean_over(3.0, 1.0, hats, |f| f.percussive_high);
    assert!(p > 0.38, "{p}");
    assert!(p > 2.0 * mean_over(3.0, 1.0, chord, |f| f.percussive), "{p}");
}

#[test]
fn a_held_chord_is_harmonic() {
    let p = mean_over(3.0, 1.0, chord, |f| f.percussive);
    assert!(p < 0.25, "{p}");
}

#[test]
fn a_mix_sits_in_between_and_silence_is_neither() {
    let mix = mean_over(3.0, 1.0, |t| hats(t) + chord(t), |f| f.percussive);
    let hats_only = mean_over(3.0, 1.0, hats, |f| f.percussive);
    let chord_only = mean_over(3.0, 1.0, chord, |f| f.percussive);
    assert!(chord_only < mix && mix < hats_only, "{chord_only} < {mix} < {hats_only}");
    assert_eq!(mean_over(2.0, 0.5, |_| 0.0, |f| f.percussive), 0.0);
}
