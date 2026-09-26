import type { AudioFrame } from '../../types/audio';
import { BeatDetector } from './BeatDetector';
import { FFT } from './FFT';
import { DynamicRange, PeakTracker, SILENCE_DB, Smoother } from './Smoother';

export const FFT_SIZE = 2048;
export const SPECTRUM_BINS = 128;
export const WAVEFORM_SIZE = 1024;

/** Frequency range of the display spectrum (log-spaced bins). */
export const MIN_FREQ = 30;
export const MAX_FREQ = 16000;
/** Display tilt so high frequencies are not dwarfed by the bass (dB/octave around 1 kHz). */
const SPECTRUM_TILT = 3;
/** dB window shown by the spectrum, below its tracked peak. */
const SPECTRUM_RANGE = 42;
/** dB per second the spectrum's top falls back after a loud passage. */
const SPECTRUM_TOP_FALL = 4;
/** >1 expands dynamics after normalization so hits stand out. */
const CONTRAST = 1.8;
const SILENCE_PEAK = 1e-4;

/*
 * Time-domain envelopes (shorter than the FFT window, so they react faster):
 * bass = 20–250 Hz over 20 ms, kick = below ~120 Hz over 10 ms, volume = RMS over 20 ms.
 */
const BASS_CUTOFF = 250;
const KICK_CUTOFF = 120;
const BASS_WINDOW = 0.02;
const KICK_WINDOW = 0.01;
const VOLUME_WINDOW = 0.02;

type BandName = 'lowMid' | 'mid' | 'highMid' | 'treble';

const BANDS: ReadonlyArray<{ name: BandName; low: number; high: number }> = [
  { name: 'lowMid', low: 250, high: 500 },
  { name: 'mid', low: 500, high: 2000 },
  { name: 'highMid', low: 2000, high: 4000 },
  { name: 'treble', low: 4000, high: 16000 },
];

interface BandState {
  name: BandName;
  low: number;
  high: number;
  from: number;
  to: number;
  range: DynamicRange;
}

export interface AnalyzerSettings {
  /** Reactivity: >1 makes levels reach their maximum sooner (1 = neutral). */
  sensitivity: number;
  /** 0 = raw/nervous, 1 = very smooth. */
  smoothing: number;
  /** When false, beat and beatPulse stay at 0 (onset and BPM keep updating). */
  beatResponse: boolean;
}

/**
 * The single place where audio is analysed. Consumes raw mono samples and
 * produces a normalized AudioFrame. Allocation-free per frame.
 *
 * Levels are measured in dB and mapped through adaptive ranges (recent peak
 * and floor per band), so they follow the music's dynamics at any volume.
 */
export class AudioAnalyzer {
  readonly frame: AudioFrame;
  readonly settings: AnalyzerSettings = { sensitivity: 1, smoothing: 0.5, beatResponse: true };

  private readonly fft = new FFT(FFT_SIZE);
  private readonly window = new Float32Array(FFT_SIZE);
  private readonly windowed = new Float32Array(FFT_SIZE);
  private readonly magnitudes = new Float32Array(FFT_SIZE / 2);
  /** Per FFT bin power in dB. */
  private readonly binDb = new Float32Array(FFT_SIZE / 2);
  private readonly tilt = new Float32Array(FFT_SIZE / 2);
  private readonly spectrumFrom = new Float32Array(SPECTRUM_BINS);
  private readonly spectrumTo = new Float32Array(SPECTRUM_BINS);
  private readonly spectrumLevels = new Float32Array(SPECTRUM_BINS);
  private readonly bands: BandState[] = BANDS.map((b) => ({ ...b, from: 0, to: 0, range: new DynamicRange() }));
  private energyFrom = 1;
  private energyTo = 1;

  private readonly smoother = new Smoother();
  private readonly bassRange = new DynamicRange();
  private readonly volumeRange = new DynamicRange();
  private readonly energyRange = new DynamicRange();
  private spectrumTop = Number.NEGATIVE_INFINITY;
  private readonly waveformPeak = new PeakTracker(0.003, 3);
  private readonly beats = new BeatDetector();
  private sampleRate = 0;
  private powerScale = 1;

