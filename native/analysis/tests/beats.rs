use spectrum_analysis::{Analyzer, BeatEvent, Event, FeatureFrame};

const SR: f32 = 48_000.0;
const TAU: f32 = std::f32::consts::TAU;

struct Run {
    beats: Vec<BeatEvent>,
    frames: Vec<FeatureFrame>,
}

fn run(seconds: f32, f: impl Fn(f32) -> f32) -> Run {
    let mut analyzer = Analyzer::new(SR, 1);
    let samples: Vec<f32> = (0..(seconds * SR) as usize).map(|i| f(i as f32 / SR)).collect();
    let mut out = Run { beats: Vec::new(), frames: Vec::new() };
    for chunk in samples.chunks(480) {
        analyzer.push(chunk, |event| match event {
            Event::Beat(beat) => out.beats.push(beat),
            Event::Frame(frame) => out.frames.push(*frame),
            Event::Onset(_) => {}
        });
    }
    out
}

fn hash_noise(t: f32) -> f32 {
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
    let pitch = 50.0 + 100.0 * (-pos * 30.0).exp();
    (TAU * pitch * pos).sin() * (-pos * 9.0).exp() * gain
}

fn hat(pos: f32, t: f32) -> f32 {
    if pos < 0.0 { 0.0 } else { hash_noise(t) * (-pos * 60.0).exp() * 0.2 }
}

fn pad(t: f32) -> f32 {
    0.05 * ((TAU * 220.0 * t).sin() + (TAU * 330.0 * t).sin())
}

/// Kick on every beat (the downbeat louder), hats on the off-beats, a soft pad.
/// `beat_at(t)` gives the beat clock (beats since 0) at time t.
fn groove(beat_at: impl Fn(f32) -> (f32, f32) + Copy) -> impl Fn(f32) -> f32 {
    move |t| {
        let (beats, period) = beat_at(t);
        let pos = beats.fract() * period;
        let n = beats.floor() as u32;
        let gain = if n % 4 == 0 { 0.9 } else { 0.5 };
        kick(pos, gain) + hat(((beats + 0.5).fract()) * period, t) + pad(t)
    }
}

fn steady(bpm: f32) -> impl Fn(f32) -> (f32, f32) + Copy {
    move |t| (t * bpm / 60.0, 60.0 / bpm)
}

/// Phase error (s) of each beat after `from` against the nearest kick of a steady grid.
fn errors(beats: &[BeatEvent], period: f64, from: f64) -> Vec<f64> {
    beats.iter().filter(|b| b.time > from).map(|b| b.time - (b.time / period).round() * period).collect()
}

fn mean_abs(values: &[f64]) -> f64 {
    values.iter().map(|v| v.abs()).sum::<f64>() / values.len() as f64
}

#[test]
fn locks_to_a_steady_groove() {
    let r = run(20.0, groove(steady(120.0)));
    let e = errors(&r.beats, 0.5, 6.0);
    assert!(e.len() >= 27, "{} beats", e.len());
    // The kick's attack is soft (≈ 5 ms to its flux peak): mean phase error well under 10 ms.
    assert!(mean_abs(&e) < 0.010, "mean phase error {:.4} s", mean_abs(&e));
    assert!(e.iter().all(|v| v.abs() < 0.02), "{e:?}");
    let last = r.frames.last().unwrap();
    assert!((last.beat_bpm - 120.0).abs() < 0.5, "{}", last.beat_bpm);
    assert!(last.beat_confidence > 0.6, "{}", last.beat_confidence);
}

#[test]
fn finds_the_downbeat() {
    let r = run(20.0, groove(steady(120.0)));
    let downbeats: Vec<_> = r.beats.iter().filter(|b| b.time > 10.0 && b.downbeat).collect();
    assert!(downbeats.len() >= 4);
    for b in &downbeats {
        // Bars of 2 s start at multiples of 2 s.
        let error = b.time - (b.time / 2.0).round() * 2.0;
        assert!(error.abs() < 0.03, "downbeat at {:.3}", b.time);
    }
    assert!(r.frames.last().unwrap().downbeat_confidence > 0.3);
    // The bar phase runs 0..1 over each bar.
    let f = r.frames.iter().find(|f| f.time > 15.5).unwrap();
    assert!((f.bar_phase - 0.75).abs() < 0.05, "bar phase {} at 15.5 s", f.bar_phase);
}

