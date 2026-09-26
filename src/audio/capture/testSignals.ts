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
  { id: 'low', label: 'Low tone 60 Hz' },
  { id: 'mid', label: 'Mid tone 1 kHz' },
  { id: 'high', label: 'High tone 8 kHz' },
  { id: 'bassPulse', label: 'Bass pulse 120 BPM' },
  { id: 'hats', label: 'Hi-hat transients' },
  { id: 'noise', label: 'Pink noise' },
  { id: 'sweep', label: 'Sweep 30 Hz → 16 kHz' },
  { id: 'pad', label: 'Sustained chord' },
  { id: 'silence', label: 'Silence' },
] as const;

export type TestSignal = (typeof TEST_SIGNALS)[number]['id'];

export const DEFAULT_TEST_SIGNAL: TestSignal = 'beat124';

const TWO_PI = Math.PI * 2;
/** Duration of one sweep, seconds (then it restarts). */
const SWEEP_SECONDS = 20;
const SWEEP_FROM = 30;
const SWEEP_TO = 16000;

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
      case 'low':
        return Math.sin(TWO_PI * 60 * t) * 0.5;
      case 'mid':
        return Math.sin(TWO_PI * 1000 * t) * 0.3;
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
      case 'pad':
        return this.pad(t, 110) * 0.12;
      case 'silence':
        return 0;
    }
  }

  /** Four-on-the-floor kick, bass line, pad and off-beat hi-hats. */
  private beat(t: number, bpm: number): number {
    const beatLength = 60 / bpm;
    const beatPos = t % beatLength;
    const bar = Math.floor(t / (beatLength * 4));

    // Kick: pitch sweep 150 -> 45 Hz with a fast exponential decay.
    const kickEnv = Math.exp(-beatPos * 18);
    const kickFreq = 45 + 105 * Math.exp(-beatPos * 30);
    const kick = Math.sin(TWO_PI * kickFreq * beatPos) * kickEnv;

    // Bass: root note changes every bar.
    const root = ROOTS[bar % 4];
    const bassEnv = 0.6 + 0.4 * Math.exp(-((t % (beatLength / 2)) * 8));
    const bass = Math.sin(TWO_PI * root * t) * bassEnv;

    return kick * 0.55 + bass * 0.22 + this.pad(t, root) * 0.05 + this.hat(t, bpm, 1) * 0.18;
  }

  /** Minor chord on `root` × 4 with a slow tremolo. */
  private pad(t: number, root: number): number {
    const lfo = 0.5 + 0.5 * Math.sin(TWO_PI * 0.15 * t);
    return (Math.sin(TWO_PI * root * 4 * t) + Math.sin(TWO_PI * root * 4.757 * t) + Math.sin(TWO_PI * root * 6 * t)) * lfo;
  }

  /** High-passed noise bursts on the off-beats (`perBeat` = 2: every eighth). */
  private hat(t: number, bpm: number, perBeat: number): number {
    const step = 60 / bpm / perBeat;
    const pos = (t + step / 2) % step;
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
