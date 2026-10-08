import { Color } from 'three';
import { AudioEngine, type AudioEngineState } from '../audio/AudioEngine';
import type { NativeSource } from '../audio/capture/NativeAudioCapture';
import { TEST_SIGNALS, type TestSignal } from '../audio/capture/testSignals';
import { isFullscreen, setFullscreen } from '../platform';
import { RenderEngine } from '../renderer/RenderEngine';
import { resolveDirection, settingsStore, type Settings } from '../stores/settingsStore';
import type { AudioSourceId } from '../types/audio';
import type { SceneInput } from '../types/visualizer';
import { REDUCED_FLASHES, STANDARD_FLASHES } from '../dynamics/FlashGuard';
import { Dial } from '../ui/Dial';
import { h } from '../ui/dom';
import { NowPlaying, type Track } from '../ui/NowPlaying';
import { CalibrationView } from './calibration/CalibrationView';
import { SettingsPanel } from '../ui/SettingsPanel';
import { findPalette, hslCss, paletteColors } from '../visualizers/palettes';
import { findVisualizer, visualizers } from '../visualizers/registry';
import { installShortcuts, type ShortcutAction } from './shortcuts';
import { appMenu, coreTarget, menuSelection } from './menus';
import { RigController } from './RigController';

/** Inactivity before an open wheel collapses by itself (token: collapse-delay). */
const COLLAPSE_DELAY = 6000;
const IDLE_CHECK_INTERVAL = 250;
/** Retry policy when a running native capture fails (device unplugged, ...). */
const RETRY_DELAY = 2000;
const MAX_RETRIES = 5;

/**
 * Application controller. Wires audio engine → render engine and drives the
 * Euforia-Audio-Experience UI: one core button, a radial wheel with sub-rings, a settings panel
 * and auto-hide. The whole UI state is: open menu, panel open, idle.
 */
export class App {
  readonly audio = new AudioEngine();
  private readonly rigController: RigController;
  private readonly sceneInput: SceneInput;
  get dynamics() { return this.rigController.dynamics; }
  get flashGuard() { return this.rigController.flashGuard; }
  get rig() { return this.rigController.rig; }
  get show() { return this.rigController.show; }
  private readonly stage: HTMLElement;
  private readonly render: RenderEngine;
  private readonly nowPlaying = new NowPlaying();
  private readonly dial: Dial;
  private readonly panel: SettingsPanel;
  private readonly calibration: CalibrationView;
  private readonly paletteScratch: [Color, Color, Color] = [new Color(), new Color(), new Color()];
  private lastInput = performance.now();
  private idle = false;
  private paused = false;
  private fullscreen = false;
  private retryTimer = 0;
  private retriesLeft = 0;
  private idleTimer = 0;
  private started = false;
  private disposed = false;
  private readonly inputEvents = new AbortController();
  private readonly cleanup: Array<() => void> = [];

  constructor(root: HTMLElement) {
    const canvasHost = h('div', { class: 'app-canvas' });
    this.dial = new Dial({ menu: (key) => appMenu(key, settingsStore.get(), this.fullscreen), onSelect: (menu, id) => this.onSelect(menu, id), onCore: () => this.onCore() });
    this.panel = new SettingsPanel(() => this.closePanel(), () => this.openCalibration(), (source) => void this.selectSource(source));
    this.calibration = new CalibrationView(this.audio, () => this.closeCalibration());
    this.stage = h(
      'main',
      { class: 'app-stage' },
      canvasHost,
      h('div', { class: 'app-vignette' }),
      this.nowPlaying.element,
      this.dial.element,
      this.panel.element,
      this.calibration.element,
    );
    root.append(this.stage);

    this.render = new RenderEngine(canvasHost, (dt) => this.onFrame(dt));
    this.rigController = new RigController(this.audio, this.render, () => settingsStore.get());
    this.sceneInput = { audio: this.audio.frame, response: this.audio.visual, rig: this.rig };

    this.cleanup.push(settingsStore.subscribe((s, previous) => this.applySettings(s, previous)));
    this.cleanup.push(this.audio.subscribe((state) => this.onAudioState(state)));
    this.installInput();
    // Development-only audio/visual debug overlay (?debug or Shift+D); not part of the production bundle.
    if (import.meta.env.DEV) void import('./debug/DebugOverlay').then((m) => {
      if (!this.disposed) this.cleanup.push(m.installDebugOverlay(this));
    });
    // Development-only engine cockpit (?engine or Shift+E): a technical view beside the cinematic one, never in production.
    if (import.meta.env.DEV) void import('./engine/EngineCockpit').then((m) => {
      if (!this.disposed) this.cleanup.push(m.installEngineCockpit(this));
    });
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    const s = settingsStore.get();
    this.applySettings(s);
    this.render.start();
    this.idleTimer = window.setInterval(() => this.checkIdle(), IDLE_CHECK_INTERVAL);
    await this.selectSource(s.source);
  }

