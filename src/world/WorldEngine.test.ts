import { describe, expect, it } from 'vitest';
import { newFrame, type AnalysisFrame } from '../audio/features/decode';
import { ExperienceEngine } from '../experience/ExperienceEngine';
import { createIntents, createState, INTENT } from '../experience/types';
import { WorldEngine } from './WorldEngine';
import { FlashGuard, REDUCED_FLASHES, STANDARD_FLASHES } from '../dynamics/FlashGuard';
import type { AudioEvent } from '../experience/EventStream';
import { MAX_BIAS_VELOCITY, MAX_RADIAL_VELOCITY, MAX_SPEED, MAX_SPIN } from './WorldState';

const HOP = 256 / 48000;

/** A rhythmic, stereo, harmonic groove with a kick every `period` s (pan alternating if `pans`). */
function groove(a: AnalysisFrame, t: number, period = 0.5, pans = false): void {
  a.presence = a.sounding = 1; a.silent = 0;
  a.loudnessMomentary = -14; a.entropy = 0.4; a.onsetDensity = 4;
  a.harmonicity = a.phaseCoherence = 0.7; a.harmonicShare = 0.6; a.correlation = 0.8;
  a.bandDb.fill(-30); a.bandDb[0] = -12;
  a.bandLevel.fill(0.5); a.bandActivity.fill(0.3); a.stereoConfidence = 1;
  const beat = (t % period) < HOP * 1.5;
  a.shortTransient = beat ? 1 : 0;
  a.onsetStrength = beat ? 1 : 0;
  a.bandTransient.fill(0);
  if (beat) { a.bandTransient[0] = 0.8; a.bandTransient[6] = 0.4; }
  const pan = pans ? (Math.floor(t / period) % 2 ? 0.9 : -0.9) : 0;
  a.bandPan.fill(pan); a.balance = pan * 0.5;
}
function silence(a: AnalysisFrame): void {
  a.presence = a.sounding = 0; a.silent = 1;
  a.loudnessMomentary = -90; a.onsetDensity = a.shortTransient = a.onsetStrength = 0;
  a.bandTransient.fill(0); a.bandActivity.fill(0); a.bandLevel.fill(0); a.bandPan.fill(0); a.balance = 0;
  a.harmonicity = a.phaseCoherence = 0;
}
/** Feeds hops from `from` to `to` s. */
function run(e: ExperienceEngine, a: AnalysisFrame, from: number, to: number, input: (a: AnalysisFrame, t: number) => void, each?: (t: number) => void): void {
  for (let n = Math.round(from / HOP) + 1; n * HOP <= to + 1e-9; n++) {
    a.time = n * HOP; a.sample = n * 256;
    input(a, a.time); e.ingest(a); each?.(a.time);
  }
}

