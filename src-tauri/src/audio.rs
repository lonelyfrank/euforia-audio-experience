use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use audio_capture::{Batch, Capture, CaptureSource};
use serde::{Deserialize, Serialize};
use spectrum_analysis::wire::{self, Clock, MAX_RECORD};
use spectrum_analysis::{Analyzer, Event, HOP};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

/// Event emitted when a running capture fails (device unplugged, ...).
const ERROR_EVENT: &str = "audio-capture-error";

pub struct AudioState {
    capture: Mutex<Option<Capture>>,
    /// Outlives the captures: a new one starts with what the frontend last asked for.
    scene: Arc<SceneControl>,
}

impl Default for AudioState {
    fn default() -> Self {
        Self { capture: Mutex::new(None), scene: Arc::new(SceneControl::new(SceneSettings::default())) }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    System,
    Microphone,
}

impl From<Source> for CaptureSource {
    fn from(source: Source) -> Self {
        match source {
            Source::System => CaptureSource::System,
            Source::Microphone => CaptureSource::Microphone,
        }
    }
}

/// The scenes' analysis as the frontend sets it: the user's reactivity and smoothing, and its
/// cadence in hops (0 = about 60 scene frames per second).
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct SceneSettings {
    sensitivity: f64,
    smoothing: f64,
    #[serde(default)]
    every: u32,
}

impl Default for SceneSettings {
    fn default() -> Self {
        Self { sensitivity: 1.0, smoothing: 0.5, every: 0 }
    }
}

/// Scene settings shared with the capture thread, which picks them up at its next batch (lock-free:
/// a setting read halfway through a change is replaced by the next read, a few milliseconds later).
struct SceneControl {
    sensitivity: AtomicU64,
    smoothing: AtomicU64,
    every: AtomicU32,
    version: AtomicU64,
}

impl SceneControl {
    fn new(settings: SceneSettings) -> Self {
        Self {
            sensitivity: AtomicU64::new(settings.sensitivity.to_bits()),
            smoothing: AtomicU64::new(settings.smoothing.to_bits()),
            every: AtomicU32::new(settings.every),
            version: AtomicU64::new(1),
        }
    }

    fn set(&self, settings: SceneSettings) {
        self.sensitivity.store(settings.sensitivity.to_bits(), Ordering::Relaxed);
        self.smoothing.store(settings.smoothing.to_bits(), Ordering::Relaxed);
        self.every.store(settings.every, Ordering::Relaxed);
        self.version.fetch_add(1, Ordering::Release);
    }

