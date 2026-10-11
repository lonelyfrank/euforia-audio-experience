/** Below this width the paired columns of a chart stack: an inspector column shows one, a wide inspector two. */
export const TWO_COLUMNS = 520;
export const columnsFor = (width: number): 1 | 2 => (width >= TWO_COLUMNS ? 2 : 1);

/**
 * Packs short readouts into as few rows as fit: `fits` says whether a row still fits its host, `emit` receives each
 * finished row. A readout is never split; one that does not fit by itself still gets its own row (the caller squeezes it).
 */
export function packRows(parts: readonly string[], separator: string, fits: (row: string) => boolean, emit: (row: string) => void): void {
  let row = '';
  for (const part of parts) {
    if (!part) continue;
    const next = row ? row + separator + part : part;
    if (row && !fits(next)) { emit(row); row = part; } else row = next;
  }
  if (row) emit(row);
}
