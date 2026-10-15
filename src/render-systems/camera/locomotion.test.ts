import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { createWorld, type WorldState } from '../../world/WorldState';
import { WorldView } from '../../world/WorldView';
import { CameraRig, createInput, Drift, Glide, Hover, Orbit, Travel, type LocomotionProfile, type MotionPose, type RigEntry } from './locomotion';

const NEUTRAL = { motion: 1, expansion: 1, turbulence: 1 };

/** A rig of fresh profiles of these kinds, all at weight 1. */
function rig(make: () => LocomotionProfile[], rest: Partial<MotionPose> = { tz: -10 }): CameraRig {
  return new CameraRig(make().map((profile): RigEntry => ({ profile, weight: 1 })), rest);
}

/**
 * Runs `r` through a scripted world for `seconds` at `fps`; returns the distance carried and the largest observer
 * acceleration. The world's travel and angle are the exact integrals of its piecewise-constant speed and spin (sampled
 * finely), so every frame rate sees the same world; the view starts at `from`, so no frame's travel is lost.
 */
function run(r: CameraRig, fps: number, seconds: number, script: (w: WorldState, t: number) => void, from = 0, focus?: (t: number) => [number, number, number, number]) {
  const world = createWorld(), view = new WorldView(), input = createInput(view), FINE = 1440;
  let distance = 0, accel = 0, lastSpeed = 0, fine = Math.round(from * FINE);
  world.time = from; script(world, from); view.update(world, NEUTRAL);
  for (let frame = 1; frame <= Math.round(fps * seconds); frame++) {
    const t = from + frame / fps;
    for (; fine < Math.round(t * FINE); fine++) { script(world, (fine + 0.5) / FINE); world.travel += world.speed / FINE; world.angle += world.spin / FINE; }
    world.time = t;
    script(world, t);
    view.update(world, NEUTRAL);
    input.dt = 1 / fps; input.time = t; input.timed = true;
    if (focus) [input.focus.x, input.focus.y, input.focus.z, input.focus.weight] = focus(t);
    r.step(input);
    distance += r.advance;
    if (frame > 1) accel = Math.max(accel, Math.abs(r.motion - lastSpeed) * fps);
    lastSpeed = r.motion;
  }
  return { distance, accel, pose: { ...r.pose } };
}

/** A piecewise-constant world, so every frame rate sees the same targets. */
const steps = (w: WorldState, t: number): void => {
  w.speed = t < 3 ? 4 : 1; w.spin = t < 2 ? 2 : -1; w.radius = t < 4 ? 0.6 : -0.2; w.bias = t < 1 ? 0.8 : -0.3;
  w.openness = 0.7; w.potential = t < 5 ? 0.6 : 0.1; w.turbulence = t < 3 ? 0.8 : 0.1; w.coherence = t < 3 ? 0.3 : 0.9;
};

const KINDS: [string, () => LocomotionProfile[]][] = [
  ['travel', () => [new Travel()]],
  ['glide + hover', () => [new Glide(), new Hover()]],
  ['orbit', () => [new Orbit()]],
  ['orbit + drift', () => [new Orbit(), new Drift()]],
  ['glide + drift', () => [new Glide(), new Drift()]],
];

