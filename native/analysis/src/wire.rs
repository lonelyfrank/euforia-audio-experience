//! A flat encoding of the event stream for hosts across a boundary (Tauri
//! IPC, WebAssembly memory): each event is a record of f64 values starting
//! with a tag. Frames follow `FeatureFrame::LAYOUT`, scene frames
//! `SceneFrame::LAYOUT`; onsets and beats have fixed small layouts.
//! `typescript_layout` renders the matching decoder constants for the
//! frontend, kept in sync by a test.

use crate::{BeatEvent, Event, FeatureFrame, OnsetEvent, SceneFrame, SectionEvent, HOP};

/// Version of this encoding. A host and a decoder built from different versions must not talk:
/// bump it whenever a tag, a record size or a layout changes.
pub const VERSION: u32 = 2;

pub const TAG_FRAME: f64 = 1.0;
pub const TAG_ONSET: f64 = 2.0;
pub const TAG_BEAT: f64 = 3.0;
/// Clock record (sent by hosts, not produced by the analyzer), the last record of every batch: the
/// capture clock at its end, how old its newest sample was when sent, and the host's own account
/// of the transport (see `Clock`).
pub const TAG_CLOCK: f64 = 4.0;
pub const TAG_SECTION: f64 = 5.0;
/// The scenes' graphic analysis, every few hops, right after the frame of its hop.
pub const TAG_SCENE: f64 = 6.0;

pub const ONSET_LAYOUT: &[(&str, usize)] = &[("sample", 1), ("time", 1), ("strength", 1), ("region", 1), ("low", 1)];
pub const BEAT_LAYOUT: &[(&str, usize)] = &[
    ("sample", 1),
    ("time", 1),
    ("index", 1),
    ("bar_position", 1),
    ("downbeat", 1),
    ("bpm", 1),
    ("confidence", 1),
    ("downbeat_confidence", 1),
];

pub const CLOCK_LAYOUT: &[(&str, usize)] =
    &[("sample", 1), ("age", 1), ("sequence", 1), ("epoch", 1), ("lost", 1), ("load", 1), ("quality", 1)];
pub const SECTION_LAYOUT: &[(&str, usize)] =
    &[("sample", 1), ("time", 1), ("kind", 1), ("previous", 1), ("id", 1), ("bar", 1), ("confidence", 1), ("novelty", 1)];

/// Values in a record (tag included) for each event kind.
pub const FRAME_RECORD: usize = 1 + FeatureFrame::SIZE;
pub const ONSET_RECORD: usize = 1 + ONSET_LAYOUT.len();
pub const BEAT_RECORD: usize = 1 + BEAT_LAYOUT.len();
pub const CLOCK_RECORD: usize = 1 + CLOCK_LAYOUT.len();
pub const SECTION_RECORD: usize = 1 + SECTION_LAYOUT.len();
pub const SCENE_RECORD: usize = 1 + SceneFrame::SIZE;
/// The largest record.
pub const MAX_RECORD: usize = if SCENE_RECORD > FRAME_RECORD { SCENE_RECORD } else { FRAME_RECORD };

/// Writes `event` at the start of `out` (at least `MAX_RECORD` long); returns the values written.
pub fn encode(event: &Event, out: &mut [f64]) -> usize {
    match event {
        Event::Frame(frame) => {
            out[0] = TAG_FRAME;
            frame.export(&mut out[1..FRAME_RECORD]);
            FRAME_RECORD
        }
        Event::Onset(OnsetEvent { sample, time, strength, region, low }) => {
            out[..ONSET_RECORD].copy_from_slice(&[TAG_ONSET, *sample as f64, *time, f64::from(*strength), f64::from(*region), f64::from(*low)]);
            ONSET_RECORD
        }
        Event::Beat(BeatEvent { sample, time, index, bar_position, downbeat, bpm, confidence, downbeat_confidence }) => {
            out[..BEAT_RECORD].copy_from_slice(&[
                TAG_BEAT,
                *sample as f64,
                *time,
                *index as f64,
                f64::from(*bar_position),
                if *downbeat { 1.0 } else { 0.0 },
                f64::from(*bpm),
                f64::from(*confidence),
                f64::from(*downbeat_confidence),
            ]);
            BEAT_RECORD
        }
        Event::Section(SectionEvent { sample, time, kind, previous, id, bar, confidence, novelty }) => {
            out[..SECTION_RECORD].copy_from_slice(&[
                TAG_SECTION,
                *sample as f64,
                *time,
                f64::from(*kind as u8),
                f64::from(*previous as u8),
                f64::from(*id),
                *bar as f64,
                f64::from(*confidence),
                f64::from(*novelty),
            ]);
            SECTION_RECORD
        }
        Event::Scene(scene) => {
            out[0] = TAG_SCENE;
            scene.export(&mut out[1..SCENE_RECORD]);
            SCENE_RECORD
        }
    }
}

