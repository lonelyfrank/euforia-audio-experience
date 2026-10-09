import { DataUtils } from 'three';
import {
  DataTexture, FloatType, GLSL3, HalfFloatType, NearestFilter, NoBlending, RawShaderMaterial, RedFormat, RGBAFormat, WebGLRenderTarget,
  type PixelFormat, type Texture, type TextureDataType, type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FIELD_VALUES, fieldLawGlsl, packFields, packWaves, PHASE_PERIOD } from '../fields/fieldLaw';
import type { SpatialFields } from '../fields/SpatialFields';
import { formLawGlsl } from '../forms/formLaw';
import { HARMONIC_HEIGHT, HARMONIC_WIDTH } from '../forms/HarmonicForm';
import { MatterForms } from '../forms/MatterForms';
import { SIGNAL_ROWS, SIGNAL_SIZE, SIGNAL_VOICES } from '../forms/SignalForm';
import { MAX_WAVES, type WaveField } from '../waves/WaveField';
import { matterStepGlsl, substeps } from './matterLaw';
import { STRAND, type MatterSeeds } from './MatterSeeds';

const vertexShader = /* glsl */ `
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = (detail: boolean) => /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
#define DETAIL ${detail ? 1 : 0}
uniform sampler2D tPosition;
uniform sampler2D tVelocity;
uniform sampler2D tHome;
uniform sampler2D tTrait;
uniform sampler2D tForm;
uniform float uStep;
uniform float uReset;
${fieldLawGlsl}
${formLawGlsl}
${matterStepGlsl}
layout(location = 0) out vec4 outPosition;
layout(location = 1) out vec4 outVelocity;

void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  vec4 pos = texelFetch(tPosition, at, 0);
  vec4 vel = texelFetch(tVelocity, at, 0);
  vec4 home = texelFetch(tHome, at, 0);
  vec4 trait = texelFetch(tTrait, at, 0);
  bool reset = uReset > 0.5;
  vec4 law = vec4(0.0);
  if (!reset) {
    int member = at.x % ${STRAND};
    vec2 links = vec2(member > 0 ? 1.0 : 0.0, member < ${STRAND - 1} ? 1.0 : 0.0);
    vec3 prev = texelFetch(tPosition, ivec2(max(at.x - 1, 0), at.y), 0).xyz;
    vec3 next = texelFetch(tPosition, ivec2(min(at.x + 1, textureSize(tPosition, 0).x - 1), at.y), 0).xyz;
    law = fieldLaw(pos.xyz, home, trait.x, prev, next, links, formAnchor(texelFetch(tForm, at, 0), member));
  }
  matterStep(pos, vel, home, trait, law, uStep, reset);
  outPosition = pos;
  outVelocity = vel;
}
`;

/** Full-float targets when the device can render to them; half floats otherwise (coarser slow motion). */
export function simulationType(renderer: WebGLRenderer): TextureDataType {
  return renderer.extensions?.has('EXT_color_buffer_float') ? FloatType : HalfFloatType;
}

/**
 * The matter's state on the GPU: position and velocity of every element in
 * two float textures, advanced by one fragment pass per sub-step (ping-pong
 * between two targets with two colour attachments each; WebGL2). The pass is
 * the form law, the field law and the matter step, nothing else: what moves
 * the matter is decided outside, in `SpatialFields`, `WaveField` and
 * `MatterForms` (whose two small data arrays are uploaded when they change).
 *
 * The public surface (two textures, `step`, `reset`, `dispose`) is the
 * boundary a compute backend would implement.
 */
export class MatterSimulation {
  private readonly targets: [WebGLRenderTarget, WebGLRenderTarget];
  private readonly home: DataTexture;
  private readonly trait: DataTexture;
  private readonly form: DataTexture;
  private readonly signal: DataTexture;
  private readonly harmonic: DataTexture;
  /** The forms of a simulation created without any: nothing is ever claimed. */
  private readonly formless: MatterForms | null = null;
  private signalVersion = -1;
  private harmonicVersion = -1;
  private readonly material: RawShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly field = new Float32Array(FIELD_VALUES);
  private readonly waveA = new Float32Array(MAX_WAVES * 4);
  private readonly waveB = new Float32Array(MAX_WAVES * 4);
  private current = 0;
  private phase = 0;
  private pendingReset = true;
  /** Whether positions are stored as 32-bit floats (false: half floats, a hardware limit). */
  readonly fullFloat: boolean;

