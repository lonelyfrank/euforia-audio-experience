import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, LineSegments, Mesh, ShaderMaterial, Vector4, type Object3D } from 'three';
import type { PaletteColors, QualityProfile } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';
import { latticeMesh } from './lattice';
import { BEHIND, OCEAN_VALUES, oceanLawGlsl, packOcean } from './oceanLaw';
import { OceanMotion, type OceanParams } from './oceanMotion';

/*
 * The sea of Pulse Ocean: one lattice of low-poly facets and the grid of its lines (no diagonals: a sea reads as rows
 * of crests), drawn from the same vertices. Its height is the ocean law (oceanLaw.ts), its motion the sea's reading of
 * the world (oceanMotion.ts); nothing is created or moved while it plays: gliding slides the mesh over the lattice.
 * Two draw calls, no texture, no pass. The light rides the waves: crests carry it, troughs keep the dark; fronts and a
 * release show as far as the shared flash guard admitted; the highs glint on single points of the surface.
 */

/** Light of the sea with nothing sounding: the surface is there, flat and dim. */
const REST_LIGHT = 0.14;
/** How much the facets show of their own tilt, at most. */
const FACET = 0.14;
/** Share of the mesh's depth over which the far end fades into the dark, and of its half width for its sides. */
const HORIZON = 0.3;
const EDGE = 0.12;

/** Columns and rows at a quality: fewer cells, larger ones, the same extent of sea. */
export function oceanQuality(p: OceanParams, quality: QualityProfile): OceanParams {
  const scale = Math.sqrt(Math.min(1, Math.max(0.25, quality.density)));
  const columns = Math.max(32, 2 * Math.round(p.columns * scale / 2)), rows = Math.max(64, Math.round(p.rows * scale));
  return { ...p, columns, rows, cell: p.cell * Math.max(p.columns / columns, p.rows / rows) };
}

const vertexShader = /* glsl */ `
${oceanLawGlsl}
// x: light of the lines, y: of the wave fronts, z: of a release front, w: glints of the highs
uniform vec4 uLight;
// x: unused, y: fog per unit, z: depth of the mesh (units), w: presence
uniform vec4 uAir;
uniform float uSpan;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
varying vec3 vColor;
varying vec3 vLocal;
varying float vFog;

void main() {
  float i = position.x, k = position.z;
  float d = oceanDepth(k);
  float h = oceanHeight(i, k);
  vec3 P = vec3(oceanAcross(i), h, -d);
  float side = abs(i - O_SHIFT_X) * O_CELL / uSpan;
  vFog = exp(-max(d, 0.0) * uAir.y) * (1.0 - smoothstep(uAir.z * ${(1 - HORIZON).toFixed(2)}, uAir.z, d)) * (1.0 - smoothstep(${(1 - EDGE).toFixed(2)}, 1.0, side)) * uAir.w;
  float crest = smoothstep(-0.3, 1.0, oceanCrest);
  float glint = step(1.0 - 0.25 * uLight.w, oceanGrain(i, k)) * uLight.w;
  float lit = uLight.x * (0.35 + 0.65 * crest) + uLight.y * oceanFront + uLight.z * oceanBand(d);
  vColor = (mix(uColorA, uColorB, crest) * lit + uColorC * (glint + 0.5 * uLight.y * oceanFront)) * vFog;
  vLocal = P;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(P, 1.0);
}
`;

const wireFragment = /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;

const fillFragment = /* glsl */ `
uniform vec3 uColorA;
uniform float uFacet;
varying vec3 vLocal;
varying float vFog;
void main() {
  vec3 n = normalize(cross(dFdx(vLocal), dFdy(vLocal)));
  float tilt = 1.0 - abs(n.y);
  gl_FragColor = vec4(uColorA * (0.014 + uFacet * tilt) * vFog, 1.0);
}
`;

