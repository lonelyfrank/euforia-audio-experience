//! Beat tracking as a phase-locked loop over the onset stream.
//!
//! The tracker keeps a beat period and the time of the next predicted beat.
//! Beats are emitted at their *predicted* time (so hosts can schedule ahead
//! of them), and onsets close to a prediction pull phase and period gently,
//! weighted by their strength (a second-order loop: phase and frequency).
//! Tempo estimates only move the period after they have disagreed with it
//! consistently, and are first folded to the octave closest to the current
//! period, so a fill or a half-time bar does not flip the tempo. The
//! downbeat is the bar position (4/4) where the low-end attacks are
//! strongest. Confidence is the share of recent predicted beats that an
//! onset confirmed, times the tempo estimate's confidence.

use crate::rhythm::{OnsetEvent, MAX_BPM, MIN_BPM};

/// Loop gains per matched onset: phase (fraction of the error) and period.
const PHASE_GAIN: f64 = 0.3;
const PERIOD_GAIN: f64 = 0.04;
/// An onset within this fraction of the period from a prediction is matched to it.
const MATCH_WINDOW: f64 = 0.2;
/// Tempo estimates must disagree with the period by this much (relative) …
const RETEMPO_TOLERANCE: f32 = 0.04;
/// … for this long (s) before the period jumps to them.
const RETEMPO_HOLD: f64 = 2.5;
/// Below this tempo confidence an estimate is ignored.
const MIN_TEMPO_CONFIDENCE: f32 = 0.3;
/// Support: how fast confirmed/unconfirmed predictions move it.
const SUPPORT_GAIN: f32 = 0.2;
const SUPPORT_LOSS: f32 = 0.12;
/// Beats predicted without any support before the tracker lets go.
const MAX_MISSED: u32 = 8;
/// Beats per bar assumed for the downbeat (4/4).
pub const BEATS_PER_BAR: usize = 4;
/// Memory (bars) of the accents per bar position.
const ACCENT_BARS: f32 = 6.0;
/// The downbeat moves only when another position is clearly stronger.
const DOWNBEAT_MARGIN: f32 = 1.25;
/// Off-beat check: memory (matched onsets) of the low-end accents on and between the beats, and
/// how much stronger the off-beats must be (after enough of them) before the grid moves half a beat.
const HALF_MEMORY: f32 = 8.0;
const HALF_MARGIN: f32 = 1.3;
const HALF_MIN_ONSETS: u32 = 4;

/// A beat of the tracked grid.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BeatEvent {
    /// Capture clock of the beat (its predicted time).
    pub sample: u64,
    pub time: f64,
    /// Beats since tracking started.
    pub index: u64,
    /// 0 = downbeat … BEATS_PER_BAR - 1.
    pub bar_position: u8,
    pub downbeat: bool,
    pub bpm: f32,
    /// 0..1: how well the grid matches the onsets right now.
    pub confidence: f32,
    /// 0..1: how clear the downbeat is.
    pub downbeat_confidence: f32,
}

/// Grid readings for the current hop.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BeatReading {
    /// Tracked tempo (BPM), 0 while not tracking.
    pub bpm: f32,
    /// Position in the beat, 0..1 (0 = on the beat).
    pub beat_phase: f32,
    /// Position in the bar, 0..1 (0 = on the downbeat).
    pub bar_phase: f32,
    pub confidence: f32,
    pub downbeat_confidence: f32,
    /// Predicted time (s, capture clock) of the next beat; 0 while not tracking.
    pub next_beat: f64,
}

pub struct BeatTracker {
    period: f64,
    next: f64,
    index: u64,
    tracking: bool,
    support: f32,
    missed: u32,
    matched: bool,
    tempo_confidence: f32,
    pending_since: Option<f64>,
    accents: [f32; BEATS_PER_BAR],
    downbeat: usize,
    /// Low-end accent of onsets on the beats and halfway between them, and how many off-beat ones were seen.
    on_beat: f32,
    off_beat: f32,
    off_beats: u32,
    reading: BeatReading,
}

