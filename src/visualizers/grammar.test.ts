import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Color, ShaderMaterial, type WebGLRenderer } from 'three';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { AudioAnalyzer } from '../audio/analysis/AudioAnalyzer';
import { VisualResponse } from '../audio/visual-response/VisualResponse';
import { QUALITY_PROFILES } from '../renderer/quality';
import type { Visualizer } from '../types/visualizer';
import { GalaxyVisualizer } from './galaxy/GalaxyVisualizer';
import galaxy from './galaxy/preset.json';
import { TunnelVisualizer } from './tunnel/TunnelVisualizer';
import tunnel from './tunnel/preset.json';
import { ParticleFieldVisualizer } from './particle-field/ParticleFieldVisualizer';
import particles from './particle-field/preset.json';
import { LiquidVisualizer } from './liquid/LiquidVisualizer';
import liquid from './liquid/preset.json';
import { SpectrumVisualizer } from './spectrum/SpectrumVisualizer';
import spectrum from './spectrum/preset.json';
import { OscilloscopeVisualizer } from './oscilloscope/OscilloscopeVisualizer';
import scope from './oscilloscope/preset.json';
import type { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { VisualDirector } from '../director/VisualDirector';
import { DEFAULT_DIRECTION } from '../director/profiles';
import { createSnapshot } from '../experience/types';
import { newFrame } from '../audio/features/decode';
import { ResonantFieldVisualizer } from './resonant-field/ResonantFieldVisualizer';
import field from './resonant-field/preset.json';

/**
 * A scene driven through a real Director whose world view observes a hand-set
 * WorldState: the tests check how each scene interprets the shared world,
 * not how it maps audio.
 */
function rig(scene: Visualizer) {
  const passes: Pass[] = [];
  scene.init({ renderer: { getPixelRatio: () => 1 } as WebGLRenderer, quality: QUALITY_PROFILES.low, width: 800, height: 600, addPass: (pass) => { passes.push(pass); } });
  scene.resize(800, 600);
  scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
  const audio = new AudioAnalyzer().frame;
  const response = new VisualResponse().frame;
  const director = new VisualDirector();
  const experience = createSnapshot(newFrame());
  const world = experience.world;
  const shaders: ShaderMaterial[] = [];
  scene.scene.traverse((object) => {
    const material = (object as unknown as { material?: ShaderMaterial }).material;
    if (material instanceof ShaderMaterial) shaders.push(material);
  });
  const clock = { time: 0, hits: { times: new Float64Array(8).fill(-Infinity), strengths: new Float64Array(8), count: 0, size: 8 } as never, hitScale: 1, experience };
  /** Advances the world by its own velocities (as the integrator would without forces) and the scene with it. */
  const update = (seconds = 1, live = true) => {
    for (let i = 0; i < seconds * 60; i++) {
      world.time += 1 / 60; world.travel += world.speed / 60; world.angle += world.spin / 60;
      clock.time = world.time;
      const modulation = director.update(response, DEFAULT_DIRECTION, 1 / 60, undefined, live ? experience : undefined);
      scene.update(audio, 1 / 60, world.time, response, modulation, live ? clock : undefined);
    }
  };
  const dispose = () => { scene.dispose(); for (const pass of passes) pass.dispose(); };
  return { scene, response, audio, shaders, passes, world, update, dispose };
}

beforeEach(() => vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 }));
afterEach(() => vi.unstubAllGlobals());

