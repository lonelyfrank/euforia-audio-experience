import { BaseCaptureProvider } from './BaseCaptureProvider';
import { SampleRingBuffer } from './SampleRingBuffer';

const SAMPLE_RATE = 48000;
const BPM = 124;
const BEAT = 60 / BPM;
const TWO_PI = Math.PI * 2;
/** Never synthesize more than this per read (e.g. after the tab was hidden). */
const MAX_CATCH_UP = 0.25;

/**
 * Deterministic synthetic "music": a four-on-the-floor kick, a bass line,
 * a slowly modulated pad and off-beat hi-hats. It produces real PCM so the
 * whole analysis pipeline is exercised without any audio device.
 */
export class FakeAudioProvider extends BaseCaptureProvider {
  private readonly ring = new SampleRingBuffer(SAMPLE_RATE);
  private readonly chunk = new Float32Array(Math.ceil(SAMPLE_RATE * MAX_CATCH_UP));
  private sampleClock = 0;
  private lastRead = 0;
  private running = false;
  private noiseSeed = 1;
  private prevNoise = 0;

  constructor() {
    super('fake');
    this.sampleRate = SAMPLE_RATE;
    this.deviceName = 'Fake audio generator';
  }

  async start(): Promise<void> {
    this.ring.clear();
    this.sampleClock = 0;
    this.lastRead = performance.now();
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  readSamples(out: Float32Array, delay: number): void {
    if (this.running) {
      const now = performance.now();
      const elapsed = Math.min((now - this.lastRead) / 1000, MAX_CATCH_UP);
      this.lastRead = now;
      const count = Math.floor(elapsed * SAMPLE_RATE);
      this.synthesize(count);
      this.ring.write(this.chunk, 0, count);
    }
    this.ring.readLatest(out, delay);
  }

  private synthesize(count: number): void {
    const out = this.chunk;
    for (let i = 0; i < count; i++) {
      const t = this.sampleClock++ / SAMPLE_RATE;
      const beatPos = t % BEAT;
      const bar = Math.floor(t / (BEAT * 4));

      // Kick: pitch sweep 150 -> 45 Hz with a fast exponential decay.
      const kickEnv = Math.exp(-beatPos * 18);
      const kickFreq = 45 + 105 * Math.exp(-beatPos * 30);
      const kick = Math.sin(TWO_PI * kickFreq * beatPos) * kickEnv;

      // Bass: root note changes every bar.
      const root = [55, 55, 65.41, 49][bar % 4];
      const bassEnv = 0.6 + 0.4 * Math.exp(-((t % (BEAT / 2)) * 8));
      const bass = Math.sin(TWO_PI * root * t) * bassEnv;

      // Pad: minor chord with slow tremolo.
      const lfo = 0.5 + 0.5 * Math.sin(TWO_PI * 0.15 * t);
      const pad =
        (Math.sin(TWO_PI * root * 4 * t) +
          Math.sin(TWO_PI * root * 4.757 * t) +
          Math.sin(TWO_PI * root * 6 * t)) *
        lfo;

      // Hi-hat: high-passed noise on the off-beats.
      const hatPos = (t + BEAT / 2) % BEAT;
      const hatEnv = Math.exp(-hatPos * 45);
      const noise = this.noise();
      const hat = (noise - this.prevNoise) * hatEnv;
      this.prevNoise = noise;

      out[i] = kick * 0.55 + bass * 0.22 + pad * 0.05 + hat * 0.18;
    }
  }

  /** Cheap deterministic white noise in -1..1. */
  private noise(): number {
    this.noiseSeed = (this.noiseSeed * 1664525 + 1013904223) >>> 0;
    return this.noiseSeed / 2147483648 - 1;
  }
}
