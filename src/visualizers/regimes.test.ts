import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Color, Material, ShaderMaterial, Texture, type Vector2, type Vector3, type Vector4, type WebGLRenderer } from 'three';
import { AudioAnalyzer } from '../audio/analysis/AudioAnalyzer';
import { newFrame } from '../audio/features/decode';
import { VisualResponse } from '../audio/visual-response/VisualResponse';
import { DEFAULT_DIRECTION } from '../director/profiles';
import { VisualDirector } from '../director/VisualDirector';
import { EventStream } from '../experience/EventStream';
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
import { createMotion, TunnelMotionCoordinator, tunnelLab } from './tunnel/motion';
import { CONFIGURATIONS, createTopology, FRONT_SPEED, tunnelTopology } from './tunnel/topology';
import { TunnelVisualizer } from './tunnel/TunnelVisualizer';

const NEUTRAL = { motion: 1, expansion: 1, turbulence: 1 };
/** The tunnel as it was before its motion was coordinated: every transformation answers the world by itself. */
const tunnelAsItWas = { ...tunnel, visual: { ...tunnel.visual, balance: 0 } };
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
  const events = new EventStream();
  const clock = { time: 0, hits: { times: new Float64Array(8).fill(-Infinity), strengths: new Float64Array(8), count: 0, size: 8 } as never, hitScale: 1, experience, events };
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
  return { scene, response, audio, shaders, world, experience, events, update, numbers, u: shaders[0].uniforms };
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
    const r = rig(new TunnelVisualizer(tunnelAsItWas)), u = r.u;
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

  it.each([['as it was', tunnelAsItWas], ['balanced', tunnel]])('the scene, %s: in a world that has come to rest nothing moves, and it is the same at 30 and 144 frames per second', (_name, preset) => {
    const play = (fps: number) => {
      const r = rig(new TunnelVisualizer(preset));
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
    // Coordinated, what gives way to the opening wall follows it at the frame's own pace: the same to three parts in a thousand.
    const tolerance = preset === tunnel ? 3 * TOLERANCE : TOLERANCE;
    for (const name of Object.keys(na)) for (let i = 0; i < na[name].length; i++) expect(Math.abs(nb[name][i] - na[name][i]), name).toBeLessThan(tolerance * Math.max(1, Math.abs(na[name][i])));
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

describe('Tunnel: balanced motion', () => {
  afterEach(() => { tunnelLab.balance = null; });
  type Rig = ReturnType<typeof rig<TunnelVisualizer>>;
  const pair = (): [Rig, Rig] => [rig(new TunnelVisualizer(tunnelAsItWas)), rig(new TunnelVisualizer(tunnel))];
  const gap = (r: Rig): number[] => (r.u.uGap.value as Vector2).toArray();
  const form = (r: Rig): number[] => (r.u.uForm.value as Vector4).toArray();
  /** An event of the session at the world's present time. */
  const strike = (r: Rig, significance: number, type: 'impact' | 'drop' = 'impact'): void => r.events.push(type, r.world.time, 0.5, 0.9, 1, 0.5, 0, significance);
  /** Both tunnels through the same world, frame by frame. */
  const both = (rigs: Rig[], seconds: number, each: (k: number, world: WorldState, r: Rig) => void, after?: (k: number) => void, fps = 60): void => {
    for (let k = 0; k < Math.round(seconds * fps); k++) {
      for (const r of rigs) { each(k, r.world, r); r.update(1 / fps, true, fps); }
      after?.(k);
    }
  };

  it('the travel stays the world\'s and is continuous: a kick surges the tunnel, it does not jerk it', () => {
    const [was, now] = pair();
    for (const r of [was, now]) r.update(1);
    const speed = [0, 0], last = [was.u.uTravel.value as number, now.u.uTravel.value as number], jerk = [0, 0], start = [...last];
    // The world's speed as kicks make it: a jump every half second, coasting down between them.
    both([was, now], 12, (k, world) => { world.speed = 1.2 + 1.6 * Math.exp(-((k / 60) % 0.5) / 0.15); }, () => {
      [was, now].forEach((r, i) => {
        const v = ((r.u.uTravel.value as number) - last[i]) * 60;
        jerk[i] = Math.max(jerk[i], Math.abs(v - speed[i])); speed[i] = v; last[i] = r.u.uTravel.value as number;
      });
    });
    // The same distance travelled (the advance is not what gives way), a third of the frame-to-frame change of speed.
    const distance = [(was.u.uTravel.value as number) - start[0], (now.u.uTravel.value as number) - start[1]];
    expect(distance[0]).toBeGreaterThan(50); expect(Math.abs(distance[1] / distance[0] - 1)).toBeLessThan(0.02);
    expect(jerk[1]).toBeLessThan(0.4 * jerk[0]);
    // Travel never runs backwards, and it stops when the world does (after the coast a moving thing has).
    for (const r of [was, now]) { r.world.speed = 0; r.update(3); }
    const still = now.u.uTravel.value;
    now.update(3);
    expect(now.u.uTravel.value).toBeCloseTo(still, 9);
    was.scene.dispose(); now.scene.dispose();
  });

  it('the wall opens when the world really strains, once, slowly, and closes later than it opened: it does not flutter', () => {
    const [was, now] = pair();
    for (const r of [was, now]) r.update(1);
    // A world that strains a little, and wavers: the wall as it was cracks open and shut with it; coordinated, it stays one wall.
    const turns = [0, 0], previous = [0, 0], rising = [true, true], most = [0, 0];
    const count = (k: number): void => [was, now].forEach((r, i) => {
      const g = gap(r)[1];
      if (k > 0 && Math.abs(g - previous[i]) > 1e-4 && (g > previous[i]) !== rising[i]) { turns[i]++; rising[i] = g > previous[i]; }
      previous[i] = g; most[i] = Math.max(most[i], g);
    });
    both([was, now], 10, (k, world) => { world.potential = 0.45 + 0.12 * Math.sin(2 * Math.PI * 1.7 * k / 60); world.turbulence = 0.08; }, count);
    expect(most[0]).toBeGreaterThan(0.02); expect(turns[0]).toBeGreaterThan(20);
    expect(most[1]).toBe(0); expect(turns[1]).toBe(0);
    // It strains for real: the wall opens, over more than half a second, not in a frame.
    const opening: number[] = [];
    both([was, now], 2, (_k, world) => { world.potential = 0.9; world.turbulence = 0.5; }, () => opening.push(gap(now)[1]));
    expect(gap(was)[1]).toBeGreaterThan(0.2);
    expect(opening[2]).toBeLessThan(0.1 * opening[119]); expect(opening[20]).toBeLessThan(0.75 * opening[119]); expect(opening[119]).toBeGreaterThan(0.8 * gap(was)[1]);
    for (let k = 1; k < opening.length; k++) expect(opening[k] - opening[k - 1]).toBeLessThan(0.02);
    // The strain wavers about where it would crack: open, the wall stays open (it closes only well below where it opened).
    turns[1] = 0; rising[1] = false; previous[1] = gap(now)[1];
    let least = 1;
    both([now], 8, (k, world) => { world.potential = 0.62 + 0.1 * Math.sin(2 * Math.PI * 1.3 * k / 60); world.turbulence = 0.1; }, (k) => { if (k > 120) least = Math.min(least, gap(now)[1]); });
    expect(least).toBeGreaterThan(0.03);
    // The world comes to rest: the wall closes over many frames, never in one, and is the corridor again.
    const closing: number[] = [];
    both([now], 4, (_k, world) => { world.potential = 0; world.turbulence = 0; }, () => closing.push(gap(now)[1]));
    expect(closing[5]).toBeGreaterThan(0.3 * closing[0]); expect(closing[239]).toBe(0);
    for (let k = 1; k < closing.length; k++) expect(closing[k]).toBeLessThanOrEqual(closing[k - 1] + 1e-12);
    expect(form(now).slice(2)).toEqual([0, 0]);
    was.scene.dispose(); now.scene.dispose();
  });

  it('an ordinary kick moves the wall as a pulse, not as architecture; an event that stands out opens the rings, one at a time', () => {
    const [was, now] = pair();
    for (const r of [was, now]) r.update(1);
    let wasOpen = 0, nowOpen = 0, pulse = 0;
    // Kicks of a steady beat: the world's own impulses, each an ordinary event of the session.
    both([was, now], 6, (k, world, r) => {
      if (k % 30 === 0) { world.impulseTime = world.time; world.impulseStrength = 0.9; world.excitation = 0.8; strike(r, 0.4); } else world.excitation *= 0.93;
    }, () => { wasOpen = Math.max(wasOpen, gap(was)[1]); nowOpen = Math.max(nowOpen, gap(now)[1]); pulse = Math.max(pulse, now.u.uRing.value as number); });
    expect(wasOpen).toBeGreaterThan(0.08); expect(nowOpen).toBe(0);
    // The lows are still all there: the rings sent down the tunnel are the same in both.
    expect(now.u.uRing.value).toBe(was.u.uRing.value); expect(pulse).toBeGreaterThan(tunnel.visual.ringTrace * 0.8);
    expect(now.scene.coordinator.refused).toBe(12); expect(now.scene.coordinator.accents).toBe(0);
    // One that stands out far beyond the usual accents: the rings part for half a second and close again.
    strike(now, 0.95); now.update(1 / 60);
    const struck = gap(now)[1];
    expect(struck).toBeGreaterThan(0.05); expect(now.scene.coordinator.accents).toBe(1);
    // A second one right behind it is not another event; two seconds later the next one is.
    now.update(0.5); strike(now, 1); now.update(1 / 60);
    expect(now.scene.coordinator.accents).toBe(1); expect(gap(now)[1]).toBeLessThan(struck);
    now.update(2);
    expect(gap(now)[1]).toBeLessThan(0.01);
    strike(now, 1); now.update(1 / 60);
    expect(now.scene.coordinator.accents).toBe(2);
    // While a release is passing down the tunnel it is the event: nothing is added beside it.
    now.update(3);
    now.world.releaseTime = now.world.time; now.world.releaseStrength = 0.7;
    strike(now, 1, 'drop'); now.update(1 / 60);
    expect(now.u.uRelease.value).toBeGreaterThan(0.9); expect(now.scene.coordinator.accent).toBe(0);
    was.scene.dispose(); now.scene.dispose();
  });

  it('while the wall is open torsion, bend and the oval give way; the lows, the highs and the light do not', () => {
    const [was, now] = pair();
    for (const r of [was, now]) { r.response.midAudible = r.response.highAudible = r.response.lowAudible = 1; r.response.flow = 0.8; r.response.detail = 0.7; r.response.weight = 0.8; r.update(1); }
    const set = (world: WorldState, open: boolean): void => { Object.assign(world, { spin: 0.8, radius: 0.3, excitation: 0.6, illumination: 0.7, coherence: 0.8, turbulence: open ? 0.7 : 0.1, potential: open ? 0.85 : 0.1 }); };
    both([was, now], 6, (_k, world) => set(world, false));
    const closed = { twist: now.u.uTwist.value as number, bend: now.u.uBend.value as number, oval: (now.u.uBreath.value as Vector3).x, waveguide: now.u.uWaveguide.value as number };
    // With the wall whole the coordinated tunnel shows what the world asks (its torsion bounded), and nothing is spent on events.
    expect(now.scene.coordinator.occupancy).toBe(0); expect(closed.twist).toBeCloseTo(was.u.uTwist.value as number, 4); expect(closed.waveguide).toBe(was.u.uWaveguide.value);
    both([was, now], 6, (_k, world) => set(world, true));
    expect(now.scene.coordinator.occupancy).toBeGreaterThan(0.7);
    // Twist is the same in the world; less of it is shown. Bend rises with disorder in the tunnel as it was; here it gives half of that up.
    expect(now.u.uTwist.value).toBeLessThan(0.6 * (was.u.uTwist.value as number)); expect(now.u.uTwist.value).toBeGreaterThan(0.2 * (was.u.uTwist.value as number));
    expect(now.u.uBend.value).toBeLessThan(0.7 * (was.u.uBend.value as number)); expect((now.u.uBreath.value as Vector3).x).toBeLessThan(0.7 * (was.u.uBreath.value as Vector3).x);
    expect(now.u.uWaveguide.value).toBeLessThan(0.75 * (was.u.uWaveguide.value as number));
    // Progressive, never a cut: nothing is removed.
    for (const value of [now.u.uTwist.value, now.u.uBend.value, (now.u.uBreath.value as Vector3).x, now.u.uWaveguide.value]) expect(value).toBeGreaterThan(0);
    // The lows (pressure on the radius, the rings), the highs (fine grid, corrugation, sparks) and the light are the world's, whole.
    expect(now.u.uRadius.value).toBe(was.u.uRadius.value); expect(now.u.uRing.value).toBe(was.u.uRing.value);
    expect(now.u.uDetail.value).toBe(was.u.uDetail.value); expect((now.u.uBreath.value as Vector3).y).toBe((was.u.uBreath.value as Vector3).y); expect(now.u.uDensity.value).toBe(was.u.uDensity.value);
    expect(now.shaders[1].uniforms.uSparks.value).toBe(was.shaders[1].uniforms.uSparks.value);
    // The architecture is the world's own once open: the same sides, the same constriction.
    expect(form(now)[0]).toBeCloseTo(form(was)[0], 3); expect(form(now)[1]).toBeCloseTo(form(was)[1], 3);
    was.scene.dispose(); now.scene.dispose();
  });

  it('torsion is bounded and never flips: rings do not jump when the world turns the other way', () => {
    const [was, now] = pair();
    for (const r of [was, now]) { r.response.flow = 1; r.update(1); }
    let jumpWas = 0, jumpNow = 0, twist = 0;
    const last = [0, 0];
    // An open wall in a world whose rotation swings through zero twice a second.
    both([was, now], 8, (k, world) => { world.potential = 0.9; world.turbulence = 0.6; world.spin = 2.5 * Math.sin(2 * Math.PI * k / 60); }, (k) => {
      const a = form(was)[3], b = form(now)[3];
      if (k > 120) { jumpWas = Math.max(jumpWas, Math.abs(a - last[0])); jumpNow = Math.max(jumpNow, Math.abs(b - last[1])); twist = Math.max(twist, Math.abs(now.u.uTwist.value as number)); }
      last[0] = a; last[1] = b;
    });
    // As it was, the rings' shear takes the sign of the spin at once (a jump of both its sides); coordinated it passes through zero.
    expect(jumpWas).toBeGreaterThan(0.03); expect(jumpNow).toBeLessThan(0.25 * jumpWas);
    expect(twist).toBeLessThanOrEqual(0.028 + 1e-12);
    // Any world, any frame: finite, the torsion within its bound, the radius within its range.
    for (const world of WORLDS) for (const dt of [1 / 60, 0, 1e-9, 5]) {
      Object.assign(now.world, createWorld(), { time: now.world.time }, world, { time: now.world.time });
      for (let k = 0; k < 30; k++) { now.world.time += 1 / 60; now.scene.update(now.audio, dt, now.world.time, now.response, undefined, undefined); now.update(1 / 60); }
      for (const [name, values] of Object.entries(now.numbers())) for (const value of values) expect(Number.isFinite(value), name).toBe(true);
      expect(Math.abs(now.u.uTwist.value as number)).toBeLessThanOrEqual(0.028 + 1e-12);
      expect(now.u.uRadius.value).toBeGreaterThanOrEqual(0.7 * tunnel.visual.radius - 1e-9); expect(now.u.uRadius.value).toBeLessThanOrEqual(1.4 * tunnel.visual.radius + 1e-9);
      expect(Math.abs(now.scene.camera.rotation.z)).toBeLessThanOrEqual(0.5);
    }
    was.scene.dispose(); now.scene.dispose();
  });

  it('the number of lobes and of ring cycles follows the notes without flickering with them', () => {
    const [was, now] = pair();
    for (const r of [was, now]) r.update(1);
    let stepWas = 0, stepNow = 0;
    const last = [was.u.uLobes.value as number, now.u.uLobes.value as number];
    // A bass line that jumps an octave and a half every quarter of a second.
    both([was, now], 6, (k, _world, r) => { r.response.music.bassPitch = Math.floor(k / 15) % 2 ? 110 : 41; r.response.music.leadPitch = Math.floor(k / 15) % 2 ? 660 : 220; }, () => {
      stepWas = Math.max(stepWas, Math.abs((was.u.uLobes.value as number) - last[0])); stepNow = Math.max(stepNow, Math.abs((now.u.uLobes.value as number) - last[1]));
      last[0] = was.u.uLobes.value as number; last[1] = now.u.uLobes.value as number;
    });
    expect(stepWas).toBeGreaterThan(0.5); expect(stepNow).toBeLessThan(0.05);
    // It still follows: held on the high note, the section has its lobes.
    both([was, now], 6, (_k, _world, r) => { r.response.music.bassPitch = 110; });
    expect(now.u.uLobes.value).toBeCloseTo(was.u.uLobes.value as number, 1);
    was.scene.dispose(); now.scene.dispose();
  });

  it('the same at 30, 60, 120 and 144 frames per second; at rest in silence; the corridor at once without a clock; and comparable on one switch', () => {
    const play = (fps: number) => {
      const r = rig(new TunnelVisualizer(tunnel));
      r.update(1, true, fps);
      Object.assign(r.world, { spin: 1.2, speed: 2, potential: 0.8, turbulence: 0.5, radius: 0.3, bias: 0.4 });
      r.update(1, true, fps);
      // Dated on the audio clock: the same instants at every rate.
      r.events.push('impact', 2, 0.6, 0.9, 1, 0.5, 0, 0.95);
      r.world.releaseTime = 2.5; r.world.releaseStrength = 0.6; r.world.impulseTime = 2; r.world.impulseStrength = 0.8;
      r.update(1.5, true, fps);
      return r;
    };
    const skip = ['uTraceShift', 'uSparkTravel', 'uPixelRatio'];
    const reference = play(30), names = reference.numbers(skip);
    for (const fps of [60, 120, 144]) {
      const other = play(fps), values = other.numbers(skip);
      for (const name of Object.keys(names)) for (let i = 0; i < names[name].length; i++) expect(Math.abs(values[name][i] - names[name][i]), `${name} @ ${fps}`).toBeLessThan(3 * TOLERANCE * Math.max(1, Math.abs(names[name][i])));
      expect(other.scene.coordinator.accents).toBe(1);
      other.scene.dispose();
    }
    // Silence: the world's velocities and fields gone, everything it excited decays and stays decayed.
    const a = reference;
    Object.assign(a.world, { spin: 0, speed: 0, potential: 0, turbulence: 0, radius: 0, bias: 0, excitation: 0, illumination: 0 });
    a.update(30);
    const still = a.numbers(skip);
    for (const value of [...still.uGap, ...still.uForm, ...still.uTwist, ...still.uRelease, ...still.uLateral]) expect(Math.abs(value)).toBeLessThan(1e-6);
    expect(a.scene.coordinator.occupancy).toBeLessThan(1e-6); expect(a.scene.coordinator.aperture).toBe(0);
    a.update(5);
    const later = a.numbers([...skip, 'uFront']);
    for (const name of Object.keys(later)) for (let i = 0; i < later[name].length; i++) expect(Math.abs(later[name][i] - still[name][i]), name).toBeLessThan(1e-6);
    // The clock is lost: nothing is known of the world, and what was being followed is dropped at once.
    Object.assign(a.world, { potential: 0.9, turbulence: 0.8, spin: 1.5 });
    a.update(3);
    expect(gap(a)[1]).toBeGreaterThan(0.2);
    a.update(1 / 60, false);
    expect(gap(a)).toEqual([0, 0]); expect(form(a)).toEqual([0, 0, 0, 0]); expect(a.u.uTwist.value).toBe(0);
    // The development switch replaces the preset's balance: the same scene, as it was and balanced, on the same world.
    a.update(3);
    const balanced = gap(a)[1];
    tunnelLab.balance = 0; a.update(1 / 60);
    const before = gap(a)[1];
    expect(a.scene.debug.balance).toBe(0); expect(before).toBeCloseTo(tunnelTopology(createTopology(), viewOf({ potential: 0.9, turbulence: 0.8, spin: 1.5 })).gapAxial, 6);
    tunnelLab.balance = 1; a.update(1 / 60);
    expect(a.scene.debug.balance).toBe(1); expect(Math.abs(gap(a)[1] - balanced)).toBeLessThan(0.05);
    a.scene.dispose();
  });

  it('the coordinator alone: part of the way lies between, and it allocates nothing it does not own', () => {
    const view = viewOf({ potential: 0.9, turbulence: 0.6, spin: 2 }), raw = createMotion(), topology = tunnelTopology(createTopology(), view);
    Object.assign(raw, { advance: 0.05, turn: 0.02, radius: 4.4, fov: 75, twist: 0.05, bend: 2.5, oval: 0.1, waveguide: 0.2, shape: 0.2, lobes: 5, cycles: 3 });
    const full = new TunnelMotionCoordinator(4), half = new TunnelMotionCoordinator(4);
    const motion = full.motion, wall = full.topology;
    for (let k = 0; k < 600; k++) { full.step(1 / 60, view, raw, topology, 1); half.step(1 / 60, view, raw, topology, 0.5); }
    expect(full.motion).toBe(motion); expect(full.topology).toBe(wall);
    for (const key of ['twist', 'bend', 'oval', 'waveguide'] as const) {
      expect(full.motion[key]).toBeLessThan(raw[key]);
      expect(half.motion[key]).toBeCloseTo(0.5 * (raw[key] + full.motion[key]), 6);
    }
    expect(full.motion.twist).toBeLessThanOrEqual(0.028); expect(full.motion.advance).toBeCloseTo(raw.advance, 9);
    // A balance that is not a number is none.
    const none = new TunnelMotionCoordinator(4);
    none.step(1 / 60, view, raw, topology, NaN);
    expect(none.motion.twist).toBe(raw.twist); expect(none.topology.gapAxial).toBe(topology.gapAxial);
    full.reset();
    expect(full.motion).toEqual(createMotion()); expect(full.occupancy).toBe(0);
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
