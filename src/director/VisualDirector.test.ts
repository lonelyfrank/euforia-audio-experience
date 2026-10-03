import { describe, expect, it } from 'vitest';
import { MusicInterpreter } from '../audio/interpretation/MusicInterpreter';
import { AutoDirection } from './AutoDirection';
import { DEFAULT_DIRECTION, moodAmount } from './profiles';
import { approach, VisualDirector } from './VisualDirector';
import galaxy from '../visualizers/galaxy';

function musicFixture() {
  const m = new MusicInterpreter().frame;
  Object.assign(m, { audible: 1, presence: 1, lowAudible: 1, midAudible: 1, highAudible: 1, weight: 0.5, flow: 0.5, detail: 0.5, motion: 0.4, openness: 0.6, brightness: 0.6, intensity: 0.7, shortEnergy: 0.6, transient: 0.8, rhythmicConfidence: 0.8, warmth: 0.5 });
  return m;
}

describe('VisualDirector', () => {
  it('interpolates mood intensity around neutral and bounds invalid input', () => {
    expect(moodAmount(2, 0)).toBe(1);
    expect(moodAmount(2, 0.5)).toBe(1.5);
    expect(moodAmount(2, 10)).toBe(2);
    expect(moodAmount(2, NaN)).toBe(1);
  });
  it('has frame-rate independent attack and a slower release', () => {
    const evolve = (hz: number) => { let v = 0; for (let i = 0; i < hz; i++) v = approach(v, 1, 1 / hz, 0.1, 1); return v; };
    expect(evolve(30)).toBeCloseTo(evolve(144), 10);
    expect(approach(0, 1, 0.1, 0.1, 1)).toBeGreaterThan(0.6);
    expect(approach(1, 0, 0.1, 0.1, 1)).toBeGreaterThan(0.9);
  });
  it('makes Galaxy Chaos/Reactive more deformed and mobile than Dream/Ambient without touching music', () => {
    const music = musicFixture();
    const snapshot = structuredClone(music);
    const dream = new VisualDirector(galaxy.direction);
    const chaos = new VisualDirector(galaxy.direction);
    for (let i = 0; i < 1200; i++) {
      dream.update(music, { ...DEFAULT_DIRECTION, mood: 'dream', moodIntensity: 1, experience: 'ambient' }, 1 / 60);
      chaos.update(music, { ...DEFAULT_DIRECTION, mood: 'chaos', moodIntensity: 1 }, 1 / 60);
    }
    expect(chaos.frame.distortion).toBeGreaterThan(dream.frame.distortion * 2);
    expect(chaos.frame.rotation).toBeGreaterThan(dream.frame.rotation * 3);
    expect(dream.frame.persistence).toBeGreaterThan(chaos.frame.persistence);
    expect(music).toEqual(snapshot);
    const stable = chaos.frame;
    chaos.update(music, DEFAULT_DIRECTION, 1 / 60);
    expect(chaos.frame).toBe(stable);
    for (const value of Object.values(stable)) expect(value).toBeGreaterThanOrEqual(0);
    for (const value of Object.values(stable)) expect(value).toBeLessThanOrEqual(1);
  });
  it('honors capabilities and replaces routes per target, preserving other mappings', () => {
    const d = new VisualDirector({ capabilities: { distortion: true }, mappings: [{ source: 'high', target: 'scale', amount: 1 }] });
    const m = musicFixture(); m.detail = 0; m.weight = 1;
    for (let i = 0; i < 600; i++) d.update(m, { ...DEFAULT_DIRECTION, moodIntensity: 0 }, 1 / 60);
    expect(d.frame.scale).toBe(0);
    expect(d.frame.cameraMotion).toBe(0);
    expect(d.frame.particleEmission).toBe(0);
    expect(d.frame.distortion).toBeGreaterThan(0);
  });
  it('fades Minimal to darkness and does not invent phase pulses without rhythm', () => {
    const d = new VisualDirector(galaxy.direction);
    const silent = new MusicInterpreter().frame;
    silent.beatPhase = 0; silent.rhythmicConfidence = 0;
    for (let i = 0; i < 600; i++) d.update(silent, { ...DEFAULT_DIRECTION, experience: 'minimal' }, 1 / 60);
    expect(d.frame.visibility).toBe(0);
    expect(d.frame.impact).toBe(0);
    expect(d.frame.scale).toBe(0);
    expect(d.response!.audible).toBe(0);
  });
});