#[test]
fn follows_a_real_tempo_change_without_flapping() {
    // 120 BPM for 12 s, then 126 BPM (beat clock continuous).
    let clock = |t: f32| if t < 12.0 { (t * 2.0, 0.5) } else { (24.0 + (t - 12.0) * 2.1, 60.0 / 126.0) };
    let r = run(28.0, groove(clock));
    let bpm_at = |t: f64| r.frames.iter().find(|f| f.time >= t).unwrap().beat_bpm;
    assert!((bpm_at(11.0) - 120.0).abs() < 0.5);
    assert!((bpm_at(27.0) - 126.0).abs() < 1.0, "{}", bpm_at(27.0));
    // Once moved, it stays: no back-and-forth between the two tempos.
    let mut crossings = 0;
    let mut above = false;
    for f in r.frames.iter().filter(|f| f.time > 12.0) {
        let now = f.beat_bpm > 123.0;
        if now != above {
            crossings += 1;
            above = now;
        }
    }
    assert!(crossings <= 1, "{crossings} crossings");
    let late: Vec<f64> = r.beats.iter().filter(|b| b.time > 22.0).map(|b| {
        let beats = 24.0 + (b.time - 12.0) * 2.1;
        (beats - beats.round()) / 2.1
    }).collect();
    assert!(mean_abs(&late) < 0.015, "phase after the change {:.4}", mean_abs(&late));
}

#[test]
fn a_fill_does_not_change_the_tempo() {
    // Bar 5 (8–10 s) has kicks on every eighth note.
    let base = groove(steady(120.0));
    let r = run(20.0, move |t| if (8.0..10.0).contains(&t) { kick(t % 0.25, 0.7) + pad(t) } else { base(t) });
    for f in r.frames.iter().filter(|f| f.time > 6.0) {
        assert!((f.beat_bpm - 120.0).abs() < 2.0, "{} BPM at {:.2}", f.beat_bpm, f.time);
    }
    assert!(mean_abs(&errors(&r.beats, 0.5, 12.0)) < 0.010);
}

#[test]
fn keeps_time_through_a_break() {
    // Drums stop for two bars (10–14 s), the pad goes on; the grid keeps time and is in phase after.
    let base = groove(steady(120.0));
    let r = run(22.0, move |t| if (10.0..14.0).contains(&t) { pad(t) } else { base(t) });
    let during: Vec<_> = r.beats.iter().filter(|b| (10.0..14.0).contains(&b.time)).collect();
    assert!(during.len() >= 7, "{} beats during the break", during.len());
    let conf = |t: f64| r.frames.iter().find(|f| f.time >= t).unwrap().beat_confidence;
    assert!(conf(13.9) < conf(9.9), "confidence drops without support");
    assert!(mean_abs(&errors(&r.beats, 0.5, 16.0)) < 0.010);
}

#[test]
fn no_grid_without_rhythm() {
    let r = run(10.0, pad);
    assert!(r.beats.is_empty());
    assert_eq!(r.frames.last().unwrap().beat_confidence, 0.0);
}

#[test]
fn same_input_same_beats() {
    let a = run(10.0, groove(steady(124.0)));
    let b = run(10.0, groove(steady(124.0)));
    assert_eq!(a.beats, b.beats);
}

#[test]
fn moves_off_the_off_beat() {
    // Off-beat hats and a bass that re-attacks on the off-beats, weaker than the kick; the signal
    // starts on an off-beat, so the first onsets the grid sees are off-beats.
    let groove = |t: f32| {
        let t = t + 0.25;
        let pos = t % 0.5;
        let off = (t + 0.25) % 0.5;
        let bass = (TAU * 55.0 * t).sin() * (-off * 8.0).exp() * 0.25;
        kick(pos, 0.8) + hat(off, t) + bass
    };
    let r = run(20.0, groove);
    // Kicks at t = 0.25 + n/2 in the signal's time.
    let late: Vec<f64> = r.beats.iter().filter(|b| b.time > 12.0).map(|b| {
        let x = b.time - 0.25;
        x - (x / 0.5).round() * 0.5
    }).collect();
    assert!(late.len() >= 10);
    assert!(mean_abs(&late) < 0.015, "mean distance to the kicks {:.3} s", mean_abs(&late));
}
