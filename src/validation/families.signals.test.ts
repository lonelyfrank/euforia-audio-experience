import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Color, type WebGLRenderer } from 'three';
import { AudioAnalyzer } from '../audio/analysis/AudioAnalyzer';
import { SignalGenerator, type TestSignal } from '../audio/capture/testSignals';
import { WasmAnalysis } from '../audio/features/WasmAnalysis';
import { VisualResponse } from '../audio/visual-response/VisualResponse';
import { DEFAULT_DIRECTION } from '../director/profiles';
import { VisualDirector } from '../director/VisualDirector';
import { ExperienceEngine } from '../experience/ExperienceEngine';
import { forEachCue, SETTLE, type Cue } from '../experience/MusicalCues';
import { QUALITY_PROFILES } from '../renderer/quality';
import type { SceneClock } from '../types/visualizer';
import type { EmergencePrimitive } from '../visual-engine/primitives/EmergencePrimitive';
import { solidSlot } from '../visual-engine/primitives/solidSlot';
import { SOLID_STAGES, stageOf, type SolidStage, type SolidPrimitive } from '../visual-engine/primitives/SolidPrimitive';
import { DEFAULT_EMERGENCE } from '../visual-engine/primitives/terrainEmergence';
import type { RecipeVisualizer } from '../visual-engine/RecipeVisualizer';
import { createReadout } from '../visual-engine/structural/SolidDynamics';
import { PULSE_LIMIT } from '../visual-engine/structural/SolidTypes';
import matterField from '../visualizers/matter-field';
import terrain from '../visualizers/terrain';
import { EMERGENCE_SLOT } from '../visualizers/terrain/recipe';

/*
 * The scene families on the real analysis path (docs/scene-families.md): deterministic test signals through the WASM
 * analysis (the same DSP as the desktop), the decoder and ExperienceEngine, to the musical cues, to Matter Field's
 * solids and to Generative Terrain's emergence. Synthetic audio, not music: regressions of known behaviour.
 *
 * In one file on purpose: each run analyses up to a minute of audio, and the suite runs its files in parallel; one
 * file keeps these runs on one worker, one after the other, instead of three at once beside the CPU benchmarks.
 */

vi.setConfig({ testTimeout: 300000 });
const SR = 48000;

// ---- one session per signal, every consumer fed from it ----

/** Matter Field with the experiment's population mounted, as the Emergence laboratory mounts it. */
function matterWithSolids() {
  const scene = matterField.create(matterField.preset) as RecipeVisualizer<unknown>;
  scene.init({ renderer: { getPixelRatio: () => 1, extensions: { has: () => true }, getRenderTarget: () => null, setRenderTarget: vi.fn(), render: vi.fn() } as unknown as WebGLRenderer, quality: QUALITY_PROFILES.low, width: 800, height: 600, addPass: () => undefined });
  scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
  const solid = scene.world.add(solidSlot()) as SolidPrimitive;
  return { scene, solid, solids: solid.system.solids!, director: new VisualDirector(matterField.direction), stages: (): SolidStage[] => Array.from(solid.stages.subarray(0, solid.system.solids!.state.bodies), (k) => SOLID_STAGES[k]) };
}

/** Generative Terrain as the product mounts it, emergence on. */
function terrainScene() {
  const scene = terrain.create(terrain.preset) as RecipeVisualizer<unknown>;
  scene.init({ renderer: { getPixelRatio: () => 1 } as WebGLRenderer, quality: QUALITY_PROFILES.low, width: 800, height: 600, addPass: () => undefined });
  scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
  return { scene, em: scene.world.primitive<EmergencePrimitive>(EMERGENCE_SLOT)!, director: new VisualDirector(terrain.direction) };
}

interface Session {
  engine: ExperienceEngine;
  /** Every cue of the session, as the presented snapshots carried them; the experience's drops; releases heard. */
  cues: Cue[];
  drops: number[];
  releases: number[];
  solids: ReturnType<typeof matterWithSolids>;
  /** Audio times the solids' gate fired at, the stages each second, the worst shape and pulse of a whole body. */
  solidFractures: number[];
  stagesAt: Map<number, SolidStage[]>;
  worst: { deviation: number; pulse: number };
  terrain: ReturnType<typeof terrainScene>;
  terrainBroke: number[];
  terrainMax: number;
}

/**
 * A test signal through the WASM analysis and the experience engine, presented 0.1 s late at `fps`, to the musical
 * cues, Matter Field with its solids and Generative Terrain with its emergence — the same snapshots for all three.
 */
