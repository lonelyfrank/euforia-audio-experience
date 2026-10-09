import type { WebGLRenderer } from 'three';
import { RollingStatistics } from '../metrics/RollingStatistics';

export interface RenderObservation {
  begin(now: number, dt: number): void;
  sourceDone(): void;
  /** Every layer is updated and drawn; the composition follows. */
  layersDone(): void;
  end(layers: number, crossfades: number, passes: number): void;
}

/** Asynchronous, bounded timer queries. No finish, no spinning, no result read before availability. */
export class GpuTimer {
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  ms: number | null = null;
  enabled = false;
  private lost = false;
  constructor(private readonly gl: WebGL2RenderingContext) { this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'); }
  get supported(): boolean { return this.ext !== null; }
  begin(): void {
    if (this.gl.isContextLost()) { this.lost = true; this.pending.length = 0; this.active = null; this.ms = null; return; }
    if (this.lost) { this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2'); this.lost = false; }
    if (!this.enabled || !this.ext) { this.ms = null; return; }
    // A frame that threw never ended its query: close it, or every later frame would begin one inside another.
    if (this.active) this.end();
    const gl = this.gl;
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) { this.clear(); return; }
    const query = this.pending[0];
    if (query && gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
      this.ms = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(query); this.pending.shift();
    }
    if (this.pending.length >= 4) return;
    this.active = gl.createQuery();
    if (this.active) gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.active);
  }
  end(): void {
    if (!this.active || !this.ext) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); this.pending.push(this.active); this.active = null;
  }
  clear(): void {
    if (this.active && this.ext) { this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); this.gl.deleteQuery(this.active); this.active = null; }
    for (const query of this.pending) this.gl.deleteQuery(query);
    this.pending.length = 0; this.ms = null;
  }
  dispose(): void { this.enabled = false; this.clear(); }
}

export class RendererProbe implements RenderObservation {
  readonly frames = new RollingStatistics();
  readonly drawn = { calls: 0, triangles: 0, points: 0, lines: 0 };
  readonly timer: GpuTimer;
  frameMs = 0;
  sourceMs = 0;
  renderSubmitMs = 0;
  /** Of `renderSubmitMs`: the layers (scene updates, their passes) and the final composition. */
  layersMs = 0;
  compositeMs = 0;
  layers = 0;
  crossfades = 0;
  passes = 0;
  onFrame: ((now: number) => void) | null = null;
  private start = 0;
  private sourceEnd = 0;
  private layersEnd = 0;
  private now = 0;
  private autoReset = true;
  /** Between begin and end: a frame that threw leaves it set, and the next one must not take this probe's own setting for the renderer's. */
  private open = false;
  constructor(private readonly renderer: WebGLRenderer) { this.timer = new GpuTimer(renderer.getContext() as WebGL2RenderingContext); }
  begin(now: number, dt: number): void {
    this.now = now / 1000; this.start = performance.now();
    this.frameMs = dt * 1000; this.frames.push(this.frameMs);
    if (!this.open) this.autoReset = this.renderer.info.autoReset;
    this.open = true;
    this.renderer.info.autoReset = false; this.renderer.info.reset(); this.timer.begin();
  }
  sourceDone(): void { this.sourceEnd = this.layersEnd = performance.now(); this.sourceMs = this.sourceEnd - this.start; }
  layersDone(): void { this.layersEnd = performance.now(); this.layersMs = this.layersEnd - this.sourceEnd; }
  end(layers: number, crossfades: number, passes: number): void {
    const end = performance.now();
    this.renderSubmitMs = end - this.sourceEnd;
    this.compositeMs = end - this.layersEnd;
    this.timer.end(); Object.assign(this.drawn, this.renderer.info.render);
    this.renderer.info.autoReset = this.autoReset; this.open = false;
    this.layers = layers; this.crossfades = crossfades; this.passes = passes;
    this.onFrame?.(this.now);
  }
  dispose(): void {
    if (this.open) { this.renderer.info.autoReset = this.autoReset; this.open = false; }
    this.timer.dispose(); this.onFrame = null;
  }
}
