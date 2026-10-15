import { afterEach, describe, expect, it } from 'vitest';
import type { EmergencePrimitive } from '../../visual-engine/primitives/EmergencePrimitive';
import type { ForestPrimitive } from '../../visual-engine/primitives/ForestPrimitive';
import type { SolidPrimitive } from '../../visual-engine/primitives/SolidPrimitive';
import { mountWorld, type WorldRun } from '../../visualizers/shared/worldHarness';
import { LAB_WORLDS, WorldsExperiment } from './worlds';

/* The Worlds subject of the Emergence laboratory, without its DOM: what it reads, resets and offers, and what it does not touch. */

let mounted: WorldRun[] = [];
const mount = (id: string): WorldRun => { const r = mountWorld(id); mounted.push(r); return r; };
afterEach(() => { for (const r of mounted) r.dispose(); mounted = []; });

describe('the Emergence laboratory: the new worlds', { timeout: 30_000 }, () => {
  it('studies the four new worlds and nothing else', () => {
    const lab = new WorldsExperiment();
    for (const id of LAB_WORLDS) expect(lab.subject(mount(id).scene.world)?.id).toBe(id);
    expect(lab.subject(mount('terrain').scene.world)).toBeNull();
    expect(lab.subject(null)).toBeNull();
    expect(lab.read(null)).toEqual([]);
  });

  it('reads each world\'s observer and its own subject', () => {
    const lab = new WorldsExperiment();
    for (const id of LAB_WORLDS) {
      const r = mount(id);
      r.sound(); r.run(2, (w) => { w.speed = 1.5; w.spin = 0.4; });
      const lines = new Map(lab.read(r.scene.world));
      expect(lines.get('locomotion'), id).toBe(r.scene.world.recipe.camera!.locomotion.join(' + '));
      expect(lines.size, id).toBeGreaterThan(7);
    }
  });

  it('synthetic cues go through each subject\'s own path: monoliths, bodies and trees take them; the sea does not', () => {
    const lab = new WorldsExperiment();
    const desert = mount('monolith-desert'), expanse = mount('fractured-expanse'), ocean = mount('pulse-ocean'), forest = mount('resonant-forest');
    expect(lab.offer(desert.scene.world, 'release', 12)).toBe(true);
    expect(desert.scene.world.primitive<EmergencePrimitive>('monoliths')!.field.stats.releases).toBe(1);
    expect(lab.offer(expanse.scene.world, 'release', 12)).toBe(true);
    expect(expanse.scene.world.primitive<SolidPrimitive>('bodies')!.cuesTaken.releases).toBe(1);
    expect(lab.offer(forest.scene.world, 'prediction', 12)).toBe(true);
    expect(forest.scene.world.primitive<ForestPrimitive>('trees')!.field.stats.prepares).toBe(1);
    expect(lab.offer(ocean.scene.world, 'release', 12)).toBe(false);
    expect(lab.offered).toBe(3);
  });

  it('a reset starts the subject over: monoliths and trees back to the pool, bodies seeded again', () => {
    const lab = new WorldsExperiment();
    const forest = mount('resonant-forest');
    forest.sound(); forest.run(20, (w) => { w.speed = 1.5; });
    const field = forest.scene.world.primitive<ForestPrimitive>('trees')!.field;
    expect(field.live()).toBeGreaterThan(0);
    expect(lab.reset(forest.scene.world)).toBe(true);
    expect(field.live()).toBe(0); expect(field.stats.spawned).toBe(0);
    expect(lab.reset(mount('pulse-ocean').scene.world)).toBe(false);
    const expanse = mount('fractured-expanse'), bodies = expanse.scene.world.primitive<SolidPrimitive>('bodies')!;
    expect(lab.reset(expanse.scene.world)).toBe(true);
    expect(bodies.system.solids!.state.bodies).toBe(7);
  });
});