async function play(signal: TestSignal, seconds: number, fps = 60): Promise<Session> {
  const pcm = new Float32Array(seconds * SR * 2);
  new SignalGenerator(signal, SR).fillStereo(pcm, seconds * SR);
  const wasm = await WasmAnalysis.create(SR, 2), engine = new ExperienceEngine();
  wasm.decoder.onFrame = (a) => engine.ingest(a); wasm.decoder.onOnset = (o) => engine.onset(o); wasm.decoder.onBeat = (b) => engine.beat(b); wasm.decoder.onSection = (s) => engine.section(s);
  const out: Session = {
    engine, cues: [], drops: [], releases: [], solids: matterWithSolids(), solidFractures: [], stagesAt: new Map(), worst: { deviation: 0, pulse: 0 },
    terrain: terrainScene(), terrainBroke: [], terrainMax: 0,
  };
  const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame, readout = createReadout(), cursor = { time: -Infinity, seq: 0 };
  const clock: SceneClock = { time: 0, hits: { times: new Float64Array(8), strengths: new Float64Array(8), count: 0, size: 8 } as never, hitScale: 1, events: engine.events, light: 0.5 };
  const { solids, terrain: ground } = out;
  let captured = 0, seen = 0, solidFired = 0, groundFired = 0;
  try {
    for (let f = 1; f <= seconds * fps; f++) {
      const t = f / fps;
      wasm.decoder.begin();
      while (captured + 480 <= Math.floor(t * SR + 1e-6)) { wasm.push(pcm.subarray(captured * 2, (captured + 480) * 2)); captured += 480; }
      const snapshot = engine.present(t - 0.1);
      if (!snapshot) continue;
      clock.time = t - 0.1; clock.experience = snapshot;
      seen = forEachCue(snapshot.cues, seen, (c) => { out.cues.push({ ...c }); if (c.kind === 'release') out.releases.push(c.time); });
      engine.events.forEachHeard(cursor, t - 0.1, (e) => { if (e.type === 'drop') out.drops.push(e.audioTime); });
      solids.scene.update(audio, 1 / fps, t - 0.1, response, solids.director.update(response, DEFAULT_DIRECTION, 1 / fps, undefined, snapshot), clock);
      ground.scene.update(audio, 1 / fps, t - 0.1, response, ground.director.update(response, DEFAULT_DIRECTION, 1 / fps, undefined, snapshot), clock);
      if (solids.solids.gate.stats.fired > solidFired) { solidFired = solids.solids.gate.stats.fired; out.solidFractures.push(solids.solids.gate.time); }
      if (ground.em.field.gate.stats.fired > groundFired) { groundFired = ground.em.field.gate.stats.fired; out.terrainBroke.push(ground.em.field.gate.time); }
      out.terrainMax = Math.max(out.terrainMax, ground.em.field.count);
      if (f % fps === 0) {
        out.stagesAt.set(Math.round(t), solids.stages());
        for (let b = 0; b < solids.solids.state.bodies; b++) {
          const r = solids.solids.read(b, null, readout);
          // A body is rigid while it is whole: what it shows of its shape and of its pulse.
          if (stageOf(r, true) === 'solid') { out.worst.deviation = Math.max(out.worst.deviation, r.deviation); out.worst.pulse = Math.max(out.worst.pulse, Math.abs(r.pulse)); }
        }
      }
    }
  } finally { wasm.dispose(); }
  return out;
}

/** One session per signal and frame rate, shared by every test that reads it. */
const sessions = new Map<string, Promise<Session>>();
const session = (signal: TestSignal, seconds: number, fps = 60): Promise<Session> => {
  const key = `${signal}/${seconds}/${fps}`;
  if (!sessions.has(key)) sessions.set(key, play(signal, seconds, fps));
  return sessions.get(key)!;
};

beforeEach(() => vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 }));
afterEach(() => vi.unstubAllGlobals());

describe('musical cues on test signals through the WASM analysis', () => {
  it('buildDrop: two releases, at the drops (18 s, 50 s), never before; the experience\'s drops around them are not cues', async () => {
    const { engine, cues, releases: heard } = await session('buildDrop', 58), releases = cues.filter((c) => c.kind === 'release');
    expect(releases.map((c) => c.status)).toEqual(['confirmed', 'confirmed']);
    for (const [i, drop] of [18, 50].entries()) { expect(heard[i]).toBeGreaterThanOrEqual(drop - 0.1); expect(heard[i]).toBeLessThan(drop + 0.6); }
    const s = engine.cues.frame.stats;
    expect(s.dropsMatched + s.dropsUnconfirmed).toBe(engine.cognition.frame.stats.experienceDrops);
    // Measured: the experience fires about 2 s before and after each drop (docs/music-response.md §2.4); none is a cue.
    expect(s.dropsUnconfirmed).toBeGreaterThanOrEqual(2);
    // Prepared before each release, and nothing prepared in the seconds right after one (the tension has just resolved).
    const prepares = cues.filter((c) => c.kind === 'prepare');
    for (const drop of [18, 50]) expect(prepares.some((c) => c.time < drop && c.time > drop - 8)).toBe(true);
    for (const c of prepares) for (const r of releases) expect(c.time - r.time < 0 || c.time - r.time >= SETTLE).toBe(true);
    expect(prepares).toHaveLength(2);
    expect(s.withdrawn).toBe(0);
  });

  it('startStop: the music coming back is neither a release nor an accent; the experience\'s drops there stay unconfirmed', async () => {
    const { engine, cues } = await session('startStop', 50), s = engine.cues.frame.stats;
    expect(cues.filter((c) => c.kind === 'release')).toEqual([]);
    expect(s.prepared).toBe(0);
    expect(s.dropsUnconfirmed).toBe(engine.cognition.frame.stats.experienceDrops);
    expect(s.dropsUnconfirmed).toBeGreaterThanOrEqual(1);
    for (const c of cues.filter((c) => c.kind === 'accent')) expect(c.status).toBe('observed');
  });

  it('beat124: a steady groove gives no release, no preparation and accents only now and then', async () => {
    const { engine, cues } = await session('beat124', 40), s = engine.cues.frame.stats;
    expect(s.releases).toBe(0); expect(s.prepared).toBe(0);
    // 124 BPM over 40 s is about 80 kicks: an accent is an exception among them, never one per kick.
    expect(cues.filter((c) => c.kind === 'accent').length).toBeLessThan(80 * 0.25);
    expect(engine.cues.frame.phase).toBe('groove');
  });
});

