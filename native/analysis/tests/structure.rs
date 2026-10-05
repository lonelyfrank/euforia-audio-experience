use spectrum_analysis::{Analyzer, Event, FeatureFrame, SectionEvent, SectionKind};

const SR: f32 = 48_000.0;
const TAU: f32 = std::f32::consts::TAU;
const BPM: f32 = 128.0;
const BEAT: f32 = 60.0 / BPM;
const BAR: f32 = 4.0 * BEAT;

fn noise(t: f32) -> f32 {
    let mut h = ((t * SR) as u32).wrapping_mul(0x9E37_79B9) ^ 0x85EB_CA6B;
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^= h >> 12;
    h as f32 / u32::MAX as f32 * 2.0 - 1.0
}

fn kick(pos: f32) -> f32 {
    (TAU * (50.0 + 100.0 * (-pos * 30.0).exp()) * pos).sin() * (-pos * 9.0).exp()
}

/// A dance track: intro 0–8, build 8–16, drop 16–32, break 32–40, drop 40–48, outro (fading) 48–60 bars.
fn song(t: f32) -> f32 {
    let bar = t / BAR;
    let beats = t / BEAT;
    let pos = beats.fract() * BEAT;
    let off = (beats + 0.5).fract() * BEAT;
    let hat = noise(t) * (-off * 60.0).exp() * 0.15;
    let chord = |root: f32| [1.0, 1.26, 1.5].iter().map(|r| (TAU * root * r * t).sin()).sum::<f32>();
    let pad = chord(if (bar as u32 / 2) % 2 == 0 { 220.0 } else { 196.0 }) * 0.04;
    let bass = (TAU * 55.0 * t).sin() * (0.6 + 0.4 * (-pos * 6.0).exp()) * 0.35;
    // The one of each bar is marked, as in real music: a louder kick, and a crash in the full parts.
    let one = beats.floor() as u32 % 4 == 0;
    let accent = if one { 1.0 } else { 0.7 };
    let crash = if one { noise(t + 11.0) * (-pos * 4.0).exp() * 0.12 } else { 0.0 };
    let full = kick(pos) * 0.9 * accent + bass + hat + pad * 1.5 + crash;
    match bar {
        b if b < 8.0 => kick(pos) * 0.45 * accent + hat + pad,
        b if b < 16.0 => {
            // Snare roll getting denser (8ths then 16ths), a rising noise riser, no kick or bass.
            let step = if b < 12.0 { BEAT / 2.0 } else { BEAT / 4.0 };
            let snare = noise(t + 7.0) * (-(t % step) * 25.0).exp() * 0.3;
            let rise = (b - 8.0) / 8.0;
            snare + noise(t + 3.0) * 0.08 * rise * rise + hat + pad
        }
        b if b < 32.0 => full,
        b if b < 40.0 => pad * 1.2 + hat * 0.5,
        b if b < 48.0 => full,
        b => full * (1.0 - (b - 48.0) / 12.0 * 0.9),
    }
}

fn run(seconds: f32) -> (Vec<SectionEvent>, Vec<FeatureFrame>) {
    let mut analyzer = Analyzer::new(SR, 1);
    let samples: Vec<f32> = (0..(seconds * SR) as usize).map(|i| song(i as f32 / SR)).collect();
    let mut sections = Vec::new();
    let mut frames = Vec::new();
    for chunk in samples.chunks(480) {
        analyzer.push(chunk, |event| match event {
            Event::Section(s) => sections.push(s),
            Event::Frame(f) => frames.push(*f),
            _ => {}
        });
    }
    (sections, frames)
}

fn at(frames: &[FeatureFrame], seconds: f32) -> &FeatureFrame {
    frames.iter().find(|f| f.time >= f64::from(seconds)).unwrap()
}

#[test]
fn finds_the_sections_of_a_dance_track() {
    let (sections, _) = run(60.0 * BAR);
    let kinds: Vec<SectionKind> = sections.iter().map(|s| s.kind).collect();
    assert_eq!(
        kinds,
        [SectionKind::Build, SectionKind::Drop, SectionKind::Break, SectionKind::Drop, SectionKind::Outro]
    );
    // Boundaries stamped on the downbeat they start on, within half a bar (the criterion is one bar).
    for (s, bar) in sections.iter().zip([8.0f32, 16.0, 32.0, 40.0]) {
        let at_bar = s.time as f32 / BAR;
        assert!((at_bar - bar).abs() < 0.5, "{:?} at bar {at_bar:.2}, expected {bar}", s.kind);
        assert!((at_bar - at_bar.round()).abs() * BAR < 0.03, "{:?} not on a downbeat: bar {at_bar:.3}", s.kind);
    }
    // A fade is only recognisable as an outro after a while: somewhere in the fade.
    let outro = sections[4].time as f32 / BAR;
    assert!((48.0..57.0).contains(&outro), "outro at bar {outro:.2}");
}

#[test]
fn recognises_a_returning_section() {
    let (sections, frames) = run(46.0 * BAR);
    let first_drop = sections.iter().find(|s| s.kind == SectionKind::Drop).unwrap();
    let second_drop = sections.iter().filter(|s| s.kind == SectionKind::Drop).nth(1).unwrap();
    assert_eq!(at(&frames, 20.0 * BAR).section_return, -1);
    let f = at(&frames, (second_drop.time as f32) + 2.5 * BAR);
    assert_eq!(f.section_return, first_drop.id as i32);
}

