//! Device selection per platform. Everything OS-specific about *which* device
//! to open for a [`CaptureSource`] lives here.
//!
//! System audio is captured differently per OS:
//! - **Windows / macOS**: loopback. An input stream built on an *output*
//!   device records what it plays (WASAPI loopback, CoreAudio aggregate).
//! - **Linux**: the `.monitor` source that PulseAudio / PipeWire attach to
//!   every output (sink), opened as a regular input through cpal's PulseAudio host.

use std::str::FromStr;

use cpal::traits::{DeviceTrait, HostTrait};
use cpal::{Device, DeviceId, Host};

use crate::{CaptureError, CaptureSource, DeviceInfo};

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod system {
    use super::*;

    pub fn check(_host: &Host) -> Result<(), CaptureError> {
        Ok(())
    }

    pub fn candidates(host: &Host) -> Result<Vec<Device>, CaptureError> {
        Ok(host.output_devices()?.collect())
    }

    pub fn default_device(host: &Host) -> Option<Device> {
        host.default_output_device()
    }

    /// Loopback must match the output device's mix format.
    pub fn stream_config(device: &Device) -> Result<cpal::SupportedStreamConfig, CaptureError> {
        Ok(device.default_output_config()?)
    }
}

#[cfg(target_os = "linux")]
mod system {
    use super::*;

    const MONITOR_SUFFIX: &str = ".monitor";

    /// Monitor sources exist only on a PulseAudio-compatible server (PipeWire included).
    pub fn check(host: &Host) -> Result<(), CaptureError> {
        if host.id() != cpal::HostId::PulseAudio {
            return Err(CaptureError::Unsupported(
                "System audio needs PipeWire or PulseAudio, which is not running.".into(),
            ));
        }
        Ok(())
    }

    fn pulse_name(device: &Device) -> Option<String> {
        device.id().ok().map(|id| id.id().to_owned())
    }

    pub fn candidates(host: &Host) -> Result<Vec<Device>, CaptureError> {
        Ok(host.input_devices()?.filter(|d| pulse_name(d).is_some_and(|n| n.ends_with(MONITOR_SUFFIX))).collect())
    }

    /// The monitor of the default output, falling back to any monitor.
    pub fn default_device(host: &Host) -> Option<Device> {
        let sink = host.default_output_device().and_then(|d| pulse_name(&d));
        let monitors = candidates(host).ok()?;
        let wanted = sink.map(|name| format!("{name}{MONITOR_SUFFIX}"));
        let position = monitors.iter().position(|d| pulse_name(d) == wanted).unwrap_or(0);
        monitors.into_iter().nth(position)
    }

    pub fn stream_config(device: &Device) -> Result<cpal::SupportedStreamConfig, CaptureError> {
        Ok(device.default_input_config()?)
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod system {
    use super::*;

    pub fn check(_host: &Host) -> Result<(), CaptureError> {
        Err(CaptureError::Unsupported("System audio capture is not supported on this platform.".into()))
    }

    pub fn candidates(_host: &Host) -> Result<Vec<Device>, CaptureError> {
        Ok(Vec::new())
    }

    pub fn default_device(_host: &Host) -> Option<Device> {
        None
    }

    pub fn stream_config(device: &Device) -> Result<cpal::SupportedStreamConfig, CaptureError> {
        Ok(device.default_input_config()?)
    }
}

/// The default host, after checking it can serve `source`.
fn host_for(source: CaptureSource) -> Result<Host, CaptureError> {
    let host = cpal::default_host();
    if source == CaptureSource::System {
        system::check(&host)?;
    }
    Ok(host)
}

fn candidates(host: &Host, source: CaptureSource) -> Result<Vec<Device>, CaptureError> {
    match source {
        CaptureSource::System => system::candidates(host),
        CaptureSource::Microphone => Ok(host.input_devices()?.collect()),
    }
}

fn default_device(host: &Host, source: CaptureSource) -> Option<Device> {
    match source {
        CaptureSource::System => system::default_device(host),
        CaptureSource::Microphone => host.default_input_device(),
    }
}

pub fn list_devices(source: CaptureSource) -> Result<Vec<DeviceInfo>, CaptureError> {
    let host = host_for(source)?;
    let default_id = default_device(&host, source).and_then(|d| d.id().ok());
    let devices = candidates(&host, source)?
        .into_iter()
        .filter_map(|device| {
            let id = device.id().ok()?;
            Some(DeviceInfo {
                is_default: default_id.as_ref() == Some(&id),
                name: device.to_string(),
                id: id.to_string(),
            })
        })
        .collect();
    Ok(devices)
}

/// Resolves the device to open. `device_id = None` means the system default.
pub fn open_device(source: CaptureSource, device_id: Option<&str>) -> Result<Device, CaptureError> {
    let host = host_for(source)?;
    match device_id {
        Some(id) => {
            let parsed = DeviceId::from_str(id)?;
            host.device_by_id(&parsed).ok_or_else(|| CaptureError::DeviceNotFound(id.to_string()))
        }
        None => default_device(&host, source).ok_or(CaptureError::NoDefaultDevice(match source {
            CaptureSource::System => "output",
            CaptureSource::Microphone => "input",
        })),
    }
}

pub fn stream_config(device: &Device, source: CaptureSource) -> Result<cpal::SupportedStreamConfig, CaptureError> {
    match source {
        CaptureSource::System => system::stream_config(device),
        CaptureSource::Microphone => Ok(device.default_input_config()?),
    }
}