describe('solids among the particles (Matter Field), on test signals through the WASM analysis', () => {
  it('ambient → build → drop: free matter forms solids, they keep their shape, break at the two releases heard (never at the experience\'s drops off them), and find each other again', async () => {
    const r = await session('buildDrop', 58);
    expect(r.releases).toHaveLength(2);
    // Formed before the first drop, every body.
    expect(r.stagesAt.get(2)).toEqual(['free', 'free', 'free']);
    expect(r.stagesAt.get(17)).toEqual(['solid', 'solid', 'solid']);
    // Two fractures, each at a release heard; the experience's drops 2 s before and after them broke nothing.
    expect(r.solidFractures).toHaveLength(2);
    for (const [i, at] of r.solidFractures.entries()) expect(Math.abs(at - r.releases[i])).toBeLessThan(0.05);
    expect(r.drops.length).toBeGreaterThanOrEqual(2);
    for (const drop of r.drops) expect(r.solidFractures.every((at) => Math.abs(at - drop) > 1)).toBe(true);
    // Fragments, then the pieces find each other: whole again before the second drop.
    expect(r.stagesAt.get(21)).toContain('fragments');
    expect(r.stagesAt.get(45)).toEqual(['solid', 'solid', 'solid']);
    expect(r.solids.solids.stats.reforms).toBeGreaterThan(0);
    // Rigid: while whole a body is its own shape, its pulse within the limit.
    expect(r.worst.deviation).toBeLessThan(0.02); expect(r.worst.pulse).toBeLessThanOrEqual(PULSE_LIMIT + 1e-9);
  });

  it('a steady groove and music that stops and starts: bodies form and stay whole, nothing breaks', async () => {
    for (const [signal, seconds] of [['beat124', 40], ['startStop', 50]] as const) {
      const r = await session(signal, seconds);
      expect(r.solidFractures, signal).toEqual([]);
      expect(r.stagesAt.get(39), signal).toEqual(['solid', 'solid', 'solid']);
    }
  });

  it('the same at 30 and 60 frames per second: the same fractures at the same audio times, the same stages', async () => {
    const [slow, fast] = [await session('buildDrop', 21, 30), await session('buildDrop', 21, 60)];
    expect(slow.solidFractures.length).toBe(fast.solidFractures.length);
    expect(slow.solidFractures.length).toBe(1);
    for (let i = 0; i < slow.solidFractures.length; i++) expect(slow.solidFractures[i]).toBeCloseTo(fast.solidFractures[i], 1);
    expect(slow.stagesAt.get(17)).toEqual(fast.stagesAt.get(17));
  });
});

describe('Generative Terrain emergence, on test signals through the WASM analysis', () => {
  it('ambient → build → drop: bursts and fractures at the two releases heard, never at the experience\'s drops 2 s off them', async () => {
    const { terrain: t, terrainBroke, releases, drops, terrainMax } = await session('buildDrop', 58), field = t.em.field;
    expect(releases).toHaveLength(2);
    expect(field.stats.bursts).toBe(2); expect(field.stats.releases).toBe(2);
    expect(terrainBroke.length).toBeGreaterThanOrEqual(1);
    for (const at of terrainBroke) expect(releases.some((r) => Math.abs(r - at) < 1e-6)).toBe(true);
    for (const drop of drops) expect(terrainBroke.every((at) => Math.abs(at - drop) > 1)).toBe(true);
    expect(terrainMax).toBeLessThanOrEqual(DEFAULT_EMERGENCE.capacity);
  });

  it('a steady groove and music that stops and starts: a few structures, no burst, nothing broken', async () => {
    for (const [signal, seconds] of [['beat124', 40], ['startStop', 50]] as const) {
      const { terrain: t, terrainBroke, terrainMax } = await session(signal, seconds);
      expect(t.em.field.stats.bursts, signal).toBe(0); expect(terrainBroke, signal).toEqual([]);
      expect(t.em.field.stats.spawned, signal).toBeGreaterThan(0);
      expect(terrainMax, signal).toBeLessThanOrEqual(12);
    }
  });
});
