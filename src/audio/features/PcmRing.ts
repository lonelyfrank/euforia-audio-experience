/**
 * Single-producer / single-consumer ring of interleaved PCM frames, laid out
 * so it can live in a SharedArrayBuffer between the AudioWorklet (producer)
 * and the analysis worker (consumer), or in a plain ArrayBuffer inside one
 * thread (fallback without cross-origin isolation, tests).
 *
 * Layout (tap.worklet.js mirrors `write`; keep both in sync):
 * - Int32 [0] frames ever written (wrapping), [1] wake-up sequence, [2] frames of
 *   silence the producer inserted for skipped render quanta;
 * - Float32 data from byte HEADER, `capacity × channels` values.
 * `capacity` is a power of two so the wrapping counter indexes it directly.
 * The counter is published with Atomics.store after the data: the consumer
 * never reads a frame before it is complete.
 */
export const HEADER = 16;
export const WRITTEN = 0;
export const SEQUENCE = 1;
export const FILLED = 2;

export class PcmRing {
  readonly state: Int32Array;
  readonly data: Float32Array;
  readonly capacity: number;
  /** Frames the consumer skipped since it last reset this (the producer outran it). */
  lost = 0;
  private read = 0;

  /** Bytes for a ring of at least `frames` frames (rounded up to a power of two). */
  static bytes(frames: number, channels: number): number {
    return HEADER + ceilPow2(frames) * channels * 4;
  }

  constructor(readonly buffer: SharedArrayBuffer | ArrayBuffer, readonly channels: number) {
    this.state = new Int32Array(buffer, 0, 4);
    this.capacity = (buffer.byteLength - HEADER) / (channels * 4);
    if (this.capacity !== ceilPow2(this.capacity)) throw new Error('PcmRing capacity must be a power of two');
    this.data = new Float32Array(buffer, HEADER, this.capacity * channels);
    this.read = Atomics.load(this.state, WRITTEN);
  }

  /** Producer: appends `frames` interleaved frames. */
  write(block: Float32Array, frames: number): void {
    const { data, channels, state } = this;
    const mask = this.capacity - 1;
    let w = Atomics.load(state, WRITTEN);
    for (let i = 0; i < frames; i++, w = (w + 1) | 0) {
      const at = (w & mask) * channels;
      for (let c = 0; c < channels; c++) data[at + c] = block[i * channels + c];
    }
    Atomics.store(state, WRITTEN, w);
    Atomics.add(state, SEQUENCE, 1);
    Atomics.notify(state, SEQUENCE);
  }

  /** Frames written since the previous read (may exceed the capacity: the oldest are lost). */
  available(): number {
    return (Atomics.load(this.state, WRITTEN) - this.read) | 0;
  }

  /**
   * Consumer: copies up to `out.length / channels` frames, oldest first; returns
   * how many. Frames overwritten before they were read are skipped and counted in `lost`.
   */
  readInto(out: Float32Array): number {
    const { data, channels } = this;
    const mask = this.capacity - 1;
    const written = Atomics.load(this.state, WRITTEN);
    let available = (written - this.read) | 0;
    if (available > this.capacity) {
      this.lost += available - this.capacity;
      this.read = (written - this.capacity) | 0;
      available = this.capacity;
    }
    const frames = Math.min(available, Math.floor(out.length / channels));
    for (let i = 0; i < frames; i++) {
      const at = ((this.read + i) & mask) * channels;
      for (let c = 0; c < channels; c++) out[i * channels + c] = data[at + c];
    }
    this.read = (this.read + frames) | 0;
    return frames;
  }
}

export function ceilPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
