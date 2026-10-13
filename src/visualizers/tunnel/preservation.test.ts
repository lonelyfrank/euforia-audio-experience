import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Color, ShaderMaterial, Texture, type Vector4, type WebGLRenderer } from 'three';
import { AudioAnalyzer } from '../../audio/analysis/AudioAnalyzer';
import { newFrame } from '../../audio/features/decode';
import { VisualResponse } from '../../audio/visual-response/VisualResponse';
import { DEFAULT_DIRECTION } from '../../director/profiles';
import { VisualDirector } from '../../director/VisualDirector';
import { EventStream } from '../../experience/EventStream';
import { createSnapshot } from '../../experience/types';
import { QUALITY_PROFILES } from '../../renderer/quality';
import { createWorld, type WorldState } from '../../world/WorldState';
import { WorldView } from '../../world/WorldView';
import { createMotion, TunnelMotionCoordinator } from './motion';
import preset from './preset.json';
import { createTopology, tunnelTopology } from './topology';
import { TunnelVisualizer } from './TunnelVisualizer';

/*
 * Infinite Tunnel, bit for bit. The tunnel's motion is the reference of the engine for travel and anticipation, and
 * what it shares with other scenes (visualizers/shared/motion.ts) was taken out of its coordinator: these digests were
 * recorded on the coordinator and the scene as they were before that (commit a08fb85) and hold every number of every
 * frame of a scripted session, to the last bit. A change here is a change of what the tunnel shows.
 *
 * To record them again after a change that is meant to alter the tunnel: run with EUFORIA_TUNNEL_DIGEST=1 and copy the
 * values printed, in the same commit that explains why.
 */

/** FNV-1a over the bits of every number written to it. */
class Digest {
  private hash = 0x811c9dc5;
  private readonly bytes = new Uint8Array(8);
  private readonly view = new DataView(this.bytes.buffer);
  add(x: number): void {
    this.view.setFloat64(0, x);
    for (let i = 0; i < 8; i++) this.hash = Math.imul(this.hash ^ this.bytes[i], 0x01000193) >>> 0;
  }
  get value(): string { return this.hash.toString(16).padStart(8, '0'); }
}

/** A session with everything the tunnel answers: kicks, a build, a release, disorder, a turn that reverses, one broken frame. */
function script(world: WorldState, t: number, k: number, fps: number): void {
  world.time = t;
  const beat = (t % 0.5) / 0.5;
  world.speed = 1.2 + 1.6 * Math.exp(-beat * 0.5 / 0.15) + (t > 14 && t < 20 ? 2 * Math.exp(-(t - 14) / 2) : 0);
  world.travel += world.speed / fps;
  world.spin = 1.4 * Math.sin(t * 0.37) + 0.3 * Math.sin(t * 2.1);
  world.angle += world.spin / fps;
  world.radius = 0.3 * Math.exp(-beat * 0.5 / 0.2) - 0.25 * world.potential;
  world.bias = 0.6 * Math.sin(t * 0.23);
  world.excitation = 0.8 * Math.exp(-beat * 0.5 / 0.3);
  world.shimmer = 0.5 + 0.5 * Math.sin(t * 5.3);
  world.potential = t < 6 ? 0 : t < 14 ? Math.min(0.95, (t - 6) / 7) : 0.08 * Math.exp(-(t - 14) / 3);
  world.turbulence = 0.15 + 0.5 * Math.max(0, Math.sin(t * 0.41)) ** 2;
  world.coherence = 1 - 0.6 * world.turbulence;
  world.illumination = 0.4 + 0.3 * Math.sin(t * 0.6);
  if (k % Math.round(fps / 2) === 0) { world.impulseTime = t; world.impulseStrength = 0.5 + 0.4 * Math.sin(t * 1.3); }
  if (t >= 14 && world.releaseTime < 14) { world.releaseTime = t; world.releaseStrength = 0.7; }
  // One frame of a broken world: nothing of it may stay.
  if (k === Math.round(22 * fps)) { world.potential = NaN; world.spin = Infinity; }
}

/** The session's own events for the same script: ordinary kicks, some that stand out, the drop. */
function strike(events: EventStream, t: number, k: number, fps: number): void {
  if (k % Math.round(fps / 2) === 0) events.push('impact', t, 0.6, 0.9, 1, 0.4, 0, (k / Math.round(fps / 2)) % 7 === 3 ? 0.92 : 0.35);
  if (k === Math.round(14 * fps)) events.push('drop', t, 0.8, 0.9, -1, 0.7, 0, 0.95);
}

function coordinatorDigest(balance: number, fps: number): string {
  const world = createWorld(), view = new WorldView(), coordinator = new TunnelMotionCoordinator(4), raw = createMotion(), topology = createTopology();
  const events = new EventStream(), digest = new Digest(), gains = { motion: 1, expansion: 1, turbulence: 1 };
  for (let k = 0; k < 30 * fps; k++) {
    const t = (k + 1) / fps;
    script(world, t, k, fps); strike(events, t, k, fps);
    view.update(world, gains);
    raw.advance = view.dTravel; raw.turn = view.dTurn; raw.radius = 4 * Math.max(0.4, 1 + 0.42 * view.pressure); raw.fov = 75 * (0.9 + 0.2 * view.openness);
    raw.shape = 0.3 * view.excitation; raw.lobes = 4 + 2 * Math.sin(t * 0.8); raw.ring = 0.14 * (0.5 + 0.6 * view.excitation);
    raw.wobble = 0.4 * view.coherence; raw.cycles = 3 + Math.sin(t * 0.5); raw.twist = view.spin * 0.03; raw.bend = 3 * (0.1 + 1.4 * view.disorder);
    raw.lateral = view.lateral; raw.oval = 0.1 * view.coherence; raw.waveguide = 0.3 * (0.4 + 0.6 * view.coherence);
    raw.detail = view.shimmer; raw.ripple = 0.035 * view.shimmer; raw.sparks = view.shimmer; raw.light = view.light;
    tunnelTopology(topology, view);
    const m = coordinator.step(1 / fps, view, raw, topology, balance, events, t), c = coordinator.topology;
    for (const key of Object.keys(m) as (keyof typeof m)[]) digest.add(m[key]);
    for (const key of Object.keys(c) as (keyof typeof c)[]) digest.add(c[key]);
    digest.add(coordinator.occupancy); digest.add(coordinator.aperture); digest.add(coordinator.accent); digest.add(coordinator.rollShare);
    digest.add(coordinator.accents); digest.add(coordinator.refused);
  }
  return digest.value;
}