describe('world physics', () => {
  it('stays exactly at rest without input: no spontaneous energy', () => {
    const e = new ExperienceEngine(), a = newFrame();
    run(e, a, 0, 30, silence);
    const w = e.world.state;
    expect(w.energy).toBe(0);
    expect(w.travel).toBe(0);
    expect(w.angle).toBe(0);
    expect(w.coherence).toBeCloseTo(1, 6);
  });

  it('music injects energy; silence lets it decay towards equilibrium, with momentum continuing first', () => {
    const e = new ExperienceEngine(), a = newFrame();
    run(e, a, 0, 12, (f, t) => groove(f, t, 0.5, true));
    const w = e.world.state;
    const loud = w.energy, speed = w.speed, travel = w.travel;
    expect(loud).toBeGreaterThan(0.3);
    expect(speed).toBeGreaterThan(0.2);
    const energies: number[] = [];
    run(e, a, 12, 24, silence, (t) => { if (Math.abs(t - Math.round(t)) < HOP / 2) energies.push(w.energy); });
    // The world kept moving after the music stopped (momentum), then settled.
    expect(w.travel).toBeGreaterThan(travel + 0.05);
    for (let i = 2; i < energies.length; i++) expect(energies[i]).toBeLessThanOrEqual(energies[i - 1] + 1e-9);
    expect(w.energy).toBeLessThan(loud * 0.02);
    expect(Math.abs(w.speed)).toBeLessThan(1e-3);
    // Structure regains coherence, light fades.
    expect(w.coherence).toBeGreaterThan(0.95);
    expect(w.illumination).toBeLessThan(0.01);
  });

  it('presents the same trajectory at 30, 60 and 144 fps and with any analysis batching', () => {
    const traces: number[][] = [];
    for (const [fps, batch] of [[30, 1], [60, 4], [144, 16]] as const) {
      const e = new ExperienceEngine(), a = newFrame();
      const trace: number[] = [];
      let fed = 0;
      for (let f = 1; f <= 10 * fps; f++) {
        const now = f / fps;
        // Batches arrive whole (up to 85 ms of hops at once); the frame looks 100 ms back (audio delay),
        // so the heard time is already analysed. (Ahead of the analysis the snapshot is extrapolated: a causal estimate.)
        while ((fed + batch) * HOP <= now) { run(e, a, fed * HOP, (fed + batch) * HOP, (x, t) => groove(x, t, 0.43, true)); fed += batch; }
        const heard = now - 0.1;
        const s = e.present(heard);
        if (s && f % (fps / 6) === 0) {
          const w = s.world;
          trace.push(w.time, w.radius, w.radialVelocity, w.angle, w.spin, w.travel, w.speed, w.bias, w.excitation, w.turbulence, w.potential, w.energy);
        }
      }
      traces.push(trace);
    }
    expect(traces[0].length).toBeGreaterThan(300);
    for (const trace of traces.slice(1)) {
      expect(trace.length).toBe(traces[0].length);
      for (let i = 0; i < trace.length; i++) expect(trace[i]).toBeCloseTo(traces[0][i], 9);
    }
  });

  it('extrapolates continuously between snapshots and never shows the future', () => {
    const e = new ExperienceEngine(), a = newFrame();
    run(e, a, 0, 5.002, (f, t) => groove(f, t));
    let previous = e.present(4)!.world.travel;
    let jump = 0;
    for (let t = 4 + 1 / 500; t < 4.99; t += 1 / 500) {
      const w = e.present(t)!.world;
      expect(w.time).toBeCloseTo(t, 9);
      expect(w.impulseTime).toBeLessThanOrEqual(t + 1e-9);
      jump = Math.max(jump, Math.abs(w.travel - previous));
      previous = w.travel;
    }
    // At most a few ms of travel per 2 ms step: no discontinuities when a new snapshot takes over.
    expect(jump).toBeLessThan(0.02);
  });

  it('stays bounded under a long, loud, hit-dense passage', () => {
    const e = new ExperienceEngine(), a = newFrame();
    let max = 0, maxRadius = 0;
    let spin = 0, speed = 0, radial = 0, lateral = 0, fieldMin = 0, fieldMax = 0;
    run(e, a, 0, 120, (f, t) => { groove(f, t, 0.13, true); f.roughness = 1; f.bandLevel.fill(1); }, () => {
      const w = e.world.state;
      max = Math.max(max, w.energy); maxRadius = Math.max(maxRadius, Math.abs(w.radius));
      spin = Math.max(spin, Math.abs(w.spin)); speed = Math.max(speed, Math.abs(w.speed));
      radial = Math.max(radial, Math.abs(w.radialVelocity)); lateral = Math.max(lateral, Math.abs(w.biasVelocity));
      fieldMin = Math.min(fieldMin, w.excitation, w.shimmer, w.turbulence, w.coherence, w.potential, w.illumination, w.openness);
      fieldMax = Math.max(fieldMax, w.excitation, w.shimmer, w.turbulence, w.coherence, w.potential, w.illumination, w.openness);
    });
    expect(spin).toBeLessThanOrEqual(MAX_SPIN);
    expect(speed).toBeLessThanOrEqual(MAX_SPEED);
    expect(radial).toBeLessThanOrEqual(MAX_RADIAL_VELOCITY);
    expect(lateral).toBeLessThanOrEqual(MAX_BIAS_VELOCITY);
    expect(fieldMin).toBeGreaterThanOrEqual(0);
    expect(fieldMax).toBeLessThanOrEqual(1);
    expect(maxRadius).toBeLessThan(1.5);
    expect(max).toBeLessThan(12);
    expect(Number.isFinite(e.world.state.travel)).toBe(true);
  }, 60000);

  it('Reduce Flashing limits luminous impulses, never the geometric response of the world', () => {
    const e = new ExperienceEngine(), a = newFrame();
    const guards = [new FlashGuard(STANDARD_FLASHES), new FlashGuard(REDUCED_FLASHES)];
    const light = [0, 0], peak = [0, 0];
    const cursor = { time: -Infinity, seq: 0 };
    const admit = (event: AudioEvent) => { if (event.type === 'impact') guards.forEach((g, i) => { const x = g.admit(event.audioTime, event.strength); light[i] += x; peak[i] = Math.max(peak[i], x); }); };
    let kinetic = 0;
    run(e, a, 0, 10, (f, t) => groove(f, t, 0.25, true), (t) => {
      e.events.forEachHeard(cursor, t, admit);
      kinetic = Math.max(kinetic, e.world.state.kinetic);
    });
    // The rig's light (both settings) comes from the same impacts; the world never reads the guard.
    expect(light[1]).toBeLessThan(light[0] * 0.8);
    expect(peak[1]).toBeLessThanOrEqual(REDUCED_FLASHES.max);
    expect(light[1]).toBeGreaterThan(0);
    expect(kinetic).toBeGreaterThan(0.1);
    expect(e.world.state.impulseStrength).toBeGreaterThan(0);
  });

  it('a session reset is the only reset: the world does not depend on any scene', () => {
    const e = new ExperienceEngine(), a = newFrame();
    run(e, a, 0, 4, (f, t) => groove(f, t, 0.5, true));
    const before = e.present(3.9)!.world.spin;
    // Two observers (two layers of a crossfade) read the same presented world.
    const first = e.present(3.95)!.world, second = e.present(3.95)!.world;
    expect(second).toBe(first);
    expect(first.spin).not.toBe(0);
    expect(Math.abs(first.spin - before)).toBeLessThan(0.2);
    e.reset();
    expect(e.world.state.energy).toBe(0);
  });
});