  constructor() {
    let windowSum = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
      windowSum += this.window[i];
    }
    this.powerScale = (2 / windowSum) ** 2;
    this.frame = {
      time: 0,
      sampleRate: 0,
      silent: true,
      volume: 0,
      peak: 0,
      bass: 0,
      lowMid: 0,
      mid: 0,
      highMid: 0,
      treble: 0,
      energy: 0,
      spectrum: new Float32Array(SPECTRUM_BINS),
      waveform: new Float32Array(WAVEFORM_SIZE),
      beat: false,
      beatPulse: 0,
      onset: 0,
      bpm: 0,
    };
  }

  /** Clears all adaptive state (call when the source changes). */
  reset(): void {
    this.frame.time = 0;
    this.frame.spectrum.fill(0);
    this.frame.waveform.fill(0);
    for (const band of this.bands) band.range.reset();
    this.bassRange.reset();
    this.volumeRange.reset();
    this.energyRange.reset();
    this.spectrumTop = Number.NEGATIVE_INFINITY;
    this.waveformPeak.reset();
    this.beats.reset();
  }

  /** `samples` must contain FFT_SIZE mono samples, oldest first. */
  analyze(samples: Float32Array, sampleRate: number, dt: number): AudioFrame {
    if (sampleRate !== this.sampleRate) this.configureFrequencyMap(sampleRate);
    const { frame, settings, smoother } = this;
    const sensitivity = settings.sensitivity;
    frame.time += dt;
    smoother.configure(settings.smoothing, dt);

    // Time domain: peak, loudness and the low-frequency envelopes.
    let peak = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
      this.windowed[i] = samples[i] * this.window[i];
    }
    frame.peak = Math.min(peak, 1);
    frame.silent = peak < SILENCE_PEAK;
    const volumeDb = meanSquareDb(samples, Math.round(VOLUME_WINDOW * sampleRate));
    const bassDb = lowpassEnergyDb(samples, BASS_CUTOFF, sampleRate, Math.round(BASS_WINDOW * sampleRate));
    const kickDb = lowpassEnergyDb(samples, KICK_CUTOFF, sampleRate, Math.round(KICK_WINDOW * sampleRate));
    frame.volume = smoother.apply(frame.volume, shape(this.volumeRange.normalize(volumeDb, dt, sensitivity)));
    frame.bass = smoother.apply(frame.bass, shape(this.bassRange.normalize(bassDb, dt, sensitivity)));

    // Frequency domain: per-bin power in dB, bands and total energy.
    this.fft.magnitudes(this.windowed, this.magnitudes);
    for (let i = 1; i < this.binDb.length; i++) {
      this.binDb[i] = 10 * Math.log10(this.magnitudes[i] ** 2 * this.powerScale + 1e-20);
    }
    for (const band of this.bands) {
      const db = bandPowerDb(this.magnitudes, band.from, band.to, this.powerScale);
      frame[band.name] = smoother.apply(frame[band.name], shape(band.range.normalize(db, dt, sensitivity)));
    }
    const energyDb = bandPowerDb(this.magnitudes, this.energyFrom, this.energyTo, this.powerScale);
    frame.energy = smoother.apply(frame.energy, shape(this.energyRange.normalize(energyDb, dt, sensitivity)));

    this.updateSpectrum(dt, sensitivity);
    this.updateWaveform(samples, dt);

    this.beats.update(kickDb, frame.silent, frame.time, dt);
    frame.beat = settings.beatResponse && this.beats.beat;
    frame.beatPulse = settings.beatResponse ? this.beats.pulse : 0;
    frame.onset = this.beats.onset;
    frame.bpm = this.beats.bpm;
    frame.sampleRate = sampleRate;
    return frame;
  }

  private updateSpectrum(dt: number, sensitivity: number): void {
    const { spectrumLevels, smoother } = this;
    const spectrum = this.frame.spectrum;
    // The loudest (tilted) bin sets the top of the displayed window; it falls back slowly.
    let top = SILENCE_DB;
    for (let b = 0; b < SPECTRUM_BINS; b++) {
      spectrumLevels[b] = this.binLevel(b);
      if (spectrumLevels[b] > top) top = spectrumLevels[b];
    }
    this.spectrumTop = Math.max(top, this.spectrumTop - SPECTRUM_TOP_FALL * dt);
    const range = SPECTRUM_RANGE / Math.max(sensitivity, 0.1);
    const bottom = this.spectrumTop - range;
    const silent = this.spectrumTop <= SILENCE_DB;
    for (let b = 0; b < SPECTRUM_BINS; b++) {
      const v = (spectrumLevels[b] - bottom) / range;
      spectrum[b] = smoother.apply(spectrum[b], silent ? 0 : shape(v < 0 ? 0 : v > 1 ? 1 : v));
    }
  }

  /** Tilted dB level of one log-spaced display bin. */
  private binLevel(b: number): number {
    const { binDb, tilt } = this;
    const from = this.spectrumFrom[b];
    const to = this.spectrumTo[b];
    if (to - from < 1) {
      // Narrower than one FFT bin: interpolate.
      const i = Math.floor(from);
      const next = Math.min(i + 1, binDb.length - 1);
      const t = from - i;
      return binDb[i] * (1 - t) + binDb[next] * t + tilt[i];
    }
    let value = Number.NEGATIVE_INFINITY;
    for (let i = Math.floor(from); i < to; i++) value = Math.max(value, binDb[i] + tilt[i]);
    return value;
  }

  /** Copies a zero-crossing aligned window so oscilloscopes stay stable. */
  private updateWaveform(samples: Float32Array, dt: number): void {
    const waveform = this.frame.waveform;
    const searchEnd = FFT_SIZE - WAVEFORM_SIZE;
    const searchStart = Math.max(0, searchEnd - 512);
    let start = searchEnd;
    for (let i = searchEnd; i > searchStart; i--) {
      if (samples[i - 1] < 0 && samples[i] >= 0) {
        start = i;
        break;
      }
    }
    let peak = 0;
    for (let i = 0; i < WAVEFORM_SIZE; i++) peak = Math.max(peak, Math.abs(samples[start + i]));
    this.waveformPeak.update(peak, dt);
    const scale = 0.85 / this.waveformPeak.value;
    for (let i = 0; i < WAVEFORM_SIZE; i++) {
      const v = samples[start + i] * scale;
      waveform[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
  }

  private configureFrequencyMap(sampleRate: number): void {
    this.sampleRate = sampleRate;
    const binHz = sampleRate / FFT_SIZE;
    const lastBin = FFT_SIZE / 2 - 1;
    const toBin = (hz: number) => Math.min(Math.max(hz / binHz, 1), lastBin);

    for (const band of this.bands) {
      band.from = Math.floor(toBin(band.low));
      band.to = Math.max(band.from + 1, Math.ceil(toBin(band.high)));
    }
    this.energyFrom = Math.floor(toBin(20));
    this.energyTo = Math.ceil(toBin(MAX_FREQ));

    const ratio = MAX_FREQ / MIN_FREQ;
    for (let b = 0; b < SPECTRUM_BINS; b++) {
      this.spectrumFrom[b] = toBin(MIN_FREQ * ratio ** (b / SPECTRUM_BINS));
      this.spectrumTo[b] = toBin(MIN_FREQ * ratio ** ((b + 1) / SPECTRUM_BINS));
    }
    for (let i = 0; i < this.tilt.length; i++) {
      const hz = Math.max(i * binHz, MIN_FREQ);
      this.tilt[i] = SPECTRUM_TILT * Math.log2(hz / 1000);
    }
  }
}

function shape(value: number): number {
  return value ** CONTRAST;
}

/** Mean power (dB) of the last `length` samples. */
function meanSquareDb(samples: Float32Array, length: number): number {
  let sum = 0;
  for (let i = samples.length - length; i < samples.length; i++) sum += samples[i] * samples[i];
  return 10 * Math.log10(sum / length + 1e-20);
}

/**
 * Power (dB) of the last `length` samples after a two-pole low-pass. The
 * filter runs over the whole window so it is settled when measuring.
 */
function lowpassEnergyDb(samples: Float32Array, cutoff: number, sampleRate: number, length: number): number {
  const a = Math.exp((-2 * Math.PI * cutoff) / sampleRate);
  const b = 1 - a;
  let y1 = 0;
  let y2 = 0;
  let sum = 0;
  const measureFrom = samples.length - length;
  for (let i = 0; i < samples.length; i++) {
    y1 = b * samples[i] + a * y1;
    y2 = b * y1 + a * y2;
    if (i >= measureFrom) sum += y2 * y2;
  }
  return 10 * Math.log10(sum / length + 1e-20);
}

/** Mean power (dB) of FFT bins [from, to). */
function bandPowerDb(magnitudes: Float32Array, from: number, to: number, scale: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += magnitudes[i] * magnitudes[i];
  return 10 * Math.log10((sum * scale) / Math.max(to - from, 1) + 1e-20);
}
