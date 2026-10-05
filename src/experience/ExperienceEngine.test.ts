import { describe, expect, it } from 'vitest';
import { newFrame } from '../audio/features/decode';
import { ExperienceEngine } from './ExperienceEngine';
import { TemporalMemory } from './TemporalMemory';
import { ResonantPhysics, radialWave } from '../physics/ResonantPhysics';
import { createState } from './types';
import { DspBudget } from '../audio/features/DspBudget';

function tone() {
  const a = newFrame();
  a.presence = a.sounding = a.phaseCoherence = a.harmonicity = a.harmonicShare = 1;
  a.loudnessMomentary = -18; a.entropy = 0.15; a.pitchBins[33] = 1;
  a.bandDb.fill(-40); a.bandDb[3] = -18;
  return a;
}
function feed(e: ExperienceEngine, seconds: number, change?: (a: ReturnType<typeof tone>, t: number) => void) {
  const a = tone();
  for (let n = 1; n <= seconds * 200; n++) {
    a.time = n / 200; a.sample = n * 240;
    change?.(a, a.time); e.ingest(a);
  }
}

describe('causal experience', () => {
  it('separates energy and complexity, without a false initial build', () => {
    const e = new ExperienceEngine(); feed(e, 10);
    expect(e.state.energy).toBeGreaterThan(0.7);
    expect(e.state.complexity).toBeLessThan(0.15);
    expect(e.state.anticipation).toBeLessThan(0.01);
    expect(e.state.releasePotential).toBeLessThan(0.01);
    expect(e.state.trajectory).toBe('plateau');
  });
  it('accumulates build tension and releases it only on a meaningful attack', () => {
    const e = new ExperienceEngine();
    let accumulated = 0, released = 0;
    feed(e, 30, (a,t) => {
      a.loudnessMomentary = t < 25 ? -55 + t * 1.5 : -10;
      a.loudnessSlope = t < 25 ? 1.5 : 0;
      a.onsetDensity = 4; a.roughness = t < 25 ? 0.5 : 0.1;
      a.shortTransient = t >= 25 && t < 25.01 ? 1 : 0;
      a.novelty = t >= 25 ? 0.8 : 0; a.structureConfidence = 0.8;
      accumulated = Math.max(accumulated, e.state.releasePotential);
      released = Math.max(released, e.state.release);
    });
    expect(accumulated).toBeGreaterThan(0.2);
    expect(released).toBeGreaterThan(0.1);
    expect(e.memory.drops).toBe(1);
  });
  it('distinguishes abrupt silence from a fade and keeps physical momentum', () => {
    const cut = new ExperienceEngine(), fade = new ExperienceEngine();
    feed(cut, 10.5, (a,t) => { if (t > 10) { a.silent = 1; a.presence = 0; } });
    feed(fade, 10.5, (a,t) => {
      a.loudnessMomentary = -18 - Math.max(0,t-5) * 10;
      if (t > 10) { a.silent = 1; a.presence = 0; }
    });
    expect(cut.state.silenceAbruptness).toBeGreaterThan(0.6);
    expect(fade.state.silenceAbruptness).toBeLessThan(0.1);
    expect(cut.state.narrative).toBe('suspended');
    expect(cut.memory.pauses).toBe(1);
  });
  it('presents only heard snapshots, with owned buffers and complete session reset', () => {
    const e = new ExperienceEngine(); feed(e, 3);
    const p = e.present(2.6)!;
    expect(p.state.time).toBeLessThanOrEqual(2.6);
    expect(p.state.time).toBeGreaterThan(2.58);
    const pitch = p.acoustic.pitchBins[33];
    const later = tone(); later.time = 3.005; later.pitchBins.fill(0); e.ingest(later);
    expect(p.acoustic.pitchBins[33]).toBe(pitch);
    expect(e.present(0.1)).toBeUndefined();
    expect(e.present(5)).toBeUndefined();
    e.reset(); expect(e.present(3)).toBeUndefined();
    expect(e.memory.drops).toBe(0); expect(e.physics.frame.energy).toBe(0);
    expect(p.acoustic.pitchBins[33]).toBe(0); expect(p.state.time).toBe(0);
  });
  it('keeps bounded recurrence memory and recognizes A → B → A', () => {
    const m = new TemporalMemory(), a = tone();
    let repeated = false;
    for (let n = 1; n <= 8000; n++) {
      a.time = n / 200;
      const b = a.time > 12 && a.time < 27;
      a.chroma.fill(0); a.chroma[b ? 6 : 0] = 1; a.chromaConfidence = 1;
      a.bandDb.fill(-70); a.bandDb[b ? 6 : 1] = -12;
      m.update(a, b ? 0.2 : 0.8, b ? 0.8 : 0.2, 0.1, 0.005);
      if (a.time > 30 && m.recurrence > 0) repeated = true;
    }
    expect(repeated).toBe(true); expect(m.fingerprints.length).toBe(32 * 24);
  });
});