function sceneDigest(balance: number, fps: number): string {
  const scene = new TunnelVisualizer({ ...preset, visual: { ...preset.visual, balance } });
  scene.init({ renderer: { getPixelRatio: () => 1 } as WebGLRenderer, quality: QUALITY_PROFILES.low, width: 800, height: 600, addPass: () => {} });
  scene.resize(800, 600);
  scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
  const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame, director = new VisualDirector();
  const experience = createSnapshot(newFrame()), world = experience.world, events = new EventStream(), digest = new Digest();
  const clock = { time: 0, hits: { times: new Float64Array(8).fill(-Infinity), strengths: new Float64Array(8), count: 0, size: 8 } as never, hitScale: 1, experience, events };
  const shaders: ShaderMaterial[] = [];
  scene.scene.traverse((object) => {
    const material = (object as unknown as { material?: ShaderMaterial }).material;
    if (material instanceof ShaderMaterial) shaders.push(material);
  });
  for (let k = 0; k < 30 * fps; k++) {
    const t = (k + 1) / fps;
    script(world, t, k, fps); strike(events, t, k, fps);
    clock.time = t;
    // A band that comes and goes, so the parts that fade with their band are in the picture too.
    response.lowAudible = 0.5 + 0.5 * Math.sin(t * 0.7); response.midAudible = 0.5 + 0.5 * Math.sin(t * 0.9); response.highAudible = 0.5 + 0.5 * Math.sin(t * 1.1);
    response.weight = 0.6; response.flow = 0.5; response.detail = 0.4; response.trace = 0.3;
    const modulation = director.update(response, DEFAULT_DIRECTION, 1 / fps, undefined, experience);
    scene.update(audio, 1 / fps, t, response, modulation, clock);
    for (const material of shaders) {
      for (const uniform of Object.values(material.uniforms)) {
        const value = uniform.value as unknown;
        if (value instanceof Color || value instanceof Texture || value === null) continue;
        if (typeof value === 'number') digest.add(value);
        else for (const x of ArrayBuffer.isView(value) ? Array.from(value as Float32Array) : (value as Vector4).toArray()) digest.add(x);
      }
    }
    digest.add(scene.camera.rotation.z); digest.add(scene.camera.fov);
  }
  scene.dispose();
  return digest.value;
}

const RECORDED = {
  coordinator: { 'balanced 60': '1b71cd90', 'balanced 144': '0c7b730c', 'half 60': 'f63ccf42' },
  scene: { 'as it was 60': 'af8f41ca', 'balanced 60': 'cac1b490', 'balanced 30': '5f380c63' },
};

beforeEach(() => vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 }));
afterEach(() => vi.unstubAllGlobals());

describe('Infinite Tunnel is preserved bit for bit', () => {
  const record = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env.EUFORIA_TUNNEL_DIGEST;
  const measured = {
    coordinator: { 'balanced 60': coordinatorDigest(1, 60), 'balanced 144': coordinatorDigest(1, 144), 'half 60': coordinatorDigest(0.5, 60) },
    scene: { 'as it was 60': sceneDigest(0, 60), 'balanced 60': sceneDigest(1, 60), 'balanced 30': sceneDigest(1, 30) },
  };
  if (record) console.log(`tunnel digests:\n${JSON.stringify(measured, null, 2)}`);

  it('the coordinator shows the same numbers, frame by frame, as before its followers were shared', () => {
    expect(measured.coordinator).toEqual(RECORDED.coordinator);
  });

  it('the scene writes the same uniforms and the same camera, as it was and balanced', () => {
    expect(measured.scene).toEqual(RECORDED.scene);
  });

  it('the script reaches what it is there for: the wall opens, accents are taken and refused, a release passes', () => {
    const world = createWorld(), view = new WorldView(), coordinator = new TunnelMotionCoordinator(4), raw = createMotion(), topology = createTopology(), events = new EventStream();
    let open = 0, release = 0;
    for (let k = 0; k < 30 * 60; k++) {
      const t = (k + 1) / 60;
      script(world, t, k, 60); strike(events, t, k, 60);
      view.update(world, { motion: 1, expansion: 1, turbulence: 1 });
      raw.advance = view.dTravel; raw.turn = view.dTurn; raw.radius = 4; raw.fov = 75;
      tunnelTopology(topology, view);
      coordinator.step(1 / 60, view, raw, topology, 1, events, t);
      open = Math.max(open, coordinator.aperture); release = Math.max(release, coordinator.topology.release);
      for (const value of Object.values(coordinator.motion)) expect(Number.isFinite(value)).toBe(true);
    }
    expect(open).toBe(1); expect(release).toBeGreaterThan(0.9);
    expect(coordinator.accents).toBeGreaterThan(2); expect(coordinator.refused).toBeGreaterThan(20);
  });
});
