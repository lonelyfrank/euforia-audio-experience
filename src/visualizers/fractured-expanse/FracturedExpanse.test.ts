import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Material } from 'three';
import type { ConstellationPrimitive } from '../../visual-engine/primitives/ConstellationPrimitive';
import type { SolidPrimitive } from '../../visual-engine/primitives/SolidPrimitive';
import type { RigCamera } from '../../visual-engine/RigCamera';
import type { Orbit } from '../../render-systems/camera/locomotion';
import { PULSE_LIMIT } from '../../visual-engine/structural/SolidTypes';
import { categoryOf, findVisualizer, scenesOf } from '../registry';
import { mountWorld, type WorldRun } from '../shared/worldHarness';
import expanse from '.';
import preset from './preset.json';
import { BODIES_SLOT } from './recipe';

/*
 * Fractured Expanse (docs/generative-worlds.md): suspended bodies of the structural engine, the field's dust, the
 * connections between pieces, an orbiting observer. What happens on which cue, and what never happens.
 */

const parts = (r: WorldRun) => ({
  bodies: r.scene.world.primitive<SolidPrimitive>(BODIES_SLOT)!,
  links: r.scene.world.primitive<ConstellationPrimitive>('constellation')!,
  camera: r.scene.world.recipe.camera as RigCamera,
});
/** A living world: it turns, it moves on, it is coherent enough for matter to gather. */
const alive = (w: { spin: number; speed: number; excitation: number; coherence: number; illumination: number; potential: number }): void => {
  w.spin = 0.6; w.speed = 1.2; w.excitation = 0.5; w.coherence = 0.85; w.illumination = 0.6; w.potential = w.potential || 0.2;
};
const pieces = (b: SolidPrimitive): number[] => Array.from(b.system.solids!.state.bodyPieces.subarray(0, b.system.solids!.state.bodies));
let mounted: WorldRun[] = [];
const mount = (...args: Parameters<typeof mountWorld>): WorldRun => { const r = mountWorld(...args); mounted.push(r); return r; };
afterEach(() => { for (const r of mounted) r.dispose(); mounted = []; vi.restoreAllMocks(); });