describe('world forces', () => {
  const frame = () => { const a = newFrame(); a.presence = 1; a.stereoConfidence = 1; return a; };

  it('stereo: a hit on the left pushes and spins the world from the left; mono stays centred', () => {
    const left = new WorldEngine(), mono = new WorldEngine();
    for (const w of [left, mono]) { w.advance(0); w.setForces(frame(), createState(), createIntents(), 1); }
    left.impact(0, 1, 0, -1); mono.impact(0, 1, 0, 0);
    left.advance(0.3); mono.advance(0.3);
    expect(left.state.bias).toBeLessThan(-0.05);
    expect(left.state.spin).toBeLessThan(0);
    expect(mono.state.bias).toBe(0);
    expect(mono.state.spin).toBe(0);
    expect(mono.state.radius).toBeGreaterThan(0.05);
  });

  it('prediction stores potential in proportion to its confidence, and only a release turns it into motion', () => {
    const charged = (confidence: number) => {
      const w = new WorldEngine(), s = createState();
      s.likelyBuild = 1; s.predictionConfidence = confidence; s.anticipation = 0.8; s.anticipationConfidence = confidence;
      w.advance(0);
      for (let t = HOP; t <= 6; t += HOP) { w.setForces(frame(), s, createIntents(), 1); w.advance(t); }
      return w;
    };
    const sure = charged(0.9), doubtful = charged(0.2);
    expect(sure.state.potential).toBeGreaterThan(0.5);
    expect(doubtful.state.potential).toBeLessThan(sure.state.potential * 0.5);
    // Tension draws the world in while it is stored.
    expect(sure.state.radius).toBeLessThan(-0.1);
    const stored = sure.state.potential, speed = sure.state.speed;
    sure.release(6, 1);
    expect(sure.state.potential).toBeLessThan(stored * 0.1);
    expect(sure.state.speed).toBeGreaterThan(speed + 1);
    expect(sure.state.releaseStrength).toBeCloseTo(stored, 6);
    // Without preparation a release has nothing to give.
    const idle = new WorldEngine();
    idle.release(0, 1);
    expect(idle.state.speed).toBe(0);
    // A forecast that does not come true leaks away instead of being released.
    const s = createState();
    for (let t = 6 + HOP; t <= 30; t += HOP) { doubtful.setForces(frame(), s, createIntents(), 1); doubtful.advance(t); }
    expect(doubtful.state.potential).toBeLessThan(0.02);
    expect(doubtful.state.releaseStrength).toBe(0);
  });

  it('energy and complexity stay distinct: a loud drone is calm, a quiet glitch is turbulent', () => {
    const settle = (setup: (a: AnalysisFrame, s: ReturnType<typeof createState>) => void) => {
      const w = new WorldEngine(), a = frame(), s = createState();
      setup(a, s);
      w.advance(0);
      for (let t = HOP; t <= 8; t += HOP) { w.setForces(a, s, createIntents(), 1); w.advance(t); }
      return w.state;
    };
    const drone = settle((a, s) => { s.energy = 0.95; s.order = 0.9; s.complexity = 0.05; a.harmonicity = a.phaseCoherence = 0.95; a.correlation = 1; });
    const glitch = settle((a, s) => { s.energy = 0.15; s.chaos = 0.8; s.complexity = 0.9; s.order = 0.1; a.roughness = 0.8; a.correlation = 0; });
    expect(drone.illumination).toBeGreaterThan(glitch.illumination * 3);
    expect(glitch.turbulence).toBeGreaterThan(drone.turbulence * 4);
    expect(drone.coherence).toBeGreaterThan(glitch.coherence + 0.3);
  });

  it('intents act as forces: rotate spins up with inertia, decelerate brakes', () => {
    const w = new WorldEngine(), intents = createIntents(), s = createState();
    intents[INTENT.rotate].strength = intents[INTENT.rotate].confidence = 1;
    w.advance(0);
    w.setForces(frame(), s, intents, 1);
    w.advance(0.1);
    const early = w.state.spin;
    for (let t = 0.1 + HOP; t <= 4; t += HOP) { w.setForces(frame(), s, intents, 1); w.advance(t); }
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(w.state.spin * 0.2);
    const cruising = w.state.spin;
    intents[INTENT.rotate].strength = 0;
    intents[INTENT.decelerate].strength = intents[INTENT.decelerate].confidence = 1;
    for (let t = 4 + HOP; t <= 5; t += HOP) { w.setForces(frame(), s, intents, 1); w.advance(t); }
    expect(w.state.spin).toBeGreaterThan(0);
    expect(w.state.spin).toBeLessThan(cruising * 0.2);
  });
});
