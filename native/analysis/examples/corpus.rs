//! Corpus evaluation of the live analysis against annotated recordings.
//! Development tool only: the app never reads files. Each recording is
//! streamed through the analyzer in 10 ms batches, exactly as live capture
//! (causal, nothing looks ahead), and its events are scored against the
//! annotations with the agreed thresholds:
//!
//! - beat F1 at ±70 ms ≥ 0.85, median phase error of the matched beats ≤ 25 ms;
//! - downbeat F1 at ±70 ms ≥ 0.6;
//! - section boundaries found within ±1 bar ≥ 60%.
//!
//! The first 5 s are not scored (the usual convention: trackers need to lock).
//!
//! Layout of the corpus directory, per recording `name`:
//!
//! - `name.wav`: PCM 16/24/32-bit or 32-bit float, any rate and channel count;
//! - `name.beats`: one beat per line, `time [position]` (position 1 = downbeat,
//!   as in the Ballroom, GTZAN-Rhythm and Harmonix annotations); without
//!   positions, downbeats are not scored;
//! - `name.sections` (optional): one boundary per line, `time [label]`; a
//!   boundary at 0 and an `end` label are ignored.
//!
//!     cargo run -p spectrum-analysis --release --example corpus -- <dir> [--resonators] [--verbose]
//!     cargo run -p spectrum-analysis --release --example corpus -- --synth <dir>
//!
//! `--synth` writes a small synthetic corpus with exact annotations (to check
//! the tool itself; it says nothing about real music).

use spectrum_analysis::{Analyzer, AnalyzerOptions, Event};
use std::fs;
use std::path::{Path, PathBuf};

const TOLERANCE: f64 = 0.07;
const SKIP: f64 = 5.0;
const BEAT_F1: f64 = 0.85;
const PHASE_MS: f64 = 25.0;
const DOWNBEAT_F1: f64 = 0.6;
const SECTIONS_FOUND: f64 = 0.6;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--synth") {
        let dir = PathBuf::from(args.get(1).expect("--synth <dir>"));
        synth::write(&dir);
        println!("synthetic corpus written to {}", dir.display());
        return;
    }
    let dir = PathBuf::from(args.iter().find(|a| !a.starts_with("--")).expect("usage: corpus <dir> [--resonators]"));
    let resonators = args.iter().any(|a| a == "--resonators");
    let verbose = args.iter().any(|a| a == "--verbose");
    let mut wavs: Vec<PathBuf> = fs::read_dir(&dir)
        .expect("corpus directory")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("wav")))
        .collect();
    wavs.sort();
    if wavs.is_empty() {
        eprintln!("no .wav files in {}", dir.display());
        std::process::exit(1);
    }

    println!(
        "{:<28} {:>7} {:>9} {:>9} {:>9} {:>11}",
        "recording", "beat F1", "phase ms", "down F1", "sections", "extra sect."
    );
    let mut totals = Totals::default();
    for wav in &wavs {
        let Some(beats) = read_annotations(&wav.with_extension("beats")) else {
            println!("{:<28} (no .beats file: skipped)", name(wav));
            continue;
        };
        let sections = read_annotations(&wav.with_extension("sections"));
        let (rate, channels, samples) = match read_wav(wav) {
            Ok(x) => x,
            Err(e) => {
                println!("{:<28} (unreadable: {e})", name(wav));
                continue;
            }
        };
        let out = analyze(rate, channels, &samples, resonators);
        let score = score(&beats, sections.as_deref(), &out);
        totals.add(&score);
        let ibis: Vec<f64> = beats.windows(2).map(|w| w[1].0 - w[0].0).filter(|&d| d > 0.0).collect();
        let reference_tempo = 60.0 / median(&ibis);
        let tempo_error = (median(&out.tempo) / reference_tempo - 1.0).abs() * 100.0;
        let delay: Vec<f64> = out.reported.iter().zip(&out.onsets).map(|(r, t)| (r - t) * 1000.0).collect();
        println!(
            "  tempo error {tempo_error:.2}% · onset report delay {:.2} ms · novelty candidates {}",
            median(&delay),
            out.novelty.len()
        );
        if let Some(onsets) = read_annotations(&wav.with_extension("onsets")) {
            let reference: Vec<f64> = onsets.iter().map(|x| x.0).filter(|&t| t >= SKIP).collect();
            let detected: Vec<f64> = out.onsets.iter().copied().filter(|&t| t >= SKIP).collect();
            println!("  annotated onset F1 {:.3}", f_measure(&reference, &detected).0);
        }
        if let Some(novelty) = read_annotations(&wav.with_extension("novelty")) {
            let reference: Vec<f64> = novelty.iter().map(|x| x.0).filter(|&t| t >= SKIP).collect();
            println!("  annotated novelty F1 (70 ms tolerance) {:.3}", f_measure(&reference, &out.novelty).0);
        }
        println!(
            "{:<28} {:>7.3} {:>9.1} {:>9} {:>9} {:>11}",
            name(wav),
            score.beat_f1,
            score.phase_ms,
            score.downbeat_f1.map_or("–".into(), |f| format!("{f:.3}")),
            score.sections_found.map_or("–".into(), |(found, of)| format!("{found}/{of}")),
            score.sections_found.map_or("–".into(), |_| score.extra_sections.to_string()),
        );
        if verbose {
            let times = |xs: &mut dyn Iterator<Item = f64>| xs.map(|t| format!("{t:.1}")).collect::<Vec<_>>().join(" ");
            println!(
                "    sections annotated: {}",
                sections.as_deref().map_or(String::new(), |s| times(&mut s.iter().map(|x| x.0)))
            );
            println!("    sections reported:  {}", out.sections_detail.join(" "));
            let first = out.beats.iter().find(|&&t| t >= SKIP).copied().unwrap_or(f64::NAN);
            println!(
                "    first beat after {SKIP} s: {first:.2} s; {} beats, {} downbeats reported",
                out.beats.len(),
                out.downbeats.len()
            );
        }
    }
    totals.report();
}