#[test]
fn predicts_phrase_boundaries_and_the_drop() {
    let (_, frames) = run(34.0 * BAR);
    // In the build, the drop is expected towards the end of its phrase.
    assert!(at(&frames, 9.5 * BAR).drop_expected < 0.3, "{}", at(&frames, 9.5 * BAR).drop_expected);
    assert!(at(&frames, 15.5 * BAR).drop_expected > 0.5, "{}", at(&frames, 15.5 * BAR).drop_expected);
    // In the drop, the next phrase boundary is predicted on a downbeat, a whole phrase after the drop started.
    let f = at(&frames, 20.3 * BAR);
    let next = f.next_phrase_time as f32 / BAR;
    assert!(
        (next - (16.0 + f.phrase_bars as f32)).abs() < 0.05,
        "next phrase at bar {next:.3} ({} bar phrases)",
        f.phrase_bars
    );
    assert!(f.structure_confidence > 0.5);
}

#[test]
fn same_song_same_sections() {
    let (a, _) = run(34.0 * BAR);
    let (b, _) = run(34.0 * BAR);
    assert_eq!(a, b);
}

#[test]
fn without_a_beat_the_structure_is_not_trusted() {
    let mut analyzer = Analyzer::new(SR, 1);
    let samples: Vec<f32> = (0..(30.0 * SR) as usize)
        .map(|i| {
            let t = i as f32 / SR;
            [220.0, 277.2, 329.6].iter().map(|f| (TAU * f * t).sin()).sum::<f32>() * 0.1
        })
        .collect();
    let mut last = FeatureFrame::default();
    let mut sections = 0;
    analyzer.push(&samples, |event| match event {
        Event::Frame(f) => last = *f,
        Event::Section(_) => sections += 1,
        _ => {}
    });
    assert!(last.structure_confidence < 0.3, "{}", last.structure_confidence);
    assert_eq!(sections, 0);
}

/// Like the app's "Ambient → build → drop" test signal: a beatless ambient pad (with a 55 Hz root),
/// a short snare-roll build (no kick, the snare's 190 Hz body in the bass band), a short drop; 32 s cycles.
fn cycle_song(t: f32) -> f32 {
    let c = t % 32.0;
    let pad = [55.0f32, 110.0, 164.8, 220.0].iter().map(|f| (TAU * f * t).sin()).sum::<f32>() * 0.025;
    if c < 10.0 {
        return pad;
    }
    let beats = c / BEAT;
    if c < 18.0 {
        let x = (c - 10.0) / 8.0;
        let step = BEAT / 2f32.powi((x * 4.0).floor().min(3.0) as i32);
        let pos = c % step;
        let snare = ((TAU * 190.0 * pos).sin() * 0.6 + noise(t) * 0.5) * (-pos * 25.0).exp() * (0.1 + 0.3 * x);
        return pad + snare + noise(t + 5.0) * 0.12 * x * x;
    }
    let pos = beats.fract() * BEAT;
    let one = beats.floor() as u32 % 4 == 0;
    let off = (beats + 0.5).fract() * BEAT;
    let snare_pos = ((beats - 1.0) / 2.0).fract() * 2.0 * BEAT;
    let bass = (TAU * 55.0 * t).sin() * 0.3;
    kick(pos) * if one { 1.0 } else { 0.75 }
        + bass
        + noise(t) * (-off * 60.0).exp() * 0.15
        + ((TAU * 190.0 * snare_pos).sin() * 0.5 + noise(t + 9.0) * 0.4) * (-snare_pos * 25.0).exp() * 0.5
        + pad
}

#[test]
fn short_cycles_after_beatless_ambient() {
    let mut analyzer = Analyzer::new(SR, 1);
    let samples: Vec<f32> = (0..(96.0 * SR) as usize).map(|i| cycle_song(i as f32 / SR)).collect();
    let mut sections = Vec::new();
    analyzer.push(&samples, |event| {
        if let Event::Section(s) = event {
            sections.push(s);
        }
    });
    let kinds: Vec<SectionKind> = sections.iter().map(|s| s.kind).collect();
    use SectionKind::{Break, Build, Drop};
    assert_eq!(kinds, [Build, Drop, Break, Build, Drop, Break, Build, Drop]);
    let truth = [10.0, 18.0, 32.0, 42.0, 50.0, 64.0, 74.0, 82.0];
    for (s, t) in sections.iter().zip(truth) {
        let late = s.time as f32 - t;
        // Drops and breaks within a bar. A build after a beatless part is only seen once the grid
        // locks onto it (a few seconds): within 2.5 bars.
        let limit = if s.kind == Build { 2.5 * BAR } else { BAR };
        assert!((-BAR / 2.0..limit).contains(&late), "{:?} at {:.2} s, expected {t}", s.kind, s.time);
    }
}

#[test]
fn phrase_horizon_uses_rhythmic_evidence() {
    let (_, frames) = run(30.0 * BAR);
    let f = at(&frames, 29.0 * BAR);
    assert_eq!(f.phrase_bars, 8);
    assert!(f.phrase_bar < f.phrase_bars);
    assert!(f.next_phrase_time > f.time);
}
