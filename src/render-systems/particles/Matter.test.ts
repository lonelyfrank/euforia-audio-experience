import { describe, expect, it } from 'vitest';
import { newFrame, type AnalysisFrame } from '../../audio/features/decode';
import { AudioAnalyzer } from '../../audio/analysis/AudioAnalyzer';
import { VisualResponse } from '../../audio/visual-response/VisualResponse';
import { EventStream } from '../../experience/EventStream';
import { ExperienceEngine } from '../../experience/ExperienceEngine';
import { createIntents, createSnapshot, createState, type ExperienceSnapshot } from '../../experience/types';
import type { SceneClock } from '../../types/visualizer';
import { SpectralMatterMapping } from '../../visualizers/spectral-matter/mapping';
import { WorldEngine } from '../../world/WorldEngine';
import type { WorldState } from '../../world/WorldState';
import { WorldView } from '../../world/WorldView';
import { WaveField } from '../waves/WaveField';
import { MAX_VELOCITY, substeps } from './matterLaw';
import { MatterProbe, type MatterMeasure } from './MatterProbe';
import { matterLayout, seedMatter, STRAND } from './MatterSeeds';

const HOP = 256 / 48000;
/** Elements that differ between two states. */
const differing = (a: Float32Array, b: Float32Array): number => a.reduce((n, value, i) => n + (value === b[i] ? 0 : 1), 0);
const NEUTRAL = { motion: 1, expansion: 1, turbulence: 1 };
const SEED = 7;

/**
 * The scene's CPU path without a GPU: presented world → view → mapping (fields)
 * → dated fronts → the matter (reference laws). `frame` advances everything by
 * one rendered frame at heard time `now`.
 */
function stage(count = 256, seed = SEED) {
  const view = new WorldView(), mapping = new SpectralMatterMapping(), waves = new WaveField(), probe = new MatterProbe(count, seed, true, mapping.forms);
  const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame;
  const clock: SceneClock = { time: 0, hits: { times: new Float64Array(8), strengths: new Float64Array(8), count: 0, size: 8 } as never, hitScale: 1 };
  const frame = (now: number, dt: number, snapshot: ExperienceSnapshot | undefined, events: EventStream): MatterMeasure => {
    view.update(snapshot?.world, NEUTRAL);
    clock.time = now; clock.experience = snapshot; clock.events = events;
    mapping.update(dt, view, audio, response, undefined, clock);
    waves.update(now, events, view.lateral, 1);
    probe.step(mapping.fields, waves, now, dt);
    return probe.measure(mapping.fields.lateral);
  };
  return { view, mapping, waves, probe, frame, audio, response };
}

/** A dense, loud, stereo mix: a kick every `period` s (alternating sides), bright busy highs, moving harmony and roughness. */
function dense(a: AnalysisFrame, t: number, period = 0.25): void {
  a.presence = a.sounding = 1; a.silent = 0;
  a.loudnessMomentary = -12 + 4 * Math.sin(t * 0.4); a.entropy = 0.5 + 0.4 * Math.sin(t * 0.23); a.onsetDensity = 6;
  a.harmonicity = 0.5 + 0.45 * Math.sin(t * 0.11); a.phaseCoherence = 0.5 + 0.4 * Math.sin(t * 0.17); a.harmonicShare = 0.6;
  a.roughness = 0.5 + 0.5 * Math.sin(t * 0.37); a.flatness = 0.4; a.correlation = Math.sin(t * 0.07);
  a.interChannelCoherence = 0.5 + 0.5 * Math.sin(t * 0.13); a.complexity = 0.7; a.width = 0.8;
  a.bandDb.fill(-20); a.bandLevel.fill(0.7); a.bandActivity.fill(0.6); a.stereoConfidence = 1;
  const beat = (t % period) < HOP * 1.5;
  a.shortTransient = a.onsetStrength = beat ? 1 : 0;
  a.bandTransient.fill(0);
  if (beat) { a.bandTransient[Math.floor(t / period) % 8] = 0.9; a.bandTransient[6] = 0.5; }
  const pan = Math.floor(t / period) % 2 ? 0.9 : -0.9;
  a.bandPan.fill(pan); a.balance = pan * 0.5;
}
function silence(a: AnalysisFrame): void {
  a.presence = a.sounding = 0; a.silent = 1;
  a.loudnessMomentary = -90; a.onsetDensity = a.shortTransient = a.onsetStrength = 0;
  a.bandTransient.fill(0); a.bandActivity.fill(0); a.bandLevel.fill(0); a.bandPan.fill(0); a.balance = 0;
  a.harmonicity = a.phaseCoherence = a.roughness = a.entropy = 0;
}

