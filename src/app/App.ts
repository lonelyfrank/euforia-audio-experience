import { MOODS, EXPERIENCES } from '../director/profiles';
import type { MoodId, ExperienceId } from '../director/types';
import { Color } from 'three';
import { AudioEngine, type AudioEngineState } from '../audio/AudioEngine';
import type { NativeSource } from '../audio/capture/NativeAudioCapture';
import { TEST_SIGNALS, type TestSignal } from '../audio/capture/testSignals';
import { isFullscreen, setFullscreen } from '../platform';
import { RenderEngine } from '../renderer/RenderEngine';
import { settingsStore, type Settings } from '../stores/settingsStore';
import type { AudioSourceId } from '../types/audio';
import type { QualitySetting, RigValues, SceneInput } from '../types/visualizer';
import { CueScheduler } from '../dynamics/CueScheduler';
import { Dynamics } from '../dynamics/Dynamics';
import { Dial, type DialMenu } from '../ui/Dial';
import { h } from '../ui/dom';
import { swatch } from '../ui/icons';
import { NowPlaying, type Track } from '../ui/NowPlaying';
import { CalibrationView } from './calibration/CalibrationView';
import { SettingsPanel } from '../ui/SettingsPanel';
import { findPalette, hslCss, paletteColors, PALETTES, type PaletteId } from '../visualizers/palettes';
import { findVisualizer, visualizers } from '../visualizers/registry';
import { installShortcuts, type ShortcutAction } from './shortcuts';

/** Inactivity before an open wheel collapses by itself (token: collapse-delay). */
const COLLAPSE_DELAY = 6000;
const IDLE_CHECK_INTERVAL = 250;
/** Retry policy when a running native capture fails (device unplugged, ...). */
const RETRY_DELAY = 2000;
const MAX_RETRIES = 5;

const QUALITIES: { id: QualitySetting; label: string; icon: 'qauto' | 'qlow' | 'qmed' | 'qhigh' }[] = [
  { id: 'auto', label: 'Auto', icon: 'qauto' },
  { id: 'low', label: 'Low', icon: 'qlow' },
  { id: 'medium', label: 'Medium', icon: 'qmed' },
  { id: 'high', label: 'High', icon: 'qhigh' },
];

/**
 * Application controller. Wires audio engine → render engine and drives the
 * Halo UI: one core button, a radial wheel with sub-rings, a settings panel
 * and auto-hide. The whole UI state is: open menu, panel open, idle.
 */
export class App {
  readonly audio = new AudioEngine();
  /** Handed to the render engine every frame; both objects are updated in place. */
  /** Dynamics: fixture parameters driven by timed targets and impulses (see src/dynamics). */
  readonly dynamics = new Dynamics();
  private readonly haloPulse = this.dynamics.channel('halo.pulse', 'flash');
  private readonly cues = new CueScheduler(this.dynamics, this.haloPulse);
  private readonly rig: RigValues = { haloPulse: 0 };
  private readonly sceneInput: SceneInput = { audio: this.audio.frame, response: this.audio.visual, rig: this.rig };
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

  constructor(root: HTMLElement) {
    const canvasHost = h('div', { class: 'halo-canvas' });
    this.dial = new Dial({ menu: (key) => this.menu(key), onSelect: (menu, id) => this.onSelect(menu, id), onCore: () => this.onCore() });
    this.panel = new SettingsPanel(() => this.closePanel(), () => this.openCalibration());
    this.calibration = new CalibrationView(this.audio, () => this.closeCalibration());
    this.stage = h(
      'main',
      { class: 'halo-stage' },
      canvasHost,
      h('div', { class: 'halo-vignette' }),
      this.nowPlaying.element,
      this.dial.element,
      this.panel.element,
      this.calibration.element,
    );
    root.append(this.stage);

    this.render = new RenderEngine(canvasHost, (dt) => this.onFrame(dt));

    settingsStore.subscribe((s, previous) => this.applySettings(s, previous));
    this.audio.subscribe((state) => this.onAudioState(state));
    this.installInput();
    // Development-only audio/visual debug overlay (?debug or Shift+D); not part of the production bundle.
    if (import.meta.env.DEV) void import('./debug/DebugOverlay').then((m) => m.installDebugOverlay(this));
  }

  async start(): Promise<void> {
    const s = settingsStore.get();
    this.applySettings(s);
    this.render.start();
    window.setInterval(() => this.checkIdle(), IDLE_CHECK_INTERVAL);
    await this.selectSource(s.source);
  }

  // ---- frame ---------------------------------------------------------------

  private onFrame(dt: number): SceneInput {
    const frame = this.audio.update(dt);
    // The core and the waveform pulse with the beat over a floor of loudness.
    const level = Math.min(1, frame.volume * 0.35 + frame.beatPulse * 0.65);
    this.dial.setLevel(level);
    this.nowPlaying.draw(level, performance.now());
    this.calibration.frame(dt);
    this.updateRig();
    return this.sceneInput;
  }

  /** Analysis events → Dynamics (on the heard audio clock) → fixture values for the renderer. */
  private updateRig(): void {
    const { features, timing, clock } = this.audio;
    if (!clock.ready) return;
    const { onsets, sections } = features;
    // A new source restarts the capture clock: the rig starts over with it.
    if (timing.heardTime < this.dynamics.time - 1) {
      this.dynamics.restart();
      this.cues.reset();
    }
    this.cues.update(features.frame, timing.gridWeight, onsets.items, onsets.count, sections.items, sections.count);
    this.dynamics.advance(timing.heardTime);
    this.rig.haloPulse = this.dynamics.value(this.haloPulse);
  }

  // ---- wheel ---------------------------------------------------------------

