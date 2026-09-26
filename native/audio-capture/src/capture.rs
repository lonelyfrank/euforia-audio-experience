use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{Data, ErrorKind, FromSample, SampleFormat, StreamConfig};

use crate::{platform, CaptureError, CaptureInfo, CaptureSource};

/// Chunks buffered between the audio callback and the delivery thread
/// (~10 ms each on WASAPI). If the consumer stalls, newest chunks are dropped
/// rather than blocking the audio thread.
const QUEUE_CHUNKS: usize = 64;
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// A running capture. Dropping it (or calling [`Capture::stop`]) stops the
/// stream and joins the worker thread.
pub struct Capture {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Capture {
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Starts capturing `source` on a dedicated thread.
///
/// - `on_samples` receives mono `f32` samples (-1..1), batched, on the worker thread.
/// - `on_error` is called for asynchronous stream failures (e.g. device unplugged).
///
/// The cpal stream is created and owned by the worker thread because streams
/// are not `Send` on every platform.
pub fn start<S, E>(
    source: CaptureSource,
    device_id: Option<&str>,
    mut on_samples: S,
    on_error: E,
) -> Result<(Capture, CaptureInfo), CaptureError>
where
    S: FnMut(&[f32]) + Send + 'static,
    E: Fn(String) + Send + Sync + 'static,
{
    let device_id = device_id.map(str::to_owned);
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::channel::<Result<CaptureInfo, CaptureError>>();
    let stop_worker = Arc::clone(&stop);

    let worker = thread::Builder::new()
        .name("audio-capture".into())
        .spawn(move || {
            let (chunk_tx, chunk_rx) = mpsc::sync_channel::<Vec<f32>>(QUEUE_CHUNKS);
            let stream = match open_stream(source, device_id.as_deref(), chunk_tx, on_error) {
                Ok((stream, info)) => {
                    let _ = ready_tx.send(Ok(info));
                    stream
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };

            let mut batch = Vec::with_capacity(4096);
            while !stop_worker.load(Ordering::Acquire) {
                match chunk_rx.recv_timeout(POLL_INTERVAL) {
                    Ok(chunk) => {
                        batch.clear();
                        batch.extend_from_slice(&chunk);
                        // Coalesce whatever else is queued into one delivery.
                        while let Ok(more) = chunk_rx.try_recv() {
                            batch.extend_from_slice(&more);
                        }
                        on_samples(&batch);
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            drop(stream);
        })
        .map_err(|_| CaptureError::ThreadFailed)?;

    let capture = Capture { stop, worker: Some(worker) };
    match ready_rx.recv() {
        Ok(Ok(info)) => Ok((capture, info)),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(CaptureError::ThreadFailed),
    }
}

fn open_stream<E>(
    source: CaptureSource,
    device_id: Option<&str>,
    chunk_tx: SyncSender<Vec<f32>>,
    on_error: E,
) -> Result<(cpal::Stream, CaptureInfo), CaptureError>
where
    E: Fn(String) + Send + Sync + 'static,
{
    let device = platform::open_device(source, device_id)?;
    let supported = platform::stream_config(&device, source)?;
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.config();
    let channels = usize::from(config.channels.max(1));
    let info =
        CaptureInfo { sample_rate: config.sample_rate, channels: config.channels, device_name: device.to_string() };

    let data_callback = move |data: &Data, _: &cpal::InputCallbackInfo| {
        let mono = match sample_format {
            SampleFormat::F32 => downmix::<f32>(data, channels),
            SampleFormat::I16 => downmix::<i16>(data, channels),
            SampleFormat::I32 => downmix::<i32>(data, channels),
            SampleFormat::U16 => downmix::<u16>(data, channels),
            SampleFormat::U8 => downmix::<u8>(data, channels),
            SampleFormat::F64 => downmix::<f64>(data, channels),
            _ => None,
        };
        if let Some(mono) = mono {
            // Never block the audio thread: if the queue is full (or the worker
            // is shutting down) the chunk is dropped.
            let _ = chunk_tx.try_send(mono);
        }
    };
    let error_callback = move |error: cpal::Error| {
        // Rerouting to a new default device is handled by cpal transparently.
        if error.kind() != ErrorKind::DeviceChanged {
            on_error(error.to_string());
        }
    };

    let stream = device.build_input_stream_raw(config, sample_format, data_callback, error_callback, None)?;
    stream.play()?;
    Ok((stream, info))
}

/// Averages interleaved channels into mono f32.
fn downmix<T>(data: &Data, channels: usize) -> Option<Vec<f32>>
where
    T: cpal::SizedSample,
    f32: FromSample<T>,
{
    let samples = data.as_slice::<T>()?;
    let scale = 1.0 / channels as f32;
    Some(
        samples
            .chunks_exact(channels)
            .map(|frame| frame.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() * scale)
            .collect(),
    )
}
