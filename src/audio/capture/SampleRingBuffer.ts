/** Fixed-size circular buffer of mono samples. Allocation-free after construction. */
export class SampleRingBuffer {
  private readonly data: Float32Array;
  private writeIndex = 0;
  /** Samples ever written, and how many of them `drain` has handed out. */
  private written = 0;
  private drained = 0;

  constructor(capacity: number) {
    this.data = new Float32Array(capacity);
  }

  write(samples: ArrayLike<number>, offset = 0, length = samples.length - offset): void {
    const { data } = this;
    const cap = data.length;
    // Only the tail can survive if the chunk is larger than the buffer.
    if (length > cap) {
      offset += length - cap;
      length = cap;
    }
    let w = this.writeIndex;
    for (let i = 0; i < length; i++) {
      data[w] = samples[offset + i];
      w = w + 1 === cap ? 0 : w + 1;
    }
    this.writeIndex = w;
    this.written += length;
  }

  /**
   * Copies samples written since the previous drain into `out`, oldest first;
   * returns how many (call again while it fills `out`). If more than the
   * capacity piled up, the oldest are skipped.
   */
  drain(out: Float32Array): number {
    const { data } = this;
    const cap = data.length;
    if (this.written - this.drained > cap) this.drained = this.written - cap;
    const n = Math.min(out.length, this.written - this.drained);
    let r = (((this.writeIndex - (this.written - this.drained)) % cap) + cap) % cap;
    for (let i = 0; i < n; i++) {
      out[i] = data[r];
      r = r + 1 === cap ? 0 : r + 1;
    }
    this.drained += n;
    return n;
  }

  /**
   * Copies `out.length` samples into `out`, oldest first, ending `delay`
   * samples before the newest one.
   */
  readLatest(out: Float32Array, delay = 0): void {
    const { data } = this;
    const cap = data.length;
    const n = Math.min(out.length, cap);
    const back = Math.min(Math.max(delay, 0), cap - n);
    let r = (((this.writeIndex - n - back) % cap) + cap) % cap;
    for (let i = 0; i < n; i++) {
      out[i] = data[r];
      r = r + 1 === cap ? 0 : r + 1;
    }
    out.fill(0, n);
  }

  clear(): void {
    this.data.fill(0);
    this.writeIndex = 0;
    this.written = 0;
    this.drained = 0;
  }
}
