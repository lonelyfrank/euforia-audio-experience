import type { AudioFrame, VisualResponseFrame } from '../../types/audio';

/** Samples of one row: one cycle of a voice (the size of the analyzer's cycle shapes). */
export const SIGNAL_SIZE = 128;
/** Rows of history kept per voice. */
export const SIGNAL_ROWS = 24;
/** Voices: 0 the low one (the bass line), 1 the high one (the lead, or the raw waveform when nothing is pitched). */
export const SIGNAL_VOICES = 2;
/** Rows pushed in one update at most (a long stall slows the history instead of smearing one instant over it). */
const MAX_PUSH = 4;
/** Lobes a voice winds round its ring: 1 at 55 Hz, about one and a half more per octave. */
const LOBES_MIN = 1;
const LOBES_MAX = 9;
const LOBES_TAU = 0.25;

/**
 * The waveform as a generator of geometry: PCM → one cycle per voice
 * (resampled, normalized) → rows of a history → what formLaw.ts bends into a
 * curve, a ribbon and a surface in space. Nothing is drawn here.
 *
 * Each voice has a ring of rows. The newest row is live: it is rewritten every
 * update with the voice's cycle as the analyzer shows it (the real shape of
 * the sound: sine, sawtooth, square, clipped …), scaled by how present and
 * clear the voice is, so an absent voice writes a flat row. When nothing is
 * pitched the high voice carries the raw waveform window instead: it changes
 * from one update to the next, and matter cannot settle on it. The history
 * advances by `flow` rows per second, given by the caller from the world's
 * motion: in a still world the history stands still.
 *
 * Rendering history only. Deterministic and allocation-free.
 */
export class SignalForm {
  /** Single-channel floats, SIGNAL_SIZE × (SIGNAL_ROWS × SIGNAL_VOICES): voice v, ring row r at row v × SIGNAL_ROWS + r. */
  readonly data = new Float32Array(SIGNAL_SIZE * SIGNAL_ROWS * SIGNAL_VOICES);
  /** Ring row being written, and how far (0..1) the history has moved towards the next one. */
  head = 0;
  frac = 0;
  /** Lobes each voice winds round its ring (continuous; the law blends the two whole numbers around it). */
  readonly lobes = new Float32Array(SIGNAL_VOICES).fill(LOBES_MIN);
  /** How present and clear each voice is (0..1): a voice that is not there holds no matter (the raw waveform alone does not). */
  readonly level = new Float32Array(SIGNAL_VOICES);
  /** Increments whenever `data` changes. */
  version = 0;

  /** `flow`: rows of history per second (≥ 0). */
  update(dt: number, flow: number, frame: AudioFrame, response: VisualResponseFrame): void {
    const h = dt > 0 ? Math.min(dt, 0.25) : 0;
    const music = response.music;
    this.frac += Math.max(0, Number.isFinite(flow) ? flow : 0) * h;
    for (let pushed = 0; this.frac >= 1 && pushed < MAX_PUSH; pushed++) {
      this.frac -= 1;
      // The row that was live becomes history as it is; the new head starts from it.
      const next = (this.head + 1) % SIGNAL_ROWS;
      for (let v = 0; v < SIGNAL_VOICES; v++) {
        const from = (v * SIGNAL_ROWS + this.head) * SIGNAL_SIZE;
        this.data.copyWithin((v * SIGNAL_ROWS + next) * SIGNAL_SIZE, from, from + SIGNAL_SIZE);
      }
      this.head = next;
    }
    if (this.frac >= 1) this.frac = 0.999;
    const bass = clamp01(music.bassVoice), lead = clamp01(music.leadVoice);
    // Unpitched sound has a shape too: the waveform itself, as far as anything is audible.
    const raw = (1 - lead) * clamp01(response.audible) * 0.35;
    const low = (0 * SIGNAL_ROWS + this.head) * SIGNAL_SIZE, high = (1 * SIGNAL_ROWS + this.head) * SIGNAL_SIZE;
    const waveform = frame.waveform, block = Math.max(1, Math.floor(waveform.length / SIGNAL_SIZE));
    for (let i = 0; i < SIGNAL_SIZE; i++) {
      this.data[low + i] = finite(music.bassLine[i]) * bass;
      let sum = 0;
      if (raw > 0) for (let k = 0; k < block; k++) sum += waveform[i * block + k];
      this.data[high + i] = finite(music.leadLine[i]) * lead + finite(sum / block) * raw;
    }
    this.level[0] = bass; this.level[1] = lead;
    const glide = 1 - Math.exp(-h / LOBES_TAU);
    this.lobes[0] += (lobesOf(music.bassPitch) - this.lobes[0]) * glide;
    this.lobes[1] += (lobesOf(music.leadPitch) - this.lobes[1]) * glide;
    this.version++;
  }

  reset(): void {
    this.data.fill(0);
    this.head = 0; this.frac = 0;
    this.lobes.fill(LOBES_MIN); this.level.fill(0);
    this.version++;
  }
}

function lobesOf(hz: number): number {
  if (!(hz > 0) || !Number.isFinite(hz)) return LOBES_MIN;
  return Math.min(LOBES_MAX, Math.max(LOBES_MIN, 1 + 1.5 * Math.log2(hz / 55)));
}

const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
const finite = (x: number): number => (x > -1 ? (x < 1 ? x : 1) : x <= -1 ? -1 : 0);
