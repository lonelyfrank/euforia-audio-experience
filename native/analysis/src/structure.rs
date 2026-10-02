//! Live musical structure: bars and phrases, novelty, self-similarity and a
//! section state machine (intro, build, drop, break, outro), from the beat
//! grid and the per-hop features. Everything is decided at beat
//! granularity and stamped on the capture clock:
//!
//! - Features are averaged per beat into a small vector (loudness, spectral
//!   shape relative to the loudness, centroid, flatness, percussive share,
//!   onset density, chroma); bars are the mean of their beats.
//! - A section change is evaluated one beat after a downbeat, on that first
//!   beat against the first beats of the previous bars (the same metric
//!   position, so an accent on the one is not mistaken for novelty), and
//!   stamped at the downbeat: a drop is reported one beat after it lands,
//!   not a bar after.
//! - Phrases (4/8/16 bars, from the genre prior) restart at every section
//!   change; the next phrase boundary is predicted on the grid.
//! - Without a trusted grid, "free" beats every 0.5 s keep the structure
//!   going at low confidence (honest fallback).
//!
//! Section names describe energy shape, not song form: `drop` is a full,
//! loud section with its low end, whatever the genre calls it.

use crate::beat::{BeatEvent, BEATS_PER_BAR};
use crate::frame::{FeatureFrame, BANDS};

/// Feature vector size: level, 8 band shapes, centroid, low percussive share, flatness,
/// percussive share, onset density, 12 chroma, onset strength.
const DIMS: usize = 1 + BANDS + 5 + 12 + 1;
/// Index of the onset strength (mean onset function over the beat: attacks right now, unlike the 2 s density).
const ODF: usize = DIMS - 1;
/// The low end is present when the sub band is within this of the level (dB / 20 units: 16 dB).
const BASS_PRESENT: f32 = -0.8;
/// Beats kept (feature vectors), enough for 16 bars back plus the current one.
const BEAT_HISTORY: usize = BEATS_PER_BAR * 20;
/// Bars a section must last before another change (a build may end sooner into a drop).
const MIN_SECTION_BARS: u32 = 4;
const MIN_BUILD_BARS: u32 = 2;
/// Novelty: a first beat this many deviations above the recent novelty is a boundary.
const NOVELTY_SIGMA: f32 = 2.0;
/// Energy of the song: its loud and quiet references drift by this much per bar (LU).
const REFERENCE_DRIFT: f32 = 0.15;
const MIN_RANGE: f32 = 6.0;
/// Without a grid, a boundary needs a level change this large (dB).
const FREE_JUMP_DB: f32 = 6.0;
/// Whole bars of sound before any section decision (the first ones still carry the fade-in).
const WARMUP_BARS: u32 = 5;
/// Level of a silent beat (dB / 20), and below which the context is not sound yet (dB).
const SILENCE_LEVEL: f32 = -96.0 / 20.0;
const CONTEXT_FLOOR_DB: f32 = -70.0;
/// Free beats when the grid is lost (s).
const FREE_BEAT: f64 = 0.5;
/// Similarity (second bar against second bar: the first still carries the previous
/// section in its smoothed features) at which a section is a return of an earlier one.
const RETURN_SIMILARITY: f32 = 0.5;
/// A change this strong on a beat that is not the one moves the bar onto it (LU, and low-end share).
const REALIGN_UP: f32 = 6.0;
const REALIGN_BASS: f32 = 0.5;
const REALIGN_DOWN: f32 = -8.0;
/// Genre memory (bars).
const GENRE_BARS: f32 = 16.0;

/// Section kinds, as numbers on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum SectionKind {
    Intro = 0,
    Build = 1,
    Drop = 2,
    Break = 3,
    Outro = 4,
}

/// Coarse genre families the priors are kept for.
pub const GENRES: [&str; 6] = ["four-on-the-floor", "drum-and-bass", "hip-hop", "band", "ambient", "acoustic"];