/** A whole session through the real ExperienceEngine, rendered at `fps`; analysis runs 50 ms ahead of what is heard. */
function session(fps: number, seconds: number, input: (a: AnalysisFrame, t: number) => void, each?: (t: number, m: MatterMeasure, s: ReturnType<typeof stage>) => void, s = stage()) {
  const e = new ExperienceEngine(), a = newFrame();
  let hop = 0;
  for (let frame = 1; frame <= Math.round(fps * seconds); frame++) {
    const heard = frame / fps;
    while ((hop + 1) * HOP <= heard + 0.05) {
      hop++;
      a.time = hop * HOP; a.sample = hop * 256;
      input(a, a.time); e.ingest(a);
    }
    const measure = s.frame(heard, 1 / fps, e.present(heard), e.events);
    each?.(heard, measure, s);
  }
  return s;
}

describe('matter seeds', () => {
  it('the same seed is the same matter; another seed is another', () => {
    const layout = matterLayout(4096);
    const a = seedMatter(layout, 11), b = seedMatter(layout, 11), c = seedMatter(layout, 12);
    expect(b.home).toEqual(a.home);
    expect(b.trait).toEqual(a.trait);
    expect(b.form).toEqual(a.form);
    expect(c.home).not.toEqual(a.home);
    expect(c.form).not.toEqual(a.form);
  });

  it('fills a body with continuous band affinity; strands start bonded', () => {
    const { home, trait, layout } = seedMatter(matterLayout(8000), 3);
    let low = 0, mid = 0, high = 0, thinnest = Infinity, thickest = 0, least = Infinity, most = -Infinity, apart = 0;
    for (let i = 0; i < layout.count; i++) {
      const at = i * 4, layer = Math.hypot(home[at], home[at + 1], home[at + 2]), affinity = home[at + 3];
      thinnest = Math.min(thinnest, layer); thickest = Math.max(thickest, layer);
      least = Math.min(least, affinity); most = Math.max(most, affinity);
      if (affinity < 1 / 3) low++; else if (affinity < 2 / 3) mid++; else high++;
      // A strand ages as one.
      if (i % STRAND && trait[at + 1] !== trait[at - 3]) apart++;
    }
    expect(thinnest).toBeGreaterThan(0.05); expect(thickest).toBeLessThanOrEqual(1.000001);
    expect(least).toBeGreaterThanOrEqual(0); expect(most).toBeLessThanOrEqual(1);
    expect(apart).toBe(0);
    // No rigid bass / mid / treble classes: every third of the range is well populated.
    for (const share of [low, mid, high]) expect(share / layout.count).toBeGreaterThan(0.15);
  });

  it('scales with the requested count in whole strands', () => {
    for (const target of [1, 100, 33600, 62400, 96000, NaN]) {
      const { width, height, count } = matterLayout(target);
      expect(width % STRAND).toBe(0);
      expect(count).toBe(width * height);
      if (target > 1000) expect(Math.abs(count - target) / target).toBeLessThan(0.02);
    }
    expect(matterLayout(96000).count).toBeGreaterThan(matterLayout(33600).count * 2.5);
  });
});

