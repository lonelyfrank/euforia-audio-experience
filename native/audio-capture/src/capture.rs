use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{Data, ErrorKind, FromSample, SampleFormat, StreamConfig, StreamInstant};

use crate::{platform, CaptureError, CaptureInfo, CaptureSource};

/// Chunks buffered between the audio callback and the delivery thread
/// (~10 ms each on WASAPI). If the consumer stalls, newest chunks are dropped
/// rather than blocking the audio thread; the frame counter keeps running,
/// so the loss shows up as a `gap` in the next batch.
const QUEUE_CHUNKS: usize = 64;
const POLL_INTERVAL: Duration = Duration::from_millis(50);
/// Samples a recycled chunk buffer starts with (grows once if a callback is larger).
const CHUNK_CAPACITY: usize = 8192;

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

/// Interleaved samples as captured, with their position on the capture clock.
#[derive(Debug)]
pub struct Batch<'a> {
    /// Interleaved `f32` samples (-1..1), `channels` per frame.
    pub samples: &'a [f32],
    pub channels: usize,
    pub sample_rate: u32,
    /// Index of the first frame of this batch since the capture started.
    pub first_frame: u64,
    /// Frames lost just before this batch (the consumer stalled); 0 normally.
    pub gap: u64,
    /// Capture time of the first frame, relative to the first callback (backend clock), when reported.
    pub capture_time: Option<Duration>,
}

/// One callback's worth of samples, travelling from the audio thread to the worker.
struct Chunk {
    data: Vec<f32>,
    first_frame: u64,
    capture_time: Option<Duration>,
}

/// Starts capturing `source` on a dedicated thread.
///
/// - `on_samples` receives interleaved batches (see [`Batch`]) on the worker thread.
/// - `on_error` is called for asynchronous stream failures (e.g. device unplugged).
///
/// The cpal stream is created and owned by the worker thread because streams
/// are not `Send` on every platform. The audio callback does not allocate in
/// steady state: chunk buffers go back to it through a return queue.
pub fn start<S, E>(
    source: CaptureSource,
    device_id: Option<&str>,
    mut on_samples: S,
    on_error: E,
) -> Result<(Capture, CaptureInfo), CaptureError>
where
    S: FnMut(Batch) + Send + 'static,
    E: Fn(String) + Send + Sync + 'static,
{
    let device_id = device_id.map(str::to_owned);
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::channel::<Result<CaptureInfo, CaptureError>>();
    let stop_worker = Arc::clone(&stop);

    let worker = thread::Builder::new()
        .name("audio-capture".into())
        .spawn(move || {
            let (chunk_tx, chunk_rx) = mpsc::sync_channel::<Chunk>(QUEUE_CHUNKS);
            let (spare_tx, spare_rx) = mpsc::sync_channel::<Vec<f32>>(QUEUE_CHUNKS + 4);
            for _ in 0..8 {
                let _ = spare_tx.try_send(Vec::with_capacity(CHUNK_CAPACITY));
            }
            let (stream, info) = match open_stream(source, device_id.as_deref(), chunk_tx, spare_rx, on_error) {
                Ok((stream, info)) => {
                    let _ = ready_tx.send(Ok(info.clone()));
                    (stream, info)
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            let channels = usize::from(info.channels.max(1));
            let mut batch: Vec<f32> = Vec::with_capacity(CHUNK_CAPACITY * 4);
            let mut next_frame = 0u64;
            while !stop_worker.load(Ordering::Acquire) {
                match chunk_rx.recv_timeout(POLL_INTERVAL) {
                    Ok(chunk) => {
                        // Coalesce whatever else is queued and contiguous into one delivery.
                        let first = chunk.first_frame;
                        let capture_time = chunk.capture_time;
                        let gap = first.saturating_sub(next_frame);
                        batch.clear();
                        batch.extend_from_slice(&chunk.data);
                        let mut end = first + (chunk.data.len() / channels) as u64;
                        let _ = spare_tx.try_send(chunk.data);
                        let mut pending = None;
                        while let Ok(more) = chunk_rx.try_recv() {
                            if more.first_frame != end {
                                pending = Some(more);
                                break;
                            }
                            batch.extend_from_slice(&more.data);
                            end += (more.data.len() / channels) as u64;
                            let _ = spare_tx.try_send(more.data);
                        }
                        on_samples(Batch { samples: &batch, channels, sample_rate: info.sample_rate, first_frame: first, gap, capture_time });
                        next_frame = end;
                        if let Some(chunk) = pending {
                            let gap = chunk.first_frame.saturating_sub(next_frame);
                            next_frame = chunk.first_frame + (chunk.data.len() / channels) as u64;
                            on_samples(Batch {
                                samples: &chunk.data,
                                channels,
                                sample_rate: info.sample_rate,
                                first_frame: chunk.first_frame,
                                gap,
                                capture_time: chunk.capture_time,
                            });
                            let _ = spare_tx.try_send(chunk.data);
                        }
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
    chunk_tx: SyncSender<Chunk>,
    spare_rx: Receiver<Vec<f32>>,
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

    let mut frames = 0u64;
    let mut origin: Option<StreamInstant> = None;
    let data_callback = move |data: &Data, callback: &cpal::InputCallbackInfo| {
        // A recycled buffer; only if none is back yet (start-up, a stalled consumer) is one allocated.
        let mut buffer = spare_rx.try_recv().unwrap_or_default();
        buffer.clear();
        let converted = match sample_format {
            SampleFormat::F32 => convert::<f32>(data, &mut buffer),
            SampleFormat::I16 => convert::<i16>(data, &mut buffer),
            SampleFormat::I32 => convert::<i32>(data, &mut buffer),
            SampleFormat::U16 => convert::<u16>(data, &mut buffer),
            SampleFormat::U8 => convert::<u8>(data, &mut buffer),
            SampleFormat::F64 => convert::<f64>(data, &mut buffer),
            _ => false,
        };
        if !converted {
            return;
        }
        let capture = callback.timestamp().capture;
        let capture_time = Some(capture.duration_since(*origin.get_or_insert(capture)));
        let first_frame = frames;
        frames += (buffer.len() / channels) as u64;
        // Never block the audio thread: if the queue is full the chunk is dropped
        // (the frame counter has moved on, so the consumer sees the gap).
        let _ = chunk_tx.try_send(Chunk { data: buffer, first_frame, capture_time });
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

/// Appends the callback's interleaved samples to `out` as f32; false for an unexpected format.
fn convert<T>(data: &Data, out: &mut Vec<f32>) -> bool
where
    T: cpal::SizedSample,
    f32: FromSample<T>,
{
    match data.as_slice::<T>() {
        Some(samples) => {
            out.extend(samples.iter().map(|s| s.to_sample::<f32>()));
            true
        }
        None => false,
    }
}