describe('locomotion profiles and the camera rig', () => {
  it.each(KINDS)('%s: the same path at 30, 60 and 144 frames per second', (_, make) => {
    const runs = [30, 60, 144].map((fps) => run(rig(make), fps, 8, steps));
    // Held inputs are followed exactly; an orbit's angle is a ramp the bodies sample once a frame, a lag of a few
    // hundredths of a unit on a radius of ten.
    for (const key of ['x', 'y', 'z', 'tx', 'ty', 'tz', 'fov', 'roll'] as const) {
      expect(Math.abs(runs[1].pose[key] - runs[0].pose[key])).toBeLessThan(0.03);
      expect(Math.abs(runs[2].pose[key] - runs[0].pose[key])).toBeLessThan(0.03);
    }
    expect(runs[2].distance).toBeCloseTo(runs[0].distance, 1);
  });

  it('forward profiles carry the scene by the world\'s own distance × their stride, whatever the frame rate', () => {
    for (const fps of [30, 60, 144]) {
      const travel = run(rig(() => [new Travel({ stride: 2 })]), fps, 20, (w, t) => { w.speed = t >= 1 && t < 11 ? 3 : 0; });
      // The world travelled 30 units from rest to rest; the follower lags but arrives: what it lost in the surge it has not lost for ever.
      expect(travel.distance).toBeCloseTo(60, 0);
    }
  });

  it('at rest the observer settles at the rest pose and carries nothing; an orbit does not go round because time passes', () => {
    for (const [, make] of KINDS) {
      const r = rig(make);
      run(r, 60, 6, steps);
      const moving = { ...r.pose };
      // What was moving coasts to a stop (the followers arrive), then nothing more is carried.
      run(r, 60, 10, () => {}, 6);
      const still = run(r, 60, 30, () => {}, 16);
      expect(still.distance).toBe(0);
      // The orbit's angle stays where the world left it; everything else is back at rest.
      const orbit = r.entries.find((e) => e.profile.kind === 'orbit')?.profile as Orbit | undefined;
      // A drift stands where its path left it (no travel, no bend); it does not go back to the middle by itself.
      if (!orbit && !r.entries.some((e) => e.profile.kind === 'drift')) {
        expect(r.pose.x).toBeCloseTo(0, 3); expect(r.pose.y).toBeCloseTo(0, 3); expect(r.pose.tx).toBeCloseTo(0, 3);
      }
      expect(r.pose.fov).toBeCloseTo(0, 2); expect(r.pose.roll).toBeCloseTo(0, 3);
      expect(r.motion).toBeLessThan(1e-3);
      if (orbit) {
        const angle = orbit.azimuth;
        run(r, 60, 10, () => {}, 46);
        expect(orbit.azimuth).toBe(angle);
        expect(Math.hypot(moving.x, moving.z)).toBeGreaterThan(0);
      }
    }
  });

  it('a beat cannot throw it: under a violent world it stays within reach, lens and roll limits, with a bounded acceleration', () => {
    for (const [, make] of KINDS) {
      const r = rig(make);
      const { accel } = run(r, 60, 30, (w, t) => {
        const flip = Math.floor(t * 2) % 2 ? 1 : -1;
        w.speed = flip > 0 ? 6 : 0; w.spin = 3 * flip; w.radius = 0.9 * flip; w.bias = flip; w.potential = 1; w.openness = flip > 0 ? 1 : 0;
        w.turbulence = 1; w.coherence = 0;
      }, 0, (t) => [8 * Math.sin(t * 9), 4, -6, 1]);
      const l = r.limits, p = r.pose;
      expect(Math.abs(p.x - r.rest.x)).toBeLessThanOrEqual(l.reach + 1e-6);
      expect(Math.abs(p.tx - r.rest.tx)).toBeLessThanOrEqual(l.reach + 1e-6);
      expect(p.fov).toBeGreaterThanOrEqual(l.fov[0] - 1e-6); expect(p.fov).toBeLessThanOrEqual(l.fov[1] + 1e-6);
      expect(Math.abs(p.roll)).toBeLessThanOrEqual(l.roll + 1e-6);
      // A critically damped body bounded to `reach` accelerates at most ω² × 2 reach (here ~ 30 units/s²): no jerk of a frame.
      expect(accel).toBeLessThan((2 * Math.PI * l.position) ** 2 * 2 * l.reach * Math.sqrt(3));
    }
  });

  it('orbit: goes round with the world\'s turn and its travel, at a distance the world breathes, looking at the subject', () => {
    const r = new CameraRig([{ profile: new Orbit({ share: 0.5, carry: 0 }), weight: 1 }], { z: 10, tz: 0 });
    const orbit = r.entries[0].profile as Orbit;
    run(r, 60, 4, (w) => { w.spin = 1; }, 0, () => [2, 1, 0, 1]);
    // The world turned 4 rad: the observer went round half of it.
    expect(orbit.azimuth).toBeCloseTo(2, 1);
    expect(r.pose.tx).toBeGreaterThan(1.5);
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    r.apply(camera, 50);
    const ahead = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const toTarget = new Vector3(r.pose.tx, r.pose.ty, r.pose.tz).sub(camera.position).normalize();
    expect(ahead.dot(toTarget)).toBeGreaterThan(0.999);
  });

  it('hover: present when the world is calm, gone when it moves fast, and it holds back the travel while it is there', () => {
    const glide = () => [new Glide(), new Hover({ hold: 0.5 })];
    const calm = run(rig(glide), 60, 20, (w) => { w.speed = 0.6; });
    const r = rig(glide);
    const fast = run(r, 60, 20, (w) => { w.speed = 5; });
    expect(r.weights[1]).toBeLessThan(0.01);
    const alone = run(rig(() => [new Glide()]), 60, 20, (w) => { w.speed = 0.6; });
    // Calm (a tenth of the world's top speed, against a calm of 0.45): the hover is 1 − 0.1/0.45 present and holds back half of that.
    expect(calm.distance / alone.distance).toBeCloseTo(1 - 0.5 * (1 - 0.1 / 0.45), 2);
    expect(fast.distance).toBeGreaterThan(alone.distance * 5);
  });

  it('drift: a path of the distance travelled, never beyond its corridor, wider with turbulence', () => {
    const drift = new Drift({ corridor: 1.5, amplitude: 1.2, wavelength: 20 });
    const r = new CameraRig([{ profile: drift, weight: 1 }], { tz: -10 }, { position: 2, target: 2 });
    let widest = 0;
    const world = createWorld(), view = new WorldView(), input = createInput(view);
    view.update(world, NEUTRAL);
    for (let frame = 1; frame <= 60 * 60; frame++) {
      world.time = frame / 60; world.speed = 2; world.travel += 2 / 60; world.turbulence = frame > 1800 ? 1 : 0; world.coherence = frame > 1800 ? 0 : 1;
      view.update(world, NEUTRAL); input.dt = 1 / 60; input.timed = true;
      r.step(input);
      widest = Math.max(widest, Math.abs(r.target.x));
    }
    expect(widest).toBeLessThanOrEqual(1.5 + 1e-9);
    expect(drift.width).toBeGreaterThan(1.5);
    // The path is the distance travelled; a second with no travel does not bend it.
    expect(drift.path).toBeCloseTo(world.travel, 6);
    const at = drift.path;
    view.update({ ...world, time: world.time + 1 }, NEUTRAL); input.dt = 1;
    r.step(input);
    expect(drift.path).toBe(at);
  });

  it('starts from the pose asked on its first frame and after a reset (a mounted world does not fly its observer in)', () => {
    const r = rig(() => [new Glide({ lift: 2 }), new Hover()]);
    run(r, 60, 1, (w) => { w.radius = 0.8; w.openness = 1; });
    const first = { ...r.pose };
    expect(first.y).toBeGreaterThan(1);
    r.reset();
    run(r, 60, 1 / 60, () => {}, 1);
    // The world at rest is asked for at once.
    expect(r.pose.y).toBeCloseTo(0, 6);
  });
});
