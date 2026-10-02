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
