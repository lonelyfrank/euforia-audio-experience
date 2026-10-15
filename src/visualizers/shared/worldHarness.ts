import { vi } from 'vitest';
import { Color, type PerspectiveCamera, type WebGLRenderer } from 'three';
import { AudioAnalyzer } from '../../audio/analysis/AudioAnalyzer';
import { newFrame } from '../../audio/features/decode';
import { VisualResponse } from '../../audio/visual-response/VisualResponse';
import { DEFAULT_DIRECTION } from '../../director/profiles';
import { VisualDirector } from '../../director/VisualDirector';
import { EventStream } from '../../experience/EventStream';
import type { Cue, CuesFrame } from '../../experience/MusicalCues';
import { createSnapshot, type ExperienceSnapshot } from '../../experience/types';
import { QUALITY_PROFILES } from '../../renderer/quality';
import type { QualityProfile, SceneClock, VisualizerPreset } from '../../types/visualizer';
import type { RecipeVisualizer } from '../../visual-engine/RecipeVisualizer';
import type { WorldState } from '../../world/WorldState';
import { findVisualizer } from '../registry';

/*
 * A world scene mounted as a layer would, on a renderer that records nothing, under a hand-set world and hand-set
 * musical cues (test support, imported by tests only). The world's travel and angle are integrated from its speed and
 * spin; the cues are written into the snapshot as MusicalCues would.
 */

export interface WorldRun {
  scene: RecipeVisualizer<unknown>;
  camera: PerspectiveCamera;
  experience: ExperienceSnapshot;
  world: WorldState;
  cues: CuesFrame;
  events: EventStream;
  /** Writes a cue as MusicalCues would. */
  push(kind: Cue['kind'], status: Cue['status'], time: number, ref?: number): void;
  /** `seconds` of frames at `fps`; `set` writes the world and the cues before each; without `timed` there is no clock. */
  run(seconds: number, set?: (world: WorldState, cues: CuesFrame, t: number) => void, fps?: number, each?: () => void, timed?: boolean): void;
  /** Sound present: the cues live, a groove phase, the world lit. */
  sound(): void;
  silence(): void;
  dispose(): void;
}

/** Mounts the registered scene `id` with its preset (or `visual` merged into it) at `quality`. */
export function mountWorld(id: string, visual: Record<string, unknown> = {}, quality: QualityProfile = QUALITY_PROFILES.medium): WorldRun {
  const definition = findVisualizer(id)!;
  const preset = { ...definition.preset, visual: { ...definition.preset.visual, ...visual } } as VisualizerPreset;
  const scene = definition.create(preset) as RecipeVisualizer<unknown>;
  const renderer = { getPixelRatio: () => 1, extensions: { has: () => true }, getRenderTarget: () => null, setRenderTarget: vi.fn(), render: vi.fn() };
  scene.init({ renderer: renderer as unknown as WebGLRenderer, quality, width: 800, height: 450, addPass: () => undefined });
  scene.resize(800, 450);
  scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
  const audio = new AudioAnalyzer().frame, response = new VisualResponse().frame, director = new VisualDirector(definition.direction);
  const experience = createSnapshot(newFrame()), events = new EventStream(), world = experience.world, cues = experience.cues;
  const clock: SceneClock = { time: 0, hits: { times: new Float64Array(8), strengths: new Float64Array(8), count: 0, size: 8 } as never, hitScale: 1, experience, events, light: 0 };
  world.time = 10;
  const push = (kind: Cue['kind'], status: Cue['status'], time: number, ref = 0): void => {
    const seq = ++cues.seq;
    Object.assign(cues.cues[seq % cues.cues.length], { seq, kind, status, time, expected: 0, strength: 0.9, confidence: 1, ref });
  };
  const run: WorldRun['run'] = (seconds, set, fps = 60, each, timed = true) => {
    const from = world.time;
    for (let k = 1; k <= Math.round(seconds * fps); k++) {
      world.time = from + k / fps;
      set?.(world, cues, world.time);
      world.travel += world.speed / fps; world.angle += world.spin / fps;
      clock.time = world.time; cues.time = world.time;
      const modulation = director.update(response, DEFAULT_DIRECTION, 1 / fps, undefined, timed ? experience : undefined);
      scene.update(audio, 1 / fps, world.time, response, modulation, timed ? clock : undefined);
      each?.();
    }
  };
  const sound = (): void => {
    experience.acoustic.presence = 1; experience.acoustic.silent = 0;
    Object.assign(experience.morphology, { periodicity: 0.6, harmonicity: 0.7, stability: 0.8, richness: 0.6, confidence: 1 });
    Object.assign(experience.state, { resonance: 0.6, flow: 0.6, pressure: 0.5, motion: 0.5, visualEntropy: 0.4, fatigue: 0 });
    Object.assign(world, { coherence: 0.8, illumination: 0.6 });
    cues.live = true; cues.silent = false; cues.phase = 'groove';
    response.presence = response.audible = 1;
  };
  const silence = (): void => {
    experience.acoustic.presence = 0; experience.acoustic.silent = 1;
    Object.assign(experience.state, { resonance: 0, flow: 0, pressure: 0, motion: 0, visualEntropy: 0 });
    Object.assign(world, { illumination: 0, spin: 0, speed: 0, turbulence: 0, excitation: 0, shimmer: 0, radius: 0, radialVelocity: 0, potential: 0, openness: 0 });
    cues.silent = true; cues.phase = 'silence';
    response.presence = response.audible = 0;
  };
  return { scene, camera: scene.camera as PerspectiveCamera, experience, world, cues, events, push, run, sound, silence, dispose: () => scene.dispose() };
}