  /** `forms`: the forms this matter can take (their data arrays become textures); none = free matter only. */
  constructor(private readonly renderer: WebGLRenderer, readonly seeds: MatterSeeds, detail: boolean, private readonly forms?: MatterForms) {
    const { width, height } = seeds.layout;
    const type = simulationType(renderer);
    this.fullFloat = type === FloatType;
    const target = () => new WebGLRenderTarget(width, height, {
      count: 2, type, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.targets = [target(), target()];
    this.home = seedTexture(seeds.home, width, height);
    this.trait = seedTexture(seeds.trait, width, height);
    this.form = seedTexture(seeds.form, width, height);
    if (!forms) this.formless = new MatterForms();
    const source = forms ?? this.formless!;
    this.signal = seedTexture(source.signal.data, SIGNAL_SIZE, SIGNAL_ROWS * SIGNAL_VOICES, RedFormat);
    this.harmonic = seedTexture(source.harmonic.data, HARMONIC_WIDTH, HARMONIC_HEIGHT);
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader, fragmentShader: fragmentShader(detail), blending: NoBlending, depthTest: false, depthWrite: false,
      uniforms: {
        tPosition: { value: null }, tVelocity: { value: null }, tHome: { value: this.home }, tTrait: { value: this.trait },
        tForm: { value: this.form }, tSignal: { value: this.signal }, tHarmonic: { value: this.harmonic },
        uStep: { value: 0 }, uReset: { value: 1 }, uField: { value: this.field }, uWaveA: { value: this.waveA }, uWaveB: { value: this.waveB },
        uForm: { value: source.pack() },
      },
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** Current state: position xyz + energy, velocity xyz + age. They change identity every step. */
  get positions(): Texture {
    return this.targets[this.current].textures[0];
  }

  get velocities(): Texture {
    return this.targets[this.current].textures[1];
  }

  get homes(): Texture {
    return this.home;
  }

  get traits(): Texture {
    return this.trait;
  }

  /** The strands' form seeds (see MatterSeeds). */
  get formSeeds(): Texture {
    return this.form;
  }

  /** Advances by `dt` seconds under `fields` and the fronts as they are at `now`. Returns the sub-steps done. */
  step(fields: Readonly<SpatialFields>, waves: WaveField | undefined, now: number, dt: number): number {
    const steps = substeps(dt) || (this.pendingReset ? 1 : 0);
    if (steps === 0) return 0;
    const h = Math.min(dt, 0.1) / steps;
    // Without fronts (no clock) none may linger from an earlier frame.
    if (waves) packWaves(this.waveA, this.waveB, waves, now);
    else this.waveB.fill(0);
    const forms = this.forms;
    if (forms) {
      // The packed vector is the uniform's own array; the two data textures are uploaded only when they changed.
      forms.pack();
      if (forms.signal.version !== this.signalVersion) { this.signal.needsUpdate = true; this.signalVersion = forms.signal.version; }
      if (forms.harmonic.version !== this.harmonicVersion) { this.harmonic.needsUpdate = true; this.harmonicVersion = forms.harmonic.version; }
    }
    const renderer = this.renderer, u = this.material.uniforms;
    const previous = renderer.getRenderTarget();
    u.uStep.value = h;
    for (let s = 0; s < steps; s++) {
      this.phase = (this.phase + fields.phaseRate * h) % PHASE_PERIOD;
      packFields(this.field, fields, this.phase);
      const from = this.targets[this.current], to = this.targets[1 - this.current];
      u.tPosition.value = from.textures[0];
      u.tVelocity.value = from.textures[1];
      u.uReset.value = this.pendingReset ? 1 : 0;
      renderer.setRenderTarget(to);
      this.quad.render(renderer);
      this.current = 1 - this.current;
      this.pendingReset = false;
    }
    renderer.setRenderTarget(previous);
    return steps;
  }

  /** Reads the state back (RGBA floats, one texel per element): positions, or velocities. Slow; diagnostics and the parity check only. */
  read(out: Float32Array, velocities = false): Float32Array {
    const { width, height } = this.seeds.layout;
    if (this.fullFloat) this.renderer.readRenderTargetPixels(this.targets[this.current], 0, 0, width, height, out, undefined, velocities ? 1 : 0);
    else {
      const half = new Uint16Array(width * height * 4);
      this.renderer.readRenderTargetPixels(this.targets[this.current], 0, 0, width, height, half, undefined, velocities ? 1 : 0);
      for (let i = 0; i < half.length; i++) out[i] = DataUtils.fromHalfFloat(half[i]);
    }
    return out;
  }

  /** The matter re-forms at its seeds on the next step (a new audio session). */
  reset(): void {
    this.pendingReset = true;
    this.phase = 0;
  }

  /** Read-only observation of the ping-pong index. */
  get diagnosticTarget(): number { return this.current; }

  /** Explicit lab readback: a prefix of one row, at most 256 elements, full-float only. */
  readDiagnosticSample(position: Float32Array, velocity: Float32Array): number {
    if (!this.fullFloat) return 0;
    const count = Math.min(256, this.seeds.layout.width, Math.floor(position.length / 4), Math.floor(velocity.length / 4));
    if (count < 1 || this.renderer.getContext().isContextLost()) return 0;
    position.fill(NaN); velocity.fill(NaN);
    this.renderer.readRenderTargetPixels(this.targets[this.current], 0, 0, count, 1, position, undefined, 0);
    this.renderer.readRenderTargetPixels(this.targets[this.current], 0, 0, count, 1, velocity, undefined, 1);
    return count;
  }

  dispose(): void {
    for (const target of this.targets) target.dispose();
    this.home.dispose();
    this.trait.dispose();
    this.form.dispose();
    this.signal.dispose();
    this.harmonic.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}

function seedTexture(data: Float32Array, width: number, height: number, format: PixelFormat = RGBAFormat): DataTexture {
  const texture = new DataTexture(data, width, height, format, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}