describe('matter under the fields of the world', () => {
  it('is deterministic: the same session gives the same matter, element by element', () => {
    const run = () => session(60, 6, dense).probe;
    const a = run(), b = run();
    expect(differing(b.position, a.position)).toBe(0);
    expect(differing(b.velocity, a.velocity)).toBe(0);
    expect(a.measure().speed).toBeGreaterThan(0.05);
    expect(differing(session(60, 6, dense, undefined, stage(256, SEED + 1)).probe.position, a.position)).toBeGreaterThan(900);
  }, 60_000);

  it('forms at rest: a silent world, or no world at all, never sets it in motion', () => {
    let fastest = 0;
    const s = session(60, 5, silence, (_t, m) => { fastest = Math.max(fastest, m.speed); });
    expect(fastest).toBeLessThan(5e-3);
    expect(s.probe.measure().energy).toBe(0);
    const t = stage();
    for (let frame = 1; frame <= 300; frame++) fastest = Math.max(fastest, t.frame(frame / 60, 1 / 60, undefined, new EventStream()).speed);
    expect(fastest).toBeLessThan(5e-3);
    // It formed as a filled, round body with its strands connected.
    const m = t.probe.measure();
    expect(m.flatness).toBeGreaterThan(0.4); expect(m.flatness).toBeLessThan(0.6);
    expect(m.connectivity).toBe(1);
  }, 60_000);

  it('silence dissipates: motion continues by inertia, then decays to rest; nothing freezes or restarts', () => {
    const speeds: number[] = [];
    let loud = 0;
    session(60, 24, (a, t) => (t < 10 ? dense(a, t) : silence(a)), (t, m) => {
      if (Math.abs(t - 10) < 1e-6) loud = m.speed;
      if (t > 10 && Math.abs(t * 2 - Math.round(t * 2)) < 1e-6) speeds.push(m.speed);
    });
    expect(loud).toBeGreaterThan(0.1);
    // Half a second into the silence the matter still moves (no sudden freeze: the world's pressure is still relaxing)…
    expect(speeds[0]).toBeGreaterThan(loud * 0.2);
    // …then it loses its motion: a tenth within a few seconds, rest at the end.
    expect(speeds[11]).toBeLessThan(loud * 0.1);
    expect(speeds[speeds.length - 1]).toBeLessThan(loud * 0.01);
    // No motion is generated in silence: once it has died down, it does not come back.
    const tail = speeds.slice(8);
    for (let i = 1; i < tail.length; i++) expect(tail[i]).toBeLessThanOrEqual(tail[i - 1] * 1.05 + 1e-4);
  }, 60_000);

  it('macroscopically the same at 30, 60 and 144 frames per second', () => {
    const at = (fps: number) => {
      const marks: MatterMeasure[] = [];
      session(fps, 12, (a, t) => (t < 9 ? dense(a, t, 0.5) : silence(a)), (t, m) => {
        if ([4, 8, 9.5, 12].some((mark) => Math.abs(t - mark) < 0.5 / fps)) marks.push({ ...m });
      });
      return marks;
    };
    const slow = at(30), mid = at(60), fast = at(144);
    expect(slow).toHaveLength(4);
    for (const other of [mid, fast]) {
      other.forEach((m, i) => {
        // The body as a whole: size, thickness, shape, how fast it moves.
        expect(Math.abs(m.radius - slow[i].radius)).toBeLessThan(0.05 * slow[i].radius);
        expect(Math.abs(m.spread - slow[i].spread)).toBeLessThan(0.05);
        expect(Math.abs(m.flatness - slow[i].flatness)).toBeLessThan(0.05);
        expect(Math.abs(m.speed - slow[i].speed)).toBeLessThan(0.15 * slow[i].speed + 0.02);
      });
    }
    // A stalled frame is cut into bounded sub-steps, never one unstable step.
    expect(substeps(1 / 144)).toBe(1); expect(substeps(1 / 60)).toBe(1); expect(substeps(1 / 30)).toBe(2); expect(substeps(10)).toBe(4); expect(substeps(0)).toBe(0);
  }, 60_000);

  it('survives 150 dense seconds: finite, bounded, no runaway energy', () => {
    let fastest = 0, largest = 0, brightest = 0, frames = 0;
    const s = session(60, 150, (a, t) => dense(a, t, 0.12 + 0.1 * Math.sin(t * 0.05) ** 2), (_t, m) => {
      frames++;
      fastest = Math.max(fastest, m.speed); largest = Math.max(largest, m.radius); brightest = Math.max(brightest, m.energy);
    }, stage(64));
    expect(frames).toBe(9000);
    const { position, velocity } = s.probe;
    for (let i = 0; i < position.length; i++) {
      expect(Number.isFinite(position[i])).toBe(true);
      expect(Number.isFinite(velocity[i])).toBe(true);
    }
    for (let i = 0; i < s.probe.count; i++) {
      expect(Math.hypot(position[i * 4], position[i * 4 + 1], position[i * 4 + 2])).toBeLessThan(4);
      expect(Math.hypot(velocity[i * 4], velocity[i * 4 + 1], velocity[i * 4 + 2])).toBeLessThanOrEqual(6.0001);
      expect(position[i * 4 + 3]).toBeLessThanOrEqual(2);
      expect(velocity[i * 4 + 3]).toBeLessThan(1);
    }
    // Mean speed far below the hard limit, the body within the frame, the energy channel short of saturation.
    expect(fastest).toBeLessThan(3);
    expect(largest).toBeLessThan(2.5);
    expect(brightest).toBeLessThan(1.5);
    expect(s.waves.active(150)).toBeLessThanOrEqual(8);
  }, 120_000);
});

