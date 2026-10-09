//! The scenes' graphic analysis as part of the analyzer: its cadence on the capture clock, what it
//! measures, and what it shares with the musical analysis. That its numbers are those of the
//! TypeScript analyzer it replaces on the frame loop is tested in the frontend, against that
//! analyzer (`src/audio/features/SceneAnalysis.test.ts`).

use spectrum_analysis::{Analyzer, Event, SceneFrame, HOP};

const TAU: f32 = std::f32::consts::TAU;

/// A groove with a pitched bass (55 Hz) and lead (440 Hz, with a second harmonic), a kick every half second
/// and a little hiss.
fn groove(rate: f32, seconds: f32) -> Vec<f32> {
    let mut seed = 1u32;
    (0..(rate * seconds) as usize)
        .map(|i| {
            let t = i as f32 / rate;
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = (seed >> 8) as f32 / 8388608.0 - 1.0;
            let beat = t % 0.5;
            let kick = (TAU * 55.0 * beat).sin() * (-beat * 18.0).exp();
            let bass = (TAU * 55.0 * t).sin();
            let lead = (TAU * 440.0 * t).sin() + 0.3 * (TAU * 880.0 * t).sin();
            0.5 * kick + 0.2 * bass + 0.15 * lead + 0.02 * noise
        })
        .collect()
}

/// Scene frames and the hop frames' samples, pushing `samples` in chunks of `chunk` values.
fn run(analyzer: &mut Analyzer, samples: &[f32], chunk: usize) -> (Vec<SceneFrame>, Vec<u64>) {
    let (mut scenes, mut hops) = (Vec::new(), Vec::new());
    for part in samples.chunks(chunk) {
        analyzer.push(part, |event| match event {
            Event::Scene(scene) => scenes.push(scene.clone()),
            Event::Frame(frame) => hops.push(frame.sample),
            _ => {}
        });
    }
    (scenes, hops)
}

#[test]
fn about_sixty_frames_per_second_on_hop_boundaries_at_any_rate() {
    for (rate, every) in [(44_100.0, 3), (48_000.0, 3), (96_000.0, 6), (22_050.0, 1)] {
        let mut analyzer = Analyzer::new(rate, 1);
        assert_eq!(analyzer.scene_every(), every, "{rate}");
        let samples = vec![0.0f32; rate as usize];
        let mut last_hop = 0;
        let mut scenes = Vec::new();
        analyzer.push(&samples, |event| match event {
            Event::Frame(frame) => last_hop = frame.sample,
            // Right after the frame of its hop, stamped with the same sample.
            Event::Scene(scene) => {
                assert_eq!(scene.sample, last_hop);
                scenes.push(scene.sample);
            }
            _ => {}
        });
        for (i, sample) in scenes.iter().enumerate() {
            assert_eq!(*sample, (i as u64 + 1) * u64::from(every) * HOP as u64);
        }
        let per_second = scenes.len() as f32;
        assert!((45.0..=90.0).contains(&per_second), "{rate}: {per_second}");
    }
}

#[test]
fn the_host_chooses_the_cadence_and_a_loaded_dsp_stretches_it() {
    let samples = groove(48_000.0, 2.0);
    let mut analyzer = Analyzer::new(48_000.0, 1);
    analyzer.set_scene(1.0, 0.5, 2);
    let (scenes, _) = run(&mut analyzer, &samples, 480);
    assert_eq!(scenes[10].sample - scenes[9].sample, 2 * HOP as u64);

    // Quality changes only how often the picture is analysed: 3 hops, then 4, then 6.
    for (quality, every) in [(0u8, 3u64), (1, 4), (2, 6)] {
        let mut analyzer = Analyzer::new(48_000.0, 1);
        analyzer.set_quality(quality);
        let (scenes, hops) = run(&mut analyzer, &samples, 480);
        assert_eq!(scenes[10].sample - scenes[9].sample, every * HOP as u64, "quality {quality}");
        // The musical analysis keeps every hop.
        assert_eq!(hops.len(), samples.len() / HOP);
    }
}

