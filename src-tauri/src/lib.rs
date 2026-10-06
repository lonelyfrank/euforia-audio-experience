//! Desktop shell: exposes the native audio capture to the web frontend.
//! No analysis happens here; PCM is streamed as-is (mono f32) to the webview.

mod audio;

pub fn run() {
    tauri::Builder::default()
        .manage(audio::AudioState::default())
        .invoke_handler(tauri::generate_handler![audio::start_audio_capture, audio::stop_audio_capture])
        .run(tauri::generate_context!())
        .expect("error while running Euforia-Audio-Experience");
}
