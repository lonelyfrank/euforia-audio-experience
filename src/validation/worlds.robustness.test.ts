import { describe, expect, it } from 'vitest';
import type { BufferGeometry, Material, Mesh } from 'three';
import { QUALITY_PROFILES } from '../renderer/quality';
import type { RigCamera } from '../visual-engine/RigCamera';
import { mountWorld } from '../visualizers/shared/worldHarness';

/*
 * The new worlds (docs/generative-worlds.md) through what a live session does to a scene: a groove whose tempo moves,
 * a build, a release heard, a breakdown, a silence, the source changing (the audio clock starts over), audio that comes
 * and goes, a prediction given up, a burst of accents; and mounting and unmounting again and again. Synthetic: hand-set
 * worlds and cues through the scenes' real code, on a renderer that records nothing.
 */

const WORLDS = ['monolith-desert', 'fractured-expanse', 'pulse-ocean', 'resonant-forest'] as const;

describe('the new worlds under a live session', { timeout: 120_000 }, () => {
  it.each(WORLDS)('%s: stays finite and bounded through six minutes of what a session does, and rests in silence', (id) => {
    const r = mountWorld(id, {}, QUALITY_PROFILES.low);
    const camera = r.scene.world.recipe.camera as RigCamera, limits = camera.rig.limits, rest = camera.rig.rest;
    let released = false, lastAccent = 0;
    const check = (): void => {
      const p = camera.rig.pose;
      for (const key of ['x', 'y', 'z', 'tx', 'ty', 'tz', 'fov', 'roll'] as const) expect(Number.isFinite(p[key]), `${id} ${key}`).toBe(true);
      expect(Math.abs(p.x - rest.x)).toBeLessThanOrEqual(limits.reach + 1e-6);
      expect(Math.abs(p.roll)).toBeLessThanOrEqual(limits.roll + 1e-6);
      expect(p.fov).toBeLessThanOrEqual(limits.fov[1] + 1e-6);
    };
    r.sound();
    // A groove whose tempo moves (120 → 140 bpm), a build with a prediction, a release heard, the drop, a breakdown.
    r.run(100, (w, cues, t) => {
      const local = t - 10, bpm = local < 30 ? 120 : 140, beat = (local * bpm / 60) % 1;
      w.speed = 1.5 + 2 * Math.exp(-beat * 4); w.spin = 0.4 * Math.sin(local * 0.2); w.excitation = 0.4 + 0.5 * Math.exp(-beat * 6);
      w.shimmer = 0.3 + 0.4 * Math.exp(-((local * bpm / 30) % 1) * 8); w.radius = 0.3 * Math.exp(-beat * 4); w.openness = 0.6;
      w.potential = local > 40 && local < 60 ? (local - 40) / 25 : 0.2; cues.phase = local > 40 && local < 60 ? 'rising' : local > 85 ? 'breakdown' : 'groove';
      cues.groove = 0.7; cues.stability = 0.8; cues.tension = w.potential; cues.repetition = 0.6;
      if (Math.abs(local - 45) < 0.01) r.push('prepare', 'predicted', t, 1);
      if (!released && local >= 60) { released = true; r.push('release', 'confirmed', t); w.releaseTime = t; w.releaseStrength = 0.8; }
    }, 20, check);
    // A prediction given up, then a burst of accents (one every quarter second): neither breaks nor builds anything wildly.
    r.run(20, (w, cues, t) => {
      w.speed = 2; w.excitation = 0.6; cues.phase = 'groove';
      if (Math.abs(t - 112) < 0.01) r.push('prepare', 'predicted', t, 2);
      if (Math.abs(t - 115) < 0.01) r.push('withdraw', 'refuted', t, 2);
      if (t - lastAccent >= 0.25) { lastAccent = t; r.push('accent', 'observed', t); }
    }, 20, check);
    // Silence: everything comes to rest.
    r.silence();
    r.run(40, undefined, 20, check);
    expect(camera.rig.motion).toBeLessThan(2e-3);
    const pose = { ...camera.rig.pose };
    r.run(5, undefined, 20, check);
    for (const key of ['x', 'y', 'z', 'tx', 'ty', 'tz'] as const) expect(camera.rig.pose[key]).toBeCloseTo(pose[key], 3);
    // The source changes: the audio clock starts over (a new session), with audio that comes and goes.
    r.world.time = 3;
    r.sound();
    r.run(30, (w, cues, t) => { const on = Math.floor(t / 2) % 2 === 0; cues.silent = !on; cues.phase = on ? 'groove' : 'silence'; w.speed = on ? 2 : 0; w.excitation = on ? 0.6 : 0; }, 20, check);
    r.run(60, (w) => { w.speed = 2.5; w.excitation = 0.6; w.spin = 0.5; }, 20, check);
    r.dispose();
  });

  it.each(WORLDS)('%s: mounted and unmounted ten times, releases every geometry and material it made each time', (id) => {
    for (let n = 0; n < 10; n++) {
      const r = mountWorld(id, {}, n % 2 ? QUALITY_PROFILES.high : QUALITY_PROFILES.low);
      const geometries = new Set<BufferGeometry>(), materials = new Set<Material>();
      r.scene.world.object.traverse((o) => { const m = o as Mesh; if (m.geometry) geometries.add(m.geometry); if (m.material) materials.add(m.material as Material); });
      let disposed = 0;
      for (const g of geometries) g.addEventListener('dispose', () => disposed++);
      for (const m of materials) m.addEventListener('dispose', () => disposed++);
      r.sound(); r.run(1, (w) => { w.speed = 2; });
      r.dispose();
      expect(disposed, `${id} #${n}`).toBe(geometries.size + materials.size);
      expect(r.scene.world.mounted).toHaveLength(0);
    }
  });
});
