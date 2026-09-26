import { ClampToEdgeWrapping, DataTexture, LinearFilter, RedFormat, UnsignedByteType } from 'three';

/**
 * A 1D signal (spectrum, waveform…) as an N×1 single-channel texture, so
 * fragment shaders can sample it at any position with linear filtering.
 * 8 bits are plenty for display. `write` reuses the same buffer every frame.
 */
export class SignalTexture {
  readonly texture: DataTexture;
  private readonly data: Uint8Array;

  constructor(readonly size: number) {
    this.data = new Uint8Array(size);
    this.texture = new DataTexture(this.data, size, 1, RedFormat, UnsignedByteType);
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearFilter;
    this.texture.wrapS = ClampToEdgeWrapping;
    this.texture.wrapT = ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /** Values in 0..1, or -1..1 with `signed` (stored as 0.5 ± v/2). Resampled if the length differs. */
  write(values: ArrayLike<number>, signed = false): void {
    const { data, size } = this;
    const ratio = values.length / size;
    for (let i = 0; i < size; i++) {
      let v = values[Math.floor(i * ratio)];
      if (signed) v = v * 0.5 + 0.5;
      data[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