/// A section change, stamped at the downbeat it starts on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SectionEvent {
    pub sample: u64,
    pub time: f64,
    pub kind: SectionKind,
    pub previous: SectionKind,
    /// Sections since the start (0 = the intro).
    pub id: u32,
    /// Bar index of its first bar.
    pub bar: u64,
    /// 0..1: how clear the change is (novelty × grid confidence).
    pub confidence: f32,
    pub novelty: f32,
}

/// Structure readings for the current hop.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StructureReading {
    pub section: u8,
    pub section_id: u32,
    pub section_bars: u32,
    /// Id of an earlier section the current one repeats, or -1 (known after its second bar).
    pub section_return: i32,
    pub bar_index: u64,
    /// Bar within the current phrase (0-based) and the phrase length (bars).
    pub phrase_bar: u32,
    pub phrase_bars: u32,
    /// Predicted capture time (s) of the next phrase boundary; 0 while unknown.
    pub next_phrase_time: f64,
    pub novelty: f32,
    /// Similarity (0..1) of the last bar to the bars 4, 8 and 16 bars before it.
    pub similarity: [f32; 3],
    /// 0..1: in a build, how close the phrase end (the likely drop) is.
    pub drop_expected: f32,
    pub confidence: f32,
    /// Prior weight of each of `GENRES` (sums to 1).
    pub genre: [f32; 6],
}

struct SectionPrint {
    id: u32,
    kind: SectionKind,
    print: [f32; DIMS],
}

pub struct Structure {
    // Accumulation of the current beat (features, and power for its level).
    sum: [f32; DIMS],
    power: f32,
    count: u32,
    /// The current bars are free (no trusted grid): only large jumps count as boundaries.
    free: bool,
    // Beat history.
    beats: Vec<[f32; DIMS]>,
    beat_loudness: Vec<f32>,
    beat_index: u64,
    // Grid.
    last_beat_time: f64,
    period: f64,
    free_next: f64,
    bar_position: u8,
    grid_confidence: f32,
    downbeat_time: f64,
    downbeat_sample: u64,
    // Bars and sections.
    bar_index: u64,
    bars_seen: u64,
    /// Consecutive whole bars with sound: decisions wait for a context made only of them.
    sound_bars: u32,
    section: SectionKind,
    section_id: u32,
    section_bars: u32,
    phrase_origin: u64,
    loud: f32,
    quiet: f32,
    references: bool,
    novelty_mean: f32,
    novelty_dev: f32,
    bar_loudness: Vec<f32>,
    prints: Vec<SectionPrint>,
    pending_outro: bool,
    /// Bar offset applied to the tracker's bar positions (moved by strong changes off the one).
    shift: u8,
    previous_time: f64,
    previous_sample: u64,
    genre: [f32; 6],
    reading: StructureReading,
}

impl Default for Structure {
    fn default() -> Self {
        Self {
            sum: [0.0; DIMS],
            power: 0.0,
            count: 0,
            free: true,
            beats: vec![[0.0; DIMS]; BEAT_HISTORY],
            beat_loudness: vec![0.0; BEAT_HISTORY],
            beat_index: 0,
            last_beat_time: 0.0,
            period: 0.0,
            free_next: 0.0,
            bar_position: 0,
            grid_confidence: 0.0,
            downbeat_time: 0.0,
            downbeat_sample: 0,
            bar_index: 0,
            bars_seen: 0,
            sound_bars: 0,
            section: SectionKind::Intro,
            section_id: 0,
            section_bars: 0,
            phrase_origin: 0,
            loud: 0.0,
            quiet: 0.0,
            references: false,
            novelty_mean: 0.0,
            novelty_dev: 0.1,
            bar_loudness: Vec::with_capacity(64),
            prints: Vec::with_capacity(32),
            pending_outro: false,
            shift: 0,
            previous_time: 0.0,
            previous_sample: 0,
            genre: [1.0 / 6.0; 6],
            reading: StructureReading { genre: [1.0 / 6.0; 6], phrase_bars: 8, section_return: -1, ..Default::default() },
        }
    }
}

