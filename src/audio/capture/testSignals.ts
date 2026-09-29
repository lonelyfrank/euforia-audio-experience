/*
 * Deterministic test signals for the synthetic source. Each one isolates a
 * part of the music so the response of the analysis and of the scenes can be
 * checked by ear and eye (and in unit tests): a low tone should move the low
 * elements, a hi-hat only the fine detail, and so on.
 */

export const TEST_SIGNALS = [
  { id: 'beat124', label: 'Beat 124 BPM' },
  { id: 'beat90', label: 'Beat 90 BPM' },
  { id: 'beat174', label: 'Beat 174 BPM' },
  { id: 'tempoRamp', label: 'Tempo ramp 100 ↔ 140' },
  { id: 'buildDrop', label: 'Ambient → build → drop' },
  { id: 'fadeCut', label: 'Fade-out, then hard cut' },
  { id: 'phrases', label: 'Phrases over hiss (4 s on / 4 s off)' },
  { id: 'hiss', label: 'Noise floor only (≈ −60 dB hiss)' },
  { id: 'tone50', label: 'Tone 50 Hz' },
  { id: 'low', label: 'Low tone 60 Hz' },
  { id: 'tone120', label: 'Tone 120 Hz' },
  { id: 'tone400', label: 'Tone 400 Hz' },
  { id: 'mid', label: 'Mid tone 1 kHz' },
  { id: 'tone4k', label: 'Tone 4 kHz' },
  { id: 'high', label: 'High tone 8 kHz' },
  { id: 'bassPulse', label: 'Bass pulse 120 BPM' },
  { id: 'hats', label: 'Hi-hat transients' },
  { id: 'snares', label: 'Snare 2 & 4' },
  { id: 'noise', label: 'Pink noise' },
  { id: 'sweep', label: 'Sweep 30 Hz → 16 kHz' },
  { id: 'pad', label: 'Sustained chord' },
  { id: 'sawBass', label: 'Saw bass line' },
  { id: 'squareLead', label: 'Square lead melody' },
  { id: 'sineLead', label: 'Sine lead melody' },
  { id: 'synthPop', label: 'Synth pop (saw bass, square lead, drums)' },
  { id: 'silence', label: 'Silence' },
] as const;

export type TestSignal = (typeof TEST_SIGNALS)[number]['id'];

export const DEFAULT_TEST_SIGNAL: TestSignal = 'beat124';

const TWO_PI = Math.PI * 2;
/** Duration of one sweep, seconds (then it restarts). */
const SWEEP_SECONDS = 20;
const SWEEP_FROM = 30;
const SWEEP_TO = 16000;
/** Tempo ramp: 100 → 140 BPM and back over this many seconds. */
const RAMP_SECONDS = 60;
/** Build/drop cycle (s) at 128 BPM: ambient until AMBIENT_END, build until BUILD_END, then the drop. */
const CYCLE_SECONDS = 32;
const AMBIENT_END = 10;
const BUILD_END = 18;
/** Hiss level: a noisy input's floor, ≈ −60 dBFS. */
const HISS_GAIN = 0.002;
/** Phrases: seconds of music, then as many of hiss alone. */
export const PHRASE_SECONDS = 4;

/** Generates one test signal sample by sample. Allocation-free. */
export class SignalGenerator {
  private clock = 0;
  private noiseSeed = 1;
  private prevNoise = 0;
  private sweepPhase = 0;
  /** Pink noise filter state (Paul Kellet's economy filter). */
  private p0 = 0;
  private p1 = 0;
  private p2 = 0;
  /** Musical clock (beats) for signals whose tempo changes. */
  private beats = 0;
  /** One-pole low-pass state for the snare noise. */
  private snareLow = 0;
  /** Oscillator phases (cycles, 0..1) for the synth voices. */
  private bassPhase = 0;
  private leadPhase = 0;

  constructor(
    readonly signal: TestSignal,
    readonly sampleRate: number,
  ) {}

  /** Writes `count` samples into `out` starting at `offset`. */
  fill(out: Float32Array, offset: number, count: number): void {
    for (let i = 0; i < count; i++) out[offset + i] = this.next();
  }