describe('resonant physics and DSP budget', () => {
  it('retains momentum after an impulse, then dissipates; wavefronts are causal', () => {
    const p = new ResonantPhysics(), a = tone(), e = createState();
    a.harmonicShare = 0; a.time = 1; e.eventId = 1; e.eventTime = 1; e.eventStrength = 1;
    p.update(a,e,0.005);
    const initial = p.frame.energy;
    for (let n = 1; n < 100; n++) { a.time += 0.005; p.update(a,e,0.005); }
    expect(Math.abs(p.frame.displacement)).toBeGreaterThan(0.01);
    expect(p.frame.energy).toBeLessThan(initial);
    for (let n = 0; n < 6000; n++) { a.time += 0.005; p.update(a,e,0.005); }
    expect(p.frame.energy).toBeLessThan(1e-8);
    expect(radialWave(1,0.1,1)).toBe(0);
    expect(radialWave(0.1,0.2,1)).not.toBe(0);
    expect(radialWave(0.1,-1,1)).toBe(0);
  });
  it('reduces slow DSP work with hysteresis and recovers independently of GPU', () => {
    const b = new DspBudget();
    for (let i=0;i<500;i++) b.update(0.008,0.01);
    expect(b.quality).toBe(2);
    for (let i=0;i<7000;i++) b.update(0.0005,0.01);
    expect(b.quality).toBe(0);
  });
});

it('does not interpret the warm-up of real steady PCM as a build/drop', { timeout: 30000 }, async () => {
  const { WasmAnalysis } = await import('../audio/features/WasmAnalysis');
  const { SignalGenerator } = await import('../audio/capture/testSignals');
  const wasm = await WasmAnalysis.create(48000, 1);
  const e = new ExperienceEngine();
  wasm.decoder.onFrame = a => e.ingest(a);
  const signal = new SignalGenerator('beat124',48000), chunk = new Float32Array(480);
  let anticipation = 0;
  for (let n=0;n<1600;n++) {
    signal.fill(chunk,0,chunk.length);wasm.push(chunk);
    if (n>300) anticipation=Math.max(anticipation,e.state.anticipation);
  }
  wasm.dispose();
  expect(anticipation).toBeLessThan(0.35);
  expect(e.memory.drops).toBe(0);
});

it('reserves contrast after sustained high visual entropy', async () => {
  const { ExperiencePlanner } = await import('./ExperiencePlanner');
  const p = new ExperiencePlanner(), s = createState(), a = tone();
  Object.assign(s,{energy:1,complexity:1,motion:1,impact:1,openness:1,confidence:1});
  p.update(s,a,0.01);const initial=p.plan.maxIntensity;
  for(let i=0;i<4000;i++){s.time=i/100;p.update(s,a,0.01);}
  expect(s.fatigue).toBeGreaterThan(0.8);
  expect(p.plan.maxIntensity).toBeLessThan(initial-0.2);
  expect(p.plan.nextIntent).toBe('breathe');
});

describe('event stream', () => {
  it('orders late arrivals by audio time and delivers each heard event once, late ones late', async () => {
    const { EventStream } = await import('./EventStream');
    const s = new EventStream(), seen: string[] = [], cursor = { time: -Infinity, seq: 0 };
    s.push('impact', 1.0, 1, 1); s.push('beat', 1.5, 1, 1); s.push('onset', 0.9, 1, 1);
    s.forEachHeard(cursor, 1.2, (e) => seen.push(`${e.type}@${e.audioTime}`));
    expect(seen).toEqual(['onset@0.9', 'impact@1']);
    // A section stamped at an already-heard downbeat arrives a beat later: delivered on the next call.
    s.push('sectionBoundary', 1.1, 1, 1);
    s.forEachHeard(cursor, 1.6, (e) => seen.push(`${e.type}@${e.audioTime}`));
    expect(seen.slice(2)).toEqual(['sectionBoundary@1.1', 'beat@1.5']);
    s.forEachHeard(cursor, 2, (e) => seen.push(e.type));
    expect(seen).toHaveLength(4);
    expect([0, 1, 2, 3].map((i) => s.at(i).audioTime)).toEqual([0.9, 1.0, 1.1, 1.5]);
  });

  it('stamps build peak and drop on the audio clock, in order', () => {
    const e = new ExperienceEngine();
    feed(e, 30, (a, t) => {
      a.loudnessMomentary = t < 25 ? -55 + t * 1.5 : -10;
      a.loudnessSlope = t < 25 ? 1.5 : 0;
      a.onsetDensity = 4; a.roughness = t < 25 ? 0.5 : 0.1;
      a.shortTransient = t >= 25 && t < 25.01 ? 1 : 0;
      a.novelty = t >= 25 ? 0.8 : 0; a.structureConfidence = 0.8;
    });
    const events = Array.from({ length: e.events.count }, (_, i) => e.events.at(i));
    const drop = events.find((x) => x.type === 'drop')!;
    expect(drop.audioTime).toBeCloseTo(25, 1);
    const peak = events.find((x) => x.type === 'buildPeak');
    expect(peak && peak.audioTime).toBeLessThanOrEqual(drop.audioTime);
    for (let i = 1; i < events.length; i++) expect(events[i].audioTime).toBeGreaterThanOrEqual(events[i - 1].audioTime);
    // The drop resolves the anticipation instead of reading its own energy as a new build.
    expect(e.state.anticipation).toBeLessThan(0.5);
    expect(e.state.trajectory).not.toBe('building');
  });
});