fn name(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// What the analyzer reported, as live.
struct Output {
    beats: Vec<f64>,
    downbeats: Vec<f64>,
    sections: Vec<f64>,
    /// "time kind" of each reported section (for --verbose).
    sections_detail: Vec<String>,
    onsets: Vec<f64>,
    reported: Vec<f64>,
    novelty: Vec<f64>,
    tempo: Vec<f64>,
}

fn analyze(rate: f32, channels: usize, samples: &[f32], resonators: bool) -> Output {
    let mut analyzer = Analyzer::with_options(rate, channels, AnalyzerOptions { resonators });
    let mut out = Output {
        beats: Vec::new(),
        downbeats: Vec::new(),
        sections: Vec::new(),
        sections_detail: Vec::new(),
        onsets: Vec::new(),
        reported: Vec::new(),
        novelty: Vec::new(),
        tempo: Vec::new(),
    };
    // 10 ms capture batches.
    let batch = ((rate / 100.0) as usize).max(1) * channels;
    for (index, chunk) in samples.chunks(batch).enumerate() {
        analyzer.push(chunk, |event| match event {
            Event::Beat(b) => {
                out.beats.push(b.time);
                if b.downbeat {
                    out.downbeats.push(b.time);
                }
            }
            Event::Section(s) => {
                out.sections.push(s.time);
                out.sections_detail.push(format!("{:.1}:{:?}", s.time, s.kind));
            }
            Event::Onset(o) => {
                out.onsets.push(o.time);
                out.reported.push(((index + 1) * batch) as f64 / channels as f64 / rate as f64);
            }
            Event::Frame(f) => {
                if f.time > SKIP && f.beat_confidence > 0.3 {
                    out.tempo.push(f.beat_bpm as f64);
                }
                if f.novelty > 0.6 && out.novelty.last().is_none_or(|t| f.time - t > 1.0) {
                    out.novelty.push(f.time);
                }
            }
            Event::Scene(_) => {}
        });
    }
    out
}

struct Score {
    beat_f1: f64,
    phase_ms: f64,
    downbeat_f1: Option<f64>,
    /// (found, annotated) boundaries.
    sections_found: Option<(usize, usize)>,
    extra_sections: usize,
    phases: Vec<f64>,
}

fn score(beats: &[(f64, Option<u32>)], sections: Option<&[(f64, Option<u32>)]>, out: &Output) -> Score {
    let reference: Vec<f64> = beats.iter().map(|b| b.0).filter(|&t| t >= SKIP).collect();
    let estimated: Vec<f64> = out.beats.iter().copied().filter(|&t| t >= SKIP).collect();
    let (beat_f1, phases) = f_measure(&reference, &estimated);
    let phase_ms = median(&phases) * 1000.0;

    let positioned = beats.iter().any(|b| b.1.is_some());
    let downbeat_f1 = positioned.then(|| {
        let reference: Vec<f64> = beats.iter().filter(|b| b.1 == Some(1) && b.0 >= SKIP).map(|b| b.0).collect();
        let estimated: Vec<f64> = out.downbeats.iter().copied().filter(|&t| t >= SKIP).collect();
        f_measure(&reference, &estimated).0
    });

    // Bar length from the annotated beats around each boundary.
    let bar_at = |t: f64| {
        let i = beats.partition_point(|b| b.0 < t).clamp(1, beats.len().saturating_sub(1).max(1));
        let from = i.saturating_sub(4);
        let to = (i + 4).min(beats.len());
        let ibis: Vec<f64> = beats[from..to].windows(2).map(|w| w[1].0 - w[0].0).collect();
        let meter = beats[from..to].iter().filter_map(|b| b.1).max().unwrap_or(4) as f64;
        meter * if ibis.is_empty() { 0.5 } else { median(&ibis) }
    };
    let mut extra_sections = 0;
    let sections_found = sections.map(|sections| {
        let boundaries: Vec<f64> = sections.iter().map(|s| s.0).filter(|&t| t >= SKIP).collect();
        let found = boundaries.iter().filter(|&&b| out.sections.iter().any(|&s| (s - b).abs() <= bar_at(b))).count();
        extra_sections = out
            .sections
            .iter()
            .filter(|&&s| s >= SKIP && !boundaries.iter().any(|&b| (s - b).abs() <= bar_at(b)))
            .count();
        (found, boundaries.len())
    });
    Score { beat_f1, phase_ms, downbeat_f1, sections_found, extra_sections, phases }
}

/// F-measure with one-to-one matching within ±TOLERANCE, and the matched errors.
fn f_measure(reference: &[f64], estimated: &[f64]) -> (f64, Vec<f64>) {
    if reference.is_empty() || estimated.is_empty() {
        return (if reference.is_empty() && estimated.is_empty() { 1.0 } else { 0.0 }, Vec::new());
    }
    let mut used = vec![false; estimated.len()];
    let mut errors = Vec::new();
    for &r in reference {
        let mut best: Option<(usize, f64)> = None;
        for (i, &e) in estimated.iter().enumerate() {
            let d = (e - r).abs();
            if !used[i] && d <= TOLERANCE && best.is_none_or(|(_, b)| d < b) {
                best = Some((i, d));
            }
        }
        if let Some((i, d)) = best {
            used[i] = true;
            errors.push(d);
        }
    }
    let hits = errors.len() as f64;
    let precision = hits / estimated.len() as f64;
    let recall = hits / reference.len() as f64;
    let f = if hits == 0.0 { 0.0 } else { 2.0 * precision * recall / (precision + recall) };
    (f, errors)
}

fn median(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return f64::NAN;
    }
    let mut v = xs.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

#[derive(Default)]
struct Totals {
    files: usize,
    beat_f1: f64,
    phases: Vec<f64>,
    downbeat: (f64, usize),
    sections: (usize, usize),
    extra: usize,
}

impl Totals {
    fn add(&mut self, s: &Score) {
        self.files += 1;
        self.beat_f1 += s.beat_f1;
        self.phases.extend(&s.phases);
        if let Some(f) = s.downbeat_f1 {
            self.downbeat.0 += f;
            self.downbeat.1 += 1;
        }
        if let Some((found, of)) = s.sections_found {
            self.sections.0 += found;
            self.sections.1 += of;
            self.extra += s.extra_sections;
        }
    }

    fn report(&self) {
        if self.files == 0 {
            return;
        }
        let verdict = |ok: bool| if ok { "PASS" } else { "FAIL" };
        let beat = self.beat_f1 / self.files as f64;
        let phase = median(&self.phases) * 1000.0;
        println!("\n{} recordings", self.files);
        println!("beat F1 (mean)        {beat:.3}   ≥ {BEAT_F1}   {}", verdict(beat >= BEAT_F1));
        println!("phase error (median)  {phase:.1} ms ≤ {PHASE_MS} ms {}", verdict(phase <= PHASE_MS));
        if self.downbeat.1 > 0 {
            let down = self.downbeat.0 / self.downbeat.1 as f64;
            println!("downbeat F1 (mean)    {down:.3}   ≥ {DOWNBEAT_F1}    {}", verdict(down >= DOWNBEAT_F1));
        } else {
            println!("downbeat F1           – (no beat positions annotated)");
        }
        if self.sections.1 > 0 {
            let found = self.sections.0 as f64 / self.sections.1 as f64;
            println!(
                "sections ±1 bar       {}/{} = {:.0}% ≥ {:.0}% {} ({} extra)",
                self.sections.0,
                self.sections.1,
                found * 100.0,
                SECTIONS_FOUND * 100.0,
                verdict(found >= SECTIONS_FOUND),
                self.extra
            );
        } else {
            println!("sections              – (no .sections files)");
        }
    }
}

/// `time [number]` per line; `#` comments and labels other than numbers are allowed (`end` lines are skipped).
fn read_annotations(path: &Path) -> Option<Vec<(f64, Option<u32>)>> {
    let text = fs::read_to_string(path).ok()?;
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split(|c: char| c.is_whitespace() || c == ',');
        let Some(Ok(time)) = parts.next().map(str::parse::<f64>) else { continue };
        let rest = parts.find(|p| !p.is_empty());
        if rest.is_some_and(|r| r.eq_ignore_ascii_case("end")) {
            continue;
        }
        // Positions may be written as 1 or 1.1 (bar.beat): the part after the dot is the beat.
        let position = rest.and_then(|r| r.rsplit('.').next()).and_then(|p| p.parse::<u32>().ok());
        if time > 0.0 || path.extension().is_some_and(|x| x == "beats") {
            out.push((time, position));
        }
    }
    out.sort_by(|a, b| a.0.total_cmp(&b.0));
    Some(out)
}