  next(): number {
    const t = this.clock++ / this.sampleRate;
    switch (this.signal) {
      case 'beat124':
        return this.beat(t, 124);
      case 'beat90':
        return this.beat(t, 90);
      case 'beat174':
        return this.beat(t, 174);
      case 'tempoRamp': {
        const x = (t % RAMP_SECONDS) / RAMP_SECONDS;
        const bpm = 100 + 40 * (1 - Math.abs(2 * x - 1));
        this.beats += bpm / 60 / this.sampleRate;
        return this.groove(this.beats, bpm, t, 1, 0);
      }
      case 'buildDrop':
        return this.buildDrop(t);
      case 'fadeCut':
        return this.beat(t, 124) * fadeCutGain(t);
      case 'snares': {
        const beatLength = 60 / 100;
        // Beats 2 and 4 of each bar.
        const beatInBar = Math.floor(t / beatLength) % 4;
        return beatInBar % 2 === 1 ? this.snare(t % beatLength) * 0.5 : 0;
      }
      case 'hiss':
        return this.pink() * HISS_GAIN;
      case 'phrases': {
        const on = Math.floor(t / PHRASE_SECONDS) % 2 === 0;
        return this.pink() * HISS_GAIN + (on ? this.beat(t, 124) : 0);
      }
      case 'tone50':
        return Math.sin(TWO_PI * 50 * t) * 0.5;
      case 'low':
        return Math.sin(TWO_PI * 60 * t) * 0.5;
      case 'tone120':
        return Math.sin(TWO_PI * 120 * t) * 0.45;
      case 'tone400':
        return Math.sin(TWO_PI * 400 * t) * 0.35;
      case 'mid':
        return Math.sin(TWO_PI * 1000 * t) * 0.3;
      case 'tone4k':
        return Math.sin(TWO_PI * 4000 * t) * 0.25;
      case 'high':
        return Math.sin(TWO_PI * 8000 * t) * 0.2;
      case 'bassPulse': {
        const pos = t % (60 / 120);
        // Soft attack (no click, so no high-frequency content) and a long decay.
        const env = (1 - Math.exp(-pos * 200)) * Math.exp(-pos * 7);
        return Math.sin(TWO_PI * 55 * t) * env * 0.6;
      }
      case 'hats':
        return this.hat(t, 124, 2) * 0.35;
      case 'noise':
        return this.pink() * 0.25;
      case 'sweep': {
        const pos = (t % SWEEP_SECONDS) / SWEEP_SECONDS;
        const hz = SWEEP_FROM * (SWEEP_TO / SWEEP_FROM) ** pos;
        this.sweepPhase = (this.sweepPhase + (TWO_PI * hz) / this.sampleRate) % TWO_PI;
        return Math.sin(this.sweepPhase) * 0.3;
      }
      case 'sawBass':
        return this.saw('bass', BASS_NOTES[Math.floor(t / 2) % BASS_NOTES.length]) * 0.4;
      case 'squareLead':
        return this.square(LEAD_NOTES[Math.floor(t / 0.5) % LEAD_NOTES.length]) * 0.25;
      case 'sineLead':
        return Math.sin(2 * Math.PI * this.advance('lead', LEAD_NOTES[Math.floor(t / 0.5) % LEAD_NOTES.length])) * 0.3;
      case 'synthPop': {
        const beats = (t * 120) / 60;
        const bass = this.saw('bass', BASS_NOTES[Math.floor(beats / 4) % BASS_NOTES.length]) * 0.25;
        const lead = this.square(LEAD_NOTES[Math.floor(beats) % LEAD_NOTES.length]) * 0.1;
        return this.groove(beats, 120, t, 0.8, 0.6) * 0.6 + bass + lead;
      }
      case 'pad':
        return this.pad(t, 110) * 0.12;
      case 'silence':
        return 0;
    }
  }

  /** Four-on-the-floor kick, bass line, pad and off-beat hi-hats. */
  private beat(t: number, bpm: number): number {
    return this.groove((t * bpm) / 60, bpm, t, 1, 0);
  }

  /**
   * Groove at a musical position `beats` (so the tempo may change): kick on
   * every beat, bass line, pad, off-beat hats and, with `snare` > 0, a snare
   * on 2 and 4. `drums` scales kick and hats.
   */
  private groove(beats: number, bpm: number, t: number, drums: number, snare: number): number {
    const beatLength = 60 / bpm;
    const beatPos = (beats - Math.floor(beats)) * beatLength;
    const bar = Math.floor(beats / 4);

    // Kick: pitch sweep 150 -> 45 Hz with a fast exponential decay.
    const kickEnv = Math.exp(-beatPos * 18);
    const kickFreq = 45 + 105 * Math.exp(-beatPos * 30);
    const kick = Math.sin(TWO_PI * kickFreq * beatPos) * kickEnv;

    // Bass: root note changes every bar.
    const root = ROOTS[bar % 4];
    const bassEnv = 0.6 + 0.4 * Math.exp(-((beatPos % (beatLength / 2)) * 8));
    const bass = Math.sin(TWO_PI * root * t) * bassEnv;

    // Hats on the off-beats.
    const hatPos = (beatPos + beatLength / 2) % beatLength;
    const snareHit = Math.floor(beats) % 2 === 1 ? this.snare(beatPos) : 0;

    return (kick * 0.55 + this.hatAt(hatPos) * 0.18) * drums + bass * 0.22 + this.pad(t, root) * 0.05 + snareHit * 0.3 * snare;
  }