/// What a host says with each batch it sends.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Clock {
    /// Capture clock: frames analysed so far.
    pub sample: u64,
    /// Seconds since the newest of them was captured.
    pub age: f64,
    /// Batches sent before this one: a receiver that sees a hole knows a batch never arrived.
    pub sequence: u64,
    /// Times the analysis restarted after losing audio for too long: the capture clock started over each time,
    /// and nothing of an older epoch may be mixed with the new one.
    pub epoch: u32,
    /// Frames the capture lost so far (analysed as silence, or restarted over).
    pub lost: u64,
    /// DSP work / audio time, smoothed (0.1 = 10 % of one core), and the DSP quality level it led to.
    pub load: f64,
    pub quality: u8,
}

/// Writes a clock record.
pub fn encode_clock(clock: &Clock, out: &mut [f64]) -> usize {
    let Clock { sample, age, sequence, epoch, lost, load, quality } = *clock;
    out[..CLOCK_RECORD].copy_from_slice(&[
        TAG_CLOCK,
        sample as f64,
        age,
        sequence as f64,
        f64::from(epoch),
        lost as f64,
        load,
        f64::from(quality),
    ]);
    CLOCK_RECORD
}

/// Appends `records` to `bytes` as little-endian f64: what goes on the wire.
pub fn to_bytes(records: &[f64], bytes: &mut Vec<u8>) {
    bytes.reserve(records.len() * 8);
    for value in records {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
}

/// TypeScript constants describing the records (generated; see the `wire` test).
pub fn typescript_layout() -> String {
    let fields = |layout: &[(&str, usize)]| -> String {
        let mut offset = 1;
        let mut out = String::new();
        for (name, len) in layout {
            out.push_str(&format!("  {}: [{offset}, {len}],\n", camel(name)));
            offset += len;
        }
        out
    };
    format!(
        "// Generated by native/analysis (wire.rs) — do not edit. Regenerate with\n\
         // `UPDATE_LAYOUT=1 cargo test -p spectrum-analysis --test wire`.\n\
         \n\
         /** Version of the encoding: the WASM module and the native backend report theirs, and it must be this one. */\n\
         export const WIRE_VERSION = {VERSION};\n\
         \n\
         /** Samples between two hop frames. */\n\
         export const HOP = {HOP};\n\
         \n\
         /** Record tags of the analysis event stream. */\n\
         export const TAG = {{ frame: {TAG_FRAME}, onset: {TAG_ONSET}, beat: {TAG_BEAT}, clock: {TAG_CLOCK}, section: {TAG_SECTION}, scene: {TAG_SCENE} }} as const;\n\
         \n\
         export const RECORD = {{ frame: {FRAME_RECORD}, onset: {ONSET_RECORD}, beat: {BEAT_RECORD}, clock: {CLOCK_RECORD}, section: {SECTION_RECORD}, scene: {SCENE_RECORD} }} as const;\n\
         \n\
         /** Field name → [offset in the record, length]. */\n\
         export const FRAME_FIELDS = {{\n{}}} as const;\n\
         \n\
         export const ONSET_FIELDS = {{\n{}}} as const;\n\
         \n\
         export const BEAT_FIELDS = {{\n{}}} as const;\n\
         \n\
         export const CLOCK_FIELDS = {{\n{}}} as const;\n\
         \n\
         export const SECTION_FIELDS = {{\n{}}} as const;\n\
         \n\
         /** The scenes' graphic analysis (see SceneFrame in Rust). */\n\
         export const SCENE_FIELDS = {{\n{}}} as const;\n",
        fields(FeatureFrame::LAYOUT),
        fields(ONSET_LAYOUT),
        fields(BEAT_LAYOUT),
        fields(CLOCK_LAYOUT),
        fields(SECTION_LAYOUT),
        fields(SceneFrame::LAYOUT),
    )
}

fn camel(name: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in name.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}