  /** Release timers, subscriptions, audio and GPU resources before unmounting. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.idleTimer);
    this.inputEvents.abort();
    for (const dispose of this.cleanup) dispose();
    this.cleanup.length = 0;
    this.panel.dispose();
    this.nowPlaying.dispose();
    this.calibration.dispose();
    this.render.dispose();
    this.stage.remove();
    await this.audio.stop();
  }

  // ---- frame ---------------------------------------------------------------

  private onFrame(dt: number): SceneInput {
    const frame = this.audio.update(dt);
    // The core and the waveform pulse with the beat over a floor of loudness.
    const level = Math.min(1, frame.volume * 0.35 + frame.beatPulse * 0.65);
    if (!this.idle) this.dial.setLevel(level);
    if (settingsStore.get().trackInfo !== 'hidden') this.nowPlaying.draw(level, performance.now());
    this.calibration.frame(dt);
    this.rigController.update(dt);
    return this.sceneInput;
  }

  // ---- wheel ---------------------------------------------------------------

  /** Core click, by priority: close panel → back to root → close wheel → open wheel. */
  private onCore(): void {
    if (this.calibration.isOpen) return this.closeCalibration();
    if (this.panel.isOpen) return this.closePanel();
    const target = coreTarget(this.dial.menu);
    if (target) this.dial.open(target);
    else this.dial.close();
  }

  private onSelect(menu: string, id: string): void {
    const effect = menuSelection(menu, id);
    if (effect.patch) settingsStore.set(effect.patch);
    if (effect.source) void this.selectSource(effect.source);
    if (effect.command) {
      this.dial.close();
      if (effect.command === 'fullscreen') void this.toggleFullscreen();
      else this.openPanel();
    } else if (effect.open) this.dial.open(effect.open);
    // Sub-ring picks apply at once and keep the ring open for comparison.
    else this.dial.select(id);
  }

  private openPanel(): void {
    this.panel.open();
    this.dial.setPanelOpen(true);
  }

  private closePanel(): void {
    const hadFocus = this.panel.element.contains(document.activeElement);
    this.panel.close();
    this.dial.setPanelOpen(false);
    if (hadFocus) this.dial.core.focus();
  }

  private closeAll(): void {
    this.dial.close();
    if (this.panel.isOpen) this.closePanel();
    if (this.calibration.isOpen) this.closeCalibration();
  }

  /** Sync calibration: replaces the panel above the core until done. */
  private openCalibration(): void {
    this.closePanel();
    this.dial.setPanelOpen(true);
    void this.calibration.open();
  }

  private closeCalibration(): void {
    const hadFocus = this.calibration.element.contains(document.activeElement);
    this.calibration.close();
    this.dial.setPanelOpen(false);
    if (hadFocus) this.dial.core.focus();
  }

  // ---- input & auto-hide -----------------------------------------------------

  private installInput(): void {
    const { signal } = this.inputEvents;
    const touch = () => {
      this.lastInput = performance.now();
      if (this.idle) this.setIdle(false);
    };
    this.stage.addEventListener('pointermove', touch, { signal });
    this.stage.addEventListener('pointerdown', (event) => {
      touch();
      const target = event.target as Node;
      if (!this.dial.element.contains(target) && !this.panel.element.contains(target) && !this.calibration.element.contains(target)) this.closeAll();
    }, { signal });
    // Capture phase: any key wakes the UI before anything else handles it.
    document.addEventListener('keydown', touch, { capture: true, signal });
    this.cleanup.push(installShortcuts((action) => this.onShortcut(action)));

    // Keep the icon right when fullscreen is left through the OS.
    window.addEventListener('resize', () => void this.syncFullscreen(), { signal });
  }

  private checkIdle(): void {
    const quiet = performance.now() - this.lastInput;
    if (this.dial.menu && quiet > COLLAPSE_DELAY) this.dial.close();
    else if (!this.dial.menu && !this.panel.isOpen && !this.calibration.isOpen && !this.idle && quiet > settingsStore.get().hideDelay) this.setIdle(true);
  }

