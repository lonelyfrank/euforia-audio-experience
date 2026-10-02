/** Reuses the analyzer's FFT magnitudes; no buffers, display gain or second FFT. */
export function measureSpectralShape(
  magnitudes: Float32Array, binHz: number,
  out: { centroidHz: number; rolloffHz: number; spreadHz: number }, silent = false,
): void {
  const from = Math.max(1, Math.ceil(20 / binHz));
  const to = Math.min(magnitudes.length, Math.floor(16000 / binHz) + 1);
  let power = 0, first = 0, second = 0;
  for (let i = from; i < to; i++) {
    const p = magnitudes[i] ** 2;
    const hz = i * binHz;
    power += p;
    first += p * hz;
    second += p * hz * hz;
  }
  if (silent || power < 1e-20) {
    out.centroidHz = out.rolloffHz = out.spreadHz = 0;
    return;
  }
  out.centroidHz = first / power;
  out.spreadHz = Math.sqrt(Math.max(0, second / power - out.centroidHz ** 2));
  let cumulative = 0;
  for (let i = from; i < to; i++) {
    cumulative += magnitudes[i] ** 2;
    if (cumulative >= power * 0.85) { out.rolloffHz = i * binHz; break; }
  }
}
