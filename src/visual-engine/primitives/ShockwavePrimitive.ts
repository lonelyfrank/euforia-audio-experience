import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, LineSegments, ShaderMaterial, Vector3, type Object3D } from 'three';
import { fieldHeaderGlsl, TURN_AT } from '../../render-systems/fields/fieldLaw';
import { MAX_WAVES } from '../../render-systems/waves/WaveField';
import type { PaletteColors } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';

/*
 * Shockwaves: the world's wave fronts, made visible. The fronts themselves
 * are the WaveField's (dated on the events of the experience stream: they
 * push the matter, tear the graph and ripple the surface); this draws each
 * one where it is right now, as two rings of the expanding sphere. A ring is
 * round when the geometry is smooth and a polygon when it has edges; its
 * light is the front's own amplitude through what the shared FlashGuard
 * admitted, so with Reduce Flashing the fronts stay geometric and dim.
 * Nothing is detected or timed here.
 *
 * The law is written twice (GLSL and the CPU reference below).
 */

/** Rings drawn per front (in the body's plane and across it) and segments per ring. */
export const RINGS = 2;
export const RING_SEGMENTS = 96;
/** A front appears over this radius (units) and is no longer drawn beyond that one. */
const APPEAR = 0.12;
const FAR = 3.2;
const EXPOSURE = 0.9;

const vertexShader = /* glsl */ `
#define DETAIL 0
${fieldHeaderGlsl}
attribute vec3 aRing;
// x: how polygonal the rings are, y: light, z: presence
uniform vec3 uShock;
uniform vec3 uColorB;
uniform vec3 uColorC;
varying vec3 vColor;

// A point of ring \`ring\` of a front of radius \`radius\` round \`origin\`, at \`turn\` (0..1 of the way round).
vec3 ringPoint(vec3 origin, float radius, float ring, float sides, float turn) {
  float angle = turn * 6.2831853;
  // An angular world snaps the ring onto the corners of a polygon: most segments vanish, the rest are its sides.
  float corner = 6.2831853 / sides;
  angle = mix(angle, floor(angle / corner + 0.5) * corner, uShock.x) + F_TURN;
  vec2 c = vec2(cos(angle), sin(angle)) * radius;
  return origin + (ring < 0.5 ? vec3(c.x, c.y, 0.0) : vec3(c.x, 0.0, c.y));
}

void main() {
  int wave = int(aRing.x);
  vec4 A = uWaveA[wave];
  vec4 B = uWaveB[wave];
  float radius = B.y * A.w;
  // Low fronts are few-sided and heavy, high ones many-sided.
  float sides = 3.0 + floor((B.w < 0.0 ? 0.5 : B.w) * 4.0 + 0.5) + aRing.y;
  vec3 P = ringPoint(A.xyz, radius, aRing.y, sides, aRing.z);
  float amount = B.x * uShock.y * uShock.z * smoothstep(0.0, ${APPEAR}, radius) * (1.0 - smoothstep(${FAR * 0.7}, ${FAR}, radius));
  vColor = mix(uColorB, uColorC, clamp(B.x, 0.0, 1.0)) * (amount * ${EXPOSURE});
  gl_Position = amount > 0.002 ? projectionMatrix * modelViewMatrix * vec4(P, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;

/** Result of the CPU reference. Reused. */
export const ringOut = new Float64Array(3);

/** Sides of the polygon front `wave` snaps to on ring `ring`. */
export function ringSides(waveB: Float32Array, wave: number, ring: number): number {
  const band = waveB[wave * 4 + 3];
  return 3 + Math.floor((band < 0 ? 0.5 : band) * 4 + 0.5) + ring;
}

/** CPU reference of the GLSL `ringPoint` for front `wave`: `polygon` 0..1 as the primitive sets it. */
export function ringPoint(waveA: Float32Array, waveB: Float32Array, wave: number, ring: number, turn: number, polygon: number, f: Float32Array): Float64Array {
  const radius = waveB[wave * 4 + 1] * waveA[wave * 4 + 3], corner = 2 * Math.PI / ringSides(waveB, wave, ring);
  let angle = turn * 2 * Math.PI;
  angle = angle + (Math.floor(angle / corner + 0.5) * corner - angle) * polygon + f[TURN_AT];
  const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
  ringOut[0] = waveA[wave * 4] + x; ringOut[1] = waveA[wave * 4 + 1] + (ring < 0.5 ? y : 0); ringOut[2] = waveA[wave * 4 + 2] + (ring < 0.5 ? 0 : y);
  return ringOut;
}

export class ShockwavePrimitive implements Primitive {
  readonly object: Object3D;
  readonly elements = MAX_WAVES * RINGS;
  readonly vertices = MAX_WAVES * RINGS * RING_SEGMENTS * 2;
  readonly debug = { rings: 0 };
  /** How polygonal the rings are and how bright, as the law reads them this frame. */
  readonly state = { polygon: 0, light: 0 };
  private readonly material: ShaderMaterial;
  private readonly geometry = new BufferGeometry();

  constructor(context: PrimitiveContext) {
    const ring = new Float32Array(this.vertices * 3);
    let at = 0;
    for (let wave = 0; wave < MAX_WAVES; wave++) {
      for (let r = 0; r < RINGS; r++) {
        for (let k = 0; k < RING_SEGMENTS; k++) {
          for (let end = 0; end < 2; end++) { ring[at++] = wave; ring[at++] = r; ring[at++] = (k + end) / RING_SEGMENTS; }
        }
      }
    }
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.vertices * 3), 3));
    this.geometry.setAttribute('aRing', new BufferAttribute(ring, 3));
    this.material = new ShaderMaterial({
      vertexShader, fragmentShader, transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending,
      uniforms: {
        uField: { value: context.uField }, uWaveA: { value: context.uWaveA }, uWaveB: { value: context.uWaveB },
        uShock: { value: new Vector3() }, uColorB: { value: new Color() }, uColorC: { value: new Color() },
      },
    });
    const lines = new LineSegments(this.geometry, this.material);
    lines.frustumCulled = false;
    this.object = lines;
  }

  setPalette([, secondary, highlight]: PaletteColors): void {
    (this.material.uniforms.uColorB.value as Color).copy(secondary); (this.material.uniforms.uColorC.value as Color).copy(highlight);
  }

  update(frame: Readonly<WorldFrame>, presence: number): void {
    const s = this.state;
    s.polygon = frame.geometry.edgeHardness;
    // The fronts' light is the material's: what the flash guard admitted, never less than a trace.
    s.light = frame.look.wave;
    (this.material.uniforms.uShock.value as Vector3).set(s.polygon, s.light, presence);
    if (import.meta.env.DEV) this.debug.rings = frame.timed ? frame.waves.active(frame.time) * RINGS : 0;
  }

  reset(): void {}

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