/// Minimal RIFF/WAVE reader: PCM 16/24/32-bit integer and 32-bit float, interleaved.
fn read_wav(path: &Path) -> Result<(f32, usize, Vec<f32>), String> {
    let data = fs::read(path).map_err(|e| e.to_string())?;
    if data.len() < 12 || &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }
    let u16_at = |i: usize| u16::from_le_bytes([data[i], data[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
    let mut at = 12;
    let mut format = None;
    while at + 8 <= data.len() {
        let id = &data[at..at + 4];
        let size = u32_at(at + 4) as usize;
        let body = at + 8;
        let end = (body + size).min(data.len());
        if id == b"fmt " {
            let mut tag = u16_at(body);
            if tag == 0xFFFE && size >= 26 {
                tag = u16_at(body + 24);
            }
            format = Some((tag, u16_at(body + 2) as usize, u32_at(body + 4) as f32, u16_at(body + 14)));
        } else if id == b"data" {
            let (tag, channels, rate, bits) = format.ok_or("data before fmt")?;
            let bytes = &data[body..end];
            let samples: Vec<f32> = match (tag, bits) {
                (1, 16) => bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect(),
                (1, 24) => bytes
                    .chunks_exact(3)
                    .map(|b| (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0)
                    .collect(),
                (1, 32) => bytes
                    .chunks_exact(4)
                    .map(|b| i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0)
                    .collect(),
                (3, 32) => bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect(),
                _ => return Err(format!("unsupported format {tag}, {bits} bits")),
            };
            return Ok((rate, channels.max(1), samples));
        }
        at = body + size + (size & 1);
    }
    Err("no data chunk".into())
}

mod synth {
    //! A small synthetic corpus with exact annotations, to check the tool itself.
    use std::f32::consts::TAU;
    use std::fs;
    use std::path::Path;

    const SR: u32 = 44_100;

    fn noise(i: usize) -> f32 {
        let mut h = (i as u32).wrapping_mul(0x9E37_79B9) ^ 0x85EB_CA6B;
        h ^= h >> 15;
        h = h.wrapping_mul(0x2C1B_3C6D);
        h ^= h >> 12;
        h as f32 / u32::MAX as f32 * 2.0 - 1.0
    }

    /// Sections of 16 bars: intro (soft kicks, hats, pad), build (kicks, hats), drop (kicks, bass, hats, loud), break (pad only: no beat to hear).
    fn track(bpm: f32, seconds_offset: f32) -> (Vec<f32>, Vec<(f32, u32)>, Vec<(f32, &'static str)>) {
        let beat = 60.0 / bpm;
        let kinds = ["intro", "build", "drop", "break", "drop"];
        let bars_per_section = 16;
        let beats_total = kinds.len() * bars_per_section * 4;
        let length = seconds_offset + beats_total as f32 * beat + 1.0;
        let n = (length * SR as f32) as usize;
        let mut out = vec![0.0f32; n];
        for (i, s) in out.iter_mut().enumerate() {
            let t = i as f32 / SR as f32 - seconds_offset;
            if t < 0.0 {
                continue;
            }
            let beats = t / beat;
            let section = ((beats / 4.0) as usize / bars_per_section).min(kinds.len() - 1);
            let kind = kinds[section];
            let pos = beats.fract() * beat;
            let off = (beats + 0.5).fract() * beat;
            // The bar is marked like in real music: an accented first kick and a bass note per bar.
            let accent = if (beats as usize) % 4 == 0 { 1.0 } else { 0.6 };
            let kick = (TAU * (50.0 + 100.0 * (-pos * 30.0).exp()) * pos).sin() * (-pos * 9.0).exp() * accent;
            let hat = noise(i) * (-off * 60.0).exp();
            let pad = 0.05 * ((TAU * 220.0 * t).sin() + (TAU * 330.0 * t).sin());
            let root = [55.0, 49.0, 41.2, 43.65][(beats as usize / 4) % 4];
            let bass = (TAU * root * t).sin() * 0.3;
            *s = match kind {
                "intro" => kick * 0.3 + hat * 0.15 + pad,
                "build" => kick * 0.6 + hat * 0.2 + pad,
                "drop" => kick * 0.8 + bass + hat * 0.25 + pad * 0.5,
                _ => pad * 1.5,
            };
        }
        let beats: Vec<(f32, u32)> =
            (0..beats_total).map(|b| (seconds_offset + b as f32 * beat, (b % 4) as u32 + 1)).collect();
        let sections = kinds
            .iter()
            .enumerate()
            .map(|(k, &kind)| (seconds_offset + (k * bars_per_section * 4) as f32 * beat, kind))
            .collect();
        (out, beats, sections)
    }

    pub fn write(dir: &Path) {
        fs::create_dir_all(dir).expect("create corpus dir");
        for (name, bpm, offset) in [("synth-124", 124.0, 0.3), ("synth-174", 174.0, 0.05), ("synth-100", 100.0, 0.7)] {
            let (audio, beats, sections) = track(bpm, offset);
            let mut wav = Vec::with_capacity(44 + audio.len() * 2);
            let data = (audio.len() * 2) as u32;
            wav.extend_from_slice(b"RIFF");
            wav.extend_from_slice(&(36 + data).to_le_bytes());
            wav.extend_from_slice(b"WAVEfmt ");
            for v in [16u32, (1u32) | (1 << 16), SR, SR * 2, 2 | (16 << 16)] {
                wav.extend_from_slice(&v.to_le_bytes());
            }
            wav.extend_from_slice(b"data");
            wav.extend_from_slice(&data.to_le_bytes());
            for s in audio {
                wav.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
            }
            fs::write(dir.join(format!("{name}.wav")), wav).expect("write wav");
            let beats: String = beats.iter().map(|(t, p)| format!("{t:.4}\t{p}\n")).collect();
            fs::write(dir.join(format!("{name}.beats")), beats).expect("write beats");
            let sections: String = sections.iter().map(|(t, k)| format!("{t:.4}\t{k}\n")).collect();
            fs::write(dir.join(format!("{name}.sections")), sections).expect("write sections");
        }
    }
}
