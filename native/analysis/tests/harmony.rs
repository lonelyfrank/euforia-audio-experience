use spectrum_analysis::{Analyzer, Event, FeatureFrame};

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