/** A hand-driven world (as in the world's own tests): forces from an experience state, events pushed at their times. */
function scripted(seconds: number, drive: (t: number, world: WorldEngine, state: ReturnType<typeof createState>, a: AnalysisFrame, events: EventStream) => void,
  each?: (t: number, m: MatterMeasure, s: ReturnType<typeof stage>, w: WorldState) => void) {
  const world = new WorldEngine(), state = createState(), a = newFrame(), events = new EventStream(), intents = createIntents();
  const snapshot = createSnapshot(newFrame());
  snapshot.world = world.state; snapshot.state = state; snapshot.acoustic = a;
  a.presence = 1; a.stereoConfidence = 1; a.harmonicity = a.phaseCoherence = 0.7; a.correlation = 0.8;
  const s = stage();
  world.advance(0);
  let hop = 0;
  for (let frame = 1; frame <= seconds * 60; frame++) {
    const now = frame / 60;
    while ((hop + 1) * HOP <= now) {
      hop++;
      const t = hop * HOP;
      world.advance(t);
      drive(t, world, state, a, events);
      world.setForces(a, state, intents, a.presence);
    }
    const measure = s.frame(now, 1 / 60, snapshot, events);
    each?.(now, measure, s, world.state);
  }
  return s;
}

describe('build-up and release', () => {
  const BUILD = 8, AFTER = 0.6;
  /**
   * Eight seconds, with or without a confident build, then the same impact at t = 8. Only the prepared world has
   * something to release, so only there is the impact a drop (as the engine decides it).
   */
  const run = (prepared: boolean) => {
    const out = { before: 0, compressed: 0, gather: 0, burst: 0, widest: 0, fronts: 0, glow: 0, stored: 0 };
    let dropped = false;
    scripted(BUILD + 3, (t, world, state, _a, events) => {
      state.energy = 0.5; state.motion = 0.3;
      const building = prepared && t < BUILD;
      state.likelyBuild = building ? 1 : 0; state.anticipation = building ? 0.8 : 0;
      state.predictionConfidence = state.anticipationConfidence = building ? 0.9 : 0;
      if (!dropped && t >= BUILD) {
        dropped = true;
        out.stored = world.state.potential;
        world.impact(t, 0.8, 1, 0);
        events.push('impact', t, 0.8, 1, 1, 0.8);
        if (prepared) { world.release(t, 1); events.push('drop', t, 0.8, 1, -1, 0.9); }
      }
    }, (t, m, s) => {
      if (Math.abs(t - 1) < 1e-6) out.before = m.radius;
      if (Math.abs(t - (BUILD - 1 / 60)) < 1e-6) { out.compressed = m.radius; out.gather = s.mapping.fields.gather; }
      if (t > BUILD && t <= BUILD + AFTER) { out.burst = Math.max(out.burst, m.speed); out.glow = Math.max(out.glow, m.energy); out.fronts = Math.max(out.fronts, s.waves.active(t)); }
      if (t > BUILD) out.widest = Math.max(out.widest, m.radius);
    });
    return out;
  };

  it('a build is an accumulation: the matter converges and gathers while the potential charges', () => {
    const built = run(true), flat = run(false);
    expect(built.stored).toBeGreaterThan(0.5);
    expect(built.compressed).toBeLessThan(built.before * 0.9);
    expect(built.gather).toBeGreaterThan(0.6);
    // Without a build nothing is stored and the matter is neither drawn in nor gathered.
    expect(flat.stored).toBeLessThan(0.05);
    expect(flat.compressed).toBeGreaterThan(built.compressed * 1.2);
    expect(flat.gather).toBeLessThan(0.3);
  }, 60_000);

  it('the release is a consequence of what was stored: the same drop moves prepared matter far more', () => {
    const built = run(true), flat = run(false);
    // Both get the event's front; only the prepared world has energy to turn into motion.
    expect(built.fronts).toBeGreaterThanOrEqual(1);
    expect(flat.fronts).toBeGreaterThanOrEqual(1);
    expect(built.burst).toBeGreaterThan(flat.burst * 1.5);
    // The structure opens: from compressed to wider than it started, and by more than the unprepared one.
    expect(built.widest).toBeGreaterThan(built.before);
    expect(built.widest - built.compressed).toBeGreaterThan((flat.widest - flat.compressed) * 1.5);
    // The front leaves energy in the matter it crosses (what the travelling light shows).
    expect(built.glow).toBeGreaterThan(0.05);
  }, 60_000);

  it('a beat alone releases nothing: impacts without stored potential leave the size of the matter alone', () => {
    let widest = 0, narrowest = Infinity;
    scripted(8, (t, world, state, _a, events) => {
      state.energy = 0.5; state.motion = 0.3;
      if (t % 0.5 < HOP) { world.impact(t, 0.5, 1, 0); events.push('impact', t, 0.5, 1, 1, 0.2); }
    }, (t, m) => { if (t > 3) { widest = Math.max(widest, m.radius); narrowest = Math.min(narrowest, m.radius); } });
    expect(widest - narrowest).toBeLessThan(0.25);
  }, 60_000);
});

