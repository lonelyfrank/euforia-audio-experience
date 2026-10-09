import { expect, it } from 'vitest';
import { QualityController } from './quality';

it('degrades resolution independently and recovers only after sustained headroom and cooldown', () => {
  const q = new QualityController();
  const initial = q.profile;
  for (let i = 0; i < 125; i++) q.sample(1 / 40);
  expect(q.profile.pixelScale).toBeLessThan(initial.pixelScale);
  expect(q.profile.density).toBe(initial.density);
  for (let i = 0; i < 25 * 60; i++) q.sample(1 / 60);
  expect(q.profile.pixelScale).toBeLessThan(initial.pixelScale);
  q.sample(2); // A hidden window is not evidence of recovery.
  for (let i = 0; i < 40 * 60; i++) q.sample(1 / 60);
  expect(q.profile).toBe(initial);
  q.set('low');
  for (let i = 0; i < 90 * 60; i++) q.sample(1 / 60);
  expect(q.profile.level).toBe('low');
});

/** Frames at `fps` for `seconds`; returns how many times the profile changed. */
function run(q: QualityController, fps: number, seconds: number, logicShare = 0, steady = true): number {
  let changes = 0;
  for (let i = 0; i < seconds * fps; i++) if (q.sample(1 / fps, logicShare / fps, steady)) changes++;
  return changes;
}

it('does not take pixels from the scene when the main thread is the limit', () => {
  const q = new QualityController();
  const initial = q.profile;
  // 40 fps with the frame's own logic taking 70 % of it: fewer pixels would not bring it back.
  expect(run(q, 40, 30, 0.7)).toBe(0);
  expect(q.profile).toBe(initial);
  expect(q.limit).toBe('cpu');
  expect(q.logicShare).toBeCloseTo(0.7, 2);
  // The same frame rate with an idle main thread is the GPU's: step down.
  expect(run(q, 40, 4, 0.05)).toBe(1);
  expect(q.limit).toBe('gpu');
});

it('takes no decision from a transition or from the seconds that follow a change', () => {
  const q = new QualityController();
  // Crossfades draw two scenes: 30 fps while one runs says nothing about the profile.
  expect(run(q, 30, 20, 0, false)).toBe(0);
  expect(q.reduced).toBe(false);
  expect(run(q, 60, 3)).toBe(0);
  // After a step down the next window starts only when the new profile has settled:
  // 9 s at 40 fps is two steps (3 s, then 2 s of settling + 3 s), where back-to-back windows would take three.
  expect(run(q, 40, 9)).toBe(2);
  expect(q.step).toBe(2);
});

it('waits longer after a recovery that did not hold, instead of rebuilding the scene every minute', () => {
  const q = new QualityController();
  const cycle = () => {
    // Slow at the upper step, fast at the lower: a machine between two steps.
    let seconds = 0;
    while (q.step === 0) { run(q, 45, 1); seconds++; }
    while (q.step > 0 && seconds < 2000) { run(q, 60, 1); seconds++; }
    return seconds;
  };
  const first = cycle(), second = cycle(), third = cycle(), fourth = cycle();
  // The first recoveries are bounded by the 60 s cooldown; then each failed one doubles the stable time asked for.
  expect(first).toBeLessThan(80);
  expect(second).toBeLessThan(80);
  expect(third).toBeGreaterThan(first + 40);
  expect(fourth).toBeGreaterThan(third + 80);
  // …up to eight minutes.
  for (let i = 0; i < 6; i++) cycle();
  expect(cycle()).toBeLessThan(520);
});

it('reports the limit at fixed settings too, without changing them', () => {
  const q = new QualityController();
  q.set('high');
  expect(run(q, 35, 10)).toBe(0);
  expect(q.limit).toBe('gpu');
  expect(q.profile.level).toBe('high');
  run(q, 60, 4);
  expect(q.limit).toBe('none');
});