impl Structure {
    pub fn reading(&self) -> StructureReading {
        self.reading
    }

    /// Accumulates one hop of features (only while there is sound).
    pub fn hop(&mut self, f: &FeatureFrame, sample_rate: f32) -> Option<SectionEvent> {
        if f.sounding && !f.silent {
            let v = vector(f);
            for (s, x) in self.sum.iter_mut().zip(v) {
                *s += x;
            }
            self.power += band_power(f);
            self.count += 1;
        }
        // Without a trusted grid, free beats keep the structure moving (at low confidence).
        if self.grid_confidence < 0.3 && f.time >= self.free_next {
            self.free_next = f.time + FREE_BEAT;
            let position = ((self.bar_position as usize + 1) % BEATS_PER_BAR) as u8;
            let beat = BeatEvent {
                sample: f.sample,
                time: f.time,
                index: self.beat_index,
                bar_position: position,
                downbeat: position == 0,
                bpm: 120.0,
                confidence: 0.0,
                downbeat_confidence: 0.0,
            };
            return self.beat(&beat, f, sample_rate, true);
        }
        None
    }

    /// A beat of the grid (or a free beat). Returns a section change, if this beat decides one.
    pub fn beat(&mut self, b: &BeatEvent, f: &FeatureFrame, sample_rate: f32, free: bool) -> Option<SectionEvent> {
        if !free {
            self.grid_confidence = b.confidence;
            if self.last_beat_time > 0.0 {
                self.period = b.time - self.last_beat_time;
            }
            self.last_beat_time = b.time;
            self.free_next = b.time + 2.0 * FREE_BEAT;
        } else {
            self.grid_confidence *= 0.9;
        }
        self.free = free;
        let position = ((b.bar_position + self.shift) as usize % BEATS_PER_BAR) as u8;
        self.bar_position = position;
        // Close the beat that just ended.
        let slot = (self.beat_index as usize) % BEAT_HISTORY;
        if self.count > 0 {
            for (d, s) in self.beats[slot].iter_mut().zip(self.sum) {
                *d = s / self.count as f32;
            }
            // The beat's level: its mean power in dB (a mean of dB would favour the quiet moments).
            self.beats[slot][0] = 10.0 * (self.power / self.count as f32).max(1e-10).log10() / 20.0;
        } else {
            // A beat without sound: silence, not the zero vector (which would read as 0 dB).
            self.beats[slot] = [0.0; DIMS];
            self.beats[slot][0] = SILENCE_LEVEL;
        }
        self.beat_loudness[slot] = self.beats[slot][0] * 20.0;
        self.sum = [0.0; DIMS];
        self.power = 0.0;
        self.count = 0;
        self.beat_index += 1;

        let mut event = None;
        if position != 1 && !free && self.sound_bars >= WARMUP_BARS && self.strong_change() {
            // A drop or a cut on a beat that is not the one: the bar actually starts on that beat.
            self.shift = ((1 + BEATS_PER_BAR - b.bar_position as usize) % BEATS_PER_BAR) as u8;
            self.bar_position = 1;
            self.downbeat_time = self.previous_time;
            self.downbeat_sample = self.previous_sample;
            self.close_bar();
            event = self.decide(sample_rate);
        } else if position == 0 {
            self.downbeat_time = b.time;
            self.downbeat_sample = b.sample;
            self.close_bar();
        } else if position == 1 && self.sound_bars >= WARMUP_BARS {
            // One beat into the bar: decide whether a new section started at the downbeat.
            event = self.decide(sample_rate);
        }
        self.previous_time = b.time;
        self.previous_sample = b.sample;
        self.update_reading(f, b.time, self.bar_position, free);
        event
    }