describe('morphology', () => {
  /** The body after 12 s in a steady world with the given character. */
  const settle = (set: (state: ReturnType<typeof createState>, a: AnalysisFrame, w: WorldEngine) => void) => {
    let last: MatterMeasure | undefined;
    const s = scripted(12, (_t, world, state, a) => set(state, a, world), (_t, m) => { last = m; });
    return { ...last!, fields: { ...s.mapping.fields }, material: { ...s.mapping.material } };
  };

  it('a loud coherent world and a quiet chaotic one are different bodies, not different brightness', () => {
    const coherent = settle((state, a) => { state.energy = 0.9; state.order = 0.9; a.harmonicity = a.phaseCoherence = 0.95; a.correlation = 1; state.flow = 0.6; state.resonance = 0.8; });
    const chaotic = settle((state, a) => {
      state.energy = 0.15; state.chaos = 0.9; state.complexity = 0.9; state.order = 0;
      a.harmonicity = a.phaseCoherence = 0.05; a.correlation = -0.5; a.roughness = 0.9; a.interChannelCoherence = 0;
    });
    // Connected filaments on shells against scattered grains.
    expect(coherent.connectivity).toBeGreaterThan(0.8);
    expect(chaotic.connectivity).toBeLessThan(coherent.connectivity - 0.3);
    expect(chaotic.speed).toBeGreaterThan(coherent.speed + 0.1);
    // Dispersed and thick against held and thin.
    expect(chaotic.radius).toBeGreaterThan(coherent.radius * 1.2);
    expect(chaotic.spread).toBeGreaterThan(coherent.spread * 1.3);
    expect(chaotic.material.fragmentation).toBeGreaterThan(0.5);
    expect(coherent.material.fragmentation).toBeLessThan(0.05);
    expect(coherent.fields.gather).toBeGreaterThan(chaotic.fields.gather + 0.2);
  }, 60_000);

  it('rotation makes a disc of the cloud; without it the body stays round', () => {
    const still = settle((state) => { state.energy = 0.5; });
    const spinning = settle((state, a, world) => { state.energy = 0.5; a.presence = 1; world.state.spin = 2; });
    expect(still.flatness).toBeGreaterThan(0.4);
    expect(spinning.flatness).toBeLessThan(still.flatness * 0.6);
  }, 60_000);
});

