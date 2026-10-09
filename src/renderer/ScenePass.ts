import { HalfFloatType, ShaderMaterial, UniformsUtils, WebGLRenderTarget, type Camera, type Scene, type WebGLRenderer } from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

/**
 * Renders a scene with multisampling into a target of its own, and hands the
 * resolved picture to the composer.
 *
 * Antialiasing is a property of geometry edges, so only this pass needs it.
 * With a multisampled composer every later pass (bloom's blend, an
 * afterimage) drew its full-screen quad into four samples per pixel and
 * resolved them again, for a picture that is the same: a quad covers every
 * sample of every pixel, and adding to four equal samples then averaging is
 * adding to their average. Here the samples are resolved once; the passes
 * after it work on plain targets.
 *
 * Like RenderPass, it leaves its result in the composer's read buffer (no swap).
 */
export class ScenePass extends Pass {
  private readonly target: WebGLRenderTarget;
  private readonly copy: ShaderMaterial;
  private readonly quad: FullScreenQuad;
  /** True when no pass follows: the composer needs no copy, the layer shows `texture` directly. */
  last = false;

  constructor(private readonly scene: Scene, private readonly camera: Camera, samples: number) {
    super();
    this.needsSwap = false;
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples });
    this.copy = new ShaderMaterial({
      name: 'ScenePassCopy',
      uniforms: UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.copy);
  }

  /** The resolved picture (valid after `render`). */
  get texture() {
    return this.target.texture;
  }

  /** The target the scene is drawn into: programs compiled for it are the ones a frame uses. */
  get renderTarget(): WebGLRenderTarget {
    return this.target;
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height);
  }

  override render(renderer: WebGLRenderer, _writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target);
    renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
    if (this.last) return;
    // Leaving the target resolves its samples into its texture.
    this.copy.uniforms.tDiffuse.value = this.target.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.target.dispose();
    this.copy.dispose();
    this.quad.dispose();
  }
}