    /// Whether the beat just closed jumps far from the 4 beats before it (energy with the low end, or a cut),
    /// and the jump happens right there (not already on the beat before: that one was the change).
    fn strong_change(&self) -> bool {
        let current = self.beat_index as usize - 1;
        if current < 5 {
            return false;
        }
        let beat = &self.beats[current % BEAT_HISTORY];
        let previous = &self.beats[(current - 1) % BEAT_HISTORY];
        let bass_of = |v: &[f32; DIMS]| v[1] + 0.3 * v[2];
        let (mut loudness, mut bass) = (0.0, 0.0);
        for k in 1..=4 {
            let v = &self.beats[(current - k) % BEAT_HISTORY];
            loudness += v[0] * 20.0 / 4.0;
            bass += bass_of(v) / 4.0;
        }
        let jump = beat[0] * 20.0 - loudness;
        let step = (beat[0] - previous[0]) * 20.0;
        let up = jump >= REALIGN_UP && step >= REALIGN_UP && bass_of(beat) >= bass + REALIGN_BASS;
        let down = jump <= REALIGN_DOWN && step <= REALIGN_DOWN;
        up || down
    }

    fn close_bar(&mut self) {
        self.bar_index += 1;
        self.bars_seen += 1;
        self.section_bars += 1;
        let bar = self.bar_vector(0);
        let loudness = bar[0] * 20.0;
        let sounding = (0..BEATS_PER_BAR).all(|k| (self.beat_index as usize).checked_sub(k + 1).is_some_and(|i| self.beats[i % BEAT_HISTORY][0] * 20.0 > CONTEXT_FLOOR_DB));
        self.sound_bars = if sounding { self.sound_bars + 1 } else { 0 };
        if self.bar_loudness.len() == self.bar_loudness.capacity() {
            self.bar_loudness.remove(0);
        }
        self.bar_loudness.push(loudness);
        if !self.references {
            self.loud = loudness + MIN_RANGE / 2.0;
            self.quiet = loudness - MIN_RANGE / 2.0;
            self.references = true;
        }
        self.loud = loudness.max(self.loud - REFERENCE_DRIFT);
        self.quiet = loudness.min(self.quiet + REFERENCE_DRIFT);
        for (i, back) in [4usize, 8, 16].iter().enumerate() {
            self.reading.similarity[i] = if self.bars_seen > *back as u64 { similarity(&bar, &self.bar_vector(*back), self.novelty_mean) } else { 0.0 };
        }
        self.update_genre();
        // After a section's second bar: is it a return of an earlier section of the same kind?
        if self.section_bars == 2 {
            let scale = self.novelty_mean;
            let kind = self.section;
            self.reading.section_return = self
                .prints
                .iter()
                .filter(|p| p.kind == kind && p.id != self.section_id)
                .map(|p| (p.id, similarity(&bar, &p.print, scale)))
                .filter(|&(_, sim)| sim >= RETURN_SIMILARITY)
                .max_by(|a, b| a.1.total_cmp(&b.1))
                .map_or(-1, |(id, _)| id as i32);
            if self.prints.len() < self.prints.capacity() {
                self.prints.push(SectionPrint { id: self.section_id, kind, print: bar });
            }
        }
        // A slow fade after enough of the song: outro (never during a build).
        if self.section != SectionKind::Outro && self.section != SectionKind::Build && self.bars_seen >= 32 && self.section_bars >= MIN_SECTION_BARS {
            let n = self.bar_loudness.len();
            if n >= 8 {
                let recent = &self.bar_loudness[n - 8..];
                let falling = recent.windows(2).filter(|w| w[1] < w[0] - 0.2).count();
                if falling >= 6 && recent[0] - recent[7] > 4.0 {
                    self.pending_outro = true;
                }
            }
        }
    }

