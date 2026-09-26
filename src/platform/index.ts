import { isTauri } from '@tauri-apps/api/core';

/** True when running inside the desktop shell, false in a plain browser (dev). */
export const isDesktop = isTauri();

/**
 * System audio is captured natively by the desktop app: WASAPI loopback on
 * Windows, the PipeWire/PulseAudio monitor on Linux, CoreAudio on macOS
 * (see native/audio-capture/src/platform.rs).
 */
export const supportsSystemAudio = isDesktop;

/** Toggles fullscreen on the native window (desktop) or the document (browser). */
export async function setFullscreen(enabled: boolean): Promise<void> {
  if (isDesktop) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setFullscreen(enabled);
    return;
  }
  if (enabled && !document.fullscreenElement) await document.documentElement.requestFullscreen();
  else if (!enabled && document.fullscreenElement) await document.exitFullscreen();
}

export async function isFullscreen(): Promise<boolean> {
  if (isDesktop) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().isFullscreen();
  }
  return document.fullscreenElement !== null;
}
