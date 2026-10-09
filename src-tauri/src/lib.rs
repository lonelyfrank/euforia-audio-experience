//! Desktop shell: captures audio natively, analyses it on the capture thread
//! (`spectrum-analysis`: the music and what the scenes draw) and streams the
//! records to the web frontend. No PCM crosses the boundary.

mod audio;

pub fn run() {
    tauri::Builder::default()
        .manage(audio::AudioState::default())
        .invoke_handler(tauri::generate_handler![audio::start_audio_capture, audio::stop_audio_capture, audio::set_scene_settings])
        .run(tauri::generate_context!())
        .expect("error while running Euforia-Audio-Experience");
}
