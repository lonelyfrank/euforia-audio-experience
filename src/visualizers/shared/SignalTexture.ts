import { ClampToEdgeWrapping, DataTexture, LinearFilter, RedFormat, UnsignedByteType } from 'three';

/**
 * 1D signals (spectrum, waveform, histories…) as an N×rows single-channel
 * texture, one signal per row, so fragment shaders can sample them at any
 * position with linear filtering (row r at v = (r + 0.5) / rows).
 * 8 bits are plenty for display. `write` reuses the same buffer every frame.
 */
export class SignalTexture {
  readonly texture: DataTexture;
  private readonly data: Uint8Array;

  constructor(
    readonly size: number,
    readonly rows = 1,
  ) {
    this.data = new Uint8Array(size * rows);
    this.texture = new DataTexture(this.data, size, rows, RedFormat, UnsignedByteType);
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearFilter;
    this.texture.wrapS = ClampToEdgeWrapping;
    this.texture.wrapT = ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /**
   * Writes one row: values in 0..1, or -1..1 with `signed` (stored as 0.5 ± v/2),
   * resampled if the length differs. `offset`/`length` select a slice of `values`.
   */
  write(values: ArrayLike<number>, signed = false, row = 0, offset = 0, length = values.length): void {
    const { data, size } = this;
    const ratio = length / size;
    const base = row * size;
    for (let i = 0; i < size; i++) {
      let v = values[offset + Math.floor(i * ratio)];
      if (signed) v = v * 0.5 + 0.5;
      data[base + i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