impl Default for BeatTracker {
    fn default() -> Self {
        Self {
            period: 0.0,
            next: 0.0,
            index: 0,
            tracking: false,
            support: 0.0,
            missed: 0,
            matched: false,
            tempo_confidence: 0.0,
            pending_since: None,
            accents: [0.0; BEATS_PER_BAR],
            downbeat: 0,
            on_beat: 0.0,
            off_beat: 0.0,
            off_beats: 0,
            reading: BeatReading::default(),
        }
    }
}

impl BeatTracker {
    /// A tempo estimate (BPM and confidence) at time `now`.
    pub fn tempo(&mut self, bpm: f32, confidence: f32, now: f64) {
        self.tempo_confidence = confidence;
        if bpm <= 0.0 || confidence < MIN_TEMPO_CONFIDENCE {
            self.pending_since = None;
            return;
        }
        if !self.tracking {
            return;
        }
        let current = (60.0 / self.period) as f32;
        // Fold the estimate to the octave nearest the current tempo.
        let folded = [bpm * 0.5, bpm, bpm * 2.0]
            .into_iter()
            .filter(|b| (MIN_BPM..=MAX_BPM).contains(b))
            .min_by(|a, b| (a / current).ln().abs().total_cmp(&(b / current).ln().abs()))
            .unwrap_or(bpm);
        if (folded / current - 1.0).abs() <= RETEMPO_TOLERANCE {
            self.pending_since = None;
            return;
        }
        let since = *self.pending_since.get_or_insert(now);
        if now - since >= RETEMPO_HOLD {
            // Sustained disagreement: a real tempo change. Keep the phase of the next beat.
            self.period = 60.0 / f64::from(folded);
            self.pending_since = None;
        }
    }

    /// Starts the grid on an onset when a trusted tempo is known.
    fn start(&mut self, bpm: f32, onset: &OnsetEvent, low_level: f32) {
        self.period = 60.0 / f64::from(bpm);
        self.next = onset.time + self.period;
        self.tracking = true;
        self.support = 0.0;
        self.missed = 0;
        self.matched = true;
        self.index = 0;
        self.accents = [0.0; BEATS_PER_BAR];
        self.downbeat = 0;
        self.on_beat = low_level;
        self.off_beat = 0.0;
        self.off_beats = 0;
        self.accent(0, low_level);
    }

    /// An onset (from the onset detector). `low_level`: low-end amplitude at the
    /// onset (any linear scale; only ratios between beats matter). `bpm`: the latest tempo estimate.
    pub fn onset(&mut self, onset: &OnsetEvent, low_level: f32, bpm: f32) {
        if !self.tracking {
            if bpm > 0.0 && self.tempo_confidence >= MIN_TEMPO_CONFIDENCE {
                self.start(bpm, onset, low_level);
            }
            return;
        }
        // Distance to the nearest predicted beat (the one just emitted or the next).
        let previous = self.next - self.period;
        let (target, beat_index) = if (onset.time - previous).abs() < (onset.time - self.next).abs() {
            (previous, self.index.saturating_sub(1))
        } else {
            (self.next, self.index)
        };
        let error = onset.time - target;
        let decay = (-1.0 / HALF_MEMORY).exp();
        if error.abs() > MATCH_WINDOW * self.period {
            // Halfway between two beats: if the low end hits harder there, the grid sits on the off-beats.
            let half = error.abs() - 0.5 * self.period;
            if half.abs() <= MATCH_WINDOW * self.period {
                self.off_beat = self.off_beat * decay + low_level * (1.0 - decay);
                self.off_beats += 1;
                if self.off_beats >= HALF_MIN_ONSETS && self.off_beat > self.on_beat * HALF_MARGIN {
                    self.next += if error > 0.0 { 0.5 * self.period } else { -0.5 * self.period };
                    std::mem::swap(&mut self.on_beat, &mut self.off_beat);
                    self.off_beats = 0;
                    self.accents = [0.0; BEATS_PER_BAR];
                }
            }
            return;
        }
        self.on_beat = self.on_beat * decay + low_level * (1.0 - decay);
        let weight = f64::from(onset.strength.clamp(0.2, 1.0));
        self.next += PHASE_GAIN * weight * error;
        self.period = (self.period + PERIOD_GAIN * weight * error).clamp(60.0 / f64::from(MAX_BPM), 60.0 / f64::from(MIN_BPM));
        if !self.matched {
            self.matched = true;
            self.support += (1.0 - self.support) * SUPPORT_GAIN;
            self.missed = 0;
        }
        self.accent(beat_index, low_level);
    }