/** A steady, rich, harmonic tone on `hz` as the DSP would report it: clear partials, coherent phase, no noise. */
function tone(hz: number, harmonics = 6) {
  return (a: AnalysisFrame): void => {
    a.presence = a.sounding = a.timbreConfidence = 1; a.silent = 0;
    a.loudnessMomentary = -16; a.harmonicity = 0.95; a.phaseCoherence = 0.97; a.pitchSalience = 0.7; a.harmonicShare = 0.9;
    a.entropy = 0.3; a.flatness = 0.02; a.phaseDeviation = 0.03; a.complexChange = 0.03; a.sharpness = 0.2; a.correlation = 1;
    a.bandLevel.fill(0.4); a.bandTransient.fill(0); a.bandActivity.fill(0);
    a.partialHz.fill(0); a.partialLevel.fill(0);
    for (let h = 0; h < harmonics; h++) { a.partialHz[h] = hz * (h + 1); a.partialLevel[h] = 0.95 / (h + 1); }
  };
}
/** What the graphic analysis would hand the scene for that tone: its cycle on both voices (or none). */
function voiced(s: ReturnType<typeof stage>, on: boolean): void {
  const music = s.response.music;
  for (let i = 0; i < music.leadLine.length; i++) music.leadLine[i] = music.bassLine[i] = 2 * i / music.leadLine.length - 1;
  music.leadVoice = music.bassVoice = on ? 1 : 0; music.leadPitch = 220; music.bassPitch = 110;
  s.response.presence = s.response.audible = on ? 1 : 0;
}