    /// Mean of the 4 beats of the bar `back` bars ago (0 = the bar that just ended).
    fn bar_vector(&self, back: usize) -> [f32; DIMS] {
        let mut out = [0.0; DIMS];
        let end = self.beat_index as usize;
        for k in 0..BEATS_PER_BAR {
            let i = end as isize - 1 - (back * BEATS_PER_BAR + k) as isize;
            if i < 0 {
                continue;
            }
            for (o, x) in out.iter_mut().zip(self.beats[i as usize % BEAT_HISTORY]) {
                *o += x / BEATS_PER_BAR as f32;
            }
        }
        out
    }

    fn decide(&mut self, sample_rate: f32) -> Option<SectionEvent> {
        // The downbeat's beat (just closed) against the first beats of the 4 bars before it.
        let current = self.beat_index as usize - 1;
        let first = self.beats[current % BEAT_HISTORY];
        let mut context = [0.0; DIMS];
        for back in 1..=4 {
            let Some(i) = current.checked_sub(back * BEATS_PER_BAR) else { continue };
            for (c, x) in context.iter_mut().zip(self.beats[i % BEAT_HISTORY]) {
                *c += x / 4.0;
            }
        }
        // The song is only starting (some of the bars before were silence): nothing to compare with yet.
        let silent_context = (1..=4).any(|back| current.checked_sub(back * BEATS_PER_BAR).is_none_or(|i| self.beats[i % BEAT_HISTORY][0] * 20.0 < CONTEXT_FLOOR_DB));
        if silent_context || first[0] * 20.0 < CONTEXT_FLOOR_DB {
            return None;
        }
        let novelty = distance(&first, &context);
        let z = (novelty - self.novelty_mean) / self.novelty_dev.max(0.05);
        self.novelty_mean += (novelty - self.novelty_mean) * 0.15;
        self.novelty_dev += ((novelty - self.novelty_mean).abs() - self.novelty_dev) * 0.15;
        self.reading.novelty = (z / (2.0 * NOVELTY_SIGMA)).clamp(0.0, 1.0);
        // Without a trusted grid the bars are only clock ticks: statistics alone are not enough there.
        let mut boundary = z > NOVELTY_SIGMA && !self.free;

        let range = (self.loud - self.quiet).max(MIN_RANGE);
        let energy = ((first[0] * 20.0 - self.quiet) / range).clamp(0.0, 1.0);
        let context_energy = ((context[0] * 20.0 - self.quiet) / range).clamp(0.0, 1.0);
        // Low end relative to the loudness, mostly the sub band: kick and bass fundamentals live there,
        // while the 60–250 Hz band also catches snare bodies (~190 Hz), which must not read as "the bass is back".
        let bass = first[1] + 0.3 * first[2];
        let context_bass = context[1] + 0.3 * context[2];
        // A jump this large is a boundary whatever the novelty statistics say (they adapt to busy parts).
        // Without a grid, only a large absolute change counts (a pad's slow beating is not a section).
        let level_jump = (first[0] - context[0]).abs() * 20.0;
        if self.free {
            boundary = level_jump >= FREE_JUMP_DB;
        } else if (energy - context_energy).abs() > 0.35 || (bass - context_bass).abs() > 0.35 {
            boundary = true;
        }
        let trend = self.loudness_trend();
        let percussion_up = first[12] > context[12] + 0.05 || first[13] > context[13] + 0.1;
        // The attacks keep coming (the onset function holds against the previous bars' first beats).
        let busy = first[ODF] >= 0.6 * context[ODF] && first[ODF] > 0.05;

        let s = self.section;
        let minimum = if s == SectionKind::Build { MIN_BUILD_BARS } else { MIN_SECTION_BARS };
        let long_enough = self.section_bars >= minimum;
        let electronic = self.genre[0] + self.genre[1];
        let next = if self.pending_outro {
            self.pending_outro = false;
            Some(SectionKind::Outro)
        } else if !long_enough {
            None
        } else {
            match s {
                // The low end coming back with a jump in energy, after a build or a quiet part: a drop.
                SectionKind::Intro | SectionKind::Build | SectionKind::Break
                    if boundary && energy > 0.65 && energy > context_energy + 0.1 && bass > context_bass + 0.2 && bass > BASS_PRESENT =>
                {
                    Some(SectionKind::Drop)
                }
                // The kick and bass drop out while the attacks keep coming (a snare roll takes over): a build starts.
                SectionKind::Intro | SectionKind::Break | SectionKind::Drop
                    if boundary && bass < context_bass - 0.3 && bass < BASS_PRESENT && busy && energy > context_energy - 0.7 =>
                {
                    Some(SectionKind::Build)
                }
                // Energy falls away and the material thins out (or the energy collapses): a break.
                SectionKind::Drop | SectionKind::Build if boundary && ((energy < context_energy - 0.25 && !busy) || energy < context_energy - 0.5) => {
                    Some(SectionKind::Break)
                }
                // From a quiet part, the energy rises without the low end: a build starts.
                SectionKind::Intro | SectionKind::Break if boundary && energy > context_energy + 0.15 && bass < context_bass + 0.2 => Some(SectionKind::Build),
                // Rising for two bars with more attacks or more noise: a build (more eagerly in electronic music).
                SectionKind::Intro | SectionKind::Break | SectionKind::Drop
                    if !self.free && trend > 1.0 - 0.5 * electronic && (percussion_up || first[11] > context[11] + 0.05) && bass <= context_bass + 0.05 =>
                {
                    Some(SectionKind::Build)
                }
                _ => None,
            }
        };
        let kind = next.filter(|&k| k != s)?;
        self.section_id += 1;
        self.reading.section_return = -1;
        let event = SectionEvent {
            sample: self.downbeat_sample,
            time: self.downbeat_time,
            kind,
            previous: s,
            id: self.section_id,
            bar: self.bar_index,
            confidence: (self.reading.novelty.max(0.3) * (0.3 + 0.7 * self.grid_confidence)).clamp(0.0, 1.0),
            novelty: self.reading.novelty,
        };
        let _ = sample_rate;
        self.section = kind;
        self.section_bars = 0;
        self.phrase_origin = self.bar_index;
        Some(event)
    }