    fn accent(&mut self, beat_index: u64, level: f32) {
        let slot = (beat_index % BEATS_PER_BAR as u64) as usize;
        let decay = (-1.0 / ACCENT_BARS).exp();
        self.accents[slot] = self.accents[slot] * decay + level * (1.0 - decay);
    }

    /// Advances to `now` (s); returns the beat that fell in this hop, if any.
    pub fn hop(&mut self, now: f64, sample_rate: f32) -> Option<BeatEvent> {
        let mut event = None;
        if self.tracking && now >= self.next {
            if !self.matched {
                self.support *= 1.0 - SUPPORT_LOSS;
                self.missed += 1;
            }
            if self.missed > MAX_MISSED {
                *self = Self { tempo_confidence: self.tempo_confidence, ..Self::default() };
                return None;
            }
            self.update_downbeat();
            let position = ((self.index + BEATS_PER_BAR as u64 - self.downbeat as u64) % BEATS_PER_BAR as u64) as u8;
            let sample = (self.next * f64::from(sample_rate)).round() as u64;
            event = Some(BeatEvent {
                sample,
                time: self.next,
                index: self.index,
                bar_position: position,
                downbeat: position == 0,
                bpm: (60.0 / self.period) as f32,
                confidence: self.confidence(),
                downbeat_confidence: self.downbeat_confidence(),
            });
            self.index += 1;
            self.next += self.period;
            self.matched = false;
        }
        let (confidence, downbeat_confidence) = (self.confidence(), self.downbeat_confidence());
        let r = &mut self.reading;
        if self.tracking {
            let phase = (1.0 - (self.next - now) / self.period).clamp(0.0, 1.0) as f32;
            let position = ((self.index + 2 * BEATS_PER_BAR as u64 - 1 - self.downbeat as u64) % BEATS_PER_BAR as u64) as f32;
            r.bpm = (60.0 / self.period) as f32;
            r.beat_phase = phase;
            r.bar_phase = (position + phase) / BEATS_PER_BAR as f32;
            r.next_beat = self.next;
        } else {
            *r = BeatReading::default();
        }
        r.confidence = confidence;
        r.downbeat_confidence = downbeat_confidence;
        event
    }

    pub fn reading(&self) -> BeatReading {
        self.reading
    }

    fn confidence(&self) -> f32 {
        if self.tracking { self.support * self.tempo_confidence.clamp(0.0, 1.0) } else { 0.0 }
    }

    fn update_downbeat(&mut self) {
        let strongest = (0..BEATS_PER_BAR).max_by(|&a, &b| self.accents[a].total_cmp(&self.accents[b])).unwrap_or(0);
        if self.accents[strongest] > self.accents[self.downbeat] * DOWNBEAT_MARGIN {
            self.downbeat = strongest;
        }
    }

    fn downbeat_confidence(&self) -> f32 {
        let top = self.accents[self.downbeat];
        if top <= 1e-4 {
            return 0.0;
        }
        let others = (0..BEATS_PER_BAR).filter(|&i| i != self.downbeat).map(|i| self.accents[i]).fold(0.0f32, f32::max);
        // A downbeat 1.5× stronger than any other position reads as fully clear.
        let ratio = if others > 1e-6 { top / others } else { 2.0 };
        ((ratio - 1.0) / 0.5).clamp(0.0, 1.0) * self.confidence()
    }
}