export class OceanPrimitive implements Primitive {
  readonly object: Object3D;
  readonly elements: number;
  readonly vertices: number;
  readonly motion: OceanMotion;
  readonly params: OceanParams;
  readonly debug = { drive: 0, ring: 0, stir: 0, life: 0, chop: 0, swell: 0, groove: 0, ripple: 0, release: 0, fronts: 0, row: 0 };
  /** Forward distance the sea is carried by this frame (units): the scene's observer sets it before the update. */
  advance = 0;
  private readonly wire: ShaderMaterial;
  private readonly fill: ShaderMaterial;
  private readonly wireGeometry = new BufferGeometry();
  private readonly fillGeometry = new BufferGeometry();
  private readonly uOcean = new Float32Array(OCEAN_VALUES);

  constructor(context: PrimitiveContext, params: OceanParams) {
    const p = this.params = params;
    this.motion = new OceanMotion(p);
    const { position, lines, faces } = latticeMesh(p.columns, p.rows, false);
    const attribute = new BufferAttribute(position, 3);
    this.wireGeometry.setAttribute('position', attribute); this.wireGeometry.setIndex(new BufferAttribute(lines, 1));
    this.fillGeometry.setAttribute('position', attribute); this.fillGeometry.setIndex(new BufferAttribute(faces, 1));
    this.elements = lines.length / 2 + faces.length / 3;
    this.vertices = position.length / 3;
    const shared = {
      uOcean: { value: this.uOcean }, uSwell: { value: this.motion.swell }, uWaveA: { value: context.uWaveA }, uWaveB: { value: context.uWaveB },
      uLight: { value: new Vector4() }, uAir: { value: new Vector4(0, p.fog, (p.rows - BEHIND) * p.cell, 1) }, uSpan: { value: (p.columns / 2 - 1) * p.cell },
      uColorA: { value: new Color() }, uColorB: { value: new Color() }, uColorC: { value: new Color() },
    };
    this.fill = new ShaderMaterial({ vertexShader, fragmentShader: fillFragment, uniforms: { ...shared, uFacet: { value: 0 } }, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.wire = new ShaderMaterial({ vertexShader, fragmentShader: wireFragment, uniforms: shared, transparent: true, depthWrite: false, blending: AdditiveBlending });
    const facets = new Mesh(this.fillGeometry, this.fill), edges = new LineSegments(this.wireGeometry, this.wire);
    facets.frustumCulled = edges.frustumCulled = false;
    const sea = new Group();
    sea.add(facets, edges);
    sea.position.y = -p.height;
    const object = new Group();
    object.add(sea);
    object.rotation.x = p.pitch;
    this.object = object;
    packOcean(this.uOcean, this.motion.values);
  }

  setPalette([primary, secondary, highlight]: PaletteColors): void {
    const u = this.wire.uniforms;
    (u.uColorA.value as Color).copy(primary); (u.uColorB.value as Color).copy(secondary); (u.uColorC.value as Color).copy(highlight);
  }

  update(frame: Readonly<WorldFrame>, presence: number): void {
    const p = this.params, look = frame.look, motion = this.motion;
    const values = motion.step(frame.dt, frame.view, frame.geometry, this.advance);
    packOcean(this.uOcean, values);
    const base = p.exposure * (REST_LIGHT * (0.5 + 0.5 * look.gate) + 0.9 * look.emissive + look.ember);
    (this.wire.uniforms.uLight.value as Vector4).set(base, p.exposure * look.wave, p.exposure * look.wave * 0.8, look.spark * motion.stir);
    (this.wire.uniforms.uAir.value as Vector4).w = presence;
    this.fill.uniforms.uFacet.value = FACET * (0.4 + 0.6 * look.relief) * (0.3 + 0.7 * look.fill);
    if (import.meta.env.DEV) {
      const d = this.debug, s = motion.swell;
      d.drive = motion.drive; d.ring = motion.ring; d.stir = motion.stir; d.life = motion.life; d.chop = values.chop;
      d.swell = s[3] + s[7]; d.groove = s[11] + s[15] + s[19]; d.ripple = s[23] + s[27]; d.release = values.release;
      d.fronts = frame.timed ? frame.waves.active(frame.time) : 0; d.row = motion.position;
    }
  }

  /** A new audio session: the followers start over; the sea travelled stays where it is. */
  reset(): void {
    this.motion.reset();
  }

  dispose(): void {
    this.wireGeometry.dispose(); this.fillGeometry.dispose();
    this.wire.dispose(); this.fill.dispose();
  }
}
