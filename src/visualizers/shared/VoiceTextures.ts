import { SHAPE_SIZE } from '../../audio/analysis/VoiceTracker';
import type { AudioFrame, MusicContextFrame } from '../../types/audio';
import { SignalTexture } from './SignalTexture';

/** Rows of the voice texture: the bass line, the lead, and the "air" (a zig-zag redrawn on high hits). */
export const BASS_ROW = 0;
export const LEAD_ROW = 1;
export const AIR_ROW = 2;
export const VOICE_ROWS = 3;
/** Points per cycle of the air zig-zag. */
const AIR_KNOTS = 16;
/** Sample-and-hold steps per cycle when a voice is drawn stepped. */
export const DIGITAL_STEPS = 24;

/**
 * GLSL: one cycle of a voice at phase `x` (cycles; wraps), -1..1, optionally
 * stepped like a sample-and-hold (`digital` 0..1). Needs `tVoices`.
 */
export const voiceGlsl = /* glsl */ `
  uniform sampler2D tVoices;
  float voiceAt(float row, float x, float digital) {
    x = mix(x, floor(x * ${DIGITAL_STEPS}.0) / ${DIGITAL_STEPS}.0, digital);
    return texture2D(tVoices, vec2(x, (row + 0.5) / ${VOICE_ROWS}.0)).r * 2.0 - 1.0;
  }
`;

/**
 * The voices a scene can draw, as one periodic texture (a cycle per row):
 * the bass line and the lead as MusicContext gives them (current shape or
 * learned style), and the air zig-zag, redrawn at random on each high hit.
 * `digital` is the stepping the style suggests (more percussive, more stepped).
 */
export class VoiceTextures {
  private readonly signal = new SignalTexture(SHAPE_SIZE, VOICE_ROWS, true);
  private readonly air = new Float32Array(SHAPE_SIZE);
  private readonly airTarget = new Float32Array(SHAPE_SIZE);
  private readonly airKnots = new Float32Array(AIR_KNOTS);
  private airSeed = 1;
  private lastHighFlux = 0;
  digital = 0;

  get texture() {
    return this.signal.texture;
  }

  update(frame: AudioFrame, music: MusicContextFrame, dt: number, digitalAmount: number): void {
    if (frame.highFlux > 0.5 && this.lastHighFlux <= 0.5) {
      for (let knot = 0; knot < AIR_KNOTS; knot++) {
        this.airSeed = (this.airSeed * 1664525 + 1013904223) >>> 0;
        this.airKnots[knot] = this.airSeed / 2147483648 - 1;
      }
      const span = SHAPE_SIZE / AIR_KNOTS;
      for (let i = 0; i < SHAPE_SIZE; i++) {
        const knot = Math.floor(i / span);
        const t = i / span - knot;
        this.airTarget[i] = this.airKnots[knot] * (1 - t) + this.airKnots[(knot + 1) % AIR_KNOTS] * t;
      }
    }
    this.lastHighFlux = frame.highFlux;
    const follow = 1 - Math.exp(-dt / 0.04);
    for (let i = 0; i < SHAPE_SIZE; i++) this.air[i] += (this.airTarget[i] - this.air[i]) * follow;
    this.signal.write(music.bassLine, true, BASS_ROW);
    this.signal.write(music.leadLine, true, LEAD_ROW);
    this.signal.write(this.air, true, AIR_ROW);
    this.digital = digitalAmount * (0.3 + 0.7 * music.stylePercussion);
  }

  dispose(): void {
    this.signal.dispose();
  }
}
