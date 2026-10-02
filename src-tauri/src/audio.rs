use std::sync::Mutex;

use audio_capture::{Batch, Capture, CaptureSource};
use spectrum_analysis::wire::{self, FRAME_RECORD, MAX_RECORD};
use spectrum_analysis::{Analyzer, Event};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

/// Event emitted when a running capture fails (device unplugged, ...).
const ERROR_EVENT: &str = "audio-capture-error";

#[derive(Default)]
pub struct AudioState {
    capture: Mutex<Option<Capture>>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfoDto {
    sample_rate: u32,
    channels: u16,
    device_name: String,
}

/// Longest stretch of lost frames filled with silence for the analysis (s); beyond it the analysis restarts.
const MAX_GAP_FILL: f32 = 1.0;

/// Starts capturing the default device of `source`. Any previous capture is stopped first.
///
/// - `on_samples`: mono PCM for the scenes, raw little-endian f32 bytes.
/// - `on_features`: the analysis event stream (spectrum-analysis, run here on the
///   capture thread), raw little-endian f64 records: every onset and beat of the
///   batch, then its latest frame (see `spectrum_analysis::wire`).
#[tauri::command]
pub async fn start_audio_capture(
    app: AppHandle,
    state: State<'_, AudioState>,
    source: Source,
    on_samples: Channel,
    on_features: Channel,
) -> Result<CaptureInfoDto, String> {
    stop(&state);

    let mut analysis = Analysis::default();
    let mut mono = Vec::new();
    let on_samples = move |batch: Batch| {
        // The webview may be gone during shutdown; nothing useful to do then.
        if let Some(bytes) = analysis.process(&batch) {
            let _ = on_features.send(InvokeResponseBody::Raw(bytes));
        }
        mono.clear();
        let scale = 1.0 / batch.channels as f32;
        mono.extend(batch.samples.chunks_exact(batch.channels).map(|frame| frame.iter().sum::<f32>() * scale));
        let bytes: Vec<u8> = mono.iter().flat_map(|s| s.to_le_bytes()).collect();
        let _ = on_samples.send(InvokeResponseBody::Raw(bytes));
    };
    let on_error = move |message: String| {
        let _ = app.emit(ERROR_EVENT, message);
    };

    let (capture, info) = audio_capture::start(source.into(), None, on_samples, on_error).map_err(|e| e.to_string())?;
    *state.capture.lock().map_err(|e| e.to_string())? = Some(capture);

    Ok(CaptureInfoDto { sample_rate: info.sample_rate, channels: info.channels, device_name: info.device_name })
}

#[tauri::command]
pub async fn stop_audio_capture(state: State<'_, AudioState>) -> Result<(), String> {
    stop(&state);
    Ok(())
}

fn stop(state: &AudioState) {
    // Take the capture out of the lock before joining its thread.
    let capture = state.capture.lock().ok().and_then(|mut guard| guard.take());
    if let Some(capture) = capture {
        capture.stop();
    }
}

/// The analysis of one capture, run on its worker thread.
#[derive(Default)]
struct Analysis {
    analyzer: Option<Analyzer>,
    records: Vec<f64>,
    record: Vec<f64>,
    frame: Vec<f64>,
    silence: Vec<f32>,
}

impl Analysis {
    /// Analyses a batch; returns the encoded records to send (ending with a clock record).
    fn process(&mut self, batch: &Batch) -> Option<Vec<u8>> {
        let channels = batch.channels;
        let rate = batch.sample_rate as f32;
        let analyzer = match &mut self.analyzer {
            Some(a) if a.channels() == channels && a.sample_rate() == rate => a,
            slot => slot.insert(Analyzer::new(rate, channels)),
        };
        if self.record.is_empty() {
            self.record = vec![0.0; MAX_RECORD];
            self.frame = vec![0.0; FRAME_RECORD];
        }
        let Self { records, record, frame, silence, .. } = self;
        records.clear();
        let mut has_frame = false;
        let mut collect = |event: Event| {
            if let Event::Frame(_) = event {
                wire::encode(&event, frame);
                has_frame = true;
            } else {
                let n = wire::encode(&event, record);
                records.extend_from_slice(&record[..n]);
            }
        };
        // Lost frames: silence keeps the capture clock aligned with time; a long loss restarts the analysis.
        if batch.gap > 0 {
            if (batch.gap as f32) < MAX_GAP_FILL * rate {
                silence.resize(4096 * channels, 0.0);
                let mut left = batch.gap as usize * channels;
                while left > 0 {
                    let n = left.min(silence.len());
                    analyzer.push(&silence[..n], &mut collect);
                    left -= n;
                }
            } else {
                analyzer.reset();
            }
        }
        analyzer.push(batch.samples, &mut collect);
        if has_frame {
            records.extend_from_slice(frame);
        }
        // Capture clock at the end of the batch and the age of its newest sample now, for the frontend's clock sync.
        let age = std::time::Instant::now().saturating_duration_since(batch.captured_end()).as_secs_f64();
        let n = wire::encode_clock(analyzer.samples(), age, record);
        records.extend_from_slice(&record[..n]);
        Some(records.iter().flat_map(|v| v.to_le_bytes()).collect())
    }
}
