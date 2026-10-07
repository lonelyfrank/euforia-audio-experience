import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Color, Material, ShaderMaterial, Texture, type Vector2, type Vector3, type Vector4, type WebGLRenderer } from 'three';
import { AudioAnalyzer } from '../audio/analysis/AudioAnalyzer';
import { newFrame } from '../audio/features/decode';
import { VisualResponse } from '../audio/visual-response/VisualResponse';
import { DEFAULT_DIRECTION } from '../director/profiles';
import { VisualDirector } from '../director/VisualDirector';
import { createSnapshot } from '../experience/types';
import { WELL_DEPTH } from '../render-systems/fields/wells';
import { QUALITY_PROFILES } from '../renderer/quality';
import type { QualityProfile, Visualizer } from '../types/visualizer';
import { Reorganization } from '../world/Reorganization';
import { createWorld, type WorldState } from '../world/WorldState';
import { WorldView } from '../world/WorldView';
import { ParticleFieldVisualizer } from './particle-field/ParticleFieldVisualizer';
import particles from './particle-field/preset.json';
import { createRegimes, FRONT_SPEED as PARTICLE_FRONT_SPEED, ORDERS, particleRegimes } from './particle-field/regimes';
import tunnel from './tunnel/preset.json';
import { CONFIGURATIONS, createTopology, FRONT_SPEED, tunnelTopology } from './tunnel/topology';
import { TunnelVisualizer } from './tunnel/TunnelVisualizer';

const NEUTRAL = { motion: 1, expansion: 1, turbulence: 1 };
/** How far two frame rates may differ, relative to the value: what the Director's own eased gains leave on an accumulated travel. */
const TOLERANCE = 1e-3;

/** A view of a hand-set world at `time`. */
function viewOf(set: Partial<WorldState>, time = 10): WorldView {
  const view = new WorldView();
  view.update({ ...createWorld(), time, ...set }, NEUTRAL);
  return view;
}

/** Every world a scene may be shown, including broken ones. */
const WORLDS: Partial<WorldState>[] = [
  {}, { potential: 1 }, { turbulence: 1, coherence: 0 }, { spin: 3 }, { spin: -3, potential: 1, turbulence: 1 },
  { releaseTime: 10, releaseStrength: 1 }, { releaseTime: 9.5, releaseStrength: 0.3, impulseTime: 9.9, impulseStrength: 2 },
  { releaseTime: 20, releaseStrength: 1, impulseTime: 30, impulseStrength: 1 },
  { potential: NaN, turbulence: Infinity, coherence: -Infinity, spin: NaN, releaseTime: NaN, releaseStrength: NaN, impulseTime: Infinity, impulseStrength: -Infinity, excitation: NaN },
  { potential: 7, turbulence: -3, coherence: 9, spin: 1e9, releaseStrength: 1e9, releaseTime: 10, excitation: 50 },
];

/**
 * A scene driven through a real Director whose world view observes a hand-set
 * WorldState, at any frame rate: the tests check how each scene's structure
 * follows the shared world, not how it maps audio.
 */
