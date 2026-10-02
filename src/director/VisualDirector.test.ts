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
