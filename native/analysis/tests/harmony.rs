use spectrum_analysis::{Analyzer, Event, FeatureFrame, PARTIALS};

const SR: f32 = 48_000.0;
const TAU: f32 = std::f32::consts::TAU;
const C: usize = 0;
const E: usize = 4;
const G: usize = 7;
const A: usize = 9;

fn run(seconds: f32, f: impl Fn(f32) -> f32) -> Vec<FeatureFrame> {
    let mut analyzer = Analyzer::new(SR, 1);
    let samples: Vec<f32> = (0..(seconds * SR) as usize).map(|i| f(i as f32 / SR)).collect();
    let mut frames = Vec::new();
    for chunk in samples.chunks(480) {
        analyzer.push(chunk, |event| {
            if let Event::Frame(frame) = event {
                frames.push(*frame);
            }
        });
    }
    frames
}

fn midi_hz(note: f32) -> f32 {
    440.0 * 2f32.powf((note - 69.0) / 12.0)
}

/// A chord of MIDI notes with a few harmonics, like a soft synth.
fn chord(notes: &[f32], t: f32) -> f32 {
    notes.iter().map(|&n| {
        let f = midi_hz(n);
        (1..=4).map(|h| (TAU * f * h as f32 * t).sin() / h as f32).sum::<f32>()
    }).sum::<f32>() * 0.08
}

fn top3(chroma: &[f32; 12]) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..12).collect();
    idx.sort_by(|&a, &b| chroma[b].total_cmp(&chroma[a]));
    let mut top = idx[..3].to_vec();
    top.sort();
    top
}

#[test]
fn a_single_note_has_its_pitch_class() {
    let frames = run(1.0, |t| 0.4 * (TAU * 440.0 * t).sin());
    let f = frames.last().unwrap();
    let strongest = (0..12).max_by(|&a, &b| f.chroma[a].total_cmp(&f.chroma[b])).unwrap();
    assert_eq!(strongest, A);
    assert!(f.chroma_confidence > 0.5, "{}", f.chroma_confidence);
}

#[test]
fn a_major_triad_lights_its_three_classes() {
    let frames = run(1.5, |t| chord(&[48.0, 52.0, 55.0, 60.0], t));
    assert_eq!(top3(&frames.last().unwrap().chroma), vec![C, E, G]);
}

#[test]
fn the_key_of_a_progression() {
    // I–IV–V–I in C major, then i–iv–v–i in A minor; each chord 1 s.
    let c_major = [[48.0, 52.0, 55.0], [53.0, 57.0, 60.0], [55.0, 59.0, 62.0], [48.0, 52.0, 55.0]];
    let a_minor = [[57.0, 60.0, 64.0], [50.0, 53.0, 57.0], [52.0, 55.0, 59.0], [57.0, 60.0, 64.0]];
    let frames = run(32.0, |t| {
        let bar = (t as usize) % 4;
        if t < 16.0 { chord(&c_major[bar], t) } else { chord(&a_minor[bar], t) }
    });
    let at = |s: f64| frames.iter().find(|f| f.time >= s).unwrap();
    assert_eq!(at(15.9).key, 0, "C major");
    assert!(at(15.9).key_confidence > 0.3, "{}", at(15.9).key_confidence);
    assert_eq!(at(31.9).key, 12 + 9, "A minor");
}

#[test]
fn noise_has_no_harmony() {
    let mut state = 1u32;
    let samples: Vec<f32> = (0..(2.0 * SR) as usize).map(|_| {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        (state as f32 / u32::MAX as f32 * 2.0 - 1.0) * 0.3
    }).collect();
    let frames = run(2.0, |t| samples[((t * SR) as usize).min(samples.len() - 1)]);
    let f = frames.last().unwrap();
    assert!(f.chroma_confidence < 0.2, "{}", f.chroma_confidence);
}

