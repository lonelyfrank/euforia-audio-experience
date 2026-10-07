import { HalfFloatType, LinearFilter, NoBlending, ShaderMaterial, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { createMemory, MEMORY_CEILING, memoryDecay } from './visualMemory';

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Writes the next memory from the fresh frame and the previous memory (the law in visualMemory.ts). */
const rememberShader = /* glsl */ `
  uniform sampler2D tFresh;
  uniform sampler2D tHistory;
  uniform float uDecay;
  uniform float uIrregularity;
  uniform float uImprint;
  uniform float uAccumulate;
  uniform float uDrift;
  uniform float uSeed;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  // Smooth value noise: the grain of an irregular memory.
  float grainAt(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    float grain = 0.0;
    vec2 at = vUv;
    // A clean memory costs two samples; the grain is computed only for an irregular one.
    if (uIrregularity > 0.004) {
      vec2 cell = vUv * 9.0 + uSeed;
      grain = grainAt(cell);
      // An irregular memory is displaced a little each second, along the grain.
      at += (vec2(grainAt(cell + 17.3), grainAt(cell + 41.9)) - 0.5) * uDrift;
    }
    vec3 history = texture2D(tHistory, at).rgb;
    vec3 fresh = texture2D(tFresh, vUv).rgb;
    vec3 kept = history * pow(uDecay, 1.0 + 3.0 * uIrregularity * grain);
    vec3 memory = max(fresh * uImprint, kept + (1.0 + uAccumulate) * (1.0 - uDecay) * fresh);
    gl_FragColor = vec4(min(memory, vec3(${MEMORY_CEILING}.0)), 1.0);
  }
`;

/** The frame shown: the fresh image, crisp, over what the memory holds. */
const showShader = /* glsl */ `
  uniform sampler2D tFresh;
  uniform sampler2D tMemory;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(max(texture2D(tFresh, vUv).rgb, texture2D(tMemory, vUv).rgb), 1.0);
  }
`;

/**
 * Temporal feedback as a post-processing pass: a memory buffer that the
 * frame is written into and shown over (trails, afterimages, persistence,
 * gathered light). Bounded and frame-rate independent by its law; `scale`
 * < 1 keeps the memory at a lower resolution (the fresh frame stays sharp).
 * Any scene can add one with `context.addPass(pass, 'pre-bloom')`; the layer
 * disposes it.
 */
export class FeedbackPass extends Pass {
  /** Set every frame by the owner (see `deriveMemory`). */
  readonly memory = createMemory();
  /** Decay applied on the last frame (diagnostics). */
  decay = 1;
  private targets: [WebGLRenderTarget, WebGLRenderTarget];
  private current = 0;
  private readonly remember: ShaderMaterial;
  private readonly show: ShaderMaterial;
  private readonly rememberQuad: FullScreenQuad;
  private readonly showQuad: FullScreenQuad;
  private seed = 0;
  private fresh = true;

  constructor(private readonly scale = 1) {
    super();
    const target = () => new WebGLRenderTarget(1, 1, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });
    this.targets = [target(), target()];
    this.remember = new ShaderMaterial({
      vertexShader, fragmentShader: rememberShader, blending: NoBlending, depthTest: false, depthWrite: false,
      uniforms: {
        tFresh: { value: null }, tHistory: { value: null }, uDecay: { value: 0 }, uIrregularity: { value: 0 }, uImprint: { value: 1 },
        uAccumulate: { value: 0 }, uDrift: { value: 0 }, uSeed: { value: 0 },
      },
    });
    this.show = new ShaderMaterial({
      vertexShader, fragmentShader: showShader, blending: NoBlending, depthTest: false, depthWrite: false,
      uniforms: { tFresh: { value: null }, tMemory: { value: null } },
    });
    this.rememberQuad = new FullScreenQuad(this.remember);
    this.showQuad = new FullScreenQuad(this.show);
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget, deltaTime: number): void {
    const from = this.targets[this.current], to = this.targets[1 - this.current];
    const m = this.memory, u = this.remember.uniforms;
    // The first frame (and the one after a resize) has no history to keep.
    this.decay = this.fresh ? 0 : memoryDecay(m.persistence, deltaTime);
    this.fresh = false;
    // The grain moves with the memory it breaks up: frozen when nothing is irregular.
    this.seed = (this.seed + deltaTime * m.irregularity * 0.7) % 64;
    u.tFresh.value = readBuffer.texture;
    u.tHistory.value = from.texture;
    u.uDecay.value = this.decay;
    u.uIrregularity.value = m.irregularity;
    u.uImprint.value = m.imprint;
    u.uAccumulate.value = m.accumulate;
    u.uDrift.value = 0.08 * m.irregularity * Math.min(deltaTime, 0.05);
    u.uSeed.value = this.seed;
    renderer.setRenderTarget(to);
    this.rememberQuad.render(renderer);
    this.current = 1 - this.current;

    this.show.uniforms.tFresh.value = readBuffer.texture;
    this.show.uniforms.tMemory.value = to.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.showQuad.render(renderer);
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * this.scale)), h = Math.max(1, Math.round(height * this.scale));
    for (const target of this.targets) target.setSize(w, h);
    this.fresh = true;
  }

  override dispose(): void {
    for (const target of this.targets) target.dispose();
    this.remember.dispose();
    this.show.dispose();
    this.rememberQuad.dispose();
    this.showQuad.dispose();
  }
}