  private menu(key: string): DialMenu {
    const s = settingsStore.get();
    switch (key) {
      case 'direction':
        return { caption: 'Direction', actions: true, items: [
          { id: 'mood', label: 'Mood', icon: 'mood' },
          { id: 'experience', label: 'Experience', icon: 'experience' },
          { id: 'auto', label: s.autoDirection ? 'Auto · On' : 'Auto · Off', icon: 'qauto', selected: s.autoDirection },
          { id: 'quality', label: 'Quality', icon: 'quality' },
        ] };
      case 'mood':
        return { caption: 'Mood', items: MOODS.map((m) => ({ id: m.id, label: m.name, icon: 'mood', selected: m.id === s.mood })) };
      case 'experience':
        return { caption: 'Experience', items: EXPERIENCES.map((m) => ({ id: m.id, label: m.name, icon: 'experience', selected: m.id === s.experience })) };
      case 'scene':
        return {
          caption: 'Scene',
          items: visualizers.map((v) => ({ id: v.id, label: v.name, icon: v.icon, selected: v.id === s.scene })),
        };
      case 'audio':
        return {
          caption: 'Audio',
          layout: 'arc',
          items: [
            { id: 'system', label: 'System Audio', icon: 'system', selected: s.source === 'system' },
            { id: 'microphone', label: 'Microphone', icon: 'mic', selected: s.source === 'microphone' },
          ],
        };
      case 'presets':
        return {
          caption: `Palette · ${findVisualizer(s.scene)?.name ?? ''}`,
          layout: 'arc',
          items: PALETTES.map((p) => ({ id: p.id, label: p.name, iconHtml: swatch(p), selected: p.id === s.preset })),
        };
      case 'quality':
        return { caption: 'Quality', layout: 'arc', items: QUALITIES.map((q) => ({ ...q, selected: q.id === s.quality })) };
      default:
        return {
          items: [
            { id: 'scene', label: 'Scene', icon: 'scene' },
            { id: 'audio', label: 'Audio', icon: 'audio' },
            { id: 'presets', label: 'Palette', icon: 'presets' },
            { id: 'settings', label: 'Settings', icon: 'settings' },
            { id: 'direction', label: 'Direction', icon: 'direction' },
            { id: 'fullscreen', label: 'Fullscreen', icon: this.fullscreen ? 'exitfull' : 'fullscreen' },
          ],
        };
    }
  }

  /** Core click, by priority: close panel → back to root → close wheel → open wheel. */
  private onCore(): void {
    const menu = this.dial.menu;
    if (this.panel.isOpen) this.closePanel();
    else if (menu && menu !== 'root') this.dial.open(['mood', 'experience', 'quality'].includes(menu) ? 'direction' : 'root');
    else if (menu) this.dial.close();
    else this.dial.open('root');
  }

  private onSelect(menu: string, id: string): void {
    if (menu === 'root') {
      if (id === 'fullscreen') {
        this.dial.close();
        void this.toggleFullscreen();
      } else if (id === 'settings') {
        this.dial.close();
        this.openPanel();
      } else {
        this.dial.open(id);
      }
      return;
    }
    if (menu === 'direction') {
      if (id === 'auto') { settingsStore.set({ autoDirection: !settingsStore.get().autoDirection }); this.dial.open('direction'); }
      else this.dial.open(id);
      return;
    }
    if (menu === 'mood') settingsStore.set({ mood: id as MoodId, autoDirection: false });
    if (menu === 'experience') settingsStore.set({ experience: id as ExperienceId, autoDirection: false });
    // Sub-ring picks apply at once and keep the ring open for comparison.
    if (menu === 'scene') settingsStore.set({ scene: id });
    if (menu === 'audio') void this.selectSource(id as AudioSourceId);
    if (menu === 'presets') settingsStore.set({ preset: id as PaletteId });
    if (menu === 'quality') settingsStore.set({ quality: id as QualitySetting });
    this.dial.select(id);
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
    const touch = () => {
      this.lastInput = performance.now();
      if (this.idle) this.setIdle(false);
    };
    this.stage.addEventListener('pointermove', touch);
    this.stage.addEventListener('pointerdown', (event) => {
      touch();
      const target = event.target as Node;
      if (!this.dial.element.contains(target) && !this.panel.element.contains(target) && !this.calibration.element.contains(target)) this.closeAll();
    });
    // Capture phase: any key wakes the UI before anything else handles it.
    document.addEventListener('keydown', touch, true);
    installShortcuts((action) => this.onShortcut(action));

    // Keep the icon right when fullscreen is left through the OS.
    window.addEventListener('resize', () => void this.syncFullscreen());
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
    this.render.setDirection(s);
    const def = findVisualizer(s.scene) ?? visualizers[0];
    // Presets scale the user's audio preferences.
    this.audio.configure({
      sensitivity: s.sensitivity * def.preset.audio.sensitivity,
      smoothing: Math.min(s.smoothing * def.preset.audio.smoothing, 0.95),
      beatResponse: s.beatResponse,
    });
    this.audio.setDelay(s.audioDelay / 1000);
    this.stage.dataset.track = s.trackInfo;
    this.stage.dataset.cursor = s.hideCursor ? 'hide' : 'show';

    if (!previous || s.preset !== previous.preset) {
      const palette = findPalette(s.preset);
      this.render.setPalette(paletteColors(palette, this.paletteScratch));
      this.stage.style.setProperty('--accent-live', hslCss(palette.hues[0]));
    }
    if (!previous || s.reflection !== previous.reflection) this.render.setReflection(s.reflection);
    if (!previous || s.quality !== previous.quality) this.render.setQuality(s.quality);
    if (!previous || s.scene !== previous.scene) this.render.show({ create: () => def.create(def.preset), preset: def.preset, direction: def.direction });
  }
}
