use spectrum_analysis::{Analyzer, FeatureFrame};
const SR: f32 = 48000.0;
fn run(kind: usize) -> FeatureFrame {
    let mut a = Analyzer::new(SR, 2);
    let mut seed = 123u32;
    let mut chunk = [0.0; 960];
    for batch in 0..200 {
        for i in 0..480 {
            let t = (batch * 480 + i) as f32 / SR;
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let sine = (std::f32::consts::TAU * 440.0 * t).sin() * 0.3;
            let x = if kind == 2 { (seed as f32 / u32::MAX as f32 - 0.5) * 0.6 } else { sine };
            chunk[2 * i] = x;
            chunk[2 * i + 1] = if kind == 1 { -x } else { x };
        }
        a.push(&chunk, |_| {});
    }
    *a.frame()
}
#[test]
fn physical_perceptual_phase_and_spatial_are_distinct() {
    let tone = run(0);
    let side = run(1);
    let noise = run(2);
    assert!((tone.rms - 0.3 / 2f32.sqrt()).abs() < 0.005);
    assert!((tone.crest - 2f32.sqrt()).abs() < 0.03);
    assert!(noise.entropy > tone.entropy + 0.3);
    assert!(tone.phase_coherence > 0.95);
    assert!(noise.phase_coherence < tone.phase_coherence - 0.1);
    assert!(tone.harmonicity > 0.8);
    assert!(tone.width < 0.01 && side.width > 0.99);
    assert!(side.side_energy > 0.01 && side.mid_energy < 1e-6);
    assert!((tone.loudness_momentary - side.loudness_momentary).abs() < 0.01);
    assert!(side.inter_channel_phase.abs() > 3.0);
    assert!(tone.pitch_bins[33] > 0.8); // A4 (69-36)
    for f in [tone, side, noise] {
        assert!((f.harmonic_share + f.percussive_share + f.residual_share - 1.0).abs() < 0.001);
        let mut values = vec![0.0; FeatureFrame::SIZE];
        f.export(&mut values);
        assert!(values.iter().all(|v| v.is_finite()));
    }
}
#[test]
fn reset_and_quality_preserve_clock_and_quiet() {
    for quality in 0..3 {
        let mut a = Analyzer::new(SR, 1);
        a.set_quality(quality);
        a.push(&[0.0; 48000], |_| {});
        assert_eq!(a.frame().dsp_quality, quality);
        assert_eq!(a.samples(), 48000);
        assert_eq!(a.frame().entropy, 0.0);
        assert_eq!(a.frame().phase_coherence, 0.0);
        a.reset();
        assert_eq!(a.samples(), 0);
    }
}

fn hiss(seed: &mut u32) -> f32 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 17;
    *seed ^= *seed << 5;
    *seed as f32 / u32::MAX as f32 - 0.5
}

#[test]
fn band_floor_learns_the_room_but_not_a_sustained_tone() {
    let mut a = Analyzer::new(SR, 1);
    let mut seed = 7u32;
    let mut frames = Vec::new();
    // 6 s of room noise (≈ -60 dB), then 20 s of a steady 1 kHz tone over it.
    let samples: Vec<f32> = (0..(26.0 * SR) as usize)
        .map(|i| {
            let t = i as f32 / SR;
            hiss(&mut seed) * 0.004 + if t > 6.0 { (std::f32::consts::TAU * 1000.0 * t).sin() * 0.2 } else { 0.0 }
        })
        .collect();
    for chunk in samples.chunks(480) {
        a.push(chunk, |e| {
            if let spectrum_analysis::Event::Frame(f) = e {
                frames.push(*f)
            }
        });
    }
    let room = frames.iter().find(|f| f.time > 5.9).unwrap();
    for b in 1..7 {
        assert!(room.band_level[b] < 0.15, "band {b} reads {} active on room noise", room.band_level[b]);
        assert!((room.band_db[b] - room.band_floor_db[b]).abs() < 6.0, "band {b} floor {} vs {}", room.band_floor_db[b], room.band_db[b]);
    }
    let last = frames.last().unwrap();
    // The mid band (500 Hz–2 kHz) keeps reading the tone after 20 s; the other bands stay at the floor.
    assert!(last.band_level[3] > 0.8, "tone absorbed: {}", last.band_level[3]);
    assert!(last.band_level[6] < 0.15);
    assert!((last.band_floor_db[3] - room.band_floor_db[3]).abs() < 6.0);
}

#[test]
fn loudness_quantiles_order_and_resist_a_single_peak() {
    let mut a = Analyzer::new(SR, 1);
    let mut frames = Vec::new();
    // 30 s at a steady level with a slow ±6 dB swell, and one loud 100 ms burst at 20 s.
    let samples: Vec<f32> = (0..(30.0 * SR) as usize)
        .map(|i| {
            let t = i as f32 / SR;
            let swell = 10f32.powf((6.0 * (std::f32::consts::TAU * t / 8.0).sin()) / 20.0);
            let burst = if (20.0..20.1).contains(&t) { 8.0 } else { 1.0 };
            ((std::f32::consts::TAU * 220.0 * t).sin() * 0.05 * swell * burst).clamp(-1.0, 1.0)
        })
        .collect();
    for chunk in samples.chunks(480) {
        a.push(chunk, |e| {
            if let spectrum_analysis::Event::Frame(f) = e {
                frames.push(*f)
            }
        });
    }
    let before = frames.iter().find(|f| f.time > 19.9).unwrap().loudness_quantiles;
    let after = frames.iter().find(|f| f.time > 21.0).unwrap().loudness_quantiles;
    let q = frames.last().unwrap().loudness_quantiles;
    assert!(q[0] < q[1] && q[1] < q[2] && q[2] <= q[3], "{q:?}");
    // The swell spans 12 dB: P10..P95 covers most of it.
    assert!(q[3] - q[0] > 6.0 && q[3] - q[0] < 16.0, "{q:?}");
    // An 18 dB burst lasting 100 ms barely moves the typical level.
    assert!((after[1] - before[1]).abs() < 1.0, "{before:?} → {after:?}");
    let positions: Vec<f32> = frames.iter().filter(|f| f.time > 24.0).map(|f| f.loudness_position).collect();
    let (lo, hi) = positions.iter().fold((1.0f32, 0.0f32), |(l, h), &p| (l.min(p), h.max(p)));
    assert!(lo < 0.25 && hi > 0.75, "position range {lo}..{hi}");
}