  /** Ambient pad, then a build (hats and snare roll speeding up, noise riser), then the full groove. */
  private buildDrop(t: number): number {
    const bpm = 128;
    const beatLength = 60 / bpm;
    const c = t % CYCLE_SECONDS;
    if (c < AMBIENT_END) return this.pad(t, 55) * 0.1;
    if (c < BUILD_END) {
      const x = (c - AMBIENT_END) / (BUILD_END - AMBIENT_END);
      // Snare roll: quarters, then eighths, sixteenths, thirty-seconds.
      const step = beatLength / 2 ** Math.min(Math.floor(x * 4), 3);
      const roll = this.snare(c % step) * (0.1 + 0.3 * x);
      const hats = this.hatAt((c + step / 2) % step) * 0.2 * x;
      const riser = this.white() * 0.12 * x * x;
      return this.pad(t, 55) * 0.1 + roll + hats + riser;
    }
    return this.groove((c * bpm) / 60, bpm, t, 1.1, 1);
  }

  /** Snare `pos` seconds after its hit: a short 190 Hz body and low-passed noise. */
  private snare(pos: number): number {
    const noise = this.white();
    this.snareLow += (noise - this.snareLow) * 0.35;
    return Math.sin(TWO_PI * 190 * pos) * Math.exp(-pos * 30) * 0.6 + this.snareLow * Math.exp(-pos * 22);
  }

  /** Advances an oscillator phase by one sample at `hz`; returns the phase (cycles, 0..1). */
  private advance(voice: 'bass' | 'lead', hz: number): number {
    const step = hz / this.sampleRate;
    if (voice === 'bass') return (this.bassPhase = (this.bassPhase + step) % 1);
    return (this.leadPhase = (this.leadPhase + step) % 1);
  }

  /** Band-limited sawtooth (polyBLEP), -1..1. */
  private saw(voice: 'bass' | 'lead', hz: number): number {
    const step = hz / this.sampleRate;
    const phase = this.advance(voice, hz);
    return 2 * phase - 1 - polyBlep(phase, step);
  }

  /** Band-limited square (polyBLEP), -1..1. */
  private square(hz: number): number {
    const step = hz / this.sampleRate;
    const phase = this.advance('lead', hz);
    return (phase < 0.5 ? 1 : -1) + polyBlep(phase, step) - polyBlep((phase + 0.5) % 1, step);
  }

  /** Minor chord on `root` × 4 with a slow tremolo. */
  private pad(t: number, root: number): number {
    const lfo = 0.5 + 0.5 * Math.sin(TWO_PI * 0.15 * t);
    return (Math.sin(TWO_PI * root * 4 * t) + Math.sin(TWO_PI * root * 4.757 * t) + Math.sin(TWO_PI * root * 6 * t)) * lfo;
  }

  /** High-passed noise bursts on the off-beats (`perBeat` = 2: every eighth). */
  private hat(t: number, bpm: number, perBeat: number): number {
    const step = 60 / bpm / perBeat;
    return this.hatAt((t + step / 2) % step);
  }

  /** Hi-hat `pos` seconds after its hit (differenced noise = high-passed). */
  private hatAt(pos: number): number {
    const noise = this.white();
    const hat = (noise - this.prevNoise) * Math.exp(-pos * 45);
    this.prevNoise = noise;
    return hat;
  }

  /** Cheap deterministic white noise in -1..1. */
  private white(): number {
    this.noiseSeed = (this.noiseSeed * 1664525 + 1013904223) >>> 0;
    return this.noiseSeed / 2147483648 - 1;
  }

  private pink(): number {
    const white = this.white();
    this.p0 = 0.99765 * this.p0 + white * 0.099046;
    this.p1 = 0.963 * this.p1 + white * 0.2965164;
    this.p2 = 0.57 * this.p2 + white * 1.0526913;
    return (this.p0 + this.p1 + this.p2 + white * 0.1848) * 0.25;
  }
}

const ROOTS = [55, 55, 65.41, 49];

/**
 * 12 s cycle: 4 s of music, a 4 s fade-out (linear in dB down to -60), 1 s
 * of silence, 2 s of music, then a hard cut and 1 s of silence.
 */
export const FADE_CUT = { cycle: 12, fadeStart: 4, fadeEnd: 8, restart: 9, cut: 11 } as const;

function fadeCutGain(t: number): number {
  const c = t % FADE_CUT.cycle;
  if (c < FADE_CUT.fadeStart) return 1;
  if (c < FADE_CUT.fadeEnd) return 10 ** ((-60 * (c - FADE_CUT.fadeStart)) / (FADE_CUT.fadeEnd - FADE_CUT.fadeStart) / 20);
  if (c < FADE_CUT.restart) return 0;
  if (c < FADE_CUT.cut) return 1;
  return 0;
}
/** Bass line (A1, A1, C2, G1) and lead melody (A3 C4 E4 G4 A4 G4 E4 C4) for the synth voices. */
const BASS_NOTES = [55, 55, 65.41, 49];
const LEAD_NOTES = [220, 261.63, 329.63, 392, 440, 392, 329.63, 261.63];

/** PolyBLEP residual: smooths an oscillator's discontinuity at phase 0 (removes aliasing). */
function polyBlep(phase: number, step: number): number {
  if (phase < step) {
    const x = phase / step;
    return x + x - x * x - 1;
  }
  if (phase > 1 - step) {
    const x = (phase - 1) / step;
    return x * x + x + x + 1;
  }
  return 0;
}
