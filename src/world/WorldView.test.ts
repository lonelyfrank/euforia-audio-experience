import { describe, expect, it } from 'vitest';
import { newFrame } from '../audio/features/decode';
import { ExperienceEngine } from '../experience/ExperienceEngine';
import { WorldView } from './WorldView';

const HOP = 256 / 48000;
const NEUTRAL = { motion: 1, expansion: 1, turbulence: 1 };

/** A stereo groove driving the real engine; frames present the world at 60 fps, 100 ms behind. */
function session(seconds: number, each: (heard: number, e: ExperienceEngine) => void): void {
  const e = new ExperienceEngine(), a = newFrame();
  let hop = 0;
  for (let f = 1; f <= seconds * 60; f++) {
    while ((hop + 1) * HOP <= f / 60) {
      hop++;
      const t = hop * HOP, beat = t % 0.5 < HOP * 1.5;
      a.time = t; a.sample = hop * 256; a.presence = a.sounding = 1; a.loudnessMomentary = -14;
      a.onsetDensity = 4; a.harmonicShare = 0.6; a.stereoConfidence = 1; a.bandLevel.fill(0.5); a.bandActivity.fill(0.3);
      a.shortTransient = a.onsetStrength = beat ? 1 : 0; a.bandTransient.fill(0); if (beat) a.bandTransient[0] = 0.8;
      a.bandPan.fill(Math.floor(t / 0.5) % 2 ? 0.8 : -0.8);
      e.ingest(a);
    }
    each(f / 60 - 0.1, e);
  }
}

describe('world views (scene adapters)', () => {
  it('a scene mounted mid-session inherits momentum, pressure and excitation at once, without a jump', () => {
    const playing = new WorldView(), mounted = new WorldView();
    let frame = 0, firstTurn = NaN, firstSpin = NaN, gap = 0;
    session(8, (heard, e) => {
      const s = e.present(heard);
      if (!s) return;
      frame++;
      playing.update(s.world, NEUTRAL);
      // The second layer (the incoming scene of a crossfade) mounts after 5 s.
      if (frame < 300) return;
      mounted.update(s.world, NEUTRAL);
      if (frame === 300) { firstTurn = mounted.dTurn; firstSpin = mounted.spin; return; }
      // From its first frame it observes the same world: same velocities, same fields, same per-frame motion.
      expect(mounted.spin).toBe(playing.spin);
      expect(mounted.pressure).toBe(playing.pressure);
      expect(mounted.excitation).toBe(playing.excitation);
      gap = Math.max(gap, Math.abs(mounted.dTurn - playing.dTurn), Math.abs(mounted.dTravel - playing.dTravel));
    });
    expect(firstTurn).toBe(0);
    expect(Math.abs(firstSpin)).toBeGreaterThan(0);
    expect(gap).toBe(0);
    expect(mounted.travel).toBeGreaterThan(0);
  });

  it('mood gains scale velocities, never positions: a gain change continues the motion', () => {
    const view = new WorldView();
    let jump = 0, previous = 0, frame = 0;
    session(6, (heard, e) => {
      const s = e.present(heard);
      if (!s) return;
      frame++;
      const gains = { motion: frame < 200 ? 1 : 2, expansion: 1, turbulence: 1 };
      view.update(s.world, gains);
      if (frame > 1) jump = Math.max(jump, Math.abs(view.travel - previous));
      previous = view.travel;
    });
    // At most two frames' worth of travel at the doubled gain: no jump to 2 × the accumulated distance.
    expect(jump).toBeLessThan(0.2);
    expect(view.travel).toBeGreaterThan(1);
  });

  it('exposes the radial velocity as a surge, scaled like the pressure by the mood', () => {
    const view = new WorldView();
    const w = { ...new ExperienceEngine().world.state };
    w.time = 1; w.radius = 0.4; w.radialVelocity = 1.5;
    view.update(w, { ...NEUTRAL, expansion: 0.5 });
    expect(view.surge).toBeCloseTo(0.75, 9);
    expect(view.pressure).toBeCloseTo(0.2, 9);
    view.update(undefined, NEUTRAL);
    expect(view.surge).toBe(0);
  });

  it('a new session restarts the deltas instead of jumping across worlds', () => {
    const view = new WorldView();
    const w = { ...new ExperienceEngine().world.state };
    w.time = 100; w.travel = 500; w.angle = 40;
    view.update(w, NEUTRAL);
    w.time = 0.01; w.travel = 0.01; w.angle = 0.01;
    view.update(w, NEUTRAL);
    expect(view.dTravel).toBe(0);
    expect(view.dTurn).toBe(0);
    view.update(undefined, NEUTRAL);
    expect(view.dTravel).toBe(0);
    expect(view.light).toBe(0);
  });
});
