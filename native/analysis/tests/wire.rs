use spectrum_analysis::wire::{self, BEAT_RECORD, FRAME_RECORD, MAX_RECORD, ONSET_RECORD, TAG_BEAT, TAG_FRAME, TAG_ONSET};
use spectrum_analysis::{Analyzer, Event};

const LAYOUT_TS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/audio/features/layout.ts");

#[test]
fn typescript_layout_is_up_to_date() {
    let generated = wire::typescript_layout();
    if std::env::var_os("UPDATE_LAYOUT").is_some() {
        std::fs::write(LAYOUT_TS, &generated).unwrap();
    }
    let current = std::fs::read_to_string(LAYOUT_TS).unwrap_or_default();
    assert!(current == generated, "src/audio/features/layout.ts is stale: run UPDATE_LAYOUT=1 cargo test -p spectrum-analysis --test wire");
}

#[test]
fn records_are_tagged_and_sized() {
    let mut analyzer = Analyzer::new(48_000.0, 1);
    let samples: Vec<f32> = (0..48_000 * 6).map(|i| {
        let pos = (i % 24_000) as f32 / 48_000.0;
        (std::f32::consts::TAU * 60.0 * pos).sin() * (-pos * 9.0).exp()
    }).collect();
    let mut out = vec![0.0; MAX_RECORD];
    let mut seen = [0usize; 3];
    analyzer.push(&samples, |event| {
        let n = wire::encode(&event, &mut out);
        let (tag, size, slot) = match event {
            Event::Frame(_) => (TAG_FRAME, FRAME_RECORD, 0),
            Event::Onset(_) => (TAG_ONSET, ONSET_RECORD, 1),
            Event::Beat(_) => (TAG_BEAT, BEAT_RECORD, 2),
        };
        assert_eq!((out[0], n), (tag, size));
        assert!(out[..n].iter().all(|v| v.is_finite()));
        seen[slot] += 1;
    });
    assert!(seen.iter().all(|&n| n > 0), "{seen:?}");
}
