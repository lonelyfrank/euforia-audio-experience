import { EventStream } from '../../experience/EventStream';
import { createGeometry } from '../../visual-engine/geometry/GeometryState';
import { TerrainMotion, type TerrainParams } from '../../visual-engine/primitives/terrainMotion';
import { createWorld, type WorldState } from '../../world/WorldState';
import { WorldView } from '../../world/WorldView';

/*
 * The terrain's motion, bit for bit (test support, imported by tests only): a scripted session with everything the
 * ground answers, and a digest of every value the law reads and every reading the tools see, every frame.
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

/** A session with everything the ground answers: kicks, hats, a build, a release, disorder, a turn, the mids hardening, one broken frame. */
function script(world: WorldState, t: number, k: number, fps: number): void {
  world.time = 10 + t;
  const beat = (t % 0.5) / 0.5, hat = (t % 0.125) / 0.125;
  world.speed = 1.2 + 1.6 * Math.exp(-beat * 0.5 / 0.15) + (t > 14 && t < 20 ? 2 * Math.exp(-(t - 14) / 2) : 0);
  world.travel += world.speed / fps;
  world.spin = 1.4 * Math.sin(t * 0.37) + 0.3 * Math.sin(t * 2.1);
  world.angle += world.spin / fps;
  world.radius = 0.3 * Math.exp(-beat * 0.5 / 0.2) - 0.25 * world.potential;
  world.bias = 0.6 * Math.sin(t * 0.23);
  world.excitation = 0.65 + 0.3 * Math.exp(-beat * 0.5 / 0.12);
  world.shimmer = 0.2 + 0.7 * Math.exp(-hat * 0.125 / 0.03);
  world.potential = t < 6 ? 0.2 : t < 14 ? Math.min(0.95, 0.2 + (t - 6) / 8) : 0.08 * Math.exp(-(t - 14) / 3);
  world.turbulence = 0.15 + 0.5 * Math.max(0, Math.sin(t * 0.41)) ** 2;
  world.coherence = 1 - 0.6 * world.turbulence;
  if (k % Math.round(fps / 2) === 0) { world.impulseTime = world.time; world.impulseStrength = 0.5 + 0.4 * Math.sin(t * 1.3); }
  if (t >= 14 && world.releaseTime < 24) { world.releaseTime = world.time; world.releaseStrength = 0.7; }
  if (k === Math.round(22 * fps)) { world.potential = NaN; world.spin = Infinity; }
}

function strike(events: EventStream, t: number, k: number, fps: number): void {
  if (k % Math.round(fps / 2) === 0) events.push('impact', 10 + t, 0.6, 0.9, 1, 0.4, 0, (k / Math.round(fps / 2)) % 7 === 3 ? 0.92 : 0.35);
  if (k === Math.round(14 * fps)) events.push('drop', 10 + t, 0.8, 0.9, -1, 0.7, 0, 0.95);
}

/** Every value the law reads and every reading the tools see, every frame of 30 s. */
export function terrainDigest(params: TerrainParams, fps: number): string {
  const world = createWorld(), view = new WorldView(), geometry = createGeometry(), motion = new TerrainMotion(params), events = new EventStream(), digest = new Digest();
  for (let k = 0; k < 30 * fps; k++) {
    const t = (k + 1) / fps;
    script(world, t, k, fps); strike(events, t, k, fps);
    geometry.edgeHardness = 0.5 + 0.5 * Math.sin(t * 0.3); geometry.angularity = 0.3;
    view.update(world, { motion: 1, expansion: 1, turbulence: 1 });
    const v = motion.step(1 / fps, view, geometry, events, world.time);
    for (const key of Object.keys(v) as (keyof typeof v)[]) digest.add(v[key]);
    digest.add(motion.bank); digest.add(motion.speed); digest.add(motion.aperture); digest.add(motion.accent); digest.add(motion.tension); digest.add(motion.disorder);
  }
  return digest.value;
}
