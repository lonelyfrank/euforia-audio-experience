/**
 * In-place iterative radix-2 FFT for real input. Tables are precomputed so a
 * transform performs no allocation.
 */
export class FFT {
  readonly size: number;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly reverse: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${size}`);
    this.size = size;
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    this.reverse = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.reverse[i] = r;
    }
  }

  /**
   * Transforms `input` (length = size, already windowed) and writes the
   * magnitudes of the first size/2 bins into `magnitudes`.
   */
  magnitudes(input: Float32Array, magnitudes: Float32Array): void {
    const { size, re, im, cos, sin, reverse } = this;
    for (let i = 0; i < size; i++) {
      re[reverse[i]] = input[i];
      im[i] = 0;
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1;
      const step = size / len;
      for (let start = 0; start < size; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step];
          const wi = sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    const bins = size >> 1;
    for (let i = 0; i < bins; i++) magnitudes[i] = Math.hypot(re[i], im[i]);
  }
}