#[test]
fn no_key_in_silence() {
    let frames = run(2.0, |_| 0.0);
    assert_eq!(frames.last().unwrap().key, -1);
    assert_eq!(frames.last().unwrap().chroma_confidence, 0.0);
}

/// The partials present in a frame, as (Hz, level, pan, phase), loudest first.
fn partials(f: &FeatureFrame) -> Vec<(f32, f32, f32, f32)> {
    (0..PARTIALS).filter(|&i| f.partial_level[i] > 0.0).map(|i| (f.partial_hz[i], f.partial_level[i], f.partial_pan[i], f.partial_phase[i])).collect()
}

#[test]
fn a_harmonic_tone_reports_its_partials_loudest_first() {
    // A sawtooth-like tone: harmonics 1..6 of 220 Hz at 1/n.
    let frames = run(1.0, |t| (1..=6).map(|h| (TAU * 220.0 * h as f32 * t).sin() / h as f32).sum::<f32>() * 0.2);
    let found = partials(frames.last().unwrap());
    assert_eq!(found.len(), 6, "{found:?}");
    for (i, &(hz, level, pan, phase)) in found.iter().enumerate() {
        let harmonic = (i + 1) as f32;
        assert!((hz - 220.0 * harmonic).abs() < 2.0, "partial {i}: {hz} Hz");
        // Levels follow the 1/n spectrum, relative to the fundamental.
        assert!((level - frames.last().unwrap().partial_level[0] / harmonic).abs() < 0.08, "partial {i}: level {level}");
        // Mono: centred and in phase.
        assert_eq!((pan, phase), (0.0, 0.0));
    }
    assert!(found[0].1 > 0.8, "{}", found[0].1);
}

#[test]
fn partials_carry_where_they_sit_between_the_channels() {
    // 330 Hz on the left only; 880 Hz on both channels, the right a quarter of a cycle behind.
    let mut analyzer = Analyzer::new(SR, 2);
    let samples: Vec<f32> = (0..SR as usize).flat_map(|i| {
        let t = i as f32 / SR;
        let left = 0.3 * (TAU * 330.0 * t).sin() + 0.2 * (TAU * 880.0 * t).sin();
        let right = 0.2 * (TAU * 880.0 * t - TAU / 4.0).sin();
        [left, right]
    }).collect();
    let mut last = None;
    analyzer.push(&samples, |event| {
        if let Event::Frame(frame) = event {
            last = Some(*frame);
        }
    });
    let found = partials(&last.unwrap());
    let near = |hz: f32| *found.iter().find(|p| (p.0 - hz).abs() < 3.0).unwrap_or_else(|| panic!("no partial at {hz} Hz in {found:?}"));
    assert!(near(330.0).2 < -0.95, "{:?}", near(330.0));
    let both = near(880.0);
    assert!(both.2.abs() < 0.05, "{both:?}");
    assert!((both.3 - TAU / 4.0).abs() < 0.05, "{both:?}");
}

#[test]
fn noise_and_silence_have_no_strong_partials() {
    let mut state = 7u32;
    let samples: Vec<f32> = (0..(2.0 * SR) as usize).map(|_| {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        (state as f32 / u32::MAX as f32 * 2.0 - 1.0) * 0.3
    }).collect();
    let noise = run(2.0, |t| samples[((t * SR) as usize).min(samples.len() - 1)]);
    // Noise has peaks, but they are scaled by how tonal the sound is.
    assert!(noise.last().unwrap().partial_level.iter().all(|&level| level < 0.35), "{:?}", noise.last().unwrap().partial_level);
    let silence = run(1.0, |_| 0.0);
    assert!(silence.last().unwrap().partial_level.iter().all(|&level| level == 0.0));
    // A tone that stops leaves no partial behind.
    let stopped = run(3.0, |t| if t < 1.0 { 0.4 * (TAU * 440.0 * t).sin() } else { 0.0 });
    assert!(stopped.last().unwrap().partial_level.iter().all(|&level| level == 0.0), "{:?}", stopped.last().unwrap().partial_level);
}