    /// Loudness change (LU) between the last two bars and the two before.
    fn loudness_trend(&self) -> f32 {
        let n = self.bar_loudness.len();
        if n < 4 {
            return 0.0;
        }
        let b = &self.bar_loudness;
        (b[n - 1] + b[n - 2] - b[n - 3] - b[n - 4]) / 2.0
    }

    fn update_genre(&mut self) {
        let n = self.bar_loudness.len();
        if n == 0 {
            return;
        }
        let bar = self.bar_vector(0);
        let bpm = if self.period > 0.0 { (60.0 / self.period) as f32 } else { 0.0 };
        let grid = self.grid_confidence;
        // Rhythm evidence comes from the grid and the onset density: the harmonic/percussive share is a
        // share of power, low in any mix with sustained pads or bass, so it says little about the genre.
        let density = bar[13] * 8.0;
        let tonal = 1.0 - bar[11];
        let tri = |x: f32, a: f32, b: f32, c: f32, d: f32| if x <= a || x >= d { 0.0 } else if x < b { (x - a) / (b - a) } else if x <= c { 1.0 } else { (d - x) / (d - c) };
        let evidence = [
            grid * tri(bpm, 110.0, 118.0, 135.0, 145.0) * tri(density, 1.5, 3.0, 8.0, 12.0),
            grid * (tri(bpm, 155.0, 165.0, 180.0, 190.0) + tri(bpm, 78.0, 82.0, 90.0, 95.0) * tri(density, 5.0, 7.0, 15.0, 20.0)).min(1.0),
            grid * tri(bpm, 65.0, 75.0, 100.0, 108.0) * tri(density, 1.0, 2.0, 6.0, 9.0),
            grid * tri(bpm, 90.0, 100.0, 160.0, 175.0) * tri(tonal, 0.2, 0.4, 0.9, 1.0),
            (1.0 - grid) * tri(density, -1.0, 0.0, 1.0, 2.5),
            (1.0 - grid * 0.8) * tri(tonal, 0.5, 0.7, 1.0, 1.1) * tri(density, -1.0, 0.0, 3.0, 5.0),
        ];
        let k = 1.0 - (-1.0 / GENRE_BARS).exp();
        for (g, e) in self.genre.iter_mut().zip(evidence) {
            *g += (e + 0.02 - *g) * k;
        }
        let total: f32 = self.genre.iter().sum();
        for (r, g) in self.reading.genre.iter_mut().zip(self.genre) {
            *r = g / total;
        }
    }