describe('scenes interpret the shared world', () => {
  it('Galaxy: orbits turn with angular momentum, tension winds and draws in, a release runs out, rest is still', () => {
    const r = rig(new GalaxyVisualizer(galaxy));
    const u = r.shaders[0].uniforms;
    r.update();
    const radius = u.uRadius.value, spin = u.uSpin.value;
    r.world.spin = 1;
    r.update();
    expect(u.uSpin.value).toBeGreaterThan(spin + 0.1);
    r.world.potential = 1; r.world.radius = -0.4;
    r.update();
    expect(u.uRadius.value).toBeLessThan(radius * 0.9);
    expect(u.uTension.value).toBe(1);
    r.world.releaseTime = r.world.time; r.world.releaseStrength = 0.6;
    r.update(1 / 60);
    expect(u.uRelease.value).toBeGreaterThan(0.95);
    r.world.coherence = 0.2;
    r.update(1 / 60);
    expect(u.uScatter.value).toBeGreaterThan(0.5);
    r.world.spin = 0;
    const still = u.uSpin.value;
    r.update(3);
    expect(u.uSpin.value).toBe(still);
    r.dispose();
  });

  it('Tunnel: the wall is the radial body, travel and torsion are the world momentum, stereo bends it', () => {
    const r = rig(new TunnelVisualizer(tunnel));
    const u = r.shaders[0].uniforms;
    r.update();
    const radius = u.uRadius.value;
    r.world.radius = -0.4;
    r.update(1 / 60);
    expect(u.uRadius.value).toBeLessThan(radius * 0.9);
    r.world.radius = 0.6;
    r.update(1 / 60);
    expect(u.uRadius.value).toBeGreaterThan(radius * 1.15);
    r.world.speed = 2; r.world.spin = 1; r.world.bias = -0.8;
    r.update();
    expect(u.uTravel.value).toBeGreaterThan(0);
    expect(u.uTwist.value).toBeGreaterThan(0.005);
    expect(u.uLateral.value).toBeLessThan(-0.5);
    r.world.speed = r.world.spin = 0;
    const travel = u.uTravel.value;
    r.update(3);
    expect(u.uTravel.value).toBe(travel);
    r.dispose();
  });

  it('Particles: pressure disperses, tension clusters, the vortex follows the spin, turbulence scatters', () => {
    const r = rig(new ParticleFieldVisualizer(particles));
    const u = r.shaders[0].uniforms;
    r.update();
    const spread = u.uSpread.value;
    r.world.radius = 0.8;
    r.update(1 / 60);
    expect(u.uSpread.value).toBeGreaterThan(spread * 1.2);
    r.world.potential = 1;
    r.update(1 / 60);
    expect(u.uTension.value).toBeGreaterThan(0.9);
    r.world.spin = -2; r.world.turbulence = 0.8;
    r.update(1 / 60);
    expect(u.uFlow.value).toBeLessThan(-1);
    expect(u.uDisorder.value).toBeGreaterThan(0.5);
    const travel = u.uTravel.value;
    r.update(3);
    expect(u.uTravel.value).toBe(travel);
    r.dispose();
  });

  it('Liquid: tension pulls the surface taut, a world release sends a broad ring, it drifts with travel', () => {
    const r = rig(new LiquidVisualizer(liquid));
    const u = r.shaders[0].uniforms;
    r.update();
    const width = u.uWidth.value;
    r.world.potential = 1;
    r.update(1 / 60);
    expect(u.uWidth.value).toBeLessThan(width * 0.8);
    r.world.potential = 0; r.world.releaseTime = r.world.time; r.world.releaseStrength = 0.6;
    r.update(1 / 60);
    expect(u.uWidth.value).toBeGreaterThan(width * 0.95);
    expect(u.uShocks.value.some((shock: { y: number }) => shock.y > 1)).toBe(true);
    r.world.speed = 1;
    const clock = u.uClock.value;
    r.update();
    expect(u.uClock.value).toBeGreaterThan(clock);
    r.world.speed = 0;
    const settled = u.uClock.value;
    r.update(3);
    expect(u.uClock.value).toBe(settled);
    r.dispose();
  });

  it('Spectrum: echoes travel with the world, pack under tension and keep their audibility across a cut', () => {
    const r = rig(new SpectrumVisualizer(spectrum));
    const u = r.shaders[0].uniforms;
    r.response.audible = r.response.lowAudible = r.response.midAudible = r.response.highAudible = 1;
    r.response.trace = 1;
    r.world.speed = 1;
    r.update();
    expect(u.uProgress.value).toBeGreaterThan(0);
    const spacing = u.uEchoSpread.value;
    r.world.potential = 1;
    r.update();
    expect(u.uEchoSpread.value).toBeLessThan(spacing * 0.5);
    r.world.releaseTime = r.world.time; r.world.releaseStrength = 0.6;
    r.update(1 / 60);
    expect(u.uRelease.value).toBeGreaterThan(0.95);
    r.response.audible = r.response.lowAudible = r.response.midAudible = r.response.highAudible = 0;
    r.response.trace = 0;
    r.update(0.2);
    expect(u.uAudible.value.lengthSq()).toBe(0);
    expect(u.uEchoAudible.value.some((v: { x: number }) => v.x > 0.1)).toBe(true);
    r.update(20);
    expect(u.uEchoAudible.value.every((v: { x: number }) => v.x < 0.001)).toBe(true);
    r.dispose();
  });

  it('Oscilloscope keeps three readable channels; excitation lengthens the phosphor, turbulence shortens it', () => {
    const scene = new OscilloscopeVisualizer(scope);
    const r = rig(scene);
    const pass = r.passes[0] as AfterimagePass;
    r.update();
    const idle = pass.uniforms.damp.value;
    r.world.excitation = 1;
    r.update(1 / 60);
    expect(pass.uniforms.damp.value).toBeGreaterThan(idle);
    r.world.excitation = 0; r.world.turbulence = 1;
    r.update(1 / 60);
    expect(pass.uniforms.damp.value).toBeLessThan(idle);
    expect(scene.scene.children).toHaveLength(4); // CH1/2/3 and the grid
    r.dispose();
  });

  it('one angular momentum, seven interpretations; without a clock every scene rests', () => {
    const turning = (make: () => Visualizer, read: (r: ReturnType<typeof rig>) => number) => {
      const r = rig(make());
      r.update(0.5);
      const before = read(r);
      r.world.spin = 1;
      r.update(1);
      const after = read(r);
      r.world.spin = 0;
      const rest = read(r);
      r.update(1, false);
      const still = read(r) === rest;
      r.dispose();
      return { moved: after - before, still };
    };
    const results = [
      turning(() => new GalaxyVisualizer(galaxy), (r) => r.shaders[0].uniforms.uSpin.value),
      turning(() => new TunnelVisualizer(tunnel), (r) => r.shaders[0].uniforms.uShapePhase.value),
      turning(() => new ParticleFieldVisualizer(particles), (r) => Math.abs(r.shaders[0].uniforms.uSwirlPhase.value)),
      turning(() => new SpectrumVisualizer(spectrum), (r) => Math.abs(r.shaders[0].uniforms.uRotation.value)),
      turning(() => new ResonantFieldVisualizer(field), (r) => r.scene.scene.children[0].rotation.z),
    ];
    for (const { moved, still } of results) { expect(Math.abs(moved)).toBeGreaterThan(1e-3); expect(still).toBe(true); }
  });
});