// Each test runs the structural engine for tens of seconds of audio: they get the time it takes on a slow machine.
describe('Fractured Expanse: a scene of the Worlds family', { timeout: 30_000 }, () => {
  it('is registered as a world after Monolith Desert, with an orbiting observer', () => {
    expect(findVisualizer('fractured-expanse')).toBe(expanse);
    expect(categoryOf('fractured-expanse')).toBe('worlds');
    expect(expanse.locomotion).toEqual(['orbit']);
    expect(scenesOf('worlds').map((v) => v.id).indexOf('fractured-expanse')).toBe(scenesOf('worlds').map((v) => v.id).indexOf('monolith-desert') + 1);
  });

  it('its bodies are the structural engine\'s, a population within its budget, in clusters, with no terrain', () => {
    const r = mount('fractured-expanse');
    const { bodies } = parts(r), solids = bodies.system.solids!;
    expect(solids.state.bodies).toBe(preset.visual.bodies.length);
    expect(solids.budget.bodies).toBe(preset.visual.bodies.length);
    expect(r.scene.world.primitive('ground')).toBeUndefined();
    expect(r.scene.world.mounted.map((m) => m.slot.id)).toEqual([BODIES_SLOT, 'dust', 'constellation', 'fronts']);
  });

  it('free matter gathers into bodies in a living world, rings within the pulse limit, and only a release heard breaks them', () => {
    const r = mount('fractured-expanse');
    const { bodies } = parts(r), solids = bodies.system.solids!;
    r.sound();
    let pulse = 0;
    r.run(30, (w) => alive(w), 60, () => { for (let b = 0; b < solids.state.bodies; b++) pulse = Math.max(pulse, Math.abs(solids.pulseOf(b))); });
    expect(solids.stats.cells).toBeGreaterThan(5);
    expect(pulse).toBeLessThanOrEqual(PULSE_LIMIT + 1e-9);
    const whole = pieces(bodies);
    // Accents and predictions are observations and expectations: nothing breaks on them.
    r.push('accent', 'observed', r.world.time); r.push('prepare', 'predicted', r.world.time, 5);
    r.run(3, (w) => alive(w));
    expect(solids.stats.events).toBe(0);
    expect(pieces(bodies)).toEqual(whole);
    // A release heard: the gate breaks the most loaded, at the release's own time.
    r.push('release', 'confirmed', r.world.time);
    r.run(2, (w, cues) => { alive(w); cues.phase = 'release'; });
    expect(solids.stats.events).toBeGreaterThan(0);
    expect(bodies.cuesTaken.releases).toBe(1);
    expect(pieces(bodies).reduce((a, b) => a + b, 0)).toBeGreaterThan(whole.reduce((a, b) => a + b, 0));
  });

  it('after a fracture its eye goes to the body that broke and comes back to the whole; the connections remember the pieces', () => {
    const r = mount('fractured-expanse');
    const { bodies, camera, links } = parts(r);
    r.sound();
    r.run(30, (w) => alive(w));
    expect(camera.debug.focus).toBeCloseTo(0.45, 1);
    r.push('release', 'confirmed', r.world.time);
    let most = 0, kin = 0;
    r.run(3, (w) => alive(w), 60, () => { most = Math.max(most, camera.debug.focus); kin = Math.max(kin, links.debug.kin); });
    expect(most).toBeGreaterThan(0.85);
    expect(kin).toBeGreaterThan(0);
    r.run(10, (w) => alive(w));
    expect(camera.debug.focus).toBeLessThan(0.55);
    expect(bodies.system.solids!.stats.events).toBeGreaterThan(0);
  });

  it('goes round only as far as the world turns and moves on: still world, still observer', () => {
    const r = mount('fractured-expanse');
    const { camera } = parts(r), orbit = camera.rig.entries[0].profile as Orbit;
    r.sound();
    r.run(10, (w) => alive(w));
    const turned = orbit.azimuth;
    expect(Math.abs(turned)).toBeGreaterThan(0.5);
    // The world stops turning and travelling: the angle stays, the observer settles.
    r.run(20, (w) => { alive(w); w.spin = 0; w.speed = 0; });
    const angle = orbit.azimuth;
    r.run(5, (w) => { alive(w); w.spin = 0; w.speed = 0; });
    expect(orbit.azimuth).toBe(angle);
    expect(camera.rig.motion).toBeLessThan(0.02);
  });

  it('is the same expanse at 30 and 60 frames per second: the fixed step on the audio clock, the fracture at the release', () => {
    const state = (fps: number) => {
      const r = mount('fractured-expanse');
      r.sound();
      r.run(30, (w, _, t) => { alive(w); if (Math.abs(t - 32) < 0.5 / fps) r.push('release', 'confirmed', t); }, fps);
      const b = parts(r).bodies, s = b.system.state;
      return { position: Array.from(s.position.subarray(0, s.count * 3)), events: b.system.solids!.stats.events, pieces: pieces(b) };
    };
    const a = state(30), b = state(60);
    expect(b.events).toBe(a.events); expect(a.events).toBeGreaterThan(0);
    expect(b.pieces).toEqual(a.pieces);
    // The physics steps on the audio clock; the fields it samples are read once a frame (the Director's and the
    // geometry's followers), so where the bodies are agrees within hundredths of a unit (a few after a fracture has
    // thrown the pieces), not to the bit.
    const gaps = a.position.map((x, i) => Math.abs(b.position[i] - x)).sort((x, y) => x - y);
    expect(gaps[Math.floor(gaps.length / 2)]).toBeLessThan(0.01);
    expect(gaps.at(-1)).toBeLessThan(0.08);
  });

  it('in silence nothing breaks, the bodies gain no energy, and the observer comes to rest', () => {
    const r = mount('fractured-expanse');
    const { bodies, camera } = parts(r), solids = bodies.system.solids!;
    r.sound();
    r.run(20, (w) => alive(w));
    r.silence();
    r.run(10);
    let kinetic = solids.stats.kinetic;
    r.run(30, undefined, 60, () => { expect(solids.stats.kinetic).toBeLessThanOrEqual(kinetic * 1.05 + 1e-6); kinetic = Math.max(solids.stats.kinetic, kinetic * 0.5); });
    expect(solids.stats.events).toBe(0);
    expect(camera.rig.motion).toBeLessThan(2e-3);
  });

  it('a long session stays finite and bounded: five minutes, a release heard every half minute', () => {
    const r = mount('fractured-expanse');
    const { bodies, links } = parts(r), solids = bodies.system.solids!, m = bodies.system.state;
    r.sound();
    let widest = 0;
    r.run(300, (w, cues, t) => {
      alive(w); w.potential = 0.2 + 0.6 * ((t % 30) / 30); cues.phase = (t % 30) > 20 ? 'rising' : 'groove';
      if (Math.abs((t % 30) - 29.9) < 0.5 / 30) r.push('release', 'confirmed', t);
    }, 30, () => {
      for (let i = 0; i < m.count * 3; i++) widest = Math.max(widest, Math.abs(m.position[i]));
    });
    expect(Number.isFinite(widest)).toBe(true);
    expect(widest).toBeLessThan(4);
    expect(solids.stats.events).toBeGreaterThan(3);
    // What the pools hold never grows: links and faces within the budget, lines within theirs.
    expect(solids.state.links).toBeLessThanOrEqual(solids.budget.links);
    expect(links.debug.kin + links.debug.neighbours).toBeLessThanOrEqual(128);
  });

  it('releases what it made when it is disposed', () => {
    const r = mountWorld('fractured-expanse');
    const geometry = vi.spyOn(BufferGeometry.prototype, 'dispose'), material = vi.spyOn(Material.prototype, 'dispose');
    r.dispose();
    // Bodies: three of each; dust: its own; constellation and fronts: one each at least.
    expect(geometry.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(material.mock.calls.length).toBeGreaterThanOrEqual(6);
  });
});