  private setIdle(idle: boolean): void {
    this.idle = idle;
    this.stage.classList.toggle('is-idle', idle);
    // Hidden controls must not take focus.
    this.dial.element.inert = idle;
    if (idle && this.dial.element.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }

  private onShortcut(action: ShortcutAction): void {
    if (action === 'escape') {
      if (this.dial.menu || this.panel.isOpen || this.calibration.isOpen) this.closeAll();
      else void setFullscreen(false).then(() => this.syncFullscreen());
      return;
    }
    // Other shortcuts only act on the bare scene, not while a menu is open.
    if (this.dial.menu || this.panel.isOpen || this.calibration.isOpen) return;
    if (action === 'toggleFullscreen') void this.toggleFullscreen();
    if (action === 'nextVisualizer') this.cycleScene(1);
    if (action === 'previousVisualizer') this.cycleScene(-1);
    if (action === 'togglePause') {
      this.paused = !this.paused;
      this.render.paused = this.paused;
    }
  }

  private cycleScene(direction: 1 | -1): void {
    const index = visualizers.findIndex((v) => v.id === settingsStore.get().scene);
    const next = visualizers[(index + direction + visualizers.length) % visualizers.length];
    settingsStore.set({ scene: next.id });
  }

  private async toggleFullscreen(): Promise<void> {
    await setFullscreen(!(await isFullscreen())).catch(() => undefined);
    await this.syncFullscreen();
  }

  private async syncFullscreen(): Promise<void> {
    this.fullscreen = await isFullscreen().catch(() => false);
  }

  // ---- audio -----------------------------------------------------------------

  private async selectSource(source: AudioSourceId): Promise<void> {
    window.clearTimeout(this.retryTimer);
    this.retriesLeft = 0;
    settingsStore.set({ source });
    this.nowPlaying.set(this.trackFor(source, ''));
    await this.audio.setSource(source);
  }

  /** Plays a synthetic test signal (debug tool); the persisted source is left unchanged. */
  async playTestSignal(signal: TestSignal): Promise<void> {
    window.clearTimeout(this.retryTimer);
    this.retriesLeft = 0;
    await this.audio.setSource('fake', { signal });
  }

  /**
   * Holds a scene in the viewport whatever the settings say (development tools), or releases it with `null`; the
   * persisted scene is left unchanged. Without a synchronized clock the show is not directing, so it is mounted at once.
   */
  pinScene(id: string | null): void {
    this.rigController.pinned = id;
    this.rigController.showScene(id ?? settingsStore.get().scene);
  }

  private onAudioState(state: AudioEngineState): void {
    if (!state.source) return;
    const track = this.trackFor(state.source, state.deviceName);
    if (state.status === 'starting') track.source = 'Connecting…';
    if (state.status === 'error') track.source = state.error ?? 'Audio unavailable';
    this.nowPlaying.set(track);

    // A running native capture that fails (device unplugged) is retried a few times.
    const native = state.source === 'system' || state.source === 'microphone';
    if (state.status === 'running') this.retriesLeft = MAX_RETRIES;
    if (state.status === 'error' && native && this.retriesLeft > 0) {
      this.retriesLeft--;
      const source = state.source as NativeSource;
      window.clearTimeout(this.retryTimer);
      this.retryTimer = window.setTimeout(() => void this.audio.setSource(source), RETRY_DELAY);
    }
  }

  /** Now-playing content per source; no track metadata is read yet. */
  private trackFor(source: AudioSourceId, name: string): Track {
    switch (source) {
      case 'system':
        return { title: 'System Audio', artist: 'Listening', source: name || 'System audio', live: true, duration: 0 };
      case 'microphone':
        return { title: 'Live input', artist: 'Microphone', source: name || 'Microphone', live: true, duration: 0 };
      case 'fake':
        return { title: 'Test Signal', artist: 'Synthetic', source: name || TEST_SIGNALS[0].label, live: true, duration: 0 };
    }
  }

  // ---- settings --------------------------------------------------------------

  /** Development diagnostics read the stable director objects without subscribing to frames. */
  get directionDebug() { return this.render; }

  private applySettings(s: Settings, previous?: Settings): void {
    const direction = resolveDirection(s);
    this.render.setDirection(direction);
    const def = findVisualizer(s.scene) ?? visualizers[0];
    // Presets scale the user's audio preferences.
    this.audio.configure({
      sensitivity: s.sensitivity * def.preset.audio.sensitivity,
      smoothing: Math.min(s.smoothing * def.preset.audio.smoothing, 0.95),
      beatResponse: s.beatResponse,
    });
    this.audio.setDelay(s.audioDelay / 1000);
    this.flashGuard.limits = s.reduceFlashing ? REDUCED_FLASHES : STANDARD_FLASHES;
    this.stage.dataset.track = s.trackInfo;
    this.stage.dataset.cursor = s.hideCursor ? 'hide' : 'show';

    if (!previous || s.preset !== previous.preset) {
      const palette = findPalette(s.preset);
      this.render.setPalette(paletteColors(palette, this.paletteScratch));
      this.stage.style.setProperty('--accent-live', hslCss(palette.hues[0]));
    }
    if (!previous || s.reflection !== previous.reflection) this.render.setReflection(s.reflection);
    if (!previous || s.quality !== previous.quality) this.render.setQuality(s.quality);
    // The chosen scene is the protagonist, except in free mode where the director picks it (it starts there).
    if (!previous || (s.scene !== previous.scene && direction.rigMode !== 'free')) {
      this.rigController.showScene(s.scene);
    }
  }
}
