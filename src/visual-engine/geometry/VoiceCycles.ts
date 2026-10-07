import { DataTexture, FloatType, NearestFilter, RedFormat } from 'three';
import { SHAPE_SIZE } from '../../audio/analysis/VoiceTracker';
import type { VisualResponseFrame } from '../../types/audio';

/** Samples of a cycle and the voices kept: row 0 the bass line, row 1 the lead. */
export const CYCLE_SIZE = SHAPE_SIZE;
export const CYCLE_VOICES = 2;

/**
 * The live cycles of the two voices as a world resource: what any primitive
 * bends its lines with (a filament vibrates in the voice's real shape). One
 * small float texture, written once per frame from the graphic analysis; the
 * levels say how present and clear each voice is, so an absent voice bends
 * nothing. Rendering data only; allocation-free after construction.
 */
export class VoiceCycles {
  readonly data = new Float32Array(CYCLE_SIZE * CYCLE_VOICES);
  /** How present and clear each voice is, 0..1. */
  readonly level = new Float32Array(CYCLE_VOICES);
  /** Fundamental of each voice (Hz, held while unpitched). */
  readonly pitch = new Float32Array(CYCLE_VOICES);
  readonly texture: DataTexture;

  constructor() {
    this.texture = new DataTexture(this.data, CYCLE_SIZE, CYCLE_VOICES, RedFormat, FloatType);
    this.texture.minFilter = this.texture.magFilter = NearestFilter;
    this.texture.needsUpdate = true;
  }

  update(response: VisualResponseFrame): void {
    const music = response.music, data = this.data;
    for (let i = 0; i < CYCLE_SIZE; i++) {
      data[i] = sample(music.bassLine[i]);
      data[CYCLE_SIZE + i] = sample(music.leadLine[i]);
    }
    this.level[0] = unit(music.bassVoice); this.level[1] = unit(music.leadVoice);
    this.pitch[0] = music.bassPitch > 0 ? music.bassPitch : 0; this.pitch[1] = music.leadPitch > 0 ? music.leadPitch : 0;
    this.texture.needsUpdate = true;
  }

  /** The cycle of `voice` at `cycles` (any real number: it repeats), linearly interpolated: the CPU twin of `voiceCycleGlsl`. */
  at(voice: number, cycles: number): number {
    const p = (cycles - Math.floor(cycles)) * CYCLE_SIZE, i = Math.min(Math.floor(p), CYCLE_SIZE - 1), base = voice * CYCLE_SIZE;
    const a = this.data[base + i];
    return a + (this.data[base + (i + 1) % CYCLE_SIZE] - a) * (p - i);
  }

  reset(): void {
    this.data.fill(0); this.level.fill(0); this.pitch.fill(0);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/** GLSL ES 3.00: `voiceCycle(voice, cycles)` reads `tVoices` (declared here) like `VoiceCycles.at`. */
export const voiceCycleGlsl = /* glsl */ `
uniform sampler2D tVoices;
float voiceCycle(int voice, float cycles) {
  float p = fract(cycles) * ${CYCLE_SIZE}.0;
  int i = min(int(p), ${CYCLE_SIZE - 1});
  return mix(texelFetch(tVoices, ivec2(i, voice), 0).r, texelFetch(tVoices, ivec2((i + 1) % ${CYCLE_SIZE}, voice), 0).r, p - float(i));
}
`;

const unit = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
const sample = (x: number): number => (x > -1 ? (x < 1 ? x : 1) : x <= -1 ? -1 : 0);
