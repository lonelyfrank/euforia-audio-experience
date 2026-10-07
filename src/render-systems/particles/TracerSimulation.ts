import { DataTexture, FloatType, GLSL3, NearestFilter, NoBlending, RawShaderMaterial, RGBAFormat, WebGLRenderTarget, type Texture, type WebGLRenderer } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { fieldHeaderGlsl } from '../fields/fieldLaw';
import { flowLawGlsl } from '../fields/flowLaw';
import { vectorFieldGlsl } from '../fields/vectorField';
import { wellsGlsl } from '../fields/wells';
import { substeps } from './matterLaw';
import { simulationType } from './MatterSimulation';
import { tracerLawGlsl, tracerStepGlsl } from './tracerLaw';
import type { TracerSeeds } from './TracerSeeds';

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
uniform float uStep;
uniform float uReset;
${fieldHeaderGlsl}
${flowLawGlsl}
${wellsGlsl}
${vectorFieldGlsl}
${tracerLawGlsl}
${tracerStepGlsl}
layout(location = 0) out vec4 outPosition;
layout(location = 1) out vec4 outVelocity;

void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  vec4 pos = texelFetch(tPosition, at, 0);
  vec4 vel = texelFetch(tVelocity, at, 0);
  vec4 home = texelFetch(tHome, at, 0);
  vec4 trait = texelFetch(tTrait, at, 0);
  bool reset = uReset > 0.5;
  vec4 law = reset ? vec4(0.0) : tracerLaw(pos.xyz, home, trait.x);
  tracerStep(pos, vel, home, trait, law, uStep, reset);
  outPosition = pos;
  outVelocity = vel;
}
`;

/** The uniform arrays a world shares with what reads its fields: the tracers bind them as they are, so they move in the very field the lines draw. */
export interface SharedField {
  uField: Float32Array;
  uWaveA: Float32Array;
  uWaveB: Float32Array;
  /** The packed topology of the vector field (fields/vectorField.ts). */
  topology: Float32Array;
}

/**
 * The tracers' state on the GPU: position and velocity of every tracer in two
 * float textures, advanced by one fragment pass per sub-step (ping-pong, two
 * colour attachments; WebGL2), like the matter's. The pass is the tracer law
 * and the tracer step, nothing else; the field it reads is the world's
 * own packed arrays, never a copy.
 */
export class TracerSimulation {
  private readonly targets: [WebGLRenderTarget, WebGLRenderTarget];
  private readonly home: DataTexture;
  private readonly trait: DataTexture;
  private readonly material: RawShaderMaterial;
  private readonly quad: FullScreenQuad;
  private current = 0;
  private pendingReset = true;
  /** Whether positions are stored as 32-bit floats (false: half floats, a hardware limit). */
  readonly fullFloat: boolean;

  constructor(private readonly renderer: WebGLRenderer, readonly seeds: TracerSeeds, detail: boolean, shared: SharedField) {
    const { width, height } = seeds.layout;
    const type = simulationType(renderer);
    this.fullFloat = type === FloatType;
    const target = () => new WebGLRenderTarget(width, height, {
      count: 2, type, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.targets = [target(), target()];
    this.home = seedTexture(seeds.home, width, height);
    this.trait = seedTexture(seeds.trait, width, height);
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader, fragmentShader: fragmentShader(detail), blending: NoBlending, depthTest: false, depthWrite: false,
      uniforms: {
        tPosition: { value: null }, tVelocity: { value: null }, tHome: { value: this.home }, tTrait: { value: this.trait },
        uStep: { value: 0 }, uReset: { value: 1 },
        uField: { value: shared.uField }, uWaveA: { value: shared.uWaveA }, uWaveB: { value: shared.uWaveB }, uTopology: { value: shared.topology },
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

  /** Advances by `dt` seconds in the field as the shared arrays describe it now. Returns the sub-steps done. */
  step(dt: number): number {
    const steps = substeps(dt) || (this.pendingReset ? 1 : 0);
    if (steps === 0) return 0;
    const renderer = this.renderer, u = this.material.uniforms;
    const previous = renderer.getRenderTarget();
    u.uStep.value = Math.min(dt, 0.1) / steps;
    for (let s = 0; s < steps; s++) {
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

  /** Reads the state back (RGBA floats, one texel per tracer): positions, or velocities. Slow; diagnostics and the parity check only. */
  read(out: Float32Array, velocities = false): Float32Array {
    const { width, height } = this.seeds.layout;
    this.renderer.readRenderTargetPixels(this.targets[this.current], 0, 0, width, height, out, undefined, velocities ? 1 : 0);
    return out;
  }

  dispose(): void {
    for (const target of this.targets) target.dispose();
    this.home.dispose();
    this.trait.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}

function seedTexture(data: Float32Array, width: number, height: number): DataTexture {
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}
