use std::sync::Mutex;

use audio_capture::{Capture, CaptureSource};
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

/// Starts capturing the default device of `source`; samples are streamed on `on_samples` as raw little-endian
/// f32 bytes (mono). Any previous capture is stopped first.
#[tauri::command]
pub async fn start_audio_capture(
    app: AppHandle,
    state: State<'_, AudioState>,
    source: Source,
    on_samples: Channel,
) -> Result<CaptureInfoDto, String> {
    stop(&state);

    let on_samples = move |samples: &[f32]| {
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        // The webview may be gone during shutdown; nothing useful to do then.
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