describe('matter taking form', () => {
  it('the same matter gathers on the forms of a steady tone and returns to particles when it stops: nothing is reset', () => {
    const run = () => {
      const s = stage(1024), sound = tone(220);
      const previous = new Float32Array(s.probe.count * 4), ages = new Float32Array(s.probe.count);
      let formed: MatterMeasure | undefined, jumps = 0, reformed = 0;
      voiced(s, true);
      session(60, 16, (a, t) => (t < 7 ? sound(a) : silence(a)), (t, m, st) => {
        if (t > 7 && st.response.presence) voiced(st, false);
        const p = st.probe.position, v = st.probe.velocity;
        for (let i = 0; i < st.probe.count; i++) {
          const at = i * 4;
          // Every element moves there: never further in a frame than its top speed allows, and it is never re-formed.
          if (t > 0.1 && Math.hypot(p[at] - previous[at], p[at + 1] - previous[at + 1], p[at + 2] - previous[at + 2]) > MAX_VELOCITY / 60 + 1e-4) jumps++;
          if (v[at + 3] < ages[i]) reformed++;
          ages[i] = v[at + 3];
        }
        previous.set(p);
        if (Math.abs(t - 6.9) < 0.009) formed = { ...m };
      }, s);
      return { s, formed: formed!, rest: { ...s.probe.measure(s.mapping.fields.lateral) }, jumps, reformed };
    };
    const r = run();
    // Most of the matter is held by a form, close to where the form wants it, and its strands have opened into facets.
    expect(r.formed.held).toBeGreaterThan(0.5);
    expect(r.formed.offForm).toBeLessThan(0.12);
    expect(r.formed.facet).toBeGreaterThan(0.005);
    expect(r.formed.speed).toBeLessThan(0.3);
    // After the sound: free matter again, back on its shells, at rest, strands closed into filaments.
    expect(r.rest.held).toBeLessThan(0.01);
    expect(r.rest.speed).toBeLessThan(0.02);
    expect(r.rest.connectivity).toBeGreaterThan(0.9);
    expect(r.rest.facet).toBeLessThan(r.formed.facet / 3);
    expect(r.rest.radius).toBeGreaterThan(0.6); expect(r.rest.radius).toBeLessThan(1.1);
    expect(r.jumps).toBe(0);
    expect(r.reformed).toBe(0);
    // The same session is the same matter, element by element.
    expect(differing(run().s.probe.position, r.s.probe.position)).toBe(0);
  }, 120_000);

  it('what the sound is made of decides the state of the matter: a pure tone, a chord and noise are three different bodies', () => {
    const body = (input: (a: AnalysisFrame) => void, voices: boolean) => {
      const s = stage(1024);
      voiced(s, voices);
      session(60, 6, input, undefined, s);
      return { ...s.probe.measure(s.mapping.fields.lateral), forms: { ...s.mapping.forms.state }, nodes: s.mapping.forms.harmonic.active };
    };
    const sine = body(tone(220, 1), true);
    const chordSound = tone(220, 0);
    const chord = body((a) => {
      chordSound(a); a.harmonicity = 0.35;
      [220, 261.63, 329.63].forEach((hz, i) => { a.partialHz[i] = hz; a.partialLevel[i] = 0.9 - 0.05 * i; });
    }, false);
    const noise = body((a) => {
      tone(220, 6)(a);
      a.harmonicity = 0.03; a.phaseCoherence = 0.5; a.phaseDeviation = 0.5; a.flatness = 0.95; a.complexChange = 1; a.entropy = 0.95;
      a.partialLevel.fill(0.03);
    }, false);
    // One partial: nothing to connect. The matter takes the shape of the cycle, closed into a ring.
    expect(sine.forms.wave).toBeGreaterThan(0.6); expect(sine.forms.harmonic).toBe(0); expect(sine.forms.closure).toBeGreaterThan(0.9);
    expect(sine.nodes).toBe(1);
    // Three notes with no single period and no voice to draw: a network, no ring.
    expect(chord.forms.harmonic).toBeGreaterThan(0.3); expect(chord.forms.wave).toBe(0); expect(chord.nodes).toBe(3);
    expect(chord.held).toBeGreaterThan(0.1);
    // Noise: neither. Free, disordered matter.
    expect(noise.forms.wave).toBe(0); expect(noise.forms.harmonic).toBe(0); expect(noise.held).toBe(0); expect(noise.nodes).toBe(0);
    expect(noise.speed).toBeGreaterThan(sine.speed);
  }, 120_000);

  it('a release throws the forms open in proportion to what was released, and they close again by themselves', () => {
    const s = stage(1024), events = new EventStream();
    const snapshot = createSnapshot(newFrame());
    tone(220)(snapshot.acoustic);
    Object.assign(snapshot.morphology, { periodicity: 0.95, harmonicity: 0.95, richness: 0.8, stability: 0.95, confidence: 1 });
    snapshot.world.coherence = 0.9; snapshot.world.illumination = 0.6;
    voiced(s, true);
    const at = (seconds: number, from: number) => {
      let m: MatterMeasure | undefined;
      for (let frame = 1; frame <= seconds * 60; frame++) { snapshot.world.time = from + frame / 60; m = s.frame(snapshot.world.time, 1 / 60, snapshot, events); }
      return { ...m! };
    };
    const formed = at(6, 0);
    expect(formed.held).toBeGreaterThan(0.5);
    // The world reports a release (WorldEngine.release sets its time and strength, and the surge that goes with it).
    snapshot.world.releaseTime = 6; snapshot.world.releaseStrength = 0.6; snapshot.world.radialVelocity = 1.5;
    const broken = at(0.3, 6);
    snapshot.world.radialVelocity = 0;
    expect(broken.held).toBeLessThan(formed.held * 0.4);
    expect(broken.speed).toBeGreaterThan(formed.speed + 0.2);
    const closed = at(6, 6.3);
    expect(closed.held).toBeGreaterThan(formed.held * 0.95);
    expect(closed.offForm).toBeLessThan(0.15);
    // A small release only loosens them.
    snapshot.world.releaseTime = 12.3; snapshot.world.releaseStrength = 0.15;
    const loosened = at(0.3, 12.3);
    expect(loosened.held).toBeGreaterThan(broken.held + 0.2); expect(loosened.held).toBeLessThan(formed.held);
  }, 120_000);

  it('takes form at the same pace at 30, 60 and 144 frames per second', () => {
    const run = (fps: number) => {
      const s = stage(512);
      voiced(s, true);
      session(fps, 4, tone(220), undefined, s);
      return { ...s.probe.measure(s.mapping.fields.lateral), wave: s.mapping.forms.state.wave, harmonic: s.mapping.forms.state.harmonic };
    };
    const [a, b, c] = [30, 60, 144].map(run);
    for (const other of [b, c]) {
      expect(other.wave).toBeCloseTo(a.wave, 2); expect(other.harmonic).toBeCloseTo(a.harmonic, 2);
      expect(other.held).toBeCloseTo(a.held, 1);
      expect(Math.abs(other.radius - a.radius)).toBeLessThan(0.06);
      expect(Math.abs(other.offForm - a.offForm)).toBeLessThan(0.05);
    }
    expect(a.held).toBeGreaterThan(0.4);
  }, 120_000);
});