describe('VisualDirector on the audio clock', () => {
  it('moves the slow parameters as springs and takes the timed impact pulse', () => {
    const music = musicFixture();
    const director = new VisualDirector(galaxy.direction);
    const clock = { time: 10, impact: 0 };
    const camera: number[] = [];
    for (let f = 0; f < 600; f++) {
      clock.time = 10 + f / 60;
      clock.impact = f === 300 ? 1 : 0;
      const m = director.update(music, DEFAULT_DIRECTION, 1 / 60, clock);
      camera.push(m.cameraMotion);
      if (f === 300) expect(m.impact).toBeGreaterThan(0.5);
      if (f === 301) expect(m.impact).toBe(0);
    }
    // A drift spring: continuous motion (no frame-to-frame jump) that settles near its target.
    for (let i = 1; i < camera.length; i++) expect(Math.abs(camera[i] - camera[i - 1])).toBeLessThan(0.01);
    expect(camera[camera.length - 1]).toBeGreaterThan(0.1);
    expect(Math.abs(camera[camera.length - 1] - camera[camera.length - 30])).toBeLessThan(0.01);
    const channels = director.dynamics.channelCount;
    expect(channels).toBe(13);
  });

  it('picks slower followers for a fluid mood and faster ones for a reactive one', () => {
    const music = musicFixture();
    const run = (mood: 'dream' | 'chaos', experience: 'ambient' | 'reactive') => {
      const director = new VisualDirector(galaxy.direction);
      const settings = { ...DEFAULT_DIRECTION, mood, experience, moodIntensity: 1 };
      for (let f = 0; f < 600; f++) director.update(music, settings, 1 / 60, { time: f / 60, impact: 0 });
      const scale = [...Array(director.dynamics.channelCount).keys()].map((c) => director.dynamics.inspect(c)).find((s) => s.name === 'scale')!;
      return scale.type;
    };
    expect(run('dream', 'ambient')).toBe('swell');
    expect(run('chaos', 'reactive')).toBe('sparkle');
  });

  it('snaps its springs at a section boundary', () => {
    const music = musicFixture();
    const director = new VisualDirector(galaxy.direction);
    const clock = { time: 0, impact: 0, snapAt: -1 };
    for (let f = 0; f < 240; f++) {
      clock.time = f / 60;
      clock.snapAt = f === 180 ? clock.time : -1;
      director.update(music, DEFAULT_DIRECTION, 1 / 60, clock);
      if (f === 181) {
        const springs = [...Array(director.dynamics.channelCount).keys()].map((c) => director.dynamics.inspect(c)).filter((s) => s.omega > 0);
        for (const s of springs) expect(s.zeta).toBe(1);
      }
    }
  });

  it('keeps the envelopes when the host has no audio clock', () => {
    const music = musicFixture();
    const a = new VisualDirector(galaxy.direction);
    for (let f = 0; f < 60; f++) a.update(music, DEFAULT_DIRECTION, 1 / 60);
    expect(a.dynamics.time).toBe(0);
    expect(a.frame.impact).toBeGreaterThan(0.3);
  });
});

describe('AutoDirection', () => {
  it('requires sustained evidence, dwell and recovers gracefully after a source reset', () => {
    const auto = new AutoDirection();
    const m = musicFixture(); m.music.lowPercussion = 0.5;
    const manual = { ...DEFAULT_DIRECTION, autoDirection: true };
    for (let i = 0; i < 19 * 60; i++) auto.update(m, manual, 1 / 60, i / 60);
    expect(auto.settings.mood).toBe('focus');
    for (let i = 19 * 60; i < 22 * 60; i++) auto.update(m, manual, 1 / 60, i / 60);
    expect(auto.settings.mood).toBe('pulse');
    m.motion = 0; m.rhythmicConfidence = 0; m.music.lowPercussion = 0; m.music.tonality = 1;
    for (let i = 22 * 60; i < 30 * 60; i++) auto.update(m, manual, 1 / 60, i / 60);
    expect(auto.settings.mood).toBe('pulse');
    auto.update(m, manual, 1 / 60, 0);
    expect(auto.settings.mood).toBe('focus');
  });
  it('ignores alternating candidates and preserves the manual choices when disabled', () => {
    const auto = new AutoDirection(); const m = musicFixture();
    for (let i = 0; i < 2400; i++) {
      m.music.lowPercussion = i % 120 < 60 ? 0.5 : 0;
      auto.update(m, { ...DEFAULT_DIRECTION, autoDirection: true }, 1 / 60, i / 60);
    }
    expect(auto.settings.mood).toBe('focus');
    auto.update(m, { ...DEFAULT_DIRECTION, mood: 'dark' }, 1 / 60, 50);
    expect(auto.settings.mood).toBe('dark');
  });
});