    fn update_reading(&mut self, f: &FeatureFrame, time: f64, position: u8, free: bool) {
        let r = &mut self.reading;
        r.section = self.section as u8;
        r.section_id = self.section_id;
        r.section_bars = self.section_bars;
        r.bar_index = self.bar_index;
        // Phrase length from the prior: electronic music runs in 8-bar phrases (16 in drops), the rest in 4 or 8.
        let electronic = r.genre[0] + r.genre[1];
        r.phrase_bars = if electronic > 0.5 { if self.section == SectionKind::Drop { 16 } else { 8 } } else if r.genre[4] + r.genre[5] > 0.5 { 4 } else { 8 };
        let since = (self.bar_index - self.phrase_origin) as u32;
        r.phrase_bar = since % r.phrase_bars;
        let bars_left = r.phrase_bars - r.phrase_bar;
        r.next_phrase_time = if self.period > 0.0 && !free {
            // From this beat to the end of the bar, then whole bars.
            let beats_left = (BEATS_PER_BAR - 1 - position as usize) as f64 + 1.0 + (bars_left as f64 - 1.0) * BEATS_PER_BAR as f64;
            time + beats_left * self.period
        } else {
            0.0
        };
        r.drop_expected = if self.section == SectionKind::Build { (1.0 - (bars_left as f32 - 1.0) / 4.0).clamp(0.0, 1.0) * self.grid_confidence } else { 0.0 };
        r.confidence = self.grid_confidence * if self.bars_seen >= 4 { 1.0 } else { self.bars_seen as f32 / 4.0 };
        let _ = f;
    }
}

/// The per-hop features the structure compares, scaled to comparable ranges. The level is
/// the instantaneous band power (43 ms window), not the 400 ms momentary loudness, which
/// would smear each beat into the previous one and blur the boundaries.
fn vector(f: &FeatureFrame) -> [f32; DIMS] {
    let mut v = [0.0; DIMS];
    let level = 10.0 * band_power(f).max(1e-10).log10();
    v[0] = level / 20.0;
    // Spectral shape: each band relative to the level (dB / 20).
    for i in 0..BANDS {
        v[1 + i] = ((f.band_db[i] - level) / 20.0).clamp(-3.0, 1.0);
    }
    v[9] = (f.centroid_hz.max(50.0) / 1000.0).log2() / 4.0;
    v[10] = f.percussive_low;
    v[11] = f.flatness;
    v[12] = f.percussive;
    v[13] = f.onset_density / 8.0;
    for c in 0..12 {
        v[14 + c] = f.chroma[c] * 0.3 * f.chroma_confidence;
    }
    v[ODF] = f.onset_strength;
    v
}

/// Total power of the bands (linear).
fn band_power(f: &FeatureFrame) -> f32 {
    f.band_db.iter().map(|db| 10f32.powf(db / 10.0)).sum()
}

fn distance(a: &[f32; DIMS], b: &[f32; DIMS]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum::<f32>().sqrt()
}

/// 1 for identical vectors, falling with their distance relative to `scale`
/// (the song's typical distance between neighbouring bars): self-calibrating.
fn similarity(a: &[f32; DIMS], b: &[f32; DIMS], scale: f32) -> f32 {
    (-distance(a, b) / scale.max(0.1)).exp()
}