#[test]
fn the_same_audio_gives_the_same_frames_whatever_the_batching() {
    let samples = groove(48_000.0, 4.0);
    let (a, _) = run(&mut Analyzer::new(48_000.0, 1), &samples, 480);
    let (b, _) = run(&mut Analyzer::new(48_000.0, 1), &samples, 77);
    let (c, _) = run(&mut Analyzer::new(48_000.0, 1), &samples, samples.len());
    assert!(a.len() > 200);
    assert!(a == b && a == c);
}

#[test]
fn it_draws_levels_a_spectrum_the_waveform_and_the_two_voices() {
    let samples = groove(48_000.0, 6.0);
    let (scenes, _) = run(&mut Analyzer::new(48_000.0, 1), &samples, 480);
    let last = scenes.last().unwrap();
    assert!(!last.silent);
    assert!(last.volume > 0.05 && last.volume <= 1.0, "{}", last.volume);
    assert!(last.spectrum.iter().cloned().fold(0.0, f32::max) > 0.5);
    assert!(last.waveform.iter().any(|v| v.abs() > 0.3));
    // The voices are found at their pitch, with the shape of one cycle.
    assert!((last.bass_pitch - 55.0).abs() < 1.5, "{}", last.bass_pitch);
    assert!((last.lead_pitch - 440.0).abs() < 4.0, "{}", last.lead_pitch);
    assert!(last.lead_clarity > 0.5, "{}", last.lead_clarity);
    assert!(last.lead_shape.iter().cloned().fold(0.0, f32::max) > 0.9);
    // Kicks are beats of the scenes' own tracker (not every one: the held bass note masks some), each for one frame.
    let beats = scenes.iter().filter(|s| s.beat).count();
    assert!((3..=13).contains(&beats), "{beats}");
    assert!(scenes.windows(2).all(|pair| !(pair[0].beat && pair[1].beat)));
    let mut out = vec![f64::NAN; SceneFrame::SIZE];
    for scene in &scenes {
        scene.export(&mut out);
        assert!(out.iter().all(|v| v.is_finite()));
    }
}

#[test]
fn silence_is_silent_and_the_picture_falls_with_its_own_smoothing() {
    let mut samples = groove(48_000.0, 3.0);
    samples.extend(std::iter::repeat_n(0.0, 48_000));
    let (scenes, _) = run(&mut Analyzer::new(48_000.0, 1), &samples, 480);
    let cut = scenes.iter().position(|s| s.sample > 3 * 48_000 + 2048).unwrap();
    assert!(scenes[cut].silent);
    assert_eq!((scenes[cut].bass_pitch, scenes[cut].lead_pitch), (0.0, 0.0));
    // Released, not zeroed: a few frames later it is still on its way down.
    assert!(scenes[cut].volume > scenes[cut + 6].volume && scenes[cut + 6].volume > 0.0);
    assert!(scenes.last().unwrap().volume < 1e-3);
}

#[test]
fn it_draws_the_mono_mix_of_every_channel() {
    // Opposite channels cancel in the mix (while the musical analysis still hears both).
    let samples: Vec<f32> = groove(48_000.0, 1.0).into_iter().flat_map(|v| [v, -v]).collect();
    let mut analyzer = Analyzer::new(48_000.0, 2);
    let (mut silent, mut sounding) = (true, false);
    analyzer.push(&samples, |event| match event {
        Event::Scene(scene) => silent &= scene.silent,
        Event::Frame(frame) => sounding |= !frame.silent,
        _ => {}
    });
    assert!(silent && sounding);
}

#[test]
fn a_restart_of_the_analysis_keeps_the_picture() {
    let samples = groove(48_000.0, 3.0);
    let mut analyzer = Analyzer::new(48_000.0, 1);
    let (before, _) = run(&mut analyzer, &samples, 480);
    analyzer.reset();
    assert_eq!(analyzer.samples(), 0);
    let (after, _) = run(&mut analyzer, &samples[..48_000], 480);
    // The capture clock started over (the cadence goes on from where it was)…
    assert!(after[0].sample <= 3 * HOP as u64 && after[0].sample % HOP as u64 == 0);
    assert_eq!(after[1].sample - after[0].sample, 3 * HOP as u64);
    // …the adaptive ranges did not: the first frames are not a cold start.
    let cold = run(&mut Analyzer::new(48_000.0, 1), &samples[..48_000], 480).0;
    assert!(after[2].volume != cold[2].volume);
    assert!(before.len() > 180);
}
