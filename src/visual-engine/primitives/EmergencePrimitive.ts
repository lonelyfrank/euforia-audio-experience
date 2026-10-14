import { BufferAttribute, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedBufferGeometry, LineSegments, Mesh, ShaderMaterial, AdditiveBlending, Vector4, type Object3D } from 'three';
import type { QualityProfile } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';
import { emergenceLawGlsl, emergenceTemplate, SHAPES, TEMPLATE_VERTICES } from './emergenceLaw';
import { EmergenceField, MAX_STRUCTURES, PHASES, type EmergenceSettings } from './terrainEmergence';
import { terrainLawGlsl } from './terrainLaw';
import type { TerrainPrimitive } from './TerrainPrimitive';

/*
 * What rises out of Generative Terrain, drawn: every structure of the emergence field (terrainEmergence.ts) as an
 * instance of one template (emergenceLaw.ts), in the ground's own space and from the ground's own uniforms — the
 * same packed terrain law, fronts, light, air and colours the ground binds, the very same objects — so a structure is
 * placed by the law that places the ground and cannot drift from it. Facets dark like the ground's, edges carrying
 * the light; two draw calls (one at Low, where only the edges are drawn: the logic is the same at every quality).
 * Buffers are allocated once at the pool's size; a frame rewrites the part in use.
 */

const vertexShader = /* glsl */ `
${terrainLawGlsl}
${emergenceLawGlsl}
uniform vec4 uLight;
uniform vec4 uAir;
uniform float uSpan;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
varying vec3 vColor;
varying vec3 vLocal;
varying float vFog;

void main() {
  vec3 P = emergentPoint(position.x, position.y, position.z);
  float d = -P.z;
  // The ground's air: what is far fades into the dark, and so does what is at the sides of the mesh.
  vFog = exp(-max(d, 0.0) * uAir.y) * (1.0 - smoothstep(uAir.z * 0.75, uAir.z, d)) * (1.0 - smoothstep(0.85, 1.0, abs(P.x) / uSpan)) * uAir.w;
  float light = aBreak.z;
  vColor = (mix(uColorA, uColorB, emergentLevel) * light * (0.25 + 1.4 * uLight.x) + uColorC * light * (0.15 + 0.6 * uLight.y)) * vFog;
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
  gl_FragColor = vec4(uColorA * (0.02 + uFacet * (0.4 + tilt)) * vFog, 1.0);
}
`;

export class EmergencePrimitive implements Primitive {
  readonly object: Object3D;
  readonly field: EmergenceField;
  readonly elements: number;
  readonly vertices: number;
  readonly debug: Record<string, number> = { structures: 0, spawned: 0, recycled: 0, fractured: 0, refused: 0, density: 0, releases: 0, prepares: 0, withdraws: 0, 'emergence ms': 0 };
  /** Draw calls at this quality: edges, and facets unless Low. */
  readonly drawCalls: number;
  private readonly inner = new Group();
  private readonly geometries: InstancedBufferGeometry[] = [];
  private readonly materials: ShaderMaterial[] = [];
  private readonly attributes: InstancedBufferAttribute[];

  constructor(context: PrimitiveContext, private readonly ground: TerrainPrimitive, params: EmergenceSettings, quality: QualityProfile) {
    this.field = new EmergenceField(params, context.seed | 0);
    const template = emergenceTemplate(), position = new BufferAttribute(template.position, 3), f = this.field;
    this.attributes = [f.anchor, f.body, f.brk].map((array) => new InstancedBufferAttribute(array, 4).setUsage(DynamicDrawUsage));
    const shapes = SHAPES.map((s) => new Vector4(s.sides, s.taper, 0, 0));
    const shared = { ...ground.shared, uShapes: { value: shapes } };
    const facets = quality.density >= 0.5;
    const make = (index: Uint16Array): InstancedBufferGeometry => {
      const g = new InstancedBufferGeometry();
      g.setAttribute('position', position); g.setAttribute('aAnchor', this.attributes[0]); g.setAttribute('aBody', this.attributes[1]); g.setAttribute('aBreak', this.attributes[2]);
      g.setIndex(new BufferAttribute(index, 1)); g.instanceCount = 0;
      this.geometries.push(g);
      return g;
    };
    const wire = new ShaderMaterial({ vertexShader, fragmentShader: wireFragment, uniforms: shared, transparent: true, depthWrite: false, blending: AdditiveBlending });
    const edges = new LineSegments(make(template.edges), wire);
    edges.frustumCulled = false;
    this.materials.push(wire);
    if (facets) {
      const fill = new ShaderMaterial({ vertexShader, fragmentShader: fillFragment, uniforms: { ...shared, uFacet: { value: 0.1 } }, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      const body = new Mesh(make(template.faces), fill);
      body.frustumCulled = false;
      this.materials.push(fill);
      this.inner.add(body);
    }
    this.inner.add(edges);
    this.drawCalls = facets ? 2 : 1;
    // Laid out as the ground is: the same height under the viewer, the same pitch and bank (copied each frame).
    this.inner.position.y = -ground.params.height;
    const object = new Group();
    object.add(this.inner);
    this.object = object;
    this.elements = MAX_STRUCTURES;
    this.vertices = MAX_STRUCTURES * TEMPLATE_VERTICES;
  }

  setPalette(): void {
    // The colours are the ground's own uniforms: nothing to copy.
  }

  update(frame: Readonly<WorldFrame>, presence: number): void {
    const started = import.meta.env.DEV ? performance.now() : 0;
    const ground = this.ground, motion = ground.motion, v = motion.values, p = ground.params;
    this.object.rotation.copy(ground.object.rotation);
    this.field.step(frame.dt, v, frame.view, v.row + v.shift, p.rows, p.columns, motion.ring, motion.tension, frame.timed ? frame.snapshot?.cues : undefined, frame.time);
    const count = presence > 0 ? this.field.count : 0;
    for (const attribute of this.attributes) {
      attribute.clearUpdateRanges();
      if (count > 0) { attribute.addUpdateRange(0, count * 4); attribute.needsUpdate = true; }
    }
    for (const g of this.geometries) g.instanceCount = count;
    if (import.meta.env.DEV) {
      const d = this.debug, s = this.field.stats;
      d.structures = this.field.count; d.spawned = s.spawned; d.recycled = s.recycled; d.fractured = s.fractured; d.refused = s.refused; d.density = s.density;
      d.releases = s.releases; d.prepares = s.prepares; d.withdraws = s.withdraws;
      for (let i = 1; i < PHASES.length; i++) d[PHASES[i]] = s.phases[i];
      d['emergence ms'] += (performance.now() - started - d['emergence ms']) * 0.05;
    }
  }

  /** A new audio session: what waited for the last session's release goes back into the ground. */
  reset(): void {
    this.field.reset();
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    (this.object as Group).clear();
  }
}

/** Draw calls of the emergence at a quality (edges; facets above Low). */
export const emergenceDrawCalls = (quality: QualityProfile): number => (quality.density >= 0.5 ? 2 : 1);
