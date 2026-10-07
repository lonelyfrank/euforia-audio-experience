import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { createWorld, type WorldState } from '../../world/WorldState';
import { WorldView } from '../../world/WorldView';
import { Observer } from './Observer';

const NEUTRAL = { motion: 1, expansion: 1, turbulence: 1 };

/** Observes a scripted world for `seconds` at `fps`. */
function observe(fps: number, seconds: number, script: (w: WorldState, t: number) => void, observer = new Observer(), from = 0) {
  const world = createWorld(), view = new WorldView();
  let fastest = 0;
  for (let frame = 1; frame <= Math.round(fps * seconds); frame++) {
    const t = from + frame / fps;
    world.time = t;
    script(world, t);
    view.update(world, NEUTRAL);
    observer.step(1 / fps, view, 1, 0.5);
    fastest = Math.max(fastest, observer.motion);
  }
  return { observer, fastest };
}

describe('observer', () => {
  it('follows the world with inertia: the same path at 30, 60 and 144 frames per second', () => {
    // Piecewise-constant world, so every frame rate sees the same targets.
    const script = (w: WorldState, t: number) => { w.spin = t < 2 ? 2 : -1; w.radius = t < 3 ? 0.6 : -0.2; w.bias = t < 1 ? 0.8 : 0; w.openness = 0.7; };
    const [a, b, c] = [30, 60, 144].map((fps) => observe(fps, 6, script).observer.state);
    for (let i = 0; i < 4; i++) {
      expect(b[i]).toBeCloseTo(a[i], 2);
      expect(c[i]).toBeCloseTo(a[i], 2);
    }
    expect(Math.abs(a[0])).toBeGreaterThan(0.02);
  });

  it('a beat cannot move it: world impulses arrive smoothed, and its motion stays contained', () => {
    // A violent world: spin and pressure flip every half second.
    const { observer, fastest } = observe(60, 30, (w, t) => {
      const flip = Math.floor(t * 2) % 2 ? 1 : -1;
      w.spin = 3 * flip; w.radius = 0.9 * flip; w.bias = flip; w.biasVelocity = 2 * flip; w.potential = 1;
    });
    const [azimuth, elevation, distance, aim] = observer.state;
    expect(Math.abs(azimuth)).toBeLessThan(0.6);
    expect(Math.abs(elevation)).toBeLessThan(0.25);
    expect(distance).toBeGreaterThan(0.6); expect(distance).toBeLessThan(1.6);
    expect(Math.abs(aim)).toBeLessThan(0.4);
    // Slow: well under a radian per second in total, even then.
    expect(fastest).toBeLessThan(1.2);
  });

  it('settles when the world rests, and places the camera looking at the matter', () => {
    const observer = new Observer();
    observe(60, 5, (w) => { w.spin = 2; w.radius = 0.5; w.bias = 0.6; }, observer);
    expect(observer.motion).toBeGreaterThan(0);
    const moving = observer.state[0];
    observe(60, 0.5, () => {}, observer, 5);
    // Inertia: it does not snap back the moment the world stops…
    expect(Math.abs(observer.state[0])).toBeGreaterThan(Math.abs(moving) * 0.3);
    observe(60, 40, () => {}, observer, 5.5);
    // …but it comes to rest.
    expect(observer.motion).toBeLessThan(1e-4);
    expect(Math.abs(observer.state[0])).toBeLessThan(1e-3);
    const camera = new PerspectiveCamera();
    observer.apply(camera, 4);
    expect(camera.position.length()).toBeCloseTo(4, 2);
    for (const v of camera.position.toArray()) expect(Number.isFinite(v)).toBe(true);
    observer.reset();
    expect(observer.state).toEqual([0, 0, 1, 0, 0, 0]);
  });

  it('is carried round the matter by a share of the world\'s own rotation, at any frame rate, and stands still when the world does', () => {
    // The world turns by 1.5 rad/s for 4 s, then stops.
    const script = (w: WorldState, t: number) => { w.spin = t < 4 ? 1.5 : 0; w.angle = 1.5 * Math.min(t, 4); };
    const [a, b, c] = [30, 60, 144].map((fps) => observe(fps, 8, script).observer);
    // A share of the turn (6 rad), never the whole of it: a slow orbit.
    expect(a.state[4]).toBeGreaterThan(0.4); expect(a.state[4]).toBeLessThan(1.2);
    // (A view's first frame has no previous angle to turn from: the rates differ by that one frame.)
    expect(b.state[4]).toBeCloseTo(a.state[4], 2); expect(c.state[4]).toBeCloseTo(a.state[4], 2);
    // The world stopped at 4 s: 4 s later the orbit has not moved on.
    const stopped = observe(60, 4, script).observer.state[4];
    expect(a.state[4]).toBeCloseTo(stopped, 2);
    // The camera is on the orbit: off the axis it started on, still looking at the matter from its distance.
    const camera = new PerspectiveCamera();
    a.apply(camera, 4);
    expect(Math.abs(camera.position.x)).toBeGreaterThan(1);
    expect(camera.position.length()).toBeCloseTo(4 * a.state[2], 1);
    // Turning the other way brings it back.
    const back = observe(60, 4, (w, t) => { w.angle = 6 - 1.5 * (t - 8); }, a, 8).observer;
    expect(Math.abs(back.state[4])).toBeLessThan(0.05);
  });

  it('opens its field of view with the world and narrows it under stored potential, within a few degrees', () => {
    const open = observe(60, 6, (w) => { w.openness = 1; }).observer, tense = observe(60, 6, (w) => { w.potential = 1; }).observer;
    expect(open.state[5]).toBeGreaterThan(3); expect(open.state[5]).toBeLessThan(10);
    expect(tense.state[5]).toBeLessThan(-2); expect(tense.state[5]).toBeGreaterThan(-8);
    const camera = new PerspectiveCamera(50);
    open.apply(camera, 4, 50);
    expect(camera.fov).toBeCloseTo(50 + open.state[5], 6);
    // A host that gives no field of view keeps its own.
    const fixed = new PerspectiveCamera(42);
    tense.apply(fixed, 4);
    expect(fixed.fov).toBe(42);
    // Rest: the scene's own field of view.
    const rest = observe(60, 6, () => {}).observer;
    rest.apply(camera, 4, 50);
    expect(camera.fov).toBeCloseTo(50, 3);
  });
});
