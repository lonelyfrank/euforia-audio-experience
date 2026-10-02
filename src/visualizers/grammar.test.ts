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

function rig(scene: Visualizer) {
  const passes: Pass[] = [];
  scene.init({ renderer: { getPixelRatio: () => 1 } as WebGLRenderer, quality: QUALITY_PROFILES.low, width: 800, height: 600, addPass: (pass) => { passes.push(pass); } });
  scene.resize(800, 600);
  scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
  const audio = new AudioAnalyzer().frame;
  const response = new VisualResponse().frame;
  const shaders: ShaderMaterial[] = [];
  scene.scene.traverse((object) => {
    const material = (object as unknown as { material?: ShaderMaterial }).material;
    if (material instanceof ShaderMaterial) shaders.push(material);
  });
  const update = (seconds = 1) => { for (let i = 0; i < seconds * 60; i++) scene.update(audio, 1 / 60, i / 60, response); };
  const dispose = () => { scene.dispose(); for (const pass of passes) pass.dispose(); };
  return { response, audio, shaders, passes, update, dispose };
}

beforeEach(() => vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 }));
afterEach(() => vi.unstubAllGlobals());

describe('scene grammar', () => {
  it('Galaxy compresses a build, releases a radial wave and stops spinning without sound', () => {
    const r = rig(new GalaxyVisualizer(galaxy));
    const u = r.shaders[0].uniforms;
    r.response.openness = 0.5;
    r.update();
    const radius = u.uRadius.value;
    r.response.tension = 1;
    r.update();
    expect(u.uRadius.value).toBeLessThan(radius * 0.8);
    expect(u.uTension.value).toBe(1);
    r.response.music.drop = 1;
    r.update();
    expect(u.uRelease.value).toBe(1);
    const spin = u.uSpin.value;
    r.update(3);
    expect(u.uSpin.value).toBe(spin);
    r.dispose();
  });
  it('Tunnel closes during tension, opens on a drop and derives travel from motion', () => {
    const r = rig(new TunnelVisualizer(tunnel));
    const u = r.shaders[0].uniforms;
    r.response.audible = 1;
    r.response.motion = 0.7;
    r.update();
    const radius = u.uRadius.value;
    r.response.tension = 1;
    r.update();
    expect(u.uRadius.value).toBeLessThan(radius);
    r.response.music.drop = 1;
    r.update();
    expect(u.uRadius.value).toBeGreaterThan(radius);
    expect(u.uRelease.value).toBe(1);
    expect(u.uTravel.value).toBeGreaterThan(0);
    r.response.audible = 0;
    const travel = u.uTravel.value;
    r.update(3);
    expect(u.uTravel.value).toBe(travel);
    r.dispose();
  });

  it('Particles spread with openness, cluster under tension, release and rest', () => {
    const r = rig(new ParticleFieldVisualizer(particles));
    const u = r.shaders[0].uniforms;
    r.update();
    const closed = u.uSpread.value;
    r.response.openness = 1;
    r.update();
    expect(u.uSpread.value).toBeGreaterThan(closed * 1.5);
    const open = u.uSpread.value;
    r.response.tension = 1;
    r.update();
    expect(u.uSpread.value).toBeLessThan(open * 0.8);
    r.response.music.drop = 1;
    r.update();
    expect(u.uRelease.value).toBe(1);
    const travel = u.uTravel.value;
    r.update(3);
    expect(u.uTravel.value).toBe(travel);
    r.dispose();
  });

  it('Liquid becomes narrow and laminar in a build, then releases a broad shock', () => {
    const r = rig(new LiquidVisualizer(liquid));
    const u = r.shaders[0].uniforms;
    r.update();
    const width = u.uWidth.value;
    r.response.tension = 1;
    r.update();
    expect(u.uWidth.value).toBeLessThan(width * 0.8);
    r.response.music.drop = 1;
    r.update(1 / 60);
    expect(u.uWidth.value).toBeGreaterThan(width * 0.9);
    expect(u.uShocks.value.some((shock: { y: number }) => shock.y > 1)).toBe(true);
    const clock = u.uClock.value;
    r.update(3);
    expect(u.uClock.value).toBe(clock);
    r.dispose();
  });

  it('Spectrum packs echoes under tension and remembers audibility across a cut', () => {
    const r = rig(new SpectrumVisualizer(spectrum));
    const u = r.shaders[0].uniforms;
    r.response.audible = r.response.lowAudible = r.response.midAudible = r.response.highAudible = 1;
    r.response.motion = 0.6;
    r.response.trace = 1;
    r.update();
    const spacing = u.uEchoSpread.value;
    r.response.tension = 1;
    r.update();
    expect(u.uEchoSpread.value).toBeLessThan(spacing * 0.5);
    r.response.music.drop = 1;
    r.update(1 / 60);
    expect(u.uRelease.value).toBe(1);
    r.response.audible = r.response.lowAudible = r.response.midAudible = r.response.highAudible = 0;
    r.response.motion = r.response.trace = 0;
    r.update(0.2);
    expect(u.uAudible.value.lengthSq()).toBe(0);
    expect(u.uEchoAudible.value.some((v: { x: number }) => v.x > 0.1)).toBe(true);
    r.update(20);
    expect(u.uEchoAudible.value.every((v: { x: number }) => v.x < 0.001)).toBe(true);
    r.dispose();
  });

  it('Oscilloscope preserves three channels and uses trace/drop for phosphor persistence', () => {
    const scene = new OscilloscopeVisualizer(scope);
    const r = rig(scene);
    const pass = r.passes[0] as AfterimagePass;
    r.update();
    const idle = pass.uniforms.damp.value;
    r.response.trace = 1;
    r.update();
    const trace = pass.uniforms.damp.value;
    expect(trace).toBeGreaterThan(idle);
    r.response.music.drop = 1;
    r.update();
    expect(pass.uniforms.damp.value).toBeGreaterThan(trace);
    expect(scene.scene.children).toHaveLength(4); // CH1/2/3 and the grid
    r.response.trace = r.response.music.drop = 0;
    r.update();
    expect(pass.uniforms.damp.value).toBe(idle);
    r.dispose();
  });

});