describe('semantic silence, trajectory and narrative', () => {
  it('classifies cut, fade, short gap and long silence, and marks a reset after a long one', () => {
    const e = new ExperienceEngine();
    let kindDuringCut = '', kindLong = '', narrativeAfter = '';
    feed(e, 20, (a, t) => {
      const silent = (t > 8 && t < 8.3) || (t > 12 && t < 15);
      if (silent) { a.silent = 1; a.presence = 0; } else { a.silent = 0; a.presence = 1; }
      if (t > 12.2 && t < 12.3) kindDuringCut = e.state.silenceKind;
      if (t > 14.5 && t < 14.6) kindLong = e.state.silenceKind;
      if (t > 15.5 && t < 15.6) narrativeAfter = e.state.narrative;
    });
    const ends = Array.from({ length: e.events.count }, (_, i) => e.events.at(i)).filter((x) => x.type === 'silenceEnd');
    expect(ends.map((x) => Math.round(x.duration * 10) / 10)).toEqual([0.3, 3]);
    expect(ends[0].duration).toBeLessThan(0.6); // short gap
    expect(kindDuringCut).toBe('hard-cut');
    expect(kindLong).toBe('long-silence');
    expect(narrativeAfter).toBe('reset');
  });

  it('reads a sustained build as building, a steady tone as a confident plateau', () => {
    const steady = new ExperienceEngine(); feed(steady, 10);
    expect(steady.state.trajectory).toBe('plateau');
    expect(steady.state.trajectoryConfidence).toBeGreaterThan(0.5);
    const build = new ExperienceEngine();
    let trajectory = '';
    feed(build, 24, (a, t) => {
      a.loudnessMomentary = -55 + t * 1.5; a.loudnessSlope = 1.5; a.onsetDensity = 4; a.roughness = 0.5;
      if (t > 23.9 && !trajectory) trajectory = build.state.trajectory;
    });
    expect(['building', 'rising']).toContain(trajectory);
    expect(build.state.energyVelocity).toBeGreaterThan(0);
    expect(build.state.likelyBuild).toBeGreaterThan(0.3);
  });

  it('does not let flickering evidence flip the narrative (hysteresis)', () => {
    const e = new ExperienceEngine();
    let changes = 0, last = '';
    feed(e, 30, (a, t) => {
      // Energy alternates every 0.25 s between two levels: no direction lasts.
      a.loudnessMomentary = Math.floor(t * 4) % 2 ? -14 : -30;
      if (t > 5 && e.state.narrative !== last) { changes++; last = e.state.narrative; }
    });
    expect(changes).toBeLessThanOrEqual(2);
  });
});

describe('prediction and planner', () => {
  it('weights grid forecasts by confidence and prepares the transition window for a forecast boundary', () => {
    const e = new ExperienceEngine();
    feed(e, 6, (a, t) => {
      a.beatBpm = 120; a.beatConfidence = 0.9; a.nextBeatTime = t + 0.2;
      a.meter = 4; a.meterConfidence = 0.9; a.downbeatConfidence = 0.9; a.nextDownbeatTime = t + 0.7;
      a.structureConfidence = 0.9; a.nextPhraseTime = 7.5;
    });
    const s = e.state, p = e.planner.plan;
    expect(s.nextDownbeatConfidence).toBeGreaterThan(0.7);
    expect(s.predictionHorizon).toBeGreaterThan(3);
    expect(s.likelyBoundary).toBeGreaterThan(0.3);
    expect(p.transitionStart).toBeLessThan(7.5);
    expect(p.transitionEnd).toBeCloseTo(8.5, 6);
    expect(p.transitionConfidence).toBeGreaterThan(0.35);
    const unsure = new ExperienceEngine();
    feed(unsure, 6, (a, t) => { a.beatBpm = 120; a.beatConfidence = 0.9; a.nextBeatTime = t + 0.2; a.nextDownbeatTime = t + 0.7; a.downbeatConfidence = 0.2; a.nextPhraseTime = 7.5; a.structureConfidence = 0.2; });
    expect(unsure.state.nextDownbeatConfidence).toBeLessThan(0.1);
    expect(unsure.planner.plan.transitionConfidence).toBeLessThan(0.35);
  });

  it('gives each intent its own confidence: pulse follows the beat forecast and peaks on the beat', async () => {
    const { INTENT } = await import('./types');
    const e = new ExperienceEngine();
    feed(e, 4, (a, t) => { a.beatBpm = 120; a.beatConfidence = 0.8; a.nextBeatTime = t + 0.1; a.beatPhase = (t * 2) % 1; });
    const pulse = e.planner.intents[INTENT.pulse];
    expect(pulse.confidence).toBeCloseTo(0.8, 6);
    expect(pulse.strength).toBeCloseTo(0.5 + 0.5 * Math.cos(e.state.beatPhase * Math.PI * 2), 9);
    expect(e.planner.intents[INTENT.contract].confidence).toBe(e.state.anticipationConfidence);
  });
});