function rig<T extends Visualizer>(scene: T, quality: QualityProfile = QUALITY_PROFILES.low) {
  scene.init({ renderer: { getPixelRatio: () => 1 } as WebGLRenderer, quality, width: 800, height: 600, addPass: () => {} });
  scene.resize(800, 600);
  scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
  const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame, director = new VisualDirector();
  const experience = createSnapshot(newFrame()), world = experience.world;
  const shaders: ShaderMaterial[] = [];
  scene.scene.traverse((object) => {
    const material = (object as unknown as { material?: ShaderMaterial }).material;
    if (material instanceof ShaderMaterial) shaders.push(material);
  });
  const clock = { time: 0, hits: { times: new Float64Array(8).fill(-Infinity), strengths: new Float64Array(8), count: 0, size: 8 } as never, hitScale: 1, experience };
  const update = (seconds = 1, live = true, fps = 60) => {
    for (let i = 0; i < Math.round(seconds * fps); i++) {
      world.time += 1 / fps; world.travel += world.speed / fps; world.angle += world.spin / fps;
      clock.time = world.time;
      const modulation = director.update(response, DEFAULT_DIRECTION, 1 / fps, undefined, live ? experience : undefined);
      scene.update(audio, 1 / fps, world.time, response, modulation, live ? clock : undefined);
    }
  };
  /** Every number the shaders are driven with, by uniform name (textures and colours left out). */
  const numbers = (skip: readonly string[] = []) => {
    const out: Record<string, number[]> = {};
    for (const material of shaders) {
      for (const [name, uniform] of Object.entries(material.uniforms)) {
        const value = uniform.value as unknown;
        if (skip.includes(name) || value instanceof Color || value instanceof Texture || value === null) continue;
        out[name] = typeof value === 'number' ? [value] : ArrayBuffer.isView(value) ? Array.from(value as Float32Array) : (value as Vector4).toArray();
      }
    }
    return out;
  };
  return { scene, response, audio, shaders, world, experience, update, numbers, u: shaders[0].uniforms };
}

