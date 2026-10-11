import { describe, expect, it } from 'vitest';
import { columnsFor, packRows, TWO_COLUMNS } from './chartLayout';

/** A stand-in for the canvas: every character is one unit wide. */
const pack = (parts: string[], width: number, separator = ' · '): string[] => {
  const rows: string[] = [];
  packRows(parts, separator, row => row.length <= width, row => rows.push(row));
  return rows;
};
describe('inspector chart layout', () => {
  it('stacks the paired columns in an inspector column and pairs them in a wide one', () => {
    for (const width of [320, 356, 380, TWO_COLUMNS - 1]) expect(columnsFor(width)).toBe(1);
    for (const width of [TWO_COLUMNS, 600, 736]) expect(columnsFor(width)).toBe(2);
  });
  it('keeps one row where the readouts fit and wraps whole readouts where they do not', () => {
    const parts = ['Tempo 124.0', 'pace ×1.00', 'song #3', '16.7 ms'];
    expect(pack(parts, 80)).toEqual(['Tempo 124.0 · pace ×1.00 · song #3 · 16.7 ms']);
    expect(pack(parts, 26)).toEqual(['Tempo 124.0 · pace ×1.00', 'song #3 · 16.7 ms']);
    // Nothing is lost or split, at any width.
    for (let width = 1; width < 60; width++) expect(pack(parts, width).join(' · ')).toBe(parts.join(' · '));
  });
  it('gives a readout wider than the host its own row and skips absent ones', () => {
    expect(pack(['a', 'a readout far too long', 'b'], 6)).toEqual(['a', 'a readout far too long', 'b']);
    expect(pack(['presence 1.00', '', 'width 0.20'], 80)).toEqual(['presence 1.00 · width 0.20']);
    expect(pack([], 80)).toEqual([]);
    expect(pack(['', ''], 80)).toEqual([]);
  });
});
