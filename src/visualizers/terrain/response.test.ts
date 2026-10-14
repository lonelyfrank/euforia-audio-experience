import { describe, expect, it } from 'vitest';
import { createGeometry } from '../../visual-engine/geometry/GeometryState';
import { DEFAULT_RESPONSE, LEGACY_RESPONSE, TerrainMotion, terrainResponse, type TerrainParams, type TerrainResponse } from '../../visual-engine/primitives/terrainMotion';
import { terrainDigest } from './terrainDigest';
import { createWorld } from '../../world/WorldState';
import { WorldView } from '../../world/WorldView';
import preset from './preset.json';

/*
 * How the ground answers the music, scale by scale (docs/generative-terrain.md, docs/scene-families.md). The motion as
 * it was before the response was refined is pinned bit for bit: these digests were recorded on terrainMotion.ts before
 * that change (commit c28ed64 + the particle solids), and the `legacy` response reproduces them at every frame rate.
 * EUFORIA_TERRAIN_DIGEST=<file> writes the digests measured to that file.
 */

const P = preset.visual as unknown as TerrainParams;
const RECORDED: Record<string, string> = { 'legacy 30': '8d13e2c9', 'legacy 60': '490ba071', 'legacy 144': '0d998d10' };

describe('Generative Terrain: the motion as it was', () => {
  it('is reproduced bit for bit by the legacy response, at 30, 60 and 144 fps', () => {
    const env = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env;
    const measured = Object.fromEntries([30, 60, 144].map((fps) => [`legacy ${fps}`, terrainDigest({ ...P, response: LEGACY_RESPONSE }, fps)]));
    if (env?.EUFORIA_TERRAIN_DIGEST) {
      const fs = 'node:fs';
      void import(/* @vite-ignore */ fs).then((m: { writeFileSync(path: string, data: string): void }) => m.writeFileSync(env.EUFORIA_TERRAIN_DIGEST!, JSON.stringify(measured, null, 2)));
      return;
    }
    expect(measured).toEqual(RECORDED);
  });
});

/** The ground under a steady groove (kicks ring the world twice a second, hats stir it eight times), then a held change of intensity. */
function groove(response: Partial<TerrainResponse>, fps = 60, seconds = 12, intensity: (t: number) => number = (t) => (t < 8 ? 0.6 : 0.85), pulsed = true) {
  const world = createWorld(), view = new WorldView(), geometry = createGeometry(), motion = new TerrainMotion({ ...P, response });
  const crest: number[] = [], quake: number[] = [], relief: number[] = [];
  for (let k = 0; k < seconds * fps; k++) {
    const t = (k + 1) / fps, beat = (t % 0.5) / 0.5, hat = (t % 0.125) / 0.125;
    world.time = 10 + t; world.speed = 1.5; world.travel += 1.5 / fps;
    world.radius = 0.3; world.potential = 0.2; world.turbulence = 0.15; world.coherence = 0.9;
    world.excitation = intensity(t) + (pulsed ? 0.3 * Math.exp(-beat * 0.5 / 0.12) - 0.15 : 0);
    world.shimmer = pulsed ? 0.2 + 0.7 * Math.exp(-hat * 0.125 / 0.03) : 0.5;
    view.update(world, { motion: 1, expansion: 1, turbulence: 1 });
    const v = motion.step(1 / fps, view, geometry, undefined, world.time);
    crest.push(v.crest); quake.push(v.quake); relief.push(v.relief);
  }
  return { motion, crest, quake, relief };
}
const jitter = (x: number[], from: number, to: number): number => { let s = 0; for (let i = from + 1; i < to; i++) s += (x[i] - x[i - 1]) ** 2; return Math.sqrt(s / (to - from - 1)); };
const mean = (x: number[], from: number, to: number): number => x.slice(from, to).reduce((a, b) => a + b, 0) / (to - from);

describe('Generative Terrain: three scales of the music', () => {
  it('a kick or a hat no longer pumps the whole landscape: the ground follows the groove, at the same level', () => {
    const before = groove(LEGACY_RESPONSE), after = groove({});
    // Measured on the steady part (2–8 s): frame to frame the mass and the surface move far less, on average they are where they were.
    for (const key of ['crest', 'quake'] as const) {
      expect(jitter(after[key], 120, 480)).toBeLessThan(jitter(before[key], 120, 480) / 8);
      expect(mean(after[key], 120, 480)).toBeCloseTo(mean(before[key], 120, 480), 1);
    }
    // The relief follows the world's pressure, a spring of its own: unchanged.
    expect(after.relief).toEqual(before.relief);
  });

  it('a held change of intensity is followed within the groove\'s time, to the same level as before', () => {
    const before = groove(LEGACY_RESPONSE), after = groove({}), at = 8 * 60;
    const settled = mean(before.crest, 660, 720), start = mean(after.crest, at - 60, at);
    // After one time constant most of the change is there; after a few, all of it.
    const reached = (mean(after.crest, at + 33, at + 39) - start) / (settled - start);
    expect(reached).toBeGreaterThan(0.5); expect(reached).toBeLessThan(0.85);
    expect(mean(after.crest, 660, 720)).toBeCloseTo(settled, 2);
  });

  it('each register is a configurable reading, bounded; at zero it leaves the ground alone', () => {
    const none = groove({ lows: 0, mids: 0, highs: 0 });
    expect(new Set(none.crest)).toEqual(new Set([1])); expect(new Set(none.quake)).toEqual(new Set([0])); expect(new Set(none.relief)).toEqual(new Set([P.relief]));
    expect(none.motion.values.ridge).toBe(0);
    expect(terrainResponse({ lows: 5, mids: -1, highs: NaN, groove: 99, surface: -2 })).toEqual({ lows: 2, mids: 0, highs: DEFAULT_RESPONSE.highs, groove: 4, surface: 0 });
    expect(terrainResponse()).toEqual(DEFAULT_RESPONSE);
    const louder = groove({ highs: 2 });
    expect(mean(louder.quake, 120, 480)).toBeCloseTo(2 * mean(groove({}).quake, 120, 480), 6);
  });

  it('the same at 30, 60 and 144 frames per second for a held input; a new session starts the followers over', () => {
    const level = (fps: number): number[] => {
      // A level that steps and is then held: the follower is exact for it at any step length.
      const g = groove({}, fps, 12, (t) => (t <= 4 ? 0.4 : 0.9), false);
      // Read at whole seconds, where every frame rate has a frame.
      return [5, 6, 8, 12].map((s) => g.crest[s * fps - 1]);
    };
    const [a, b, c] = [30, 60, 144].map(level);
    for (let i = 0; i < a.length; i++) { expect(b[i]).toBeCloseTo(a[i], 9); expect(c[i]).toBeCloseTo(a[i], 9); }
    const g = groove({});
    g.motion.reset();
    expect([g.motion.ring, g.motion.stir]).toEqual([0, 0]);
  });
});
