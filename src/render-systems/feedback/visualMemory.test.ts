import { describe, expect, it } from 'vitest';
import { createWorld, type WorldState } from '../../world/WorldState';
import { WorldView } from '../../world/WorldView';
import { createMemory, deriveMemory, MAX_PERSISTENCE, MEMORY_CEILING, memoryDecay, remember, type VisualMemory } from './visualMemory';

const NEUTRAL = { motion: 1, expansion: 1, turbulence: 1 };
function memoryOf(set: (w: WorldState) => void, persistence = 0.5, light = 0): VisualMemory {
  const world = createWorld(), view = new WorldView();
  set(world);
  view.update(world, NEUTRAL);
  return deriveMemory(createMemory(), view, persistence, light);
}
/** One pixel fed `fresh(t)` for `seconds` at `fps`; returns what the memory holds at the end. */
function pixel(memory: VisualMemory, fps: number, seconds: number, fresh: (t: number) => number, grain = 0): number {
  let held = 0;
  for (let frame = 1; frame <= Math.round(fps * seconds); frame++) held = remember(held, fresh(frame / fps), memoryDecay(memory.persistence, 1 / fps), memory, grain);
  return held;
}

describe('visual memory', () => {
  it('coherence keeps it long and clean, turbulence breaks it, shimmer shortens it, an admitted impact is brief and strong', () => {
    const coherent = memoryOf((w) => { w.coherence = 1; });
    const turbulent = memoryOf((w) => { w.coherence = 0.3; w.turbulence = 0.9; });
    expect(coherent.persistence).toBeGreaterThan(turbulent.persistence * 3);
    expect(coherent.irregularity).toBe(0);
    expect(turbulent.irregularity).toBeGreaterThan(0.8);
    expect(memoryOf((w) => { w.shimmer = 0.9; }).persistence).toBeLessThan(coherent.persistence * 0.6);
    const hit = memoryOf((w) => { w.coherence = 1; }, 0.5, 1);
    expect(hit.persistence).toBeLessThan(coherent.persistence);
    expect(hit.imprint).toBeGreaterThan(1.3);
    // The Director's persistence (mood, experience) lengthens it, within the bound.
    expect(memoryOf((w) => { w.coherence = 1; }, 1).persistence).toBeGreaterThan(coherent.persistence);
    expect(memoryOf((w) => { w.coherence = 1e9; w.turbulence = NaN; w.shimmer = -5; }, 1e9, NaN).persistence).toBeLessThanOrEqual(MAX_PERSISTENCE);
  });

  it('fades the same at 30, 60 and 144 frames per second', () => {
    const memory = memoryOf((w) => { w.coherence = 0.8; });
    // A flash at the start, then darkness: what is left after one second.
    const left = [30, 60, 144].map((fps) => pixel(memory, fps, 1 + 1 / fps, (t) => (t <= 1 / fps + 1e-9 ? 1 : 0)));
    expect(left[0]).toBeGreaterThan(0.05);
    expect(left[1]).toBeCloseTo(left[0], 6);
    expect(left[2]).toBeCloseTo(left[0], 6);
  });

  it('cannot run away: a steady or flickering bright image stays bounded for minutes', () => {
    const longest = memoryOf((w) => { w.coherence = 1; w.excitation = 1; }, 1, 1);
    for (const fps of [30, 144]) {
      const steady = pixel(longest, fps, 300, () => 1);
      // A steady image leaves at most itself times its imprint and what it gathers on its own trace.
      expect(steady).toBeLessThanOrEqual(Math.max(longest.imprint, 1 + longest.accumulate) + 1e-6);
      const flicker = pixel(longest, fps, 300, (t) => (Math.sin(t * 40) > 0 ? 3 : 0));
      expect(flicker).toBeLessThanOrEqual(MEMORY_CEILING);
      expect(pixel(longest, fps, 300, () => 1e6)).toBe(MEMORY_CEILING);
    }
    // Without accumulation or imprint a steady image is remembered as exactly itself.
    expect(pixel(memoryOf((w) => { w.coherence = 1; }), 60, 60, () => 0.4)).toBeCloseTo(0.4, 9);
  });

  it('silence dissolves the memory gradually: neither at once nor never', () => {
    // A silent world is fully coherent and unexcited: the longest clean memory.
    const silent = memoryOf(() => {}, 1);
    const after = (seconds: number) => pixel(silent, 60, 1 + seconds, (t) => (t <= 1 ? 1 : 0));
    expect(after(0.25)).toBeGreaterThan(0.5);
    expect(after(2)).toBeLessThan(after(0.25) * 0.5);
    expect(after(15)).toBeLessThan(1e-3);
  });

  it('an irregular memory fades unevenly across the picture', () => {
    const broken = memoryOf((w) => { w.coherence = 0.2; w.turbulence = 1; });
    const smooth = pixel(broken, 60, 0.3, (t) => (t <= 0.1 ? 1 : 0), 0), rough = pixel(broken, 60, 0.3, (t) => (t <= 0.1 ? 1 : 0), 1);
    expect(rough).toBeLessThan(smooth * 0.5);
  });
});