    fn get(&self) -> SceneSettings {
        SceneSettings {
            sensitivity: f64::from_bits(self.sensitivity.load(Ordering::Relaxed)),
            smoothing: f64::from_bits(self.smoothing.load(Ordering::Relaxed)),
            every: self.every.load(Ordering::Relaxed),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfoDto {
    sample_rate: u32,
    channels: u16,
    device_name: String,
    /// Version of the record encoding (`wire::VERSION`): the frontend's decoder must be built for it.
    wire_version: u32,
}

/// Longest stretch of lost frames filled with silence for the analysis (s); beyond it the analysis restarts.
const MAX_GAP_FILL: f32 = 1.0;
/// Hops of analysis that may wait for the next message. Batches that carry a scene frame or an event
/// (onset, beat, section) leave at once; the hop frames in between ride with the next one, so the
/// frontend gets about one message per scene frame instead of one per capture callback.
const MAX_HELD_HOPS: usize = 4;
/// DSP work / audio time above which the analysis is overloaded (for 2 s) and lowers its quality (slow
/// feature rates and the scenes' cadence only), and below which it has room again (for 30 s). The
/// same thresholds as the browser's `DspBudget`.
const DSP_HOT: f64 = 0.4;
const DSP_COOL: f64 = 0.2;
/// Seconds of audio after the start that are not evidence of overload (cold caches, a starting device).
const DSP_WARM_UP: f64 = 3.0;

/// Starts capturing the default device of `source`. Any previous capture is stopped first.
///
/// `on_features` receives everything the frontend needs, as raw little-endian f64 records
/// (see `spectrum_analysis::wire`): every hop frame, onset, beat and section of the musical
/// analysis and the scene frames of the graphic one, both run here on the capture thread, in
/// time order, each message ending with a clock record. No PCM crosses the boundary.
#[tauri::command]
pub async fn start_audio_capture(
    app: AppHandle,
    state: State<'_, AudioState>,
    source: Source,
    scene: Option<SceneSettings>,
    on_features: Channel,
) -> Result<CaptureInfoDto, String> {
    stop(&state);
    if let Some(scene) = scene {
        state.scene.set(scene);
    }

    let mut analysis = Analysis::new(Arc::clone(&state.scene));
    let on_samples = move |batch: Batch| {
        // The webview may be gone during shutdown; nothing useful to do then.
        if let Some(bytes) = analysis.process(&batch) {
            let _ = on_features.send(InvokeResponseBody::Raw(bytes));
        }
    };
    let on_error = move |message: String| {
        let _ = app.emit(ERROR_EVENT, message);
    };

    let (capture, info) = audio_capture::start(source.into(), None, on_samples, on_error).map_err(|e| e.to_string())?;
    *state.capture.lock().map_err(|e| e.to_string())? = Some(capture);

    Ok(CaptureInfoDto {
        sample_rate: info.sample_rate,
        channels: info.channels,
        device_name: info.device_name,
        wire_version: wire::VERSION,
    })
}

#[tauri::command]
pub async fn stop_audio_capture(state: State<'_, AudioState>) -> Result<(), String> {
    stop(&state);
    Ok(())
}

/// The scenes' analysis settings; they apply from the capture's next batch, and to the next capture.
#[tauri::command]
pub fn set_scene_settings(state: State<'_, AudioState>, scene: SceneSettings) {
    state.scene.set(scene);
}

fn stop(state: &AudioState) {
    // Take the capture out of the lock before joining its thread.
    let capture = state.capture.lock().ok().and_then(|mut guard| guard.take());
    if let Some(capture) = capture {
        capture.stop();
    }
}

/// The analysis of one capture, run on its worker thread.
struct Analysis {
    analyzer: Option<Analyzer>,
    scene: Arc<SceneControl>,
    scene_version: u64,
    /// Records waiting for the next message, and one being encoded.
    records: Vec<f64>,
    record: Vec<f64>,
    /// Frames analysed since the last message.
    held: usize,
    silence: Vec<f32>,
    cpu_load: f64,
    /// Seconds of audio analysed, above the hot threshold, and below the cool one.
    elapsed: f64,
    hot: f64,
    cool: f64,
    quality: u8,
    /// Messages sent, restarts of the analysis, and frames the capture lost so far.
    sequence: u64,
    epoch: u32,
    lost: u64,
}

impl Analysis {
    fn new(scene: Arc<SceneControl>) -> Self {
        Self {
            analyzer: None,
            scene,
            scene_version: 0,
            records: Vec::new(),
            record: vec![0.0; MAX_RECORD],
            held: 0,
            silence: Vec::new(),
            cpu_load: 0.0,
            elapsed: 0.0,
            hot: 0.0,
            cool: 0.0,
            quality: 0,
            sequence: 0,
            epoch: 0,
            lost: 0,
        }
    }

    /// Analyses a batch; returns a message to send (records ending with a clock record) when one is due.
    fn process(&mut self, batch: &Batch) -> Option<Vec<u8>> {
        let channels = batch.channels;
        let rate = batch.sample_rate as f32;
        let analyzer = match &mut self.analyzer {
            Some(a) if a.channels() == channels && a.sample_rate() == rate => a,
            slot => {
                self.scene_version = 0;
                slot.insert(Analyzer::new(rate, channels))
            }
        };
        let version = self.scene.version.load(Ordering::Acquire);
        if version != self.scene_version {
            self.scene_version = version;
            let SceneSettings { sensitivity, smoothing, every } = self.scene.get();
            analyzer.set_scene(sensitivity, smoothing, every);
        }
        // What is shown or cued the moment it is known leaves with this batch.
        let mut urgent = false;
        // Lost frames: silence keeps the capture clock aligned with time; a long loss restarts the analysis.
        if batch.gap > 0 {
            self.lost += batch.gap;
            if (batch.gap as f32) < MAX_GAP_FILL * rate {
                self.silence.resize(4096 * channels, 0.0);
                let mut collect = sink(&mut self.records, &mut self.record, &mut urgent);
                let mut left = batch.gap as usize * channels;
                while left > 0 {
                    let n = left.min(self.silence.len());
                    analyzer.push(&self.silence[..n], &mut collect);
                    left -= n;
                }
            } else {
                analyzer.reset();
                // Nothing analysed before the restart may follow it: the capture clock starts over.
                self.records.clear();
                self.epoch += 1;
                urgent = true;
            }
        }
        let started = std::time::Instant::now();
        analyzer.push(batch.samples, sink(&mut self.records, &mut self.record, &mut urgent));
        let frames = batch.samples.len() / channels;
        let seconds = frames as f64 / rate as f64;
        if seconds > 0.0 {
            let cost = (started.elapsed().as_secs_f64() / seconds).min(4.0);
            self.cpu_load += (cost - self.cpu_load) * (1.0 - (-seconds).exp());
            self.elapsed += seconds;
            self.hot = if self.cpu_load > DSP_HOT && self.elapsed > DSP_WARM_UP { self.hot + seconds } else { 0.0 };
            self.cool = if self.cpu_load < DSP_COOL { self.cool + seconds } else { 0.0 };
            if self.hot > 2.0 && self.quality < 2 {
                self.quality += 1;
                self.hot = 0.0;
                self.cool = 0.0;
            }
            if self.cool > 30.0 && self.quality > 0 {
                self.quality -= 1;
                self.hot = 0.0;
                self.cool = 0.0;
            }
            analyzer.set_quality(self.quality);
        }
        self.held += frames;
        if !urgent && self.held < MAX_HELD_HOPS * HOP {
            return None;
        }
        self.held = 0;
        // Capture clock at the end of the batch and the age of its newest sample now, for the frontend's clock sync.
        let age = std::time::Instant::now().saturating_duration_since(batch.captured_end()).as_secs_f64();
        let clock = Clock {
            sample: analyzer.samples(),
            age,
            sequence: self.sequence,
            epoch: self.epoch,
            lost: self.lost,
            load: self.cpu_load,
            quality: self.quality,
        };
        self.sequence += 1;
        let n = wire::encode_clock(&clock, &mut self.record);
        self.records.extend_from_slice(&self.record[..n]);
        let mut bytes = Vec::new();
        wire::to_bytes(&self.records, &mut bytes);
        self.records.clear();
        Some(bytes)
    }
}

/// Appends each event to `records` (encoded through `record`); anything but a plain hop frame makes the batch `urgent`.
fn sink<'a>(records: &'a mut Vec<f64>, record: &'a mut [f64], urgent: &'a mut bool) -> impl FnMut(Event) + 'a {
    move |event| {
        *urgent |= !matches!(event, Event::Frame(_));
        let n = wire::encode(&event, record);
        records.extend_from_slice(&record[..n]);
    }
}