beforeEach(() => vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('reorganization: the structure a release leaves behind', () => {
  const world = createWorld(), view = new WorldView();
  const at = (r: Reorganization, time: number, set: Partial<WorldState> = {}) => { Object.assign(world, set, { time }); view.update(world, NEUTRAL); r.update(view); return r; };

  it('is the canonical one until something is released, then another one, chosen by the release itself', () => {
    Object.assign(world, createWorld());
    const r = new Reorganization(7, 3);
    at(r, 1);
    expect([r.previous, r.current, r.age]).toEqual([0, 0, Infinity]);
    at(r, 5.25, { releaseTime: 5, releaseStrength: 0.6 });
    const first = r.current;
    expect(r.previous).toBe(0); expect(first).not.toBe(0); expect(first).toBeLessThan(7); expect(r.age).toBeCloseTo(0.25, 9);
    // The same release, later: the same structure, older.
    at(r, 9);
    expect([r.previous, r.current]).toEqual([0, first]); expect(r.age).toBeCloseTo(4, 9);
    // Every release leaves a structure that is not the one it found.
    let last = first;
    for (let k = 0; k < 40; k++) {
      at(r, 10 + k + 0.5, { releaseTime: 10 + k + 0.137 * k });
      expect(r.previous).toBe(last); expect(r.current).not.toBe(last);
      expect(Number.isInteger(r.current)).toBe(true); expect(r.current).toBeGreaterThanOrEqual(0); expect(r.current).toBeLessThan(7);
      last = r.current;
    }
  });

  it('does not depend on when it is looked at: the same releases give the same structures at any cadence', () => {
    const play = (step: number) => {
      const w = createWorld(), v = new WorldView(), r = new Reorganization(7, 3), seen: number[] = [];
      for (let t = 0; t < 30; t += step) {
        w.time = t;
        for (const release of [4, 11.5, 12.25, 26]) if (t >= release) w.releaseTime = release;
        v.update(w, NEUTRAL); r.update(v);
        if (seen[seen.length - 1] !== r.current) seen.push(r.current);
      }
      return seen;
    };
    expect(play(1 / 144)).toEqual(play(1 / 30)); expect(play(1 / 30)).toEqual(play(0.3));
    expect(play(1 / 60)).toHaveLength(5);
  });

  it('starts again from the canonical structure in a new session', () => {
    Object.assign(world, createWorld());
    const r = new Reorganization(7, 3);
    at(r, 50, { releaseTime: 49, releaseStrength: 1 });
    expect(r.current).not.toBe(0);
    at(r, 0.1, { releaseTime: -Infinity, releaseStrength: 0 });
    expect([r.previous, r.current, r.age]).toEqual([0, 0, Infinity]);
  });
});

describe('Tunnel: architecture under the world\'s forces', () => {
  const topology = (set: Partial<WorldState>, time = 10) => ({ ...tunnelTopology(createTopology(), viewOf(set, time)) });

  it('is the plain corridor in a world at rest', () => {
    expect(topology({})).toEqual({ gapAxial: 0, gapAngular: 0, lift: 0, shear: 0, facet: 0, throat: 0, front: 1e4, release: 0 });
    // A coherent, lit, moving world that holds no potential and no disorder is still one wall.
    expect(topology({ speed: 4, illumination: 1, excitation: 0.8, radius: 0.5 })).toMatchObject({ gapAxial: 0, gapAngular: 0, lift: 0, facet: 0, throat: 0 });
  });

  it('held potential gives the section edges, draws the far tunnel in and pulls the rings apart; disorder and torsion cut it lengthwise', () => {
    let last = topology({});
    for (const potential of [0.3, 0.6, 0.9]) {
      const t = topology({ potential });
      expect(t.facet).toBeGreaterThan(last.facet - 1e-9); expect(t.throat).toBeGreaterThan(last.throat); expect(t.gapAxial).toBeGreaterThanOrEqual(last.gapAxial);
      last = t;
    }
    expect(last.facet).toBe(1); expect(last.throat).toBeGreaterThan(0.35); expect(last.gapAxial).toBeGreaterThan(0.15);
    // Tension alone opens rings more than panels; disorder opens both and lets the pieces float.
    expect(last.gapAngular).toBeLessThan(last.gapAxial * 0.5);
    const broken = topology({ potential: 0.9, turbulence: 0.9 });
    expect(broken.gapAngular).toBeGreaterThan(2 * last.gapAngular); expect(broken.lift).toBeGreaterThan(last.lift + 0.05);
    // Rings turn against each other the way the world turns.
    expect(topology({ potential: 0.9, spin: 2 }).shear).toBeGreaterThan(0.02);
    expect(topology({ potential: 0.9, spin: -2 }).shear).toBeCloseTo(-topology({ potential: 0.9, spin: 2 }).shear, 12);
    expect(topology({ spin: 2 }).shear).toBe(0);
  });

  it('a strong impact holds the rings apart for an instant, by its age alone', () => {
    const struck = (age: number) => topology({ impulseTime: 10 - age, impulseStrength: 1 }).gapAxial;
    expect(struck(0)).toBeGreaterThan(0.1); expect(struck(0.2)).toBeLessThan(struck(0)); expect(struck(0.2)).toBeGreaterThan(struck(0.6));
    expect(struck(3)).toBeLessThan(1e-3);
    // An impact that has not been heard yet does nothing.
    expect(topology({ impulseTime: 10.5, impulseStrength: 1 }).gapAxial).toBe(0);
  });

  it('a release is a front that travels down the tunnel at its own speed and fades', () => {
    const released = (age: number) => topology({ releaseTime: 10 - age, releaseStrength: 0.6 });
    expect(released(0).front).toBe(0); expect(released(0).release).toBe(1);
    expect(released(0.5).front).toBeCloseTo(FRONT_SPEED * 0.5, 9); expect(released(2).front).toBeCloseTo(FRONT_SPEED * 2, 9);
    expect(released(1).release).toBeLessThan(released(0.5).release); expect(released(12).release).toBeLessThan(1e-3);
    expect(released(1e6).front).toBe(1e4);
    // While it passes the wall opens and the pieces float; a weak release is a weak front.
    expect(released(0.3).gapAxial).toBeGreaterThan(0.1); expect(released(0.3).lift).toBeGreaterThan(0.05);
    expect(topology({ releaseTime: 9.7, releaseStrength: 0.1 }).release).toBeLessThan(released(0.3).release * 0.3);
    expect(topology({ releaseTime: 11, releaseStrength: 1 })).toMatchObject({ front: 1e4, release: 0 });
  });

  it('is finite, bounded and continuous for any world', () => {
    for (const world of WORLDS) {
      const t = topology(world);
      for (const [key, value] of Object.entries(t)) { expect(Number.isFinite(value), key).toBe(true); expect(Math.abs(value), key).toBeLessThanOrEqual(key === 'front' ? 1e4 : 1); }
      expect(t.gapAxial).toBeLessThanOrEqual(0.36); expect(t.gapAngular).toBeLessThanOrEqual(0.28); expect(t.lift).toBeLessThanOrEqual(0.2);
    }
    // No switches: a small change of the world is a small change of the wall.
    for (let k = 0; k < 200; k++) {
      const x = k / 200, a = topology({ potential: x, turbulence: 1 - x, spin: 0.5 + 3 * x }), b = topology({ potential: x + 0.005, turbulence: 1 - x - 0.005, spin: 0.5 + 3 * x + 0.015 });
      for (const key of ['gapAxial', 'gapAngular', 'lift', 'shear', 'facet', 'throat'] as const) expect(Math.abs(a[key] - b[key]), key).toBeLessThan(0.03);
    }
  });

  it('the scene: torsion, waveguide, fracture and constriction follow the world; without a clock it is the corridor', () => {
    const r = rig(new TunnelVisualizer(tunnel)), u = r.u;
    r.update(1);
    expect((u.uGap.value as Vector2).toArray()).toEqual([0, 0]); expect((u.uForm.value as Vector4).toArray()).toEqual([0, 0, 0, 0]);
    expect(u.uFront.value).toBe(1e4); expect(u.uRelease.value).toBe(0); expect(u.uTwist.value).toBe(0);
    expect((u.uConfig.value as Vector4).toArray()).toEqual([CONFIGURATIONS[0][0], CONFIGURATIONS[0][1], CONFIGURATIONS[0][0], CONFIGURATIONS[0][1]]);
    // The wall carries the modes the audio engine keeps ringing.
    r.experience.physics.modes.set([0.3, -0.2, 0.1, 0.05]);
    r.world.spin = 1.5; r.world.potential = 0.9; r.world.turbulence = 0.8;
    r.update(1 / 60);
    expect(Array.from(u.uModes.value as Float32Array).slice(0, 4)).toEqual([0.3, -0.2, 0.1, 0.05].map(Math.fround));
    expect(u.uWaveguide.value).toBeGreaterThan(0.1);
    // Torsion is a property of the geometry (turns per unit of depth), with the world's own sense.
    expect(u.uTwist.value).toBeGreaterThan(0.01);
    const form = (u.uForm.value as Vector4).toArray(), gap = (u.uGap.value as Vector2).toArray();
    expect(form[0]).toBe(1); expect(form[1]).toBeGreaterThan(0.35); expect(form[2]).toBeGreaterThan(0.1); expect(form[3]).toBeGreaterThan(0.02);
    expect(gap[0]).toBeGreaterThan(0.1); expect(gap[1]).toBeGreaterThan(0.2);
    r.world.spin = -1.5;
    r.update(1 / 60);
    expect(u.uTwist.value).toBeLessThan(-0.01); expect((u.uForm.value as Vector4).w).toBeLessThan(-0.02);
    // The breathing by register needs its register to be heard.
    expect((u.uBreath.value as Vector3).x).toBe(0);
    r.response.midAudible = r.response.highAudible = 1; r.response.detail = 0.8; r.response.flow = 0.5;
    r.update(1 / 60);
    expect((u.uBreath.value as Vector3).x).toBeGreaterThan(0.05); expect((u.uBreath.value as Vector3).y).toBeGreaterThan(0.01);
    expect((u.uBreath.value as Vector3).z).toBeGreaterThanOrEqual(8);
    // The clock is lost: nothing of the world is known, the tunnel is the corridor.
    r.update(1 / 60, false);
    expect((u.uGap.value as Vector2).toArray()).toEqual([0, 0]); expect((u.uForm.value as Vector4).toArray()).toEqual([0, 0, 0, 0]);
    expect(Math.max(...(u.uModes.value as Float32Array).map(Math.abs))).toBe(0);
    r.scene.dispose();
  });

  it('the scene: a release sweeps the tunnel and leaves another structure behind its front', () => {
    const r = rig(new TunnelVisualizer(tunnel)), u = r.u;
    const config = () => (u.uConfig.value as Vector4).toArray(), rings = () => (u.uRings.value as Vector2).toArray();
    r.world.potential = 0.8;
    r.update(2);
    const canonical = config();
    r.world.releaseTime = r.world.time; r.world.releaseStrength = 0.7; r.world.potential = 0;
    r.update(1 / 60);
    // At the instant of the release the whole tunnel is still ahead of the front: what was there is there.
    const [sides, panels, sidesBefore, panelsBefore] = config();
    expect([sidesBefore, panelsBefore]).toEqual(canonical.slice(0, 2)); expect(rings()[1]).toBe(CONFIGURATIONS[0][2]);
    expect([sides, panels, rings()[0]]).not.toEqual([...canonical.slice(0, 2), CONFIGURATIONS[0][2]]);
    expect(CONFIGURATIONS.some((c) => c[0] === sides && c[1] === panels && c[2] === rings()[0])).toBe(true);
    expect(u.uFront.value).toBeCloseTo(FRONT_SPEED / 60, 3); expect(u.uRelease.value).toBeGreaterThan(0.95);
    r.update(1);
    expect(u.uFront.value).toBeCloseTo(FRONT_SPEED * (1 + 1 / 60), 2); expect(u.uRelease.value).toBeLessThan(0.6);
    // Long after, the front has left and the new structure is the tunnel's.
    r.update(20);
    expect(u.uRelease.value).toBeLessThan(1e-4); expect(config().slice(0, 2)).toEqual([sides, panels]);
    // The next release starts from it.
    r.world.releaseTime = r.world.time; r.update(1 / 60);
    expect(config().slice(2)).toEqual([sides, panels]); expect(config().slice(0, 2)).not.toEqual([sides, panels]);
    r.scene.dispose();
  });

  it('the scene: in a world that has come to rest nothing moves, and it is the same at 30 and 144 frames per second', () => {
    const play = (fps: number) => {
      const r = rig(new TunnelVisualizer(tunnel));
      // The frame a scene is mounted on starts its view of the world: let it pass before the world moves.
      r.update(1, true, fps);
      r.experience.physics.modes.set([0.2, 0.1]);
      Object.assign(r.world, { spin: 1.2, speed: 2, potential: 0.7, turbulence: 0.5, radius: 0.3, bias: 0.4 });
      r.update(1, true, fps);
      // Events are dated on the audio clock: the same instant whatever the frame rate (the rig's own clock is a sum of frames).
      r.world.releaseTime = r.world.impulseTime = 2; r.world.releaseStrength = 0.6; r.world.impulseStrength = 0.8;
      r.update(1, true, fps);
      return r;
    };
    // The trace's scroll and the sparks are advanced per frame by the tempo and the shimmer: they are not the wall.
    const skip = ['uTraceShift', 'uSparkTravel', 'uPixelRatio'];
    const a = play(30), b = play(144), na = a.numbers(skip), nb = b.numbers(skip);
    expect(Object.keys(na)).toEqual(Object.keys(nb));
    for (const name of Object.keys(na)) for (let i = 0; i < na[name].length; i++) expect(Math.abs(nb[name][i] - na[name][i]), name).toBeLessThan(TOLERANCE * Math.max(1, Math.abs(na[name][i])));
    // The world comes to rest (its velocities and fields gone, its position kept): the wall is whole again and still.
    Object.assign(a.world, { spin: 0, speed: 0, potential: 0, turbulence: 0 });
    a.experience.physics.modes.fill(0);
    a.update(30);
    const still = a.numbers(skip);
    // What is left of the release is its own decaying tail (a part in a hundred million after half a minute).
    for (const value of [...still.uGap, ...still.uForm, ...still.uTwist, ...still.uRelease]) expect(Math.abs(value)).toBeLessThan(1e-6);
    a.update(5);
    const later = a.numbers([...skip, 'uFront']);
    for (const name of Object.keys(later)) for (let i = 0; i < later[name].length; i++) expect(Math.abs(later[name][i] - still[name][i]), name).toBeLessThan(1e-6);
    for (const values of Object.values(a.numbers())) for (const value of values) expect(Number.isFinite(value)).toBe(true);
    a.scene.dispose(); b.scene.dispose();
  });

  it('the scene: seeded without Math.random, and it releases what it owns', () => {
    // Whatever Math.random returns (three.js uses it for its ids), the scene is the same.
    let n = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => 0.123);
    const first = rig(new TunnelVisualizer(tunnel));
    vi.spyOn(Math, 'random').mockImplementation(() => (n = (n * 7 + 0.31) % 1));
    const second = rig(new TunnelVisualizer(tunnel));
    const seeds = (r: typeof first) => Array.from((r.scene.scene.children[1] as unknown as { geometry: BufferGeometry }).geometry.getAttribute('aSeed').array as Float32Array);
    expect(seeds(first)).toEqual(seeds(second));
    const geometries = vi.spyOn(BufferGeometry.prototype, 'dispose'), materials = vi.spyOn(Material.prototype, 'dispose'), textures = vi.spyOn(Texture.prototype, 'dispose');
    first.scene.dispose();
    expect(geometries).toHaveBeenCalledTimes(2); expect(materials).toHaveBeenCalledTimes(2); expect(textures.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(first.scene.scene.children).toHaveLength(0);
    second.scene.dispose();
  });
});

describe('Particle Field: particles that organise themselves', () => {
  const regimes = (set: Partial<WorldState>, time = 10) => ({ ...particleRegimes(createRegimes(), viewOf(set, time), 120) });

  it('is the field as it was in a world at rest: the shells hold, no other well is deep', () => {
    expect(regimes({})).toEqual({ shell: 1, spokes: 0, planes: 0, collapse: 0, wind: 0, melt: 0, reform: 1, front: 1, pulse: 0 });
  });

  it('one set of particles, many organisations: each well is deepened by something else the world does', () => {
    // A world that does not hold together: a cloud, whatever else happens.
    const cloud = regimes({ coherence: 0.2, potential: 0.8, excitation: 0.8 });
    expect(cloud.shell).toBe(0); expect(cloud.spokes).toBe(0); expect(cloud.planes).toBe(0);
    // Held potential: spokes (with the shells and the flight, filaments), a tighter field.
    const held = regimes({ potential: 0.9 });
    expect(held.spokes).toBeGreaterThan(0.8); expect(held.collapse).toBeGreaterThan(0.2); expect(held.planes).toBeLessThan(held.spokes);
    // Rotation: spokes that the vortex winds, with the world's own sense.
    const turning = regimes({ spin: 2 }), back = regimes({ spin: -2 });
    expect(turning.spokes).toBeGreaterThan(0.4); expect(turning.wind).toBeGreaterThan(0.1); expect(back.wind).toBeCloseTo(-turning.wind, 12); expect(turning.planes).toBe(0);
    // A struck, ringing world: planes across the flight.
    const ringing = regimes({ excitation: 0.8 });
    expect(ringing.planes).toBeGreaterThan(0.8); expect(ringing.spokes).toBeLessThan(ringing.planes * 0.6);
    // All of it at once: a lattice. Disorder flattens every well.
    const lattice = regimes({ potential: 0.9, excitation: 0.8, spin: 1 });
    expect(Math.min(lattice.shell, lattice.spokes, lattice.planes)).toBeGreaterThan(0.85);
    const shaken = regimes({ potential: 0.9, excitation: 0.8, spin: 1, turbulence: 0.9 });
    expect(Math.max(shaken.shell, shaken.spokes, shaken.planes)).toBeLessThan(0.4);
    for (const r of [held, turning, ringing, lattice]) { expect(r.spokes).toBeLessThanOrEqual(WELL_DEPTH); expect(r.planes).toBeLessThanOrEqual(WELL_DEPTH); }
  });

  it('a release melts the structure without a jump and lets it set again; an impact is a front running into the field', () => {
    const released = (age: number) => regimes({ potential: 0.6, excitation: 0.5, releaseTime: 10 - age, releaseStrength: 0.6 });
    const before = regimes({ potential: 0.6, excitation: 0.5 });
    // At the instant of the release the particles are exactly where they were.
    expect(released(0)).toMatchObject({ shell: before.shell, spokes: before.spokes, planes: before.planes, melt: 0, reform: 0 });
    expect(released(0.3).melt).toBeGreaterThan(0.7); expect(released(0.3).spokes).toBeLessThan(before.spokes * 0.3);
    expect(released(1.3).reform).toBe(1); expect(released(3).melt).toBeLessThan(released(1).melt); expect(released(12).spokes).toBeCloseTo(before.spokes, 2);
    let last = 0;
    for (let age = 0; age < 2; age += 0.01) { const r = released(age); expect(r.reform).toBeGreaterThanOrEqual(last); expect(Math.abs(r.melt - released(age + 0.01).melt)).toBeLessThan(0.1); last = r.reform; }
    const struck = (age: number) => regimes({ impulseTime: 10 - age, impulseStrength: 0.9 });
    expect(struck(0)).toMatchObject({ front: 0, pulse: 0.9 });
    expect(struck(0.5).front).toBeCloseTo(PARTICLE_FRONT_SPEED * 0.5 / 120, 9); expect(struck(0.5).pulse).toBeLessThan(0.9 * 0.6);
    expect(struck(60)).toMatchObject({ front: 1 }); expect(struck(60).pulse).toBeLessThan(1e-9);
    expect(regimes({ impulseTime: 11, impulseStrength: 1 })).toMatchObject({ front: 1, pulse: 0 });
  });

  it('is finite and bounded for any world', () => {
    for (const world of WORLDS) {
      for (const [key, value] of Object.entries(regimes(world))) { expect(Number.isFinite(value), key).toBe(true); expect(Math.abs(value), key).toBeLessThanOrEqual(1); }
    }
  });

  it('the scene: the wells follow the world, a release carries the particles from one structure to another', () => {
    const r = rig(new ParticleFieldVisualizer(particles)), u = r.u;
    const wells = () => (u.uWells.value as Vector4).toArray(), orders = () => (u.uOrders.value as Vector4).toArray();
    r.update(1);
    expect(wells()).toEqual([1, 0, 0, 1]); expect(orders()).toEqual([ORDERS[0][0], ORDERS[0][0], ORDERS[0][1], ORDERS[0][1]]);
    expect((u.uFront.value as Vector4).toArray()).toEqual([1, 0, 0, 0]);
    const spread = u.uSpread.value;
    Object.assign(r.world, { potential: 0.9, excitation: 0.8, spin: 1.5, shimmer: 0.6 });
    r.update(1 / 60);
    expect(wells()[1]).toBeGreaterThan(0.85); expect(wells()[2]).toBeGreaterThan(0.85);
    expect(u.uSpread.value).toBeLessThan(spread * 0.85);
    expect((u.uFront.value as Vector4).z).toBeGreaterThan(0.1); expect((u.uFront.value as Vector4).w).toBeCloseTo(0.6, 6);
    r.world.coherence = 0.1;
    r.update(1 / 60);
    expect(wells().slice(0, 3)).toEqual([0, 0, 0]);
    r.world.coherence = 1;
    // A release: the orders change, and the particles start from the ones they had.
    r.world.releaseTime = r.world.time; r.world.releaseStrength = 0.7;
    r.update(1 / 60);
    const [spokes, spokesBefore, planes, planesBefore] = orders();
    expect([spokesBefore, planesBefore]).toEqual([ORDERS[0][0], ORDERS[0][1]]); expect([spokes, planes]).not.toEqual([ORDERS[0][0], ORDERS[0][1]]);
    expect(ORDERS.some((o) => o[0] === spokes && o[1] === planes)).toBe(true);
    expect(wells()[3]).toBe(0);
    r.update(0.4);
    expect(wells()[3]).toBeGreaterThan(0); expect(wells()[3]).toBeLessThan(1); expect(wells()[1]).toBeLessThan(0.4);
    r.update(10);
    expect(wells()[3]).toBe(1); expect(wells()[1]).toBeGreaterThan(0.85); expect(orders().slice(0, 1)).toEqual([spokes]);
    // An impact crosses the field as a front.
    r.world.impulseTime = r.world.time; r.world.impulseStrength = 0.8;
    r.update(0.2);
    expect((u.uFront.value as Vector4).x).toBeCloseTo(PARTICLE_FRONT_SPEED * 0.2 / particles.visual.depth, 2); expect((u.uFront.value as Vector4).y).toBeGreaterThan(0.5);
    // The clock is lost: the field as it always was.
    r.update(1 / 60, false);
    expect(wells()).toEqual([1, 0, 0, 1]);
    r.scene.dispose();
  });

  it('the scene: in a world that has come to rest nothing moves, and it is the same at 30 and 144 frames per second', () => {
    const play = (fps: number) => {
      const r = rig(new ParticleFieldVisualizer(particles));
      r.update(1, true, fps);
      Object.assign(r.world, { spin: 1.2, speed: 2, potential: 0.7, turbulence: 0.3, radius: 0.3, bias: 0.4, excitation: 0.6 });
      r.update(1, true, fps);
      // Events are dated on the audio clock: the same instant whatever the frame rate (the rig's own clock is a sum of frames).
      r.world.releaseTime = r.world.impulseTime = 2; r.world.releaseStrength = 0.6; r.world.impulseStrength = 0.8;
      r.update(1, true, fps);
      return r;
    };
    // The trace's scroll is advanced per frame by the tempo; the emitted share is eased by the Director's own clock.
    const skip = ['uTraceShift', 'uPixelRatio', 'uDensity'];
    const a = play(30), b = play(144), na = a.numbers(skip), nb = b.numbers(skip);
    expect(Object.keys(na)).toEqual(Object.keys(nb));
    for (const name of Object.keys(na)) for (let i = 0; i < na[name].length; i++) expect(Math.abs(nb[name][i] - na[name][i]), name).toBeLessThan(TOLERANCE * Math.max(1, Math.abs(na[name][i])));
    Object.assign(a.world, { spin: 0, speed: 0, potential: 0, turbulence: 0, excitation: 0 });
    a.update(30);
    const still = a.numbers(skip);
    // What is left of the release is its own decaying tail (a part in ten million after half a minute).
    for (const [i, rest] of [1, 0, 0, 1].entries()) expect(Math.abs(still.uWells[i] - rest)).toBeLessThan(1e-6);
    expect(still.uFront[1]).toBeLessThan(1e-9); expect(still.uRelease[0]).toBeLessThan(1e-6);
    a.update(5);
    const later = a.numbers(skip);
    for (const name of Object.keys(later)) for (let i = 0; i < later[name].length; i++) expect(Math.abs(later[name][i] - still[name][i]), name).toBeLessThan(1e-6);
    for (const values of Object.values(a.numbers())) for (const value of values) expect(Number.isFinite(value)).toBe(true);
    a.scene.dispose(); b.scene.dispose();
  });

  it('the scene: seeded without Math.random, and it releases what it owns', () => {
    let n = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => 0.123);
    const first = rig(new ParticleFieldVisualizer(particles));
    vi.spyOn(Math, 'random').mockImplementation(() => (n = (n * 7 + 0.31) % 1));
    const second = rig(new ParticleFieldVisualizer(particles));
    const seeds = (r: typeof first) => Array.from((r.scene.scene.children[0] as unknown as { geometry: BufferGeometry }).geometry.getAttribute('aSeed').array as Float32Array).slice(0, 4000);
    expect(seeds(first)).toEqual(seeds(second));
    const geometries = vi.spyOn(BufferGeometry.prototype, 'dispose'), materials = vi.spyOn(Material.prototype, 'dispose'), textures = vi.spyOn(Texture.prototype, 'dispose');
    first.scene.dispose();
    expect(geometries).toHaveBeenCalledTimes(1); expect(materials).toHaveBeenCalledTimes(1); expect(textures.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(first.scene.scene.children).toHaveLength(0);
    second.scene.dispose();
  });
});
